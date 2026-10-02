import { describe, expect, it } from 'vitest'
import { contextText, messageItems, toolSummary, TurnTracker } from '../../src/services/turnProgress.ts'

// 턴 중 opencode 이벤트 → 진행 줄. 이벤트 모양은 01g 실측 그대로 (세션 SSE + 전역 조각, opencode 1.18.18 [think-tool] 시나리오)

const M = 'msg_a'
const ev = (type: string, data: Record<string, unknown>) => [`session.next.${type}`, { sessionID: 'ses', assistantMessageID: M, timestamp: 1, ...data }] as const

describe('TurnTracker', () => {
  it('생각: started 는 빈 줄, 조각은 누적, ended 는 완성본으로 덮고 그 뒤 조각은 버린다', () => {
    const tracker = new TurnTracker()
    expect(tracker.observe(...ev('reasoning.started', { reasoningID: 'reasoning-0' }))).toEqual({ kind: 'think', id: 'msg_a:reasoning-0', text: '', done: false })
    expect(tracker.observe(...ev('reasoning.delta', { reasoningID: 'reasoning-0', delta: '**Plan** a' }))).toMatchObject({ text: '**Plan** a', done: false })
    expect(tracker.observe(...ev('reasoning.delta', { reasoningID: 'reasoning-0', delta: ' b' }))).toMatchObject({ text: '**Plan** a b' })
    expect(tracker.observe(...ev('reasoning.ended', { reasoningID: 'reasoning-0', text: '**Plan** a b c' }))).toMatchObject({ text: '**Plan** a b c', done: true })
    expect(tracker.observe(...ev('reasoning.delta', { reasoningID: 'reasoning-0', delta: 'late' }))).toBeUndefined()
  })

  it('조각이 started 보다 먼저 와도(스트림이 둘) 줄을 다시 비우지 않는다', () => {
    const tracker = new TurnTracker()
    tracker.observe(...ev('text.delta', { textID: 'text-0', delta: 'Hi' }))
    expect(tracker.observe(...ev('text.started', { textID: 'text-0' }))).toBeUndefined()
    expect(tracker.observe(...ev('text.ended', { textID: 'text-0', text: 'Hi there' }))).toMatchObject({ kind: 'text', text: 'Hi there', done: true })
  })

  it('스텝마다 -0 부터 다시 시작하는 id 는 assistantMessageID 로 가른다', () => {
    const tracker = new TurnTracker()
    const a = tracker.observe('session.next.text.started', { assistantMessageID: 'm1', textID: 'text-0' })
    const b = tracker.observe('session.next.text.started', { assistantMessageID: 'm2', textID: 'text-0' })
    expect(a?.id).not.toBe(b?.id)
  })

  it('도구: input.started(준비) → called(실행 중, 설명) → success(끝, 결과)', () => {
    const tracker = new TurnTracker()
    expect(tracker.observe(...ev('tool.input.started', { callID: 'call_a', name: 'bash' }))).toEqual({
      kind: 'tool', id: 'msg_a:call_a', name: 'bash', status: 'preparing',
    })
    expect(
      tracker.observe(...ev('tool.called', { callID: 'call_a', tool: 'bash', input: { command: 'sleep 2; echo hi', description: 'Wait two seconds' } })),
    ).toMatchObject({ name: 'bash', status: 'running', summary: 'Wait two seconds', input: '{"command":"sleep 2; echo hi","description":"Wait two seconds"}' })
    expect(
      tracker.observe(...ev('tool.success', { callID: 'call_a', content: [{ type: 'text', text: 'hi\n' }, { type: 'text', text: 'Command exited with code 0.' }] })),
    ).toMatchObject({ status: 'done', result: 'hi\nCommand exited with code 0.', summary: 'Wait two seconds' })
  })

  it('도구 실패는 error 줄. 이 턴에서 시작하지 않은 도구의 끝(앞 턴 매듭)은 버린다', () => {
    const tracker = new TurnTracker()
    expect(tracker.observe(...ev('tool.failed', { callID: 'old', error: { message: 'Tool execution interrupted' } }))).toBeUndefined()
    tracker.observe(...ev('tool.input.started', { callID: 'c', name: 'read' }))
    expect(tracker.observe(...ev('tool.failed', { callID: 'c', error: { type: 'unknown', message: 'Invalid tool input' } }))).toMatchObject({
      status: 'error', error: 'Invalid tool input', name: 'read',
    })
  })

  it('지시문 바뀜은 context 줄, 그 밖의 이벤트는 줄이 아니다', () => {
    const tracker = new TurnTracker()
    expect(
      tracker.observe('session.next.context.updated', { messageID: 'msg_s', text: 'These instructions replace…\n\nInstructions from: /p/AGENTS.md\n# 규칙' }),
    ).toEqual({ kind: 'context', id: 'context:msg_s', text: '지시문 바뀜 · AGENTS.md' })
    expect(tracker.observe(...ev('step.ended', { finish: 'stop' }))).toBeUndefined()
    expect(tracker.observe('server.connected', {})).toBeUndefined()
  })
})

describe('toolSummary·contextText', () => {
  it('bash 는 description, 없으면 command 첫 줄. 다른 도구는 흔한 인자', () => {
    expect(toolSummary({ command: 'ls\npwd' })).toBe('ls')
    expect(toolSummary({ filePath: '/a/b.ts' })).toBe('/a/b.ts')
    expect(toolSummary({ pattern: 'needle' })).toBe('needle')
    expect(toolSummary({})).toBeUndefined()
    expect(toolSummary('')).toBeUndefined()
  })

  it('지시문 출처가 없으면 "지시문 바뀜" 만', () => {
    expect(contextText('x')).toBe('지시문 바뀜')
  })
})

describe('messageItems (지난 대화)', () => {
  it('reasoning·text·tool 파트를 같은 줄 모양으로 — 끝난 기록이라 done', () => {
    expect(
      messageItems('m', [
        { type: 'reasoning', text: 'think' },
        { type: 'text', text: 'Let me check' },
        { type: 'tool', id: 'p3', name: 'bash', state: { status: 'completed', input: { command: 'ls', description: 'List' }, content: [{ text: 'a' }] } },
        { type: 'tool', name: 'read', state: { status: 'error', input: { filePath: '/x' }, error: { message: 'nope' } } },
      ]),
    ).toEqual([
      { kind: 'think', id: 'm:0', text: 'think', done: true },
      { kind: 'text', id: 'm:1', text: 'Let me check', done: true },
      { kind: 'tool', id: 'm:p3', name: 'bash', status: 'done', input: '{"command":"ls","description":"List"}', summary: 'List', result: 'a' },
      { kind: 'tool', id: 'm:3', name: 'read', status: 'error', input: '{"filePath":"/x"}', summary: '/x', error: 'nope' },
    ])
  })
})
