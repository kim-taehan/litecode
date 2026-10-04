import { describe, expect, it } from 'vitest'
import { awaitCaller, findCaller, ToolCalls, type LiveCalls } from '../../src/services/toolCalls.ts'
import type { EnginePart } from '../../src/services/turnProgress.ts'

// 부른 대화 찾기 (이슈 #55, 01z 1-2) — 앱 MCP 서버의 호출 요청에는 "누가 불렀나" 가 없다. 그 폴더에서 같은 도구·같은 인자로 running 인
// 도구 파트를 찾아 세션·callID 를 얻는다. 승인 기록: 사용자가 앱에서 허용한 callID 만 approved 다 (한 번 쓰면 소진)

const TOOL = 'litecode_send_to_session'
const part = (callID: string, status: string, input: unknown, sessionID = 'ses_a', tool = TOOL): EnginePart => ({ type: 'tool', tool, callID, sessionID, state: { status, input } })
const live = (sessionId: string, workdir = '/p'): LiveCalls => ({ sessionId, workdir, calls: new ToolCalls() })
const ARGS = { session: 'c-1', message: 'hi' }

describe('ToolCalls', () => {
  it('running 파트만 쥔다 — pending 은 아직 인자가 없고, 끝난 것은 뺀다', () => {
    const calls = new ToolCalls()
    calls.observe(part('call_1', 'pending', {}), false)
    expect(calls.matching(TOOL, {})).toEqual([])
    calls.observe(part('call_1', 'running', ARGS), false)
    expect(calls.matching(TOOL, ARGS).map((call) => call.callId)).toEqual(['call_1'])
    expect(calls.inputOf('call_1')).toEqual(ARGS)
    calls.observe(part('call_1', 'completed', ARGS), false)
    expect(calls.matching(TOOL, ARGS)).toEqual([])
  })

  it('인자는 깊게 비교한다 — 값·키가 하나라도 다르면 짝이 아니다', () => {
    const calls = new ToolCalls()
    calls.observe(part('call_1', 'running', { session: 'c-1', message: 'hi', nested: { a: [1, 2] } }), false)
    expect(calls.matching(TOOL, { nested: { a: [1, 2] }, message: 'hi', session: 'c-1' })).toHaveLength(1) // 키 순서는 상관없다
    expect(calls.matching(TOOL, { session: 'c-1', message: 'hi', nested: { a: [1, 3] } })).toEqual([])
    expect(calls.matching(TOOL, { session: 'c-1', message: 'hi' })).toEqual([])
    expect(calls.matching('litecode_start_session', { session: 'c-1', message: 'hi', nested: { a: [1, 2] } })).toEqual([])
  })

  it('승인 기록 — 허용한 callID 만 approved 이고, 한 번 쓴 callID 는 다시 짝이 되지 않는다', () => {
    const calls = new ToolCalls()
    calls.observe(part('call_1', 'running', ARGS), false)
    calls.approve('call_1')
    expect(calls.claim('call_1')).toEqual({ approved: true })
    expect(calls.matching(TOOL, ARGS)).toEqual([]) // 소진
    expect(calls.claim('call_1')).toEqual({ approved: false })
    // running 이 다시 와도(같은 파트의 갱신) 되살아나지 않는다
    calls.observe(part('call_1', 'running', ARGS), false)
    expect(calls.matching(TOOL, ARGS)).toEqual([])
  })

  it('허용을 되돌리면(답 전송 실패) 기록이 없다', () => {
    const calls = new ToolCalls()
    calls.observe(part('call_1', 'running', ARGS), false)
    calls.approve('call_1')
    calls.revoke('call_1')
    expect(calls.claim('call_1')).toEqual({ approved: false })
  })

  // 이슈 #67 — 승인 카드에서 사용자가 고른 받을 대화가 허용 기록에 함께 적힌다
  it('허용하며 고른 받을 대화는 기록에 실려 한 번만 나온다 — 소진된 뒤·되돌린 뒤에는 없다', () => {
    const calls = new ToolCalls()
    calls.observe(part('call_1', 'running', ARGS), false)
    calls.approve('call_1', { kind: 'conversation', conversationId: 'c9' })
    expect(calls.claim('call_1')).toEqual({ approved: true, target: { kind: 'conversation', conversationId: 'c9' } })
    expect(calls.claim('call_1')).toEqual({ approved: false })
    calls.observe(part('call_2', 'running', ARGS), false)
    calls.approve('call_2', { kind: 'new' })
    calls.revoke('call_2')
    expect(calls.claim('call_2')).toEqual({ approved: false })
  })
})

