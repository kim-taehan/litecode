import { describe, expect, it } from 'vitest'
import { emptyChatView, reduceChat, withHistory, withLive, type ChatView } from '../../shared/chatReducer.ts'
import { queueLabel, titleFrom, TITLE_MAX, type ChatEvent } from '../../shared/chat.ts'
import { applyChat, applyHistory, applyLive, planEnded, switchedMode, type ChatFields } from '../../renderer/chatState.ts'
import type { Attention, Conversation, HistoryMessage, TurnItem } from '../../shared/contract.ts'

// 화면 상태 리듀서 (이슈 #52) — 화면은 ctx.chat 의 이벤트·스냅샷·불러온 기록만으로 말풍선·진행 줄·대기열을 그린다.
// 원래 App.tsx 의 send() 가 직접 하던 것(내 말 붙이기 → pending → 답 붙이기·통계 합산)과 같은 상태가 나와야 한다

const asked = (id: string, text: string, patch: Partial<HistoryMessage> = {}): HistoryMessage => ({ id, role: 'user', text, at: 1_000, mode: 'build', ...patch })
const answered = (text: string, patch: Partial<HistoryMessage> = {}): HistoryMessage => ({ role: 'assistant', text, items: [], duration: 500, ...patch })
const conversation = (patch: Partial<Conversation> = {}): Conversation => ({ id: 'c1', project: '/work/a', title: '제목', updatedAt: 2_000, ...patch })
const think: TurnItem = { kind: 'think', id: 't1', text: '생각', done: false }
const tool: TurnItem = { kind: 'tool', id: 'x1', name: 'bash', status: 'running' }
const permission: Attention = { kind: 'permission', id: 'per_1', sessionId: 'ses_1', action: 'bash', resources: ['ls'] }

const started = (message: HistoryMessage, patch: Partial<Conversation> = {}): ChatEvent => ({ event: 'turn.started', data: { cid: 'c1', message, origin: 'user', conversation: conversation(patch) } })
const progress = (item: TurnItem): ChatEvent => ({ event: 'turn.progress', data: { cid: 'c1', item } })
const ended = (message: HistoryMessage, patch?: Partial<Conversation>): ChatEvent => ({
  event: 'turn.ended',
  data: { cid: 'c1', message, outcome: message.interrupted ? 'interrupted' : message.error ? 'failed' : 'done', ...(patch && { conversation: conversation(patch) }) },
})
const queue = (items: string[], held = false): ChatEvent => ({ event: 'queue.changed', data: { cid: 'c1', items, held, attachments: [] } })
const run = (view: ChatView, ...events: ChatEvent[]) => events.reduce(reduceChat, view)

describe('reduceChat', () => {
  it('턴 시작: 내 말을 붙이고 도는 중 — 진행 줄·승인 카드는 비운다. 보낸 시각은 내 말의 시각', () => {
    const view = run({ ...emptyChatView, progress: [tool], attention: [permission] }, started(asked('m1', 'hi')))
    expect(view).toMatchObject({ messages: [asked('m1', 'hi')], running: true, startedAt: 1_000, progress: [], attention: [] })
  })

  it('진행 줄: 처음 나타난 순서, 같은 id 는 그 자리에서 교체. 승인 목록은 통째로', () => {
    const done: TurnItem = { ...think, text: '생각 끝', done: true } as TurnItem
    const view = run(emptyChatView, started(asked('m1', 'hi')), progress(think), progress(tool), progress(done), { event: 'turn.attention', data: { cid: 'c1', requests: [permission] } })
    expect(view.progress).toEqual([done, tool])
    expect(view.attention).toEqual([permission])
  })

  it('턴이 안 도는 대화에 늦게 온 진행 줄·승인은 버린다', () => {
    const view = run(emptyChatView, progress(think), { event: 'turn.attention', data: { cid: 'c1', requests: [permission] } })
    expect(view).toEqual(emptyChatView)
  })

  it('턴 끝: 답을 붙이고 도는 턴의 것을 다 비운다 — 실패·중단은 답의 error 로', () => {
    const failed = answered('', { error: 'HTTP 500' })
    const view = run(emptyChatView, started(asked('m1', 'hi')), progress(tool), ended(failed))
    expect(view).toMatchObject({ messages: [asked('m1', 'hi'), failed], running: false, progress: [], attention: [] })
    expect(view.startedAt).toBeUndefined()
  })

  it('대기열: 줄 글·붙잡힘·첨부 칩을 통째로 바꾼다. 턴과 무관하다', () => {
    const chip = { kind: 'file' as const, name: 'a.md', size: 1 }
    const view = reduceChat(emptyChatView, { event: 'queue.changed', data: { cid: 'c1', items: ['a', 'b'], held: true, attachments: [chip] } })
    expect(view).toMatchObject({ queue: ['a', 'b'], held: true, queuedAttachments: [chip], running: false })
    expect(reduceChat(view, queue([]))).toMatchObject({ queue: [], held: false, queuedAttachments: [] })
  })

  it('턴 중 보내기 → 대기열 → 턴 끝에 합쳐 다음 턴: 메인이 내는 이벤트 순서대로 말풍선이 쌓인다', () => {
    const view = run(
      emptyChatView,
      started(asked('m1', '처음')),
      queue(['a']),
      queue(['a', 'b']),
      ended(answered('답 1')),
      queue([]),
      started(asked('m2', 'a\nb')),
      ended(answered('답 2')),
    )
    expect(view.messages.map((message) => message.text)).toEqual(['처음', '답 1', 'a\nb', '답 2'])
    expect(view).toMatchObject({ running: false, queue: [] })
  })

  it('같은 id 의 내 말이 이미 있으면(스냅샷으로 먼저 받음) 그 자리를 바꾼다 — 두 번 붙이지 않는다', () => {
    const view = run({ ...emptyChatView, messages: [asked('m1', 'hi')] }, started(asked('m1', 'hi')))
    expect(view.messages).toHaveLength(1)
  })
})

