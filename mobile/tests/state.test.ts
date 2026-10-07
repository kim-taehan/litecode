import { describe, expect, it } from 'vitest'
import type { ConversationSnapshot, Hello, RemoteEvent } from '../../shared/remote.ts'
import { initialState, reduce, type RemoteAction, type RemoteState } from '../src/core/state.ts'

const hello = (runId: string, seq: number): Hello => ({ desktopId: 'd', name: 'pc', appVersion: '0', apiVersion: 1, runId, seq, addresses: ['10.0.0.2:47600'] })
const snapshot = (seq: number, extra: Partial<ConversationSnapshot> = {}): ConversationSnapshot => ({ history: { messages: [] }, seq, ...extra })
const run = (actions: RemoteAction[], from: RemoteState = initialState): RemoteState => actions.reduce(reduce, from)
const ev = (event: RemoteEvent): RemoteAction => ({ type: 'event', event })

const started = (seq: number, text = '안녕', id = 'm1'): RemoteAction => ev({ event: 'turn.started', seq, data: { cid: 'c1', origin: 'dev_1', message: { id, role: 'user', text } } })
const text = (seq: number, value: string, done = false): RemoteAction => ev({ event: 'turn.progress', seq, data: { cid: 'c1', item: { kind: 'text', id: 't1', text: value, done } } })
const ended = (seq: number, value = '답'): RemoteAction => ev({ event: 'turn.ended', seq, data: { cid: 'c1', outcome: 'done', message: { role: 'assistant', text: value } } })

/** hello(run A, seq 10) 뒤 대화 c1 을 seq 10 스냅샷으로 연 상태 */
const opened = (): RemoteState => run([{ type: 'hello', hello: hello('A', 10) }, { type: 'conversation.loading', cid: 'c1' }, { type: 'conversation.loaded', cid: 'c1', snapshot: snapshot(10) }])