describe('findCaller', () => {
  it('일치 하나 — 그 턴의 세션·callID·승인 여부를 준다', () => {
    const a = live('ses_a')
    a.calls.observe(part('call_1', 'running', ARGS), false)
    a.calls.approve('call_1')
    expect(findCaller([a], '/p', TOOL, ARGS)).toEqual({ sessionId: 'ses_a', callId: 'call_1', child: false, approved: true })
  })

  it('사용자가 고른 받을 대화가 부른 대화와 함께 온다 (이슈 #67)', () => {
    const a = live('ses_a')
    a.calls.observe(part('call_1', 'running', ARGS), false)
    a.calls.approve('call_1', { kind: 'new' })
    expect(findCaller([a], '/p', TOOL, ARGS)).toEqual({ sessionId: 'ses_a', callId: 'call_1', child: false, approved: true, target: { kind: 'new' } })
  })

  it('허용 기록이 없는 호출(엔진 API 로 스스로 허용)은 approved 가 false 다', () => {
    const a = live('ses_a')
    a.calls.observe(part('call_1', 'running', ARGS), false)
    expect(findCaller([a], '/p', TOOL, ARGS)).toMatchObject({ callId: 'call_1', approved: false })
  })

  it('없음 — 인자가 다르거나 다른 폴더의 턴이면 none', () => {
    const a = live('ses_a')
    a.calls.observe(part('call_1', 'running', ARGS), false)
    expect(findCaller([a], '/p', TOOL, { ...ARGS, message: 'other' })).toBe('none')
    expect(findCaller([a], '/other', TOOL, ARGS)).toBe('none')
    expect(findCaller([], '/p', TOOL, ARGS)).toBe('none')
  })

  it('둘 — 같은 도구·같은 인자가 두 턴(또는 한 턴에 둘)에서 돌면 가를 수 없다. 아무것도 소진하지 않는다', () => {
    const a = live('ses_a')
    const b = live('ses_b')
    a.calls.observe(part('call_1', 'running', ARGS), false)
    b.calls.observe(part('call_2', 'running', ARGS, 'ses_b'), false)
    expect(findCaller([a, b], '/p', TOOL, ARGS)).toBe('ambiguous')
    b.calls.observe(part('call_2', 'completed', ARGS, 'ses_b'), false)
    expect(findCaller([a, b], '/p', TOOL, ARGS)).toMatchObject({ sessionId: 'ses_a', callId: 'call_1' })
  })

  it('자식 세션(하위 작업)이 부른 것은 child 로 알린다 — 세션은 그 턴의 본 세션', () => {
    const a = live('ses_a')
    a.calls.observe(part('call_9', 'running', ARGS, 'ses_child'), true)
    expect(findCaller([a], '/p', TOOL, ARGS)).toEqual({ sessionId: 'ses_a', callId: 'call_9', child: true, approved: false })
  })
})

describe('awaitCaller', () => {
  it('이벤트가 요청보다 늦게 와도 기한 안이면 찾는다', async () => {
    const a = live('ses_a')
    setTimeout(() => a.calls.observe(part('call_1', 'running', ARGS), false), 30)
    expect(await awaitCaller(() => findCaller([a], '/p', TOOL, ARGS), 1_000)).toMatchObject({ callId: 'call_1' })
  })

  it('기한까지 안 오면 없다', async () => {
    const a = live('ses_a')
    const started = Date.now()
    expect(await awaitCaller(() => findCaller([a], '/p', TOOL, ARGS), 60)).toBeUndefined()
    expect(Date.now() - started).toBeGreaterThanOrEqual(55)
  })

  it('둘이면 기다리지 않고 바로 거절한다', async () => {
    const a = live('ses_a')
    a.calls.observe(part('call_1', 'running', ARGS), false)
    a.calls.observe(part('call_2', 'running', ARGS), false)
    const started = Date.now()
    expect(await awaitCaller(() => findCaller([a], '/p', TOOL, ARGS), 1_000)).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(500)
  })
})
