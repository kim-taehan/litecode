import { Context, Service } from 'cordis'
import './providers.ts'

// opencode 를 감싸는 서비스 — 위층(세션·UI)은 이 ctx.llm 키만 알고 opencode 를 직접 모른다.
// 나중에 엔진을 바꾸더라도 이 서비스만 교체하면 된다 (Cordis: 서비스는 키로 찾는다).

declare module 'cordis' {
  interface Context {
    llm: LlmService
  }
}

export interface ChatResult {
  ok: boolean
  text?: string
  error?: string
}

export interface LlmServiceOptions {
  opencodeUrl: string
}

export class LlmService extends Service {
  static readonly inject = ['providers']

  constructor(
    ctx: Context,
    private opts: LlmServiceOptions,
  ) {
    super(ctx, 'llm')
  }

  async chat(providerId: string, modelId: string, prompt: string): Promise<ChatResult> {
    const provider = this.ctx.providers.get(providerId)
    if (!provider) return { ok: false, error: `provider ${providerId} 없음` }

    // TODO: opencode 의 실제 세션/챗 API(POST /session, SSE 구독)로 교체한다.
    // 지금은 배선 확인용으로 /doc 헬스체크만 한다.
    try {
      const res = await fetch(`${this.opts.opencodeUrl}/doc`, { signal: AbortSignal.timeout(1500) })
      return {
        ok: res.ok,
        text: `[${provider.displayName}/${modelId}] opencode 응답 코드=${res.status}, prompt="${prompt}"`,
      }
    } catch (error) {
      return { ok: false, error: `opencode 연결 실패: ${(error as Error).message}` }
    }
  }
}