describe('리듀서 — 턴 이벤트', () => {
  it('started → progress → ended 로 말풍선 둘과 빈 진행 줄이 된다', () => {
    const during = run([started(11), text(12, 'ec'), text(13, 'echo', true)], opened())
    expect(during.views['c1']).toMatchObject({ running: true, messages: [{ role: 'user', text: '안녕' }], progress: [{ id: 't1', text: 'echo', done: true }] })

    const after = reduce(during, ended(14))
    expect(after.views['c1']).toMatchObject({ running: false, progress: [], messages: [{ role: 'user' }, { role: 'assistant', text: '답' }] })
    expect(after.seq).toBe(14)
  })

  it('같은 id 의 progress 는 줄을 늘리지 않고 그 자리를 바꾼다 (순서는 처음 나타난 순서)', () => {
    const tool = (seq: number, status: 'running' | 'done'): RemoteAction => ev({ event: 'turn.progress', seq, data: { cid: 'c1', item: { kind: 'tool', id: 'tool1', name: 'bash', status } } })
    const state = run([started(11), tool(12, 'running'), text(13, 'a'), tool(14, 'done'), text(15, 'ab')], opened())
    expect(state.views['c1']!.progress).toEqual([
      { kind: 'tool', id: 'tool1', name: 'bash', status: 'done' },
      { kind: 'text', id: 't1', text: 'ab', done: false },
    ])
  })

  it('같은 seq 가 두 번 오면(이어 받기 재생과 겹침) 한 번만 적용한다', () => {
    const state = run([started(11), started(11), ended(12), ended(12), started(11)], opened())
    expect(state.views['c1']!.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(state.views['c1']!.running).toBe(false)
    // 늦게 온 옛 이벤트가 쥔 seq 를 되돌리지 않는다 (되돌아가면 다음 이어 받기가 본 것을 또 받는다)
    expect(state.seq).toBe(12)
  })

  it('화면이 먼저 그려 둔 같은 id 의 말풍선은 turn.started 가 확정본으로 바꾼다', () => {
    const base = run([{ type: 'conversation.loaded', cid: 'c1', snapshot: snapshot(10, { history: { messages: [{ id: 'm1', role: 'user', text: '보내는 중' }] } }) }], opened())
    expect(reduce(base, started(11, '확정', 'm1')).views['c1']!.messages).toEqual([{ id: 'm1', role: 'user', text: '확정' }])
  })

  it('승인 요청·대기열은 마지막 값으로 바뀌고, 턴이 끝나면 승인 카드는 사라진다', () => {
    const request = { kind: 'permission' as const, id: 'per_1', sessionId: 's', action: 'bash', resources: ['ls'] }
    const waiting = run([started(11), ev({ event: 'turn.attention', seq: 12, data: { cid: 'c1', requests: [request] } }), ev({ event: 'queue.changed', seq: 13, data: { cid: 'c1', items: ['다음'] } })], opened())
    expect(waiting.views['c1']).toMatchObject({ attention: [request], queue: ['다음'] })
    expect(reduce(waiting, ended(14)).views['c1']).toMatchObject({ attention: [], queue: ['다음'] })
  })

  it('열지 않은 대화의 이벤트는 seq 만 넘긴다', () => {
    const state = run([{ type: 'hello', hello: hello('A', 10) }, started(11)])
    expect(state.views).toEqual({})
    expect(state.seq).toBe(11)
  })
})

describe('리듀서 — 스냅샷과 스트림 사이', () => {
  it('스냅샷이 스트림보다 앞서 있으면, 스냅샷 seq 이하의 이벤트는 다시 얹지 않는다', () => {
    // 스트림은 10 까지 봤는데 스냅샷은 12 시점이다 — 11(턴 시작)·12(턴 끝)는 이미 기록에 들어 있다
    const history = { messages: [{ id: 'm1', role: 'user' as const, text: '안녕' }, { role: 'assistant' as const, text: '답' }] }
    const base = run([{ type: 'hello', hello: hello('A', 10) }, { type: 'conversation.loaded', cid: 'c1', snapshot: snapshot(12, { history }) }])
    const replayed = run([started(11), text(11.5, 'ec'), ended(12)], base)
    expect(replayed.views['c1']).toMatchObject({ messages: history.messages, running: false, progress: [] })
    expect(replayed.views['c1']!.messages).toHaveLength(2)

    // 그 뒤(13~)는 얹는다
    expect(reduce(replayed, started(13, '또', 'm2')).views['c1']).toMatchObject({ running: true, messages: [{}, {}, { id: 'm2' }] })
  })

  it('스냅샷을 받는 동안 온 이벤트는 스냅샷 위에 다시 얹는다 (요청과 응답 사이에 턴이 시작돼도 잃지 않는다)', () => {
    const state = run([
      { type: 'hello', hello: hello('A', 10) },
      { type: 'conversation.loading', cid: 'c1' },
      started(11),
      text(12, 'ec'),
      { type: 'conversation.loaded', cid: 'c1', snapshot: snapshot(11, { history: { messages: [{ id: 'm1', role: 'user', text: '안녕' }] }, live: { progress: [], attention: [], queue: [] } }) },
    ])
    expect(state.views['c1']).toMatchObject({ running: true, messages: [{ id: 'm1' }], progress: [{ id: 't1', text: 'ec' }] })
    expect(state.loading).toEqual({})
  })

  it('턴이 도는 중인 스냅샷은 running 이고 진행 줄·승인·대기열을 그대로 싣는다', () => {
    const live = { progress: [{ kind: 'think' as const, id: 'k', text: '…', done: false }], attention: [], queue: ['q'] }
    const state = reduce(initialState, { type: 'conversation.loaded', cid: 'c1', snapshot: snapshot(3, { live }) })
    expect(state.views['c1']).toMatchObject({ running: true, progress: live.progress, queue: ['q'] })
  })
})

describe('리듀서 — 다시 받기', () => {
  it('reset 은 seq 를 서버 값으로 되돌리고(작아져도) resync 를 올린다 — 그 뒤 이벤트가 버려지지 않는다', () => {
    const before = run([started(11), text(12, 'ec')], opened())
    const state = reduce(before, ev({ event: 'reset', data: { runId: 'B', seq: 2 } }))
    expect(state).toMatchObject({ runId: 'B', seq: 2, resync: before.resync + 1 })

    // 새 실행의 작은 seq 도 적용된다 (열린 대화의 스냅샷 seq 도 같이 내려간다)
    expect(reduce(state, ended(3)).views['c1']!.running).toBe(false)
  })

  it('hello 의 runId 가 바뀌었으면(데스크탑 재시작) resync, 같으면 쥔 seq 를 그대로 둔다', () => {
    const before = run([started(11)], opened())
    expect(reduce(before, { type: 'hello', hello: hello('A', 40) })).toMatchObject({ runId: 'A', seq: 11, resync: 0 })
    expect(reduce(before, { type: 'hello', hello: hello('B', 0) })).toMatchObject({ runId: 'B', seq: 0, resync: 1 })
  })

  it('ready 의 runId 가 바뀌었을 때도 resync, 같으면 아무것도 안 바뀐다', () => {
    const before = opened()
    expect(reduce(before, ev({ event: 'ready', data: { runId: 'A', seq: 99 } }))).toBe(before)
    expect(reduce(before, ev({ event: 'ready', data: { runId: 'B', seq: 1 } }))).toMatchObject({ runId: 'B', seq: 1, resync: 1 })
  })

  it('conversations.changed 는 받아 둔 프로젝트만 낡았다고 적고, 다시 받으면 지운다', () => {
    const changed = (seq: number, project: string): RemoteAction => ev({ event: 'conversations.changed', seq, data: { project } })
    const state = run([{ type: 'conversations.loaded', project: '/p', conversations: [] }, changed(1, '/p'), changed(2, '/p'), changed(3, '/other')])
    expect(state.staleProjects).toEqual(['/p'])
    expect(reduce(state, { type: 'conversations.loaded', project: '/p', conversations: [] }).staleProjects).toEqual([])
  })

  // #187 B5 — 새 실행의 데스크탑은 "바뀔 때만" notices.changed 를 낸다. 도는 턴이 없으면 아무것도 안 와서 죽은 턴의 "답 필요" 점이 남았다.
  // 비우면 목록 화면은 다시 받은 목록의 status(데스크탑이 지금 도는 턴·안 본 끝남으로 채운다)를 쓴다
  it('reset·runId 가 바뀐 hello·ready 는 옛 실행의 notices 를 비운다', () => {
    const noticed = run([ev({ event: 'notices.changed', seq: 11, data: { c1: { project: '/p', status: 'attention' } } })], opened())
    expect(noticed.notices).not.toEqual({})
    expect(reduce(noticed, ev({ event: 'reset', data: { runId: 'B', seq: 0 } })).notices).toEqual({})
    expect(reduce(noticed, { type: 'hello', hello: hello('B', 0) }).notices).toEqual({})
    expect(reduce(noticed, ev({ event: 'ready', data: { runId: 'B', seq: 0 } })).notices).toEqual({})
    // 같은 실행이면 그대로
    expect(reduce(noticed, { type: 'hello', hello: hello('A', 40) }).notices).toEqual(noticed.notices)
  })

  it('notices·addresses 는 통째로 바뀐다', () => {
    const state = run([ev({ event: 'notices.changed', seq: 1, data: { c1: { project: '/p', status: 'running' } } }), ev({ event: 'addresses.changed', seq: 2, data: { addresses: ['10.0.0.9:47600'] } })])
    expect(state.notices).toEqual({ c1: { project: '/p', status: 'running' } })
    expect(state.addresses).toEqual(['10.0.0.9:47600'])
  })
})
