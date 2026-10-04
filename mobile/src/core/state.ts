// 화면 상태 리듀서 — 스냅샷(REST)과 이벤트(SSE)로 화면이 그릴 상태를 만든다. 순수 함수다(네트워크·시간·React 없음).
//
// 규칙 (01t 2·4절):
// - 기록된 이벤트에는 seq 가 있다. 이미 본 seq(≤ state.seq)는 버린다 — 이어 받기(`after`)의 재생과 겹쳐도 한 번만 적용된다
// - 대화 스냅샷에는 그 시점 seq 가 있다. 그 대화의 이벤트는 스냅샷 seq 초과분만 적용한다
// - 스냅샷을 받는 동안(loading) 온 그 대화의 이벤트는 모아 두었다가 스냅샷 위에 다시 적용한다 — 요청과 응답 사이의 틈을 메운다
// - `reset`, 또는 runId 가 바뀐 `ready`·hello → 쥔 seq 는 무효다. resync 번호를 올리고, 연결(connection.ts)이 목록과 열린 대화를 다시 받는다
// - `turn.progress` 는 같은 item.id 를 통째로 바꾼다
// - `conversations.changed` → 그 프로젝트 목록이 낡았다고 적는다(staleProjects) — 다시 받는 것은 연결의 몫

import type { Attention, HistoryMessage, NoticeState, TurnItem } from '../../../shared/contract.ts'
import type { ConversationSnapshot, Hello, RemoteConversation, RemoteEvent, RemoteProject } from '../../../shared/remote.ts'

/** 열어 둔 대화 하나 */
export interface ConversationView {
  messages: HistoryMessage[]
  /** 턴이 도는 중 */
  running: boolean
  /** 도는 턴의 진행 줄 (처음 나타난 순서) */
  progress: TurnItem[]
  /** 기다리는 승인·질문 */
  attention: Attention[]
  /** 대기열 (보낸 순서) */
  queue: string[]
  missingFolder?: boolean
  error?: string
  /** 이 모습이 반영한 마지막 seq — 이 이하 이벤트는 이미 들어 있다 */
  seq: number
}

export interface RemoteState {
  /** 데스크탑 실행 id — 아직 hello 를 못 받았으면 없다 */
  runId?: string
  /** 적용한 마지막 seq — 다시 붙을 때 `after` 로 보낸다 */
  seq: number
  projects: RemoteProject[]
  /** 프로젝트 경로 → 대화 목록 (받아 둔 프로젝트만) */
  conversations: Record<string, RemoteConversation[]>
  /** 대화 id → 열어 둔 대화 */
  views: Record<string, ConversationView>
  /** 스냅샷을 받는 중인 대화 → 그동안 온 이벤트 */
  loading: Record<string, RemoteEvent[]>
  notices: NoticeState
  /** 데스크탑이 알려 준 주소 후보 (`ip:port`) */
  addresses: string[]
  /** 스냅샷을 통째로 다시 받아야 할 때마다 오른다 */
  resync: number
  /** 목록을 다시 받아야 하는 프로젝트 */
  staleProjects: string[]
}

export type RemoteAction =
  | { type: 'hello'; hello: Hello }
  | { type: 'projects.loaded'; projects: RemoteProject[] }
  | { type: 'conversations.loaded'; project: string; conversations: RemoteConversation[] }
  | { type: 'conversation.loading'; cid: string }
  | { type: 'conversation.loaded'; cid: string; snapshot: ConversationSnapshot }
  /** 스냅샷을 못 받았다 — 모으던 이벤트를 버린다 (열려 있던 모습은 그대로) */
  | { type: 'conversation.failed'; cid: string }
  | { type: 'conversation.closed'; cid: string }
  | { type: 'event'; event: RemoteEvent }

export const initialState: RemoteState = {
  seq: 0,
  projects: [],
  conversations: {},
  views: {},
  loading: {},
  notices: {},
  addresses: [],
  resync: 0,
  staleProjects: [],
}

