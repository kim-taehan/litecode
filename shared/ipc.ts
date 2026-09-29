// 렌더러 ↔ 메인 IPC 계약. 채널 이름과 페이로드 모양을 한 곳에 둔다.
// 타입은 서비스 쪽 정의를 그대로 재수출한다 — 같은 모양을 두 곳에 베끼지 않는다.

import type { ProviderConfig } from '../src/services/providers.ts'
import type { ChatResult } from '../src/services/llm.ts'

export type { ProviderConfig, ModelCatalogEntry } from '../src/services/providers.ts'
export type { ChatResult } from '../src/services/llm.ts'

export const Channel = {
  LIST_PROVIDERS: 'providers:list',
  SEND_MESSAGE: 'chat:send',
} as const

export interface LitecodeBridge {
  listProviders(): Promise<ProviderConfig[]>
  /** sessionId 를 안 주면 opencode 세션을 새로 만든다 — 결과의 sessionId 를 다음 호출에 넘긴다 */
  sendMessage(providerId: string, modelId: string, prompt: string, sessionId?: string): Promise<ChatResult>
}

declare global {
  interface Window {
    litecode: LitecodeBridge
  }
}
