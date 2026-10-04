// 대화 화면 상태 리듀서 — ctx.chat 의 이벤트·스냅샷·불러온 기록으로 화면이 그릴 대화 한 건의 모습을 만든다. 순수 함수다 (IPC·시간·React 없음).
// 모바일 리듀서(mobile/src/core/state.ts 의 ConversationView·applyToView)와 같은 이름·같은 규칙이다 — seq 만 없다(IPC 는 순서대로 온다).
// 데스크탑에만 있는 것: startedAt(진행 줄의 초), held·queuedAttachments(대기열 되돌리기·첨부 상한)

import type { ChatEvent, ChatLive } from './chat.ts'
import type { Attachment, Attention, HistoryMessage, TurnItem } from './contract.ts'

export interface ChatView {
  messages: HistoryMessage[]
  /** 턴이 도는 중 */
  running: boolean
  /** 도는 턴을 보낸 시각(ms) */
  startedAt?: number
  /** 도는 턴의 진행 줄 (처음 나타난 순서) */
  progress: TurnItem[]
  /** 기다리는 승인·질문 */
  attention: Attention[]
  /** 대기열 — 줄마다 보일 글 (보낸 순서) */
  queue: string[]
  /** 사용자가 턴을 멈춰 붙잡힌 대기열 — 화면이 입력창으로 되돌린다 */
  held: boolean
  queuedAttachments: Attachment[]
}

export const emptyChatView: ChatView = { messages: [], running: false, progress: [], attention: [], queue: [], held: false, queuedAttachments: [] }

/** 같은 id 면 그 자리에서 바꾸고, 처음이면 끝에 붙인다 — 줄 순서는 처음 나타난 순서 */
export function upsertItem(items: readonly TurnItem[] | undefined, item: TurnItem): TurnItem[] {
  const list = items ?? []
  const index = list.findIndex((existing) => existing.id === item.id)
  if (index === -1) return [...list, item]
  return list.map((existing, at) => (at === index ? item : existing))
}

/** 같은 id 의 말풍선이 있으면 그 자리를 바꾸고, 없으면 끝에 붙인다 */
function withMessage(messages: HistoryMessage[], message: HistoryMessage): HistoryMessage[] {
  const at = message.id === undefined ? -1 : messages.findIndex((existing) => existing.id === message.id)
  return at === -1 ? [...messages, message] : messages.map((existing, index) => (index === at ? message : existing))
}

export function reduceChat(view: ChatView, event: ChatEvent): ChatView {
  switch (event.event) {
    case 'turn.started': {
      const { message } = event.data
      return { ...view, messages: withMessage(view.messages, message), running: true, startedAt: message.at, progress: [], attention: [] }
    }
    case 'turn.progress':
      // 끝난 뒤 늦게 온 것은 버린다
      return view.running ? { ...view, progress: upsertItem(view.progress, event.data.item) } : view
    case 'turn.attention':
      return view.running ? { ...view, attention: event.data.requests } : view
    case 'turn.ended':
      return { ...view, messages: [...view.messages, event.data.message], running: false, startedAt: undefined, progress: [], attention: [] }
    case 'queue.changed':
      return { ...view, queue: event.data.items, held: event.data.held, queuedAttachments: event.data.attachments }
    default:
      return view // conversations.changed 는 목록의 일이다
  }
}

/** 스냅샷(메인이 쥔 지금 모습)을 입힌다 — 화면을 다시 불러온 뒤. live 가 없으면 도는 턴도 대기열도 없다 */
export function withLive(view: ChatView, live: ChatLive | undefined): ChatView {
  const queue = { queue: live?.queue.items ?? [], held: live?.queue.held ?? false, queuedAttachments: live?.queue.attachments ?? [] }
  const turn = live?.turn
  if (!turn) return { ...view, ...queue, running: false, startedAt: undefined, progress: [], attention: [] }
  return { ...view, ...queue, messages: withMessage(view.messages, turn.message), running: true, startedAt: turn.startedAt, progress: turn.progress, attention: turn.attention }
}

/** 엔진에서 불러온 기록을 입힌다. 턴이 도는 중이면 기록은 그 턴의 내 말까지만 쓴다 — 그 뒤(쓰다 만 답)는 진행 줄이 그리고, 끝나면 turn.ended 가 붙인다.
 *  그 턴의 내 말이 기록에 아직 없으면(엔진이 받기 전) 끝에 붙인다 */
export function withHistory(view: ChatView, loaded: HistoryMessage[]): ChatView {
  if (!view.running) return { ...view, messages: loaded }
  const asked = [...view.messages].reverse().find((message) => message.role === 'user')
  if (!asked) return { ...view, messages: loaded }
  const at = asked.id === undefined ? -1 : loaded.findIndex((message) => message.id === asked.id)
  return { ...view, messages: at === -1 ? [...loaded, asked] : [...loaded.slice(0, at), asked] }
}
