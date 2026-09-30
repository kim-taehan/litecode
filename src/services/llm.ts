import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import path from 'node:path'
import './providers.ts'

// opencode 를 감싸는 서비스 — 위층(세션·UI)은 이 ctx.llm 키만 알고 opencode 를 직접 모른다.
// 나중에 엔진을 바꾸더라도 이 서비스만 교체하면 된다 (Cordis: 서비스는 키로 찾는다).
//
// opencode 프로토콜은 실측(2026-09-29, opencode 1.x /doc)으로 확인했다 — 신규 세대
// (session.next.*) 이벤트를 쓴다 (Q1=G2 결정).
// 흐름: POST /api/session 으로 세션을 만들고, GET /api/session/{id}/event (SSE) 를
// 먼저 구독한 뒤 POST /api/session/{id}/prompt 로 프롬프트를 밀어 넣는다 — 순서가
// 바뀌면(구독 전에 prompt) 초반 이벤트를 놓친다.
// 텍스트는 session.next.text.ended 의 data.text 에 완성된 조각으로 온다(델타 아님).
// 턴 종료는 session.next.step.ended(finish !== 'tool-calls') 또는
// session.next.step.failed.
//
// 작업 디렉터리: 한 opencode 서버에서 세션마다 location.directory 를 준다 — 도구 cwd·시스템 프롬프트의 작업 디렉터리·
// 그 폴더의 AGENTS.md·opencode.json 이 전부 그 폴더 기준이 되고, 동시에 돌려도 안 섞인다 (2026-09-30 실측,
// _workspace/01_probe.md Q1).

declare module 'cordis' {
  interface Context {
    llm: LlmService
  }
}

export interface ChatResult {
  ok: boolean
  sessionId?: string
  text?: string
  error?: string
}

export interface LlmServiceOptions {
  opencodeUrl: string
}

interface OpencodeEventEnvelope {
  type: string
  durable?: { seq?: number }
  data: Record<string, unknown>
}

export const MODEL_CATALOG_TIMEOUT_MS = 10_000

export class LlmService extends Service {
  static readonly inject = ['providers']

  constructor(
    ctx: Context,
    private opts: LlmServiceOptions,
  ) {
    super(ctx, 'llm')
  }

