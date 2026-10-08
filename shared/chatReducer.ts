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

/** 진행 줄의 글 — 글 줄을 나타난 순서대로 잇는다 (엔진 쪽 TurnTracker.text 와 같은 규칙). 끼워 넣은 말 앞에 얼린 답·그 뒤 답의 글 (이슈 #250) */
export function segmentText(items: readonly TurnItem[]): string {
  return items.map((item) => (item.kind === 'text' ? item.text : '')).join('')
}

/** 도는 턴의 진행 줄을 끼워 넣은 말 앞에서 얼린 답 — 진행 줄이 없으면 만들지 않는다 (이슈 #250) */
export function frozenAnswer(progress: readonly TurnItem[]): HistoryMessage[] {
  return progress.length > 0 ? [{ role: 'assistant', text: segmentText(progress), items: [...progress] }] : []
}

/** 도는 턴의 진행 줄 하나를 놓는다 (이슈 #250) — 끼워 넣은 말 앞에 얼린 답(segments)에 같은 id 의 줄이 있으면 그 자리에서 바꾸고(끼우기 전에
 *  돌던 도구가 늦게 끝남), 아니면 지금 진행 줄에 (upsertItem). segments 에는 얼린 답과 끼워 넣은 말이 섞여 있다 */
export function placeItem(segments: readonly HistoryMessage[], progress: readonly TurnItem[], item: TurnItem): { segments: HistoryMessage[]; progress: TurnItem[] } {
  const at = segments.findIndex((message) => message.role === 'assistant' && message.items?.some((existing) => existing.id === item.id))
  if (at === -1) return { segments: [...segments], progress: upsertItem(progress, item) }
  const items = upsertItem(segments[at]!.items, item)
  return { segments: segments.map((message, index) => (index === at ? { ...message, items, text: segmentText(items) } : message)), progress: [...progress] }
}

/** 말풍선 목록 끝에서 도는 턴의 끼워 넣은 말·얼린 답이 시작하는 자리 — 없으면 길이 (그 턴의 내 말은 끼워 넣은 말이 아니라 거기서 멈춘다) */
function interjectedFrom(messages: readonly HistoryMessage[]): number {
  let at = messages.length
  while (at > 0 && messages[at - 1]!.role === 'user' && messages[at - 1]!.interjected) {
    at--
    if (at > 0 && messages[at - 1]!.role === 'assistant') at--
  }
  return at
}

/** 답을 못 받은 끼워 넣은 말에 표시를 단다 (이슈 #250) */
function markUnanswered(messages: HistoryMessage[], ids: readonly string[] | undefined): HistoryMessage[] {
  if (!ids?.length) return messages
  return messages.map((message) => (message.role === 'user' && message.id !== undefined && ids.includes(message.id) ? { ...message, unanswered: true } : message))
}

/** 도는 턴의 진행 줄 하나를 화면 모습에 놓는다 — 얼린 답이 있으면 placeItem, 없으면 진행 줄에 (모바일 리듀서도 쓴다) */
export function placeInView<V extends { messages: HistoryMessage[]; progress: TurnItem[] }>(view: V, item: TurnItem): V {
  const from = interjectedFrom(view.messages)
  if (from === view.messages.length) return { ...view, progress: upsertItem(view.progress, item) }
  const placed = placeItem(view.messages.slice(from), view.progress, item)
  return { ...view, messages: [...view.messages.slice(0, from), ...placed.segments], progress: placed.progress }
}

/** 끼워 넣은 말을 화면 모습에 끼운다 — 지금 진행 줄을 그 앞의 답으로 얼리고 진행 줄을 비운다 (모바일 리듀서도 쓴다) */
export function interjectInView<V extends { messages: HistoryMessage[]; progress: TurnItem[] }>(view: V, message: HistoryMessage): V {
  return { ...view, messages: [...view.messages, ...frozenAnswer(view.progress), message], progress: [] }
}

/** 턴 끝의 말풍선 — 답을 붙이고 답을 못 받은 끼워 넣은 말에 표시 (모바일 리듀서도 쓴다) */
export function endedMessages(messages: HistoryMessage[], answer: HistoryMessage, unanswered?: readonly string[]): HistoryMessage[] {
  return markUnanswered([...messages, answer], unanswered)
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
      return view.running ? placeInView(view, event.data.item) : view
    case 'turn.interjected':
      return view.running ? interjectInView(view, event.data.message) : view
    case 'turn.attention':
      return view.running ? { ...view, attention: event.data.requests } : view
    case 'turn.ended':
      return { ...view, messages: endedMessages(view.messages, event.data.message, event.data.unanswered), running: false, startedAt: undefined, progress: [], attention: [] }
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
  return { ...view, ...queue, messages: liveMessages(view.messages, turn), running: true, startedAt: turn.startedAt, progress: turn.progress, attention: turn.attention }
}

/** 도는 턴의 내 말을 입히고, 끼워 넣은 말이 있으면 그 뒤를 메인이 쥔 얼린 답·끼워 넣은 말로 바꾼다 (이슈 #250 — 다시 입혀도 두 번 붙지 않게) */
function liveMessages(messages: HistoryMessage[], turn: NonNullable<ChatLive['turn']>): HistoryMessage[] {
  const base = withMessage(messages, turn.message)
  if (!turn.interjections?.length) return base
  const at = base.findIndex((message) => message === turn.message || (message.id !== undefined && message.id === turn.message.id))
  return [...base.slice(0, at + 1), ...turn.interjections]
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
