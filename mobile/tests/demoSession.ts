// 견본 세션 — **테스트 지원**이다 (제품 번들에 들어가지 않는다 — 앱은 remoteSession.ts 로 데스크탑에 붙는다, 이슈 #62).
// 네트워크 없이 데스크탑이 할 일을 흉내 낸다: 계약(shared/remote.ts)의 스냅샷·이벤트를 만들어 **진짜 리듀서(core/state.ts)에 흘린다.**
// tests/demo.test.ts 가 이것으로 "이벤트 흐름 → 리듀서 상태 → 화면 글(view.ts)" 을 지킨다.
//
// 내용은 시안(_workspace/mock-mobile)의 것: billing-api, 대화 5개(답 필요·진행 중·완료·읽은 것 둘), "배포 스크립트 정리" 대화의
// 진행 줄·승인 카드 `npm test -- --run`·대기 1. 동작:
// - 승인에 답하면 카드가 사라지고 턴이 이어져 답이 붙는다(거절이면 그 자리에서 끝). 끝나면 대기 글이 합쳐져 다음 턴으로 간다
// - 보내면 내 말이 붙고 "echo: …" 로 답한다. 턴 중에 보낸 것은 대기열로
// - 중지하면 그 턴이 "중단됨" 으로 끝나고 대기열은 보내지 않고 남는다. 되돌리기는 대기 글을 돌려주고 비운다

import type { Attention, ConversationStatus, HistoryMessage, NoticeState, TurnItem } from '../../shared/contract.ts'
import type { ConversationSnapshot, RemoteConversation, RemoteEvent, RemoteEventMap, RemoteEventName, RemoteModel, RemoteProject } from '../../shared/remote.ts'
import { initialState, reduce, type ConnectionStatus, type RemoteAction, type RemoteState } from '../src/core/index.ts'
import type { AppSession } from '../src/app/session.ts'

/** 진행 줄 사이 간격 */
export const DEMO_STEP_MS = 700
/** 처음 "다시 연결 중" 띠가 보이는 시간 (시안의 "다시 연결 중 · 3초") */
export const DEMO_RECONNECT_MS = 3_000

export const DEMO_PROJECT: RemoteProject = { path: '/Users/kim/work/billing-api', name: 'billing-api', displayPath: '~/work/billing-api', favorite: true }
export const DEMO_MODEL: RemoteModel = { providerId: 'gateway', providerName: '사내 게이트웨이', modelId: 'qwen3.8-27b', displayName: 'Qwen3.8 27B' }
/** 시안의 대화 — 승인을 기다리는 턴이 서 있다 */
export const DEMO_CHAT = 'c_deploy'

interface Turn {
  startedAt: number
  items: Map<string, TurnItem>
  attention: Attention[]
  /** 남은 걸음 */
  steps: (() => void)[]
  timer?: ReturnType<typeof setTimeout>
}

interface Chat {
  info: RemoteConversation
  queue: string[]
  /** 멈춘 턴 뒤 — 대기열을 보내지 않고 남긴다 */
  held: boolean
  turn?: Turn
}

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

