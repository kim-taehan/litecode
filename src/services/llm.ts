import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import path from 'node:path'
import { normalizeBaseURL } from './providers.ts'
import type { EngineConnection } from './engine.ts'
import { messageTokens, TurnMeter, type TurnUsage } from './turnUsage.ts'
import './engine.ts'

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
// opencode 서버는 ctx.engine 이 띄우고 관리한다 — 여기서는 주소·인증(connection())만 받아 모든 요청에 싣는다.
// 서버가 재시작·크래시로 끝나면 진행 중 턴은 끝 이벤트 없이 사라진다(01_probe Q3) → connection().closed 를 보고 "중단됨" 으로 끝낸다.
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
  /** 이 턴의 사용량·시간 (중립 모양 — turnUsage.ts). 끝난 스텝이 없으면 없다 */
  usage?: TurnUsage
}

/** 지난 대화의 말풍선 하나 (중립 모양 — 화면은 opencode 메시지 형식을 모른다). assistant 의 error 는 실패·중단 사유 */
export interface HistoryMessage {
  role: 'user' | 'assistant'
  text: string
  error?: string
}

export interface History {
  messages: HistoryMessage[]
  /** 작업 폴더가 없어 opencode 에 묻지 않았다 */
  missingFolder?: boolean
  /** 불러오지 못한 사유 */
  error?: string
}

/** GET /api/session/{id}/message 의 메시지 중 우리가 읽는 필드 (01c Q2 실측) */
interface OpencodeMessage {
  type: string
  text?: string
  time?: { created?: number; completed?: number }
  content?: { type: string; text?: string }[]
  error?: { message?: string }
}

// /message 의 limit 상한은 200 이다 — 넘기면 400 InvalidRequestError, 안 주면 50 (2026-10-01 실측, opencode 1.18.18, 메시지 260개 세션).
// 상한보다 낮게 잡고 cursor 로 끝까지 넘긴다
const MESSAGE_PAGE = 100

interface TurnOutcome {
  ok: boolean
  text: string
  error?: string
  usage?: TurnUsage
}

interface OpencodeEventEnvelope {
  type: string
  durable?: { seq?: number }
  data: Record<string, unknown>
}

interface CatalogModel {
  id: string
  providerID: string
  api?: { url?: string }
}

export const MODEL_CATALOG_TIMEOUT_MS = 10_000
export const INTERRUPTED = '중단됨 — 엔진(opencode)이 재시작되거나 끝나서 답을 끝까지 받지 못했습니다. 다시 보내 주세요'

export class LlmService extends Service {
  static readonly inject = ['providers', 'engine']