describe('withLive — 화면을 다시 불러왔을 때의 스냅샷', () => {
  const turn = { message: asked('m2', '도는 중'), startedAt: 5_000, progress: [think], attention: [permission] }
  const live = { turn, queue: { cid: 'c1', items: ['다음'], held: false, attachments: [] } }

  it('도는 턴의 내 말·시작 시각·진행 줄·승인 카드와 대기열을 입힌다', () => {
    expect(withLive(emptyChatView, live)).toEqual({ messages: [turn.message], running: true, startedAt: 5_000, progress: [think], attention: [permission], queue: ['다음'], held: false, queuedAttachments: [] })
  })

  it('붙잡힌 대기열만 남은 대화 (턴은 끝났다)', () => {
    const view = withLive(emptyChatView, { queue: { cid: 'c1', items: ['a'], held: true, attachments: [] } })
    expect(view).toMatchObject({ running: false, messages: [], queue: ['a'], held: true })
  })
})

describe('withHistory — 엔진에서 불러온 기록', () => {
  it('턴이 안 돌면 기록 그대로', () => {
    const loaded = [asked('m1', 'hi'), answered('답')]
    expect(withHistory(emptyChatView, loaded).messages).toEqual(loaded)
  })

  it('턴이 도는 중이면 그 턴의 내 말까지만 — 쓰다 만 답은 진행 줄이 그리고 턴 끝이 붙인다', () => {
    const view = withLive(emptyChatView, { turn: { message: asked('m2', '/hi world'), startedAt: 5_000, progress: [], attention: [] }, queue: { cid: 'c1', items: [], held: false, attachments: [] } })
    const loaded = [asked('m1', 'hi'), answered('답'), asked('m2', '풀어 쓴 본문'), answered('쓰다 만')]
    expect(withHistory(view, loaded).messages).toEqual([asked('m1', 'hi'), answered('답'), asked('m2', '/hi world')])
  })

  it('그 턴의 내 말이 기록에 아직 없으면(엔진이 받기 전) 끝에 붙인다', () => {
    const view = withLive(emptyChatView, { turn: { message: asked('m2', '둘째'), startedAt: 5_000, progress: [], attention: [] }, queue: { cid: 'c1', items: [], held: false, attachments: [] } })
    const loaded = [asked('m1', 'hi'), answered('답')]
    expect(withHistory(view, loaded).messages).toEqual([...loaded, asked('m2', '둘째')])
  })
})

