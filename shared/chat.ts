// 대화 한 건의 "턴 소유" 계약 (ctx.chat, 이슈 #52) — 메인이 대화별 대기열·도는 턴을 쥐고, 화면(데스크탑 창·나중에 모바일)은 손님으로
// 보내기를 부탁하고 이벤트를 받아 그린다. 타입 + 순수 함수뿐이다 (Node·Electron·React 를 모른다).
//
// 이벤트 이름·data 는 shared/remote.ts 의 RemoteEventMap 과 같은 모양이다 — 나중에 ctx.remote 가 그대로 내보낸다.
// 데스크탑 화면에만 필요한 것(목록 정보 conversation, 대기열의 held·attachments, 지운 대화 removed)은 **덧붙인 필드**로만 싣는다.

import type { Attachment, Attention, Conversation, HistoryMessage, MessageOrigin, PickedAttachment, TurnItem, TurnUsage } from './contract.ts'
import type { Mode } from './modes.ts'

/** 누가 보냈나 — 사람('user'), 다른 대화가 보낸 지시 `session:<보낸 대화 id>` (이슈 #55),
 *  짝지은 폰이 보낸 것 `device:<기기 id>` (ctx.remote, 이슈 #56) */
export type ChatOrigin = 'user' | `session:${string}` | `device:${string}`

export interface ChatModel {
  providerId: string
  modelId: string
}

/** 보내기 한 건 — 대기열에도 이 모양 그대로 쌓인다 */
export interface QueuedSend {
  /** 엔진에 보낼 본문 */
  text: string
  /** 말풍선·제목에 보일 글 (`/` 명령: text 는 풀어 쓴 template). 없으면 text */
  display?: string
  /** 붙인 파일·이미지 (pickAttachments 가 준 것만) */
  attachments?: PickedAttachment[]
  /** 이 턴을 돌릴 모드 */
  mode?: Mode
  model?: ChatModel
  /** 아직 저장 안 된(새) 대화면 이 프로젝트에 만든다 */
  project?: string
  /** 없으면 'user' */
  origin?: ChatOrigin
  /** origin 이 다른 대화일 때 — 보낸 대화 (말풍선 딱지·대기열 줄에 보인다). 화면(IPC)이 보낸 것에는 없다 */
  from?: MessageOrigin
  /** 새 대화의 제목 (start_session). 없으면 첫 메시지의 첫 줄 */
  title?: string
}

export interface SendResult {
  /** sent: 바로 턴이 됐다. queued: 턴이 도는 중(또는 앞에 쌓인 것이 있어) 그 대화 대기열에 들어갔다 */
  state: 'sent' | 'queued'
}

export type TurnOutcome = 'done' | 'failed' | 'interrupted'

/** ctx.chat 이 내는 이벤트 (Cordis `chat/<이름>`, IPC `chat:…`). 이름·기본 필드는 RemoteEventMap 과 같다 */
export interface ChatEventMap {
  /** 턴이 시작됐다 — message 는 그 턴의 내 말. conversation 은 그때 저장한 목록 정보(제목·모델·모드·시각) */
  'turn.started': { cid: string; message: HistoryMessage; origin: string; conversation: Conversation }
  /** 같은 item.id 는 통째로 교체 */
  'turn.progress': { cid: string; item: TurnItem }
  /** 그 턴이 지금 기다리는 승인·질문 전부 (빈 배열 = 더 없다) */
  'turn.attention': { cid: string; requests: Attention[] }
  /** 턴이 끝났다 — message 는 답(실패·중단이면 error). usage 는 이 턴 것, conversation 은 합산·저장한 뒤의 목록 정보(지워졌으면 없다) */
  'turn.ended': { cid: string; message: HistoryMessage; usage?: TurnUsage; outcome: TurnOutcome; conversation?: Conversation }
  /** 대기열이 바뀌었다 — items 는 줄마다 보일 글. held: 사용자가 턴을 멈춰 붙잡힌 대기열(되돌리기를 기다린다). attachments: 쌓인 첨부 칩.
   *  sources: items 와 같은 순서로 그 줄을 보낸 대화 (사람이 친 줄은 null) — 이슈 #55 */
  'queue.changed': { cid: string; items: string[]; held: boolean; attachments: Attachment[]; sources?: (MessageOrigin | null)[] }
  /** 그 프로젝트의 대화 목록이 바뀌었다. removed: 보관 개수를 넘어 지워진 대화 */
  'conversations.changed': { project: string; removed: string[] }
}

export type ChatEventName = keyof ChatEventMap
export type ChatEvent = { [K in ChatEventName]: { event: K; data: ChatEventMap[K] } }[ChatEventName]

/** 대화 하나의 지금 모습 — 화면을 다시 불러와도(창을 닫았다 열기) 도는 턴·대기열을 이어 그린다 */
export interface ChatLive {
  /** 턴이 도는 중일 때만 */
  turn?: { message: HistoryMessage; startedAt: number; progress: TurnItem[]; attention: Attention[] }
  queue: ChatEventMap['queue.changed']
}

/** 대화 id → 지금 모습. 도는 턴도 대기열도 없는 대화는 빠진다 */
export type ChatSnapshot = Record<string, ChatLive>

/** 대화 제목 = 첫 메시지의 첫 줄. 목록 행은 흘러가며·옆 카드는 줄바꿈해 전체를 보이므로 카드가 너무 커지지 않을 만큼만 자른다 */
export const TITLE_MAX = 80

export function titleFrom(text: string): string {
  const line = text.split('\n').find((part) => part.trim()) ?? text
  return line.trim().slice(0, TITLE_MAX)
}

/** 말풍선에 그릴 칩 — 경로 없이, 파일 먼저 이미지 나중. 다시 연 대화(메인이 적어 둔 파일 칩 + 엔진 기록의 이미지 칩)와 같은 순서 */
export function chipsOf(picked: readonly PickedAttachment[]): Attachment[] {
  const chip = ({ kind, name, size }: PickedAttachment): Attachment => ({ kind, name, size })
  return [...picked.filter((item) => item.kind !== 'image').map(chip), ...picked.filter((item) => item.kind === 'image').map(chip)]
}

/** 대기열 한 줄에 보일 글 — 보일 글(없으면 본문), 글 없이 첨부만 쌓았으면 파일 이름 (이슈 #44) */
export function queueLabel(item: QueuedSend): string {
  return (item.display ?? item.text) || (item.attachments ?? []).map((file) => file.name).join(', ')
}
