// 화면이 기대는 것 전부 — 리듀서 상태(core/state.ts)·연결 상태·명령 몇 개. 화면은 이 인터페이스만 안다.
// 지금 구현은 견본(demo/demoSession.ts) 하나다. 진짜 연결은 `Connection`(core/connection.ts)을 이 모양으로 감싸 꽂는다:
// getState/getStatus/subscribe 는 Connection 의 것 그대로, 명령은 connection.client 의 send·stop·takeQueue·reply·createConversation.

import type { Attention, AttentionAnswer } from '../../../shared/contract.ts'
import type { RemoteModel } from '../../../shared/remote.ts'
import type { ConnectionStatus, RemoteState } from '../core/index.ts'

/** 설정 화면 "연결된 데스크탑" 카드에 보일 것 */
export interface DesktopInfo {
  name: string
  /** `ip:port` */
  address: string
  /** 인증서 지문 앞부분 */
  fingerprint: string
}

export interface AppSession {
  getState(): RemoteState
  getStatus(): ConnectionStatus
  /** state·status 가 바뀔 때마다 부른다 */
  subscribe(listener: () => void): () => void
  readonly desktop: DesktopInfo
  readonly models: readonly RemoteModel[]
  /** 턴이 도는 중이면 데스크탑이 대기열에 넣는다 */
  send(cid: string, text: string): void
  stop(cid: string): void
  /** 대기열 되돌리기 — 합친 글 (입력창에 넣는다) */
  takeQueue(cid: string): Promise<string>
  reply(request: Attention, answer: AttentionAnswer): void
  /** 새 대화를 만들고 그 id 를 준다 (열어 둔 상태로) */
  createConversation(project: string): Promise<string>
  /** 타이머·연결을 거둔다 */
  dispose(): void
}