  // model 을 꼭 명시한다 — {} 로 보내면 opencode 가 opencode.json 의 model 을 무시하고 models.dev 카탈로그의
  // 외부 provider(실측: nano-gpt/...)로 세션을 만들 때가 있다 (2026-09-30 실측, 5회 중 2~5회).
  // 우리 provider/모델 id 를 opencode 의 providerID/모델 id 로 그대로 쓴다 — 매핑 설정 화면이 생기면 이 자리만 바꾼다.
  private async createSession(providerId: string, modelId: string, directory: string): Promise<string> {
    const res = await fetch(`${this.opts.opencodeUrl}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: { providerID: providerId, id: modelId }, location: { directory } }),
    })
    if (!res.ok) throw new Error(`세션 생성 실패 (${res.status})`)
    const body = (await res.json()) as { data: { id: string } }
    return body.data.id
  }

  // 세션을 만들기 전에 opencode 모델 카탈로그에 그 모델이 있는지 본다. 두 가지 이유 (2026-09-30 실측):
  // - 카탈로그는 GET /api/model·/api/provider 가 처음 불릴 때에야 로드된다(지연 로드). 로드 전에 프롬프트가 오면
  //   opencode 는 로그에만 ModelUnavailableError("Failed to drain Session")를 남기고 턴을 버린다 — SSE 에는
  //   step.failed 도 없이 prompt.admitted·prompted 뒤로 아무것도 안 와서 턴이 영원히 멈춘다.
  //   빈도 (opencode 1.18.18): 준비 없이 첫 턴 5회 중 1회만 완료, /api/model·/api/provider 선호출 후 10회 중 10회 완료.
  //   목록은 세 단계로 바뀐다: 빈 목록(로드 시작, 첫 조회) → models.dev 원본 8306개(설정 provider 가 **없다**) →
  //   설정 반영 목록. "비어 있지 않음" 을 완료로 보면 가운데 목록에서 있는 모델도 없다고 판단한다 — 그래서
  //   **찾는 모델이 나올 때까지** 다시 묻는다. 이 머신에서 설정 반영까지 0.7~1.1초(5회 기동).
  // - 없는 providerID/모델이어도 세션 생성은 200 으로 성공하고 같은 식으로 멈춘다 — 기한까지 안 나오면 없다고 본다.
  //   기한은 실측 최대의 ~10배. 느린 머신의 콜드 스타트에서 있는 모델을 거절하는 쪽이 설정 오류를 늦게 알리는 쪽보다 나쁘다.
  // - 새 세션을 만들 때만 확인한다. 이어가는 턴에는 조회하지 않는다.
  // - 카탈로그는 디렉터리별이다(전역 설정 + 그 폴더의 opencode.json) — 세션을 만들 폴더의 카탈로그를 본다.
  private async waitForModel(providerId: string, modelId: string, directory: string): Promise<boolean> {
    const deadline = Date.now() + MODEL_CATALOG_TIMEOUT_MS
    while (true) {
      const models = await this.listModels(directory)
      if (models.some((model) => model.providerID === providerId && model.id === modelId)) return true
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  // 쿼리 이름은 `location[directory]` (deepObject). 틀린 이름(`?directory=`)이면 opencode 는 200 에 서버 cwd 의
  // 카탈로그를 조용히 준다 (2026-09-30 실측) — llm.live.test.ts 의 "폴더에만 있는 모델" 시나리오가 이것을 지킨다.
  private async listModels(directory: string): Promise<{ id: string; providerID: string }[]> {
    const query = new URLSearchParams({ 'location[directory]': directory })
    const res = await fetch(`${this.opts.opencodeUrl}/api/model?${query}`)
    if (!res.ok) throw new Error(`모델 목록 조회 실패 (${res.status})`)
    return ((await res.json()) as { data: { id: string; providerID: string }[] }).data
  }

  /** directory 는 새 세션의 작업 디렉터리(절대 경로). 이어가는 세션(sessionId)은 만들 때 정한 폴더·모델을 따른다
   *  (prompt 본문에는 model·location 필드가 없다). */
  async chat(providerId: string, modelId: string, directory: string, prompt: string, sessionId?: string): Promise<ChatResult> {
    const provider = this.ctx.providers.get(providerId)
    if (!provider) return { ok: false, error: `provider ${providerId} 없음` }

    try {
      let id = sessionId
      if (!id) {
        const workdir = await realDirectory(directory)
        if (!workdir) return { ok: false, error: `작업 디렉터리가 없다: ${directory}` }
        if (!(await this.waitForModel(providerId, modelId, workdir))) {
          return { ok: false, error: `opencode 에 모델 ${providerId}/${modelId} 없음` }
        }
        id = await this.createSession(providerId, modelId, workdir)
      }

      let admitted!: (seq: number) => void
      const events = this.subscribe(id, new Promise<number>((resolve) => (admitted = resolve)))
      const admit = await fetch(`${this.opts.opencodeUrl}/api/session/${id}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: { text: prompt } }),
      })
      if (!admit.ok) {
        events.stop()
        return { ok: false, sessionId: id, error: `프롬프트 전송 실패 (${admit.status})` }
      }
      admitted(((await admit.json()) as { data: { admittedSeq: number } }).data.admittedSeq)

      const result = await events.result
      return { ok: result.ok, sessionId: id, text: result.text, error: result.error }
    } catch (error) {
      return { ok: false, sessionId, error: `opencode 연결 실패: ${(error as Error).message}` }
    }
  }

  /** SSE 를 구독하고, 턴이 끝나면(성공/실패 모두) 풀리는 결과를 준다.
   *
   *  구독은 그 세션의 과거 이벤트를 seq 1 부터 재생한다 (2026-09-30 실측) — 거르지 않으면 이어가는 세션에서
   *  이전 턴의 step.ended 를 보고 이전 답을 돌려준다. `?after=<seq>` 로 자를 수 있지만 구독을 먼저 걸어야 해서
   *  그 시점엔 이번 턴의 seq 를 모른다. 그래서 프롬프트 응답의 admittedSeq(= 이번 턴 prompt.admitted 의 seq)가
   *  올 때까지 프레임 처리를 미루고, durable.seq 가 그 이하인 이벤트는 버린다. */
  private subscribe(sessionId: string, admittedSeq: Promise<number>): { result: Promise<{ ok: boolean; text: string; error?: string }>; stop: () => void } {
    const controller = new AbortController()
    const result = (async () => {
      const res = await fetch(`${this.opts.opencodeUrl}/api/session/${sessionId}/event`, {
        signal: controller.signal,
      })
      if (!res.ok || !res.body) throw new Error(`이벤트 구독 실패 (${res.status})`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const texts: string[] = []

      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) return { ok: false, text: texts.join(''), error: '이벤트 스트림이 조용히 끊김' }
          buffer += decoder.decode(value, { stream: true })

          let frameEnd: number
          while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, frameEnd)
            buffer = buffer.slice(frameEnd + 2)
            const outcome = this.handleFrame(frame, texts, await admittedSeq)
            if (outcome) return outcome
          }
        }
      } finally {
        void reader.cancel().catch(() => {})
      }
    })()

    return { result, stop: () => controller.abort() }
  }

  private handleFrame(frame: string, texts: string[], admittedSeq: number): { ok: boolean; text: string; error?: string } | undefined {
    const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
    if (!dataLine) return undefined

    let event: OpencodeEventEnvelope
    try {
      event = JSON.parse(dataLine.slice('data: '.length)) as OpencodeEventEnvelope
    } catch {
      return undefined
    }
    if ((event.durable?.seq ?? Infinity) <= admittedSeq) return undefined // 이전 턴의 재생분

    if (event.type === 'session.next.text.ended') {
      const text = event.data['text']
      if (typeof text === 'string') texts.push(text)
      return undefined
    }
    if (event.type === 'session.next.step.ended') {
      if (event.data['finish'] === 'tool-calls') return undefined // 다음 스텝이 이어진다
      return { ok: true, text: texts.join('') }
    }
    if (event.type === 'session.next.step.failed') {
      const error = event.data['error'] as { message?: string } | undefined
      return { ok: false, text: texts.join(''), error: error?.message ?? '알 수 없는 오류' }
    }
    return undefined
  }
}

/** 폴더면 realpath 를, 아니면(없는 경로·파일·상대 경로) undefined 를 준다.
 *  opencode 는 없는 경로로도 세션을 200 으로 만들지만 그 세션은 모든 요청이 500 이고, 그 경로는 서버 재시작 전까지
 *  계속 500 이다 (폴더를 나중에 만들어도) — 사용자 opencode 를 오염시키므로 opencode 에 닿기 전에 거른다.
 *  realpath 인 이유: opencode 는 경로를 문자열 그대로 저장·비교한다 (2026-09-30 실측, 01_probe Q3). */
async function realDirectory(directory: string): Promise<string | undefined> {
  if (!path.isAbsolute(directory)) return undefined
  try {
    const real = await fs.realpath(directory)
    return (await fs.stat(real)).isDirectory() ? real : undefined
  } catch {
    return undefined
  }
}
