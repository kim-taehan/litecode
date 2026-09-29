import { Context, Service } from 'cordis'
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
  data: Record<string, unknown>
}

export class LlmService extends Service {
  static readonly inject = ['providers']

  constructor(
    ctx: Context,
    private opts: LlmServiceOptions,
  ) {
    super(ctx, 'llm')
  }

  private async createSession(): Promise<string> {
    const res = await fetch(`${this.opts.opencodeUrl}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    if (!res.ok) throw new Error(`세션 생성 실패 (${res.status})`)
    const body = (await res.json()) as { data: { id: string } }
    return body.data.id
  }

  async chat(providerId: string, modelId: string, prompt: string, sessionId?: string): Promise<ChatResult> {
    const provider = this.ctx.providers.get(providerId)
    if (!provider) return { ok: false, error: `provider ${providerId} 없음` }
    void modelId // TODO: 우리 provider/모델 id 를 opencode 자체 provider id 로 매핑하는 설정 화면이 생기면 여기서 쓴다.
    // 지금은 opencode 자신의 기본 provider/모델(opencode.json)을 그대로 쓴다.

    try {
      const id = sessionId ?? (await this.createSession())

      const events = this.subscribe(id)
      const admit = await fetch(`${this.opts.opencodeUrl}/api/session/${id}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: { text: prompt } }),
      })
      if (!admit.ok) {
        events.stop()
        return { ok: false, sessionId: id, error: `프롬프트 전송 실패 (${admit.status})` }
      }

      const result = await events.result
      return { ok: result.ok, sessionId: id, text: result.text, error: result.error }
    } catch (error) {
      return { ok: false, sessionId, error: `opencode 연결 실패: ${(error as Error).message}` }
    }
  }

  /** SSE 를 구독하고, 턴이 끝나면(성공/실패 모두) 풀리는 결과를 준다. */
  private subscribe(sessionId: string): { result: Promise<{ ok: boolean; text: string; error?: string }>; stop: () => void } {
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
            const outcome = this.handleFrame(frame, texts)
            if (outcome) return outcome
          }
        }
      } finally {
        void reader.cancel().catch(() => {})
      }
    })()

    return { result, stop: () => controller.abort() }
  }

  private handleFrame(frame: string, texts: string[]): { ok: boolean; text: string; error?: string } | undefined {
    const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
    if (!dataLine) return undefined

    let event: OpencodeEventEnvelope
    try {
      event = JSON.parse(dataLine.slice('data: '.length)) as OpencodeEventEnvelope
    } catch {
      return undefined
    }

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
