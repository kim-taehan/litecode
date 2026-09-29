import { Context, Service } from 'cordis'

// 모델 provider 설정 — dsh 의 Settings > Models 화면과 같은 모양을 따른다.
// baseURL 을 직접 지정할 수 있어야 폐쇄망 내부 게이트웨이(LiteLLM 등)를 붙일 수 있다.

export interface ModelCatalogEntry {
  id: string
  displayName: string
}

export interface ProviderConfig {
  id: string
  displayName: string
  baseURL: string
  protocol: 'openai-chat-completions'
  models: ModelCatalogEntry[]
}

declare module 'cordis' {
  interface Context {
    providers: ProviderRegistry
  }
}

export class ProviderRegistry extends Service {
  private list = new Map<string, ProviderConfig>()

  constructor(ctx: Context) {
    super(ctx, 'providers')
  }

  /** 되돌릴 수 있는 등록 — 호출부가 반환값을 불러 해제한다 (Cordis effect 원칙) */
  register(config: ProviderConfig): () => void {
    this.list.set(config.id, config)
    return () => this.list.delete(config.id)
  }

  get(id: string): ProviderConfig | undefined {
    return this.list.get(id)
  }

  all(): ProviderConfig[] {
    return [...this.list.values()]
  }

  /** dsh 화면의 "Fetch available models" 에 해당. 지금은 등록된 카탈로그를 그대로 준다 —
   *  실제 조회(opencode GET /provider 등)는 이 자리를 나중에 채운다. */
  async fetchAvailableModels(id: string): Promise<ModelCatalogEntry[]> {
    const provider = this.get(id)
    if (!provider) throw new Error(`unknown provider: ${id}`)
    return provider.models
  }
}