describe('applyChat — 화면 대화 상태 (renderer/chatState.ts)', () => {
  const blank: ChatFields = { title: '', updatedAt: 1, messages: [] }

  it('턴 시작: 내 말·pending·보낸 시각, 메인이 지은 제목·시각·모드. 모델은 화면이 고른 것이 없을 때만 받는다', () => {
    const model = { providerId: 'gw', modelId: 'm1' }
    const next = applyChat(blank, started(asked('m1', '첫 줄'), { title: '첫 줄', model, mode: 'plan' }))
    expect(next).toMatchObject({ title: '첫 줄', updatedAt: 2_000, model, mode: 'plan', pending: true, sentAt: 1_000, progress: [], messages: [asked('m1', '첫 줄')] })
    const chosen = { providerId: 'gw', modelId: 'm2' }
    expect(applyChat({ ...blank, model: chosen }, started(asked('m1', 'x'), { model })).model).toEqual(chosen)
  })

  it('턴 끝: 답 말풍선, pending 풀림, 메인이 합산한 통계·엔진 세션·시각. 진행 줄·승인 카드는 지운다', () => {
    const usage = { turns: 2, steps: 3, tokens: { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, llmMs: 1, toolMs: 0, ttftMs: 0, ttftSteps: 0, lastContextTokens: 3 }
    const running = applyChat(applyChat(blank, started(asked('m1', 'hi'))), progress(tool))
    expect(running.progress).toEqual([tool])
    const done = applyChat(running, ended(answered('답', { items: [tool] }), { updatedAt: 9_000, engineSessionId: 'ses_1', usage }))
    expect(done).toMatchObject({ pending: false, updatedAt: 9_000, engineSessionId: 'ses_1', usage, messages: [asked('m1', 'hi'), answered('답', { items: [tool] })] })
    expect(done.progress).toBeUndefined()
    expect(done.sentAt).toBeUndefined()
    expect(done.attention).toBeUndefined()
  })

  it('지워진 대화의 턴 끝(목록 정보 없음)도 말풍선은 붙인다. 엔진 세션은 아는 것을 그대로 둔다', () => {
    const running = { ...applyChat(blank, started(asked('m1', 'hi'))), engineSessionId: 'ses_1' }
    const done = applyChat(running, ended(answered('', { error: '중단됨', interrupted: true })))
    expect(done).toMatchObject({ pending: false, engineSessionId: 'ses_1' })
    expect(done.messages.at(-1)).toMatchObject({ error: '중단됨', interrupted: true })
  })

  it('대기열 이벤트: 줄 글·붙잡힘 — 멈춘 턴의 대기열은 held 로 와서 화면이 입력창으로 되돌린다', () => {
    expect(applyChat(blank, queue(['a', 'b'], true))).toMatchObject({ queue: ['a', 'b'], held: true })
  })

  it('applyLive·applyHistory: 다시 뜬 화면이 도는 턴을 이어 그린다 — 스냅샷이 없는 대화는 그대로', () => {
    expect(applyLive(blank, undefined)).toBe(blank)
    const live = { turn: { message: asked('m2', '도는 중'), startedAt: 5_000, progress: [think], attention: [] }, queue: { cid: 'c1', items: ['다음'], held: false, attachments: [] } }
    const session = applyLive(blank, live)
    expect(session).toMatchObject({ pending: true, sentAt: 5_000, progress: [think], queue: ['다음'] })
    const loaded = applyHistory(session, [asked('m1', 'hi'), answered('답'), asked('m2', '도는 중'), answered('쓰다 만')])
    expect(loaded.messages.map((message) => message.text)).toEqual(['hi', '답', '도는 중'])
    expect(loaded.pending).toBe(true)
  })
})

describe('대화 화면의 판정 (App.tsx 에서 옮김)', () => {
  it('titleFrom: 첫 메시지의 비지 않은 첫 줄, 앞뒤 공백 없이, 길면 자른다', () => {
    expect(titleFrom('\n  hello world  \nsecond')).toBe('hello world')
    expect(titleFrom('x'.repeat(200))).toHaveLength(TITLE_MAX)
    expect(titleFrom('')).toBe('')
  })

  it('queueLabel: 보일 글 > 본문 > (글 없이 첨부만) 파일 이름들', () => {
    expect(queueLabel({ text: 'expanded', display: '/hi' })).toBe('/hi')
    expect(queueLabel({ text: 'plain' })).toBe('plain')
    expect(queueLabel({ text: '', attachments: [{ kind: 'file', path: '/w/a.md', name: 'a.md', size: 1 }, { kind: 'image', path: '/w/b.png', name: 'b.png', size: 2 }] })).toBe('a.md, b.png')
  })

  it('switchedMode: 앞 내 말과 모드가 다른 내 말 자리에 구분선 — 첫 내 말·모드 없는 말은 아니다', () => {
    const messages = [asked('m1', 'a', { mode: 'plan' }), answered('1'), asked('m2', 'b', { mode: 'plan' }), answered('2'), asked('m3', 'c', { mode: 'build' })]
    expect([0, 2, 4].map((index) => switchedMode(messages, index))).toEqual([false, false, true])
    expect(switchedMode([asked('m1', 'a', { mode: 'plan' }), asked('m2', 'b', { mode: undefined })], 1)).toBe(false)
  })

  it('planEnded: 마지막 턴이 계획 모드로 잘 끝났을 때만 "이 계획대로 실행" — 실패·거절·다른 모드는 아니다', () => {
    const plan = asked('m1', '계획', { mode: 'plan' })
    expect(planEnded([plan, answered('계획입니다')])).toBe(true)
    expect(planEnded([plan, answered('', { error: 'boom' })])).toBe(false)
    expect(planEnded([plan, answered('', { declined: true })])).toBe(false)
    expect(planEnded([asked('m1', 'x', { mode: 'build' }), answered('답')])).toBe(false)
    expect(planEnded([plan])).toBe(false)
  })
})
