import type { Attachment, Attention, ChatEvent, ChatLive, ChatModel, HistoryMessage, Mode, TurnItem } from '../shared/ipc.ts'
import type { MessageOrigin } from '../shared/contract.ts'
import { reduceChat, withHistory, withLive, type ChatView } from '../shared/chatReducer.ts'
import type { ChatUsage } from './stats.ts'

// 대화 한 건의 화면 상태 중 메인(ctx.chat)이 정하는 부분 — 말풍선·도는 턴·대기열·목록 정보(제목·시각·통계). 순수 함수다.
// 화면은 보내기를 부탁하고(sendMessage) 여기서 이벤트·스냅샷·불러온 기록을 상태에 입힌다 (이슈 #52). 턴·대기열의 규칙은
// shared/chatReducer.ts (모바일과 같은 리듀서 모양) — 여기는 그 모습을 화면 상태의 필드 이름으로 옮기고 목록 정보를 맞춘다

export interface ChatFields {
  title: string
  updatedAt: number
  engineSessionId?: string
  model?: ChatModel
  mode?: Mode
  usage?: ChatUsage
  messages: HistoryMessage[]
  /** 답을 기다리는 중 */
  pending?: boolean
  /** 답을 기다리는 턴의 진행 줄과 보낸 시각 — 턴이 끝나면 답(turn.ended 의 message.items)에 실려 온다 */
  progress?: TurnItem[]
  sentAt?: number
  /** 답을 기다리는 턴이 기다리는 승인·질문 */
  attention?: Attention[]
  /** 답하는 중에 보내 쌓인 것 — 줄마다 보일 글. 정본은 메인 */
  queue?: string[]
  /** 멈춘 턴이 붙잡은 대기열 — 입력창으로 되돌린다 */
  held?: boolean
  queuedAttachments?: Attachment[]
  /** queue 와 같은 순서로 그 줄을 보낸 대화 (사람이 친 줄은 null) — 이슈 #55 */
  queueSources?: (MessageOrigin | null)[]
}

function viewOf(session: ChatFields): ChatView {
  return {
    messages: session.messages,
    running: !!session.pending,
    startedAt: session.sentAt,
    progress: session.progress ?? [],
    attention: session.attention ?? [],
    queue: session.queue ?? [],
    held: !!session.held,
    queuedAttachments: session.queuedAttachments ?? [],
  }
}

function withView<S extends ChatFields>(session: S, view: ChatView): S {
  return {
    ...session,
    messages: view.messages,
    pending: view.running,
    progress: view.running ? view.progress : undefined,
    sentAt: view.startedAt,
    attention: view.running ? view.attention : undefined,
    queue: view.queue,
    held: view.held,
    queuedAttachments: view.queuedAttachments,
  }
}

/** 이벤트 하나를 그 대화에 입힌다. 턴 시작·끝에는 메인이 저장한 목록 정보도 맞춘다 — 고른 모델은 화면 것이 먼저다(턴 중에 바꾼 것) */
export function applyChat<S extends ChatFields>(session: S, event: ChatEvent): S {
  const next = withView(session, reduceChat(viewOf(session), event))
  if (event.event === 'queue.changed') return { ...next, queueSources: event.data.sources }
  if (event.event === 'turn.started') {
    const { title, updatedAt, model, mode } = event.data.conversation
    return { ...next, title, updatedAt, model: session.model ?? model, mode }
  }
  if (event.event === 'turn.ended' && event.data.conversation) {
    const { updatedAt, engineSessionId, usage } = event.data.conversation
    return { ...next, updatedAt, engineSessionId: engineSessionId ?? session.engineSessionId, usage: usage as ChatUsage | undefined }
  }
  return next
}

/** 화면이 (다시) 뜰 때 — 메인이 쥔 도는 턴·대기열을 입힌다 */
export function applyLive<S extends ChatFields>(session: S, live: ChatLive | undefined): S {
  return live ? { ...withView(session, withLive(viewOf(session), live)), queueSources: live.queue.sources } : session
}

/** 엔진에서 불러온 기록을 입힌다 — 턴이 도는 중이면 그 턴의 내 말까지만 (그 뒤는 진행 줄) */
export function applyHistory<S extends ChatFields>(session: S, loaded: HistoryMessage[]): S {
  return { ...session, messages: withHistory(viewOf(session), loaded).messages }
}

/** 그 내 말이 앞 내 말과 다른 모드로 갔나 — 모드가 바뀐 자리의 구분선 */
export function switchedMode(messages: readonly HistoryMessage[], index: number): boolean {
  const mode = messages[index]?.mode
  const previous = messages.slice(0, index).reverse().find((message) => message.role === 'user')?.mode
  return !!mode && !!previous && mode !== previous
}

/** 마지막 턴이 계획 모드로 잘 끝났나 — "이 계획대로 실행" 자리 */
export function planEnded(messages: readonly HistoryMessage[]): boolean {
  const last = messages.at(-1)
  const asked = messages.at(-2)
  return last?.role === 'assistant' && !last.error && !last.declined && asked?.role === 'user' && asked.mode === 'plan'
}
