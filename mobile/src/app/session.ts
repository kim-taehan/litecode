// 화면이 기대는 것 전부 — 리듀서 상태(core/state.ts)·연결 상태·명령 몇 개. 화면은 이 인터페이스만 안다.
// 구현은 remoteSession.ts 하나다: `Connection`(core/connection.ts)을 이 모양으로 감싼다 — 대화의 정본은 데스크탑이고 앱은 붙은 화면이다.
// (테스트에는 네트워크 없이 리듀서에 이벤트를 흘리는 견본 구현이 하나 더 있다 — mobile/tests/demoSession.ts.)

import type { Attention, AttentionAnswer } from '../../../shared/contract.ts'
import type { RemoteEvent, RemoteModel } from '../../../shared/remote.ts'
import type { ConnectionStatus, RemoteState } from '../core/index.ts'

/** 설정 화면 "연결된 데스크탑" 카드에 보일 것 */
export interface DesktopInfo {
  name: string
  /** `ip:port` */
  address: string
  /** 인증서 지문 앞부분 — 평문 연결(이 컴퓨터 안)이면 없다 */
  fingerprint?: string
}

/**
 * 대화 화면에 잠깐 보일 안내.
 * desktop-only: 전체 권한 모드 대화라 폰에서 못 보낸다 · answer-desktop-only: 전체 권한 모드 대화의 승인·질문은 폰에서 못 답한다 · send-failed: 보내지 못했다 · elsewhere: 승인·질문을 다른 기기가 먼저 답했다 ·
 * failed: 그 밖의 명령(중지·되돌리기·새 대화)이 실패했다
 */
export type SessionNotice = 'desktop-only' | 'answer-desktop-only' | 'send-failed' | 'elsewhere' | 'failed'

/** 데스크탑에 붙는 길 — 사용자가 고른 것만 쓴다. 자동으로 다른 길로 넘어가지 않는다 (사용자 2026-10-07 "선택할 수 있게") */
export type Carrier = 'wifi' | 'bluetooth'

export interface AppSession {
  getState(): RemoteState
  getStatus(): ConnectionStatus
  getNotice(): SessionNotice | undefined
  /** state·status·notice 가 바뀔 때마다 부른다 */
  subscribe(listener: () => void): () => void
  /** 데스크탑이 낸 이벤트를 한 번씩 듣는다 — 알림(alerts.ts)이 쓴다. 열어 두지 않은 대화의 것도 온다 */
  onEvent(listener: (event: RemoteEvent) => void): () => void
  readonly desktop: DesktopInfo
  readonly models: readonly RemoteModel[]
  /** 이 세션이 쓰는 길 — 길을 바꾸면 세션을 새로 만든다 (link.ts chooseCarrier) */
  readonly carrier: Carrier
  /** 이 세션이 한 번이라도 붙었나 — 아직이면 앱은 연결 화면(수단 고르기·안 될 때)을 보인다 */
  hasConnected(): boolean
  /** 마지막으로 붙지 못한 까닭(운반이 던진 것) — 붙어 있으면 undefined (view.ts gateView 가 문구로) */
  getFailure(): unknown
  /** 링크로 받은 바이트 누계 — 블루투스만 센다(Wi-Fi 는 0). 긴 대화를 받는 진행 표시 */
  receivedBytes(): number
  /** [다시 시도] — 기다리던 재연결이나 사람을 기다리며 멈춘 연결(needs-action)을 지금 */
  retry(): void
  /** 대화를 받아 두고 이벤트를 따라가게 한다 (대화 화면에 들어갈 때). 나갈 때 close */
  openConversation(cid: string): void
  closeConversation(cid: string): void
  /** 턴이 도는 중이면 데스크탑이 대기열에 넣는다. 받아들여졌으면 true — false 면 안내(notice)가 서고 화면은 친 글을 돌려놓는다 */
  send(cid: string, text: string): Promise<boolean>
  stop(cid: string): void
  /** 대기열 되돌리기 — 합친 글 (입력창에 넣는다) */
  takeQueue(cid: string): Promise<string>
  reply(request: Attention, answer: AttentionAnswer): void
  /** 새 대화를 만들고 그 id 를 준다 (열어 둔 상태로). 못 만들면 undefined */
  createConversation(project: string): Promise<string | undefined>
  clearNotice(): void
  /** 앱이 앞으로 돌아왔다 — 기다리던 재연결을 지금 한다 */
  wake(): void
  /** 타이머·연결을 거둔다 */
  dispose(): void
}