export function createDemoSession(): AppSession {
  const started = Date.now()
  let state: RemoteState = initialState
  let status: ConnectionStatus = { kind: 'reconnecting', attempt: 1, retryAt: started + DEMO_RECONNECT_MS }
  let seq = 40
  let counter = 0
  const listeners = new Set<() => void>()
  const notices: NoticeState = {}
  const chats = new Map<string, Chat>()

  const eventListeners = new Set<(event: RemoteEvent) => void>()
  const notify = (): void => {
    for (const listener of listeners) listener()
  }
  const dispatch = (action: RemoteAction): void => {
    state = reduce(state, action)
    notify()
  }
  /** 데스크탑이 낸 이벤트 하나 */
  const emit = <K extends RemoteEventName>(event: K, data: RemoteEventMap[K]): void => {
    seq += 1
    const sent = { event, data, seq } as RemoteEvent
    dispatch({ type: 'event', event: sent })
    for (const listener of eventListeners) listener(sent)
  }
  /** 목록·상태 점을 다시 보낸다 (진짜 연결에서는 conversations.changed → 목록 다시 받기) */
  const publishList = (): void => {
    const conversations = [...chats.values()].map((chat) => ({ ...chat.info, status: notices[chat.info.id]?.status })).sort((a, b) => b.updatedAt - a.updatedAt)
    dispatch({ type: 'conversations.loaded', project: DEMO_PROJECT.path, conversations })
  }
  const mark = (chat: Chat, noticeStatus: ConversationStatus | undefined): void => {
    if (noticeStatus) notices[chat.info.id] = { project: chat.info.project, status: noticeStatus }
    else delete notices[chat.info.id]
    chat.info.updatedAt = Date.now()
    emit('notices.changed', { ...notices })
    publishList()
  }

  // ── 턴 ─────────────────────────────────────────────────────────────────────────────────────

  const progress = (chat: Chat, item: TurnItem): void => {
    chat.turn?.items.set(item.id, item)
    emit('turn.progress', { cid: chat.info.id, item })
  }

  const advance = (chat: Chat): void => {
    const turn = chat.turn
    if (!turn) return
    turn.timer = setTimeout(() => {
      turn.steps.shift()?.()
      if (chat.turn === turn) advance(chat)
    }, DEMO_STEP_MS)
  }

  const endTurn = (chat: Chat, outcome: 'done' | 'interrupted', extra: Partial<HistoryMessage> = {}): void => {
    const turn = chat.turn
    if (!turn) return
    clearTimeout(turn.timer)
    chat.turn = undefined
    const items = [...turn.items.values()]
    const text = items.flatMap((item) => (item.kind === 'text' ? [item.text] : [])).join('\n\n')
    emit('turn.ended', { cid: chat.info.id, outcome, message: { role: 'assistant', text, items, duration: Date.now() - turn.startedAt, ...extra } })
    mark(chat, outcome === 'done' ? 'done' : 'interrupted')
    if (outcome === 'done' && !chat.held && chat.queue.length > 0) {
      const merged = chat.queue.join('\n')
      chat.queue = []
      emit('queue.changed', { cid: chat.info.id, items: [] })
      startEcho(chat, merged)
    }
  }

  const startEcho = (chat: Chat, text: string): void => {
    const n = ++counter
    const answer = `echo: ${text}`
    const turn: Turn = { startedAt: Date.now(), items: new Map(), attention: [], steps: [] }
    turn.steps = [
      () => progress(chat, { kind: 'think', id: `think_${n}`, text: '받은 글을', done: false }),
      () => progress(chat, { kind: 'think', id: `think_${n}`, text: '받은 글을 그대로 되돌려 준다', done: true }),
      () => progress(chat, { kind: 'text', id: `text_${n}`, text: answer.slice(0, Math.ceil(answer.length / 2)), done: false }),
      () => progress(chat, { kind: 'text', id: `text_${n}`, text: answer, done: true }),
      () => endTurn(chat, 'done'),
    ]
    chat.turn = turn
    chat.held = false
    if (!chat.info.title) chat.info.title = text.slice(0, 24)
    emit('turn.started', { cid: chat.info.id, origin: 'demo-phone', message: { id: `msg_demo_${n}`, role: 'user', text, at: turn.startedAt, mode: chat.info.mode } })
    mark(chat, 'running')
    advance(chat)
  }

  // ── 견본 내용 (시안) ─────────────────────────────────────────────────────────────────────────

  const add = (id: string, title: string, age: number, snapshot: Omit<ConversationSnapshot, 'seq'>, noticeStatus?: ConversationStatus, turn?: Turn, queue: string[] = []): void => {
    const chat: Chat = { info: { id, project: DEMO_PROJECT.path, title, updatedAt: started - age, model: DEMO_MODEL, mode: 'build', engineSessionId: `ses_${id}` }, queue, held: false, turn }
    chats.set(id, chat)
    if (noticeStatus) notices[id] = { project: DEMO_PROJECT.path, status: noticeStatus }
    dispatch({ type: 'conversation.loaded', cid: id, snapshot: { ...snapshot, seq } })
  }
  const exchange = (ask: string, answer: string, age: number): HistoryMessage[] => [
    { id: `msg_seed_${++counter}`, role: 'user', text: ask, at: started - age - 20_000, mode: 'build' },
    { role: 'assistant', text: answer, duration: 20_000, items: [{ kind: 'text', id: `seed_text_${counter}`, text: answer, done: true }] },
  ]

  dispatch({ type: 'hello', hello: { desktopId: 'demo', name: '김의 MacBook', appVersion: '0.0.1', apiVersion: 1, runId: 'demo', seq, addresses: ['10.1.2.3:47821'] } })
  dispatch({ type: 'projects.loaded', projects: [DEMO_PROJECT] })

  // 1) 승인을 기다리는 턴 — 스크립트를 고친 뒤 테스트를 돌리려고 묻는다. 대기 1
  const deployItems: TurnItem[] = [
    { kind: 'think', id: 'd_think', text: '테스트 단계를 빌드 앞에 둔다', done: true },
    { kind: 'tool', id: 'd_read', name: 'read', status: 'done', summary: 'scripts/deploy.sh' },
    { kind: 'tool', id: 'd_edit', name: 'edit', status: 'done', summary: 'scripts/deploy.sh', diffs: [{ path: 'scripts/deploy.sh', status: 'modified', added: 4, removed: 1, patch: '' }] },
    { kind: 'text', id: 'd_text', text: '스크립트를 고쳤습니다. 바뀐 순서가 맞는지 테스트를 한 번 돌려 확인하겠습니다.', done: true },
    { kind: 'subtask', id: 'd_sub1', agent: 'explore', description: '배포 문서에서 순서 확인', status: 'running', startedAt: started - 9_000, items: [] },
    { kind: 'subtask', id: 'd_sub2', agent: 'explore', description: 'CI 설정에서 테스트 단계 찾기', status: 'running', startedAt: started - 9_000, items: [] },
    { kind: 'tool', id: 'd_bash', name: 'bash', status: 'preparing', summary: 'npm test -- --run' },
  ]
  const permission: Attention = { kind: 'permission', id: 'per_demo', sessionId: `ses_${DEMO_CHAT}`, action: 'bash', resources: ['npm test -- --run'] }
  const deployTurn: Turn = { startedAt: started - 18_000, items: new Map(deployItems.map((item) => [item.id, item])), attention: [permission], steps: [] }
  const queued = ['그리고 README 도 맞춰 줘']
  add(
    DEMO_CHAT,
    '배포 스크립트 정리',
    0,
    {
      history: { messages: [{ id: 'msg_seed_deploy', role: 'user', text: '배포 스크립트에서 테스트를 먼저 돌리게 바꿔 줘.', at: started - 18_000, mode: 'build' }] },
      live: { progress: deployItems, attention: [permission], queue: queued },
    },
    'attention',
    deployTurn,
    queued,
  )

  // 2) 도는 턴 — 하위 작업 둘
  const loginItems: TurnItem[] = [
    { kind: 'think', id: 'l_think', text: '세션 검증과 토큰 갱신을 나눠서 본다', done: true },
    { kind: 'subtask', id: 'l_sub1', agent: 'general', description: '세션 미들웨어 옮기기', status: 'running', startedAt: started - 10_000, items: [] },
    { kind: 'subtask', id: 'l_sub2', agent: 'general', description: '토큰 갱신 테스트 쓰기', status: 'running', startedAt: started - 10_000, items: [] },
  ]
  add(
    'c_login',
    '로그인 인증 리팩터링',
    12_000,
    { history: { messages: [{ id: 'msg_seed_login', role: 'user', text: '로그인 인증 코드를 미들웨어로 옮겨 줘.', at: started - 12_000, mode: 'build' }] }, live: { progress: loginItems, attention: [], queue: [] } },
    'running',
    { startedAt: started - 12_000, items: new Map(loginItems.map((item) => [item.id, item])), attention: [], steps: [] },
  )

  // 3) 안 본 완료 · 4) 5) 읽은 것
  add('c_docs', '결제 API 문서 정리', 2 * MINUTE, { history: { messages: exchange('결제 API 문서를 정리해 줘.', '엔드포인트 12개를 표로 정리했습니다', 2 * MINUTE) } }, 'done')
  add('c_tests', '테스트 실패 원인 찾기', DAY + 2 * 60 * MINUTE, { history: { messages: exchange('어제부터 정산 테스트가 실패해. 왜지?', '시간대 변환에서 하루가 밀립니다', DAY) } })
  add('c_readme', 'README 다듬기', 3 * DAY + MINUTE, { history: { messages: exchange('README 설치 절차가 너무 길어.', '설치 절차를 세 단계로 줄였습니다', 3 * DAY) } })

  dispatch({ type: 'event', event: { event: 'notices.changed', data: { ...notices }, seq: ++seq } })
  publishList()

  const reconnect = setTimeout(() => {
    status = { kind: 'connected' }
    notify()
  }, DEMO_RECONNECT_MS)

  // ── AppSession ─────────────────────────────────────────────────────────────────────────────

  return {
    getState: () => state,
    getStatus: () => status,
    getNotice: () => undefined,
    onEvent(listener) {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
    clearNotice: () => undefined,
    openConversation: () => undefined, // 견본은 전부 받아 둔 채로 시작한다
    closeConversation: () => undefined,
    wake: () => undefined,
    carrier: 'wifi',
    hasConnected: () => true,
    getFailure: () => undefined,
    receivedBytes: () => 0,
    retry: () => undefined,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    desktop: { name: '김의 MacBook', address: '10.1.2.3:47821', fingerprint: '9F:2C:41:AB' },
    models: [DEMO_MODEL],

    async send(cid, text) {
      const chat = chats.get(cid)
      if (!chat || !text.trim()) return false
      if (chat.turn || chat.queue.length > 0) {
        chat.queue.push(text)
        emit('queue.changed', { cid, items: [...chat.queue] })
      } else {
        startEcho(chat, text)
      }
      return true
    },

    stop(cid) {
      const chat = chats.get(cid)
      if (!chat?.turn) return
      chat.held = true
      endTurn(chat, 'interrupted', { interrupted: true, error: '중단됨' })
    },

    async takeQueue(cid) {
      const chat = chats.get(cid)
      if (!chat) return ''
      const text = chat.queue.join('\n')
      chat.held = false
      if (chat.queue.length > 0) {
        chat.queue = []
        emit('queue.changed', { cid, items: [] })
      }
      return text
    },

    reply(request, answer) {
      const chat = [...chats.values()].find((candidate) => candidate.turn?.attention.some((waiting) => waiting.id === request.id))
      const turn = chat?.turn
      if (!chat || !turn) return // 이미 답했다 (진짜 데스크탑이면 `elsewhere`)
      turn.attention = []
      emit('turn.attention', { cid: chat.info.id, requests: [] })
      const bash = [...turn.items.values()].find((item) => item.kind === 'tool' && item.status === 'preparing')
      if (answer === 'reject') {
        if (bash?.kind === 'tool') progress(chat, { ...bash, status: 'error', error: '거절됨' })
        return endTurn(chat, 'done', { declined: true })
      }
      const done = '테스트 14개가 모두 통과했습니다. 이제 배포 스크립트는 테스트 → 빌드 → 배포 순서로 돕니다.'
      turn.steps = [
        () => bash?.kind === 'tool' && progress(chat, { ...bash, status: 'running' }),
        () => bash?.kind === 'tool' && progress(chat, { ...bash, status: 'done', result: 'Test Files  3 passed (3)\n     Tests  14 passed (14)' }),
        () => {
          for (const item of [...turn.items.values()]) if (item.kind === 'subtask' && item.status === 'running') progress(chat, { ...item, status: 'done', endedAt: Date.now() })
        },
        () => progress(chat, { kind: 'text', id: 'd_text2', text: done.slice(0, 22), done: false }),
        () => progress(chat, { kind: 'text', id: 'd_text2', text: done, done: true }),
        () => endTurn(chat, 'done'),
      ]
      mark(chat, 'running')
      advance(chat)
    },

    async createConversation(project) {
      const id = `c_new_${++counter}`
      chats.set(id, { info: { id, project, title: '', updatedAt: Date.now(), model: DEMO_MODEL, mode: 'build', engineSessionId: `ses_${id}` }, queue: [], held: false })
      dispatch({ type: 'conversation.loaded', cid: id, snapshot: { history: { messages: [] }, seq } })
      publishList()
      return id
    },

    dispose() {
      clearTimeout(reconnect)
      for (const chat of chats.values()) clearTimeout(chat.turn?.timer)
      listeners.clear()
    },
  }
}