export function reduce(state: RemoteState, action: RemoteAction): RemoteState {
  switch (action.type) {
    case 'hello': {
      const { runId, seq, addresses } = action.hello
      // 처음: 지금부터 본다(지난 이벤트를 재생받을 것이 없다). 같은 실행: 쥔 seq 뒤부터 이어 받는다. 실행이 바뀜: 다시 받는다
      if (state.runId === undefined) return { ...state, runId, seq, addresses }
      if (state.runId === runId) return { ...state, addresses }
      return { ...restart(state, runId, seq), addresses }
    }
    case 'projects.loaded':
      return { ...state, projects: action.projects }
    case 'conversations.loaded':
      return {
        ...state,
        conversations: { ...state.conversations, [action.project]: action.conversations },
        staleProjects: state.staleProjects.filter((project) => project !== action.project),
      }
    case 'conversation.loading':
      return { ...state, loading: { ...state.loading, [action.cid]: [] } }
    case 'conversation.loaded': {
      const { [action.cid]: buffered = [], ...loading } = state.loading
      const view = buffered.reduce((current, event) => applyToView(current, event), viewOf(action.snapshot))
      return { ...state, loading, views: { ...state.views, [action.cid]: view } }
    }
    case 'conversation.failed': {
      const { [action.cid]: _dropped, ...loading } = state.loading
      return { ...state, loading }
    }
    case 'conversation.closed': {
      const { [action.cid]: _view, ...views } = state.views
      const { [action.cid]: _buffered, ...loading } = state.loading
      return { ...state, views, loading }
    }
    case 'event':
      return applyEvent(state, action.event)
  }
}

function viewOf(snapshot: ConversationSnapshot): ConversationView {
  return {
    messages: snapshot.history.messages,
    running: snapshot.live !== undefined,
    progress: snapshot.live?.progress ?? [],
    attention: snapshot.live?.attention ?? [],
    queue: snapshot.live?.queue ?? [],
    missingFolder: snapshot.history.missingFolder,
    error: snapshot.history.error,
    seq: snapshot.seq,
  }
}

/** 쥔 seq 가 무효가 됐다 — 새 실행의 seq 로 맞추고 다시 받으라고 적는다. 열린 대화는 다시 받을 때까지 낡은 모습 그대로 보인다 */
function restart(state: RemoteState, runId: string, seq: number): RemoteState {
  const views = Object.fromEntries(Object.entries(state.views).map(([cid, view]) => [cid, { ...view, seq }]))
  const loading = Object.fromEntries(Object.keys(state.loading).map((cid) => [cid, []]))
  return { ...state, runId, seq, views, loading, resync: state.resync + 1 }
}

function applyEvent(state: RemoteState, event: RemoteEvent): RemoteState {
  if (event.event === 'ready') {
    if (state.runId === undefined) return { ...state, runId: event.data.runId }
    return state.runId === event.data.runId ? state : restart(state, event.data.runId, event.data.seq)
  }
  if (event.event === 'reset') return restart(state, event.data.runId, event.data.seq)

  if (event.seq !== undefined) {
    if (event.seq <= state.seq) return state
    state = { ...state, seq: event.seq }
  }
  switch (event.event) {
    case 'turn.started':
    case 'turn.progress':
    case 'turn.attention':
    case 'turn.ended':
    case 'queue.changed': {
      const { cid } = event.data
      const buffer = state.loading[cid]
      if (buffer) state = { ...state, loading: { ...state.loading, [cid]: [...buffer, event] } }
      const view = state.views[cid]
      return view ? { ...state, views: { ...state.views, [cid]: applyToView(view, event) } } : state
    }
    case 'conversations.changed': {
      const { project } = event.data
      if (!(project in state.conversations) || state.staleProjects.includes(project)) return state
      return { ...state, staleProjects: [...state.staleProjects, project] }
    }
    case 'notices.changed':
      return { ...state, notices: event.data }
    case 'addresses.changed':
      return { ...state, addresses: event.data.addresses }
    default:
      return state // device.revoked 는 연결이 처리한다. 모르는 이벤트(새 버전 데스크탑)는 seq 만 넘긴다
  }
}

function applyToView(view: ConversationView, event: RemoteEvent): ConversationView {
  if (event.seq !== undefined && event.seq <= view.seq) return view
  const seq = event.seq ?? view.seq
  switch (event.event) {
    case 'turn.started': {
      const { message } = event.data
      // 같은 id 의 말풍선(화면이 먼저 그려 둔 것)이 있으면 그 자리를 확정본으로 바꾼다
      const at = message.id === undefined ? -1 : view.messages.findIndex((existing) => existing.id === message.id)
      const messages = at === -1 ? [...view.messages, message] : view.messages.map((existing, index) => (index === at ? message : existing))
      return { ...view, messages, running: true, progress: [], attention: [], seq }
    }
    case 'turn.progress': {
      const { item } = event.data
      const known = view.progress.some((existing) => existing.id === item.id)
      const progress = known ? view.progress.map((existing) => (existing.id === item.id ? item : existing)) : [...view.progress, item]
      return { ...view, progress, running: true, seq }
    }
    case 'turn.attention':
      return { ...view, attention: event.data.requests, seq }
    case 'turn.ended':
      return { ...view, messages: [...view.messages, event.data.message], running: false, progress: [], attention: [], seq }
    case 'queue.changed':
      return { ...view, queue: event.data.items, seq }
    default:
      return view
  }
}