  /** 답을 기다리는 턴 수 — DB 정리는 0 일 때만 돈다 (정리 잠금이 길면 그 사이 opencode 쓰기가 실패한다, 01_probe) */
  private turns = 0
  private purgeWanted = false

  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  // model 을 꼭 명시한다 — {} 로 보내면 opencode 가 opencode.json 의 model 을 무시하고 models.dev 카탈로그의
  // 외부 provider(실측: nano-gpt/...)로 세션을 만들 때가 있다 (2026-09-30 실측, 5회 중 2~5회).
  // 우리 provider/모델 id 를 opencode 의 providerID/모델 id 로 그대로 쓴다 — 매핑 설정 화면이 생기면 이 자리만 바꾼다.
  private async createSession(conn: EngineConnection, providerId: string, modelId: string, directory: string): Promise<string> {
    const res = await fetch(`${conn.url}/api/session`, {
      method: 'POST',
      headers: { ...conn.headers, 'content-type': 'application/json' },
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
  // - 이어가는 턴도 매번 확인한다 (리더 결정 2026-09-30): 설정 적용으로 opencode 가 재시작되면 카탈로그가 다시 지연 로드되고,
  //   폴더 opencode.json 도 다시 읽혀 주소가 바뀌었을 수 있다 (아래 주소 대조).
  // - 카탈로그는 디렉터리별이다(전역 설정 + 그 폴더의 opencode.json) — 세션을 만들 폴더의 카탈로그를 본다.
  private async waitForModel(conn: EngineConnection, providerId: string, modelId: string, directory: string): Promise<CatalogModel | undefined> {
    const deadline = Date.now() + MODEL_CATALOG_TIMEOUT_MS
    while (true) {
      const models = await this.listModels(conn, directory)
      const found = models.find((model) => model.providerID === providerId && model.id === modelId)
      if (found) return found
      if (Date.now() >= deadline) return undefined
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  // 쿼리 이름은 `location[directory]` (deepObject). 틀린 이름(`?directory=`)이면 opencode 는 200 에 서버 cwd 의
  // 카탈로그를 조용히 준다 (2026-09-30 실측) — llm.live.test.ts 의 "폴더에만 있는 모델" 시나리오가 이것을 지킨다.
  private async listModels(conn: EngineConnection, directory: string): Promise<CatalogModel[]> {
    const query = new URLSearchParams({ 'location[directory]': directory })
    const res = await fetch(`${conn.url}/api/model?${query}`, { headers: conn.headers })
    if (!res.ok) throw new Error(`모델 목록 조회 실패 (${res.status})`)
    return ((await res.json()) as { data: CatalogModel[] }).data
  }

  // 이어가는 세션의 모델 바꾸기 — prompt 본문엔 model 이 없고(additionalProperties:false), 이 호출(204)이 다음 턴부터 바꾼다.
  // 앞 턴 맥락은 그대로 실린다 (2026-10-01 실측 5/5, _workspace/01_probe.md). 세션의 지금 모델은 GET 으로 본다 — SSE 의
  // model.switched 가 이전 턴 step.started 보다 먼저 올 수 있어 이벤트 순서로 추론하지 않는다.
  // opencode 는 모델이 있는지 검증하지 않는다(없어도 204, 다음 턴이 step.* 없이 매달린다) — 그래서 chat 이 모델·주소 확인을
  // 통과한 뒤에만 부른다.
  private async useModel(conn: EngineConnection, sessionId: string, providerId: string, modelId: string): Promise<void> {
    const res = await fetch(`${conn.url}/api/session/${sessionId}`, { headers: conn.headers })
    if (!res.ok) throw new Error(`세션 조회 실패 (${res.status})`)
    const current = ((await res.json()) as { data: { model?: { providerID?: string; id?: string } } }).data.model
    if (current?.providerID === providerId && current.id === modelId) return
    const switched = await fetch(`${conn.url}/api/session/${sessionId}/model`, {
      method: 'POST',
      headers: { ...conn.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ model: { providerID: providerId, id: modelId } }),
    })
    if (!switched.ok) throw new Error(`모델 바꾸기 실패 (${switched.status})`)
  }

  /** directory 는 새 세션의 작업 디렉터리(절대 경로). 이어가는 세션(sessionId)은 만들 때 정한 폴더를 따르고, 모델이 다르면
   *  보내기 전에 그 세션의 모델을 바꾼다 — 이어갈 때도 그 세션의 폴더를 넘긴다(모델·주소 확인에 쓴다).
   *  onSession 은 새 세션을 만든 직후, 프롬프트를 보내기 전에 불린다 — 답을 기다리는 중에 앱이 꺼져도 그 대화를 다시 열 수 있게 */
  async chat(
    providerId: string,
    modelId: string,
    directory: string,
    prompt: string,
    sessionId?: string,
    onSession?: (sessionId: string) => Promise<void>,
  ): Promise<ChatResult> {
    this.turns++
    try {
      return await this.turn(providerId, modelId, directory, prompt, sessionId, onSession)
    } finally {
      this.turns--
      this.purgeIfIdle()
    }
  }

  private async turn(
    providerId: string,
    modelId: string,
    directory: string,
    prompt: string,
    sessionId?: string,
    onSession?: (sessionId: string) => Promise<void>,
  ): Promise<ChatResult> {
    const provider = this.ctx.providers.get(providerId)
    if (!provider) return { ok: false, error: `provider ${providerId} 없음` }

    let conn: EngineConnection | undefined
    let id = sessionId
    try {
      conn = await this.ctx.engine.connection()
      // 매 턴 보내기 전에 그 폴더 카탈로그로 모델·주소를 본다 — 이어가는 세션도 directory(그 대화의 프로젝트)로 본다
      const workdir = await realDirectory(directory)
      if (!workdir) return { ok: false, sessionId: id, error: `작업 디렉터리가 없다: ${directory}` }
      const model = await this.waitForModel(conn, providerId, modelId, workdir)
      if (!model) return { ok: false, sessionId: id, error: `opencode 에 모델 ${providerId}/${modelId} 없음` }
      // 세션 폴더의 opencode.json 은 우리 provider 의 baseURL 까지 덮는다 — 그러면 프롬프트(와 프록시 토큰)가 그 주소로 간다.
      // OPENCODE_DISABLE_PROJECT_CONFIG 로는 못 막는다 — 대신 그 폴더 카탈로그의 api.url 에 덮인 주소가 보인다 (01_probe Q4, 5/5).
      // 우리가 적은 주소는 키 프록시 주소다 (engine.ts)
      if (normalizeBaseURL(model.api?.url ?? '') !== normalizeBaseURL(conn.providerBaseURL(providerId))) {
        return { ok: false, sessionId: id, error: `이 프로젝트의 opencode.json 이 provider 주소를 바꿉니다 (${model.api?.url}) — 대화 내용이 그 주소로 갈 수 있어 보내지 않았습니다` }
      }
      if (id) await this.useModel(conn, id, providerId, modelId)
      else {
        id = await this.createSession(conn, providerId, modelId, workdir)
        await onSession?.(id)
      }

      let admitted!: (seq: number) => void
      const events = this.subscribe(conn, id, new Promise<number>((resolve) => (admitted = resolve)))
      const admit = await fetch(`${conn.url}/api/session/${id}/prompt`, {
        method: 'POST',
        headers: { ...conn.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: { text: prompt } }),
      }).catch((error: unknown) => {
        events.stop()
        throw error
      })
      if (!admit.ok) {
        events.stop()
        return { ok: false, sessionId: id, error: `프롬프트 전송 실패 (${admit.status})` }
      }
      admitted(((await admit.json()) as { data: { admittedSeq: number } }).data.admittedSeq)

      const result = await events.result
      const usage = result.usage && { ...result.usage, messageTokens: await this.messageTokens(conn, id) }
      return { ok: result.ok, sessionId: id, text: result.text, error: result.error, usage }
    } catch (error) {
      if (conn?.closed.aborted) return { ok: false, sessionId: id, error: INTERRUPTED }
      return { ok: false, sessionId: id, error: `opencode 연결 실패: ${(error as Error).message}` }
    }
  }

  /** 지난 대화의 말풍선. directory 는 그 세션의 작업 폴더 — 없으면 opencode 에 묻지 않는다: 폴더가 없어진 세션은 내용 요청이
   *  500 이고, 한 번 실패한 경로는 폴더를 되살려도 opencode 를 재시작할 때까지 계속 500 이다 (01c Q5). 재시작 뒤에도 내용은
   *  그대로 온다(01c Q2) — 이벤트 재생 대신 조립된 메시지 목록을 쓴다 */
  async history(directory: string, sessionId: string): Promise<History> {
    if (!(await realDirectory(directory))) return { messages: [], missingFolder: true }
    try {
      const conn = await this.ctx.engine.connection()
      const raw = await this.readMessages(conn, sessionId)
      const active = await fetch(`${conn.url}/api/session/active`, { headers: conn.headers })
      if (!active.ok) throw new Error(`진행 중 세션 조회 실패 (${active.status})`)
      const running = sessionId in ((await active.json()) as { data: Record<string, unknown> }).data
      return { messages: historyMessages(raw, running) }
    } catch (error) {
      return { messages: [], error: `대화를 불러오지 못했습니다: ${(error as Error).message}` }
    }
  }

  /** 세션의 메시지 전부 (asc). 읽기만 한다 — 화면별 모양 변환(historyMessages 등)은 따로 둔다: 같은 응답을 다른 모양으로 쓸 화면이 있다.
   *  cursor 는 order 와 같이 못 준다(/doc). 마지막 쪽에도 cursor.next 가 오므로 받은 개수 < limit 이거나 빈 쪽이면 끝이다 (01c Q1) */
  private async readMessages(conn: EngineConnection, sessionId: string): Promise<OpencodeMessage[]> {
    const messages: OpencodeMessage[] = []
    let query = `order=asc&limit=${MESSAGE_PAGE}`
    while (true) {
      const res = await fetch(`${conn.url}/api/session/${sessionId}/message?${query}`, { headers: conn.headers })
      if (!res.ok) throw new Error(`메시지 조회 실패 (${res.status})`)
      const page = (await res.json()) as { data: OpencodeMessage[]; cursor?: { next?: string | null } }
      messages.push(...page.data)
      if (page.data.length < MESSAGE_PAGE || !page.cursor?.next) return messages
      query = new URLSearchParams({ cursor: page.cursor.next, limit: String(MESSAGE_PAGE) }).toString()
    }
  }

  /** 지운 대화의 본문을 DB 파일에서 걷어낸다 (ctx.engine.purgeDeleted). 답을 기다리는 턴이 있으면 다 끝난 뒤로 미룬다 */
  purgeDeleted(): void {
    this.purgeWanted = true
    this.purgeIfIdle()
  }

  private purgeIfIdle(): void {
    if (this.turns > 0 || !this.purgeWanted) return
    this.purgeWanted = false
    void this.ctx.engine.purgeDeleted()
  }

  /** 세션을 지운다. 신규 세대(/api/*)에는 세션 삭제가 없어 **레거시 `DELETE /session/{id}` 를 쓰는 유일한 자리**다 (01c Q3).
   *  레거시 호출이라 CONFIG_DIR 에 npm 설치를 한 번 일으킨다 — 폐쇄망에선 조용히 실패하고 기능 영향은 없다 (01b).
   *  이미 없는 세션(404)은 지워진 것으로 본다. 지운 본문은 DB 의 WAL 에 남는다 (01c Q3) */
  async deleteSession(sessionId: string): Promise<void> {
    const conn = await this.ctx.engine.connection()
    const res = await fetch(`${conn.url}/session/${sessionId}`, { method: 'DELETE', headers: conn.headers })
    if (!res.ok && res.status !== 404) throw new Error(`세션 삭제 실패 (${res.status})`)
  }

  /** 컨텍스트 중 대화 메시지 몫 (추정). 통계용이라 못 구해도 턴은 그대로 돌려준다 */
  private async messageTokens(conn: EngineConnection, sessionId: string): Promise<number | undefined> {
    try {
      const res = await fetch(`${conn.url}/api/session/${sessionId}/context`, { headers: conn.headers })
      return res.ok ? messageTokens(((await res.json()) as { data: Parameters<typeof messageTokens>[0] }).data) : undefined
    } catch {
      return undefined
    }
  }

  /** SSE 를 구독하고, 턴이 끝나면(성공/실패 모두) 풀리는 결과를 준다.
   *
   *  구독은 그 세션의 과거 이벤트를 seq 1 부터 재생한다 (2026-09-30 실측) — 거르지 않으면 이어가는 세션에서
   *  이전 턴의 step.ended 를 보고 이전 답을 돌려준다. `?after=<seq>` 로 자를 수 있지만 구독을 먼저 걸어야 해서
   *  그 시점엔 이번 턴의 seq 를 모른다. 그래서 프롬프트 응답의 admittedSeq(= 이번 턴 prompt.admitted 의 seq)가
   *  올 때까지 프레임 처리를 미루고, durable.seq 가 그 이하인 이벤트는 버린다. */
  private subscribe(
    conn: EngineConnection,
    sessionId: string,
    admittedSeq: Promise<number>,
  ): { result: Promise<TurnOutcome>; stop: () => void } {
    const controller = new AbortController()
    const result = (async () => {
      const res = await fetch(`${conn.url}/api/session/${sessionId}/event`, {
        headers: conn.headers,
        signal: AbortSignal.any([controller.signal, conn.closed]), // 서버가 끝나면 읽기를 바로 멈춘다
      })
      if (!res.ok || !res.body) throw new Error(`이벤트 구독 실패 (${res.status})`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const texts: string[] = []
      const meter = new TurnMeter()

      try {
        while (true) {
          const read = await reader.read().catch((error: unknown) => {
            if (controller.signal.aborted) throw error // 우리가 멈췄다 (stop)
            return undefined // 연결이 잘렸다 (undici: "terminated")
          })
          if (!read || read.done) return { ok: false, text: texts.join(''), error: await interruption(conn.closed), usage: meter.usage() }
          const { value } = read
          buffer += decoder.decode(value, { stream: true })

          let frameEnd: number
          while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, frameEnd)
            buffer = buffer.slice(frameEnd + 2)
            const outcome = this.handleFrame(frame, texts, meter, await admittedSeq)
            if (outcome) return outcome
          }
        }
      } finally {
        void reader.cancel().catch(() => {})
      }
    })()
    result.catch(() => {}) // stop() 뒤의 거절은 기다리는 쪽이 없다 — 처리 안 된 거절로 남기지 않는다

    return { result, stop: () => controller.abort() }
  }

  private handleFrame(frame: string, texts: string[], meter: TurnMeter, admittedSeq: number): TurnOutcome | undefined {
    const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
    if (!dataLine) return undefined

    let event: OpencodeEventEnvelope
    try {
      event = JSON.parse(dataLine.slice('data: '.length)) as OpencodeEventEnvelope
    } catch {
      return undefined
    }
    if ((event.durable?.seq ?? Infinity) <= admittedSeq) return undefined // 이전 턴의 재생분
    meter.observe(event.type, event.data)

    if (event.type === 'session.next.text.ended') {
      const text = event.data['text']
      if (typeof text === 'string') texts.push(text)
      return undefined
    }
    if (event.type === 'session.next.step.ended') {
      if (event.data['finish'] === 'tool-calls') return undefined // 다음 스텝이 이어진다
      return { ok: true, text: texts.join(''), usage: meter.usage() }
    }
    if (event.type === 'session.next.step.failed') {
      const error = event.data['error'] as { message?: string } | undefined
      return { ok: false, text: texts.join(''), error: error?.message ?? '알 수 없는 오류', usage: meter.usage() }
    }
    return undefined
  }
}

/** opencode 메시지(asc) → 말풍선. 도구 턴의 assistant 여럿은 한 답으로 합치고 텍스트만 쓴다 — 실시간 턴이 text.ended 만
 *  모으는 것과 같은 모양. 끊긴 턴(01c Q6): 그 세션이 돌고 있지 않은데 마지막이 답 없는 user 이거나 완료 시각 없는 assistant 면
 *  끝에 "중단됨" 을 단다 (재시작 뒤 opencode 는 그 턴을 다시 돌리지 않는다) */
export function historyMessages(raw: OpencodeMessage[], running: boolean): HistoryMessage[] {
  const messages: HistoryMessage[] = []
  for (const message of raw) {
    if (message.type === 'user') {
      messages.push({ role: 'user', text: message.text ?? '' })
      continue
    }
    if (message.type !== 'assistant') continue // 모델 바꿈·시스템·압축 등은 말풍선이 아니다
    const previous = messages.at(-1)
    const reply: HistoryMessage = previous?.role === 'assistant' ? previous : { role: 'assistant', text: '' }
    if (reply !== previous) messages.push(reply)
    reply.text += (message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('')
    if (message.error) reply.error = message.error.message ?? '알 수 없는 오류'
  }

  const last = raw.filter((message) => message.type === 'user' || message.type === 'assistant').at(-1)
  if (!running && last && (last.type === 'user' || !last.time?.completed)) {
    const reply = messages.at(-1)
    if (reply?.role === 'assistant') reply.error = INTERRUPTED
    else messages.push({ role: 'assistant', text: '', error: INTERRUPTED })
  }
  return messages
}

/** 끝 이벤트 없이 스트림이 끊겼을 때의 사유. 서버가 끝나면 소켓이 exit 보다 먼저 닫혀(실측 2026-09-30, 앱 실물 테스트에서
 *  "terminated" 가 먼저 왔다) closed 가 아직 안 걸렸을 수 있다 — 잠깐 기다려 원인을 가린다. 어느 쪽이든 턴은 "중단됨" 이다 */
async function interruption(closed: AbortSignal): Promise<string> {
  if (!closed.aborted) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000)
      closed.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
    })
  }
  return closed.aborted ? INTERRUPTED : '중단됨 — 이벤트 스트림이 끊겼습니다. 다시 보내 주세요'
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
