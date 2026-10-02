import { describe, expect, it } from 'vitest'
import { messageItems, toolSummary, TurnScope, TurnTracker } from '../../src/services/turnProgress.ts'

// 턴 중 opencode 레거시 이벤트 → 진행 줄. 이벤트 모양은 01w 실측 그대로 (GET /event 의 {type, properties}, opencode 1.18.18 `hello [think]`·`[bash:pwd]`)

const S = 'ses_1'
const U = 'msg_user'
const A = 'msg_answer'
const updated = (part: Record<string, unknown>, time = 1) => ['message.part.updated', { sessionID: S, part: { sessionID: S, messageID: A, ...part }, time }] as const
const delta = (partID: string, text: string, messageID = A) => ['message.part.delta', { sessionID: S, messageID, partID, field: 'text', delta: text }] as const
const info = (extra: Record<string, unknown>) => ['message.updated', { sessionID: S, info: { sessionID: S, ...extra } }] as const

describe('TurnScope — 이 턴의 메시지 가리기 (parentID)', () => {
  it('내 user 메시지는 user, parentID 가 내 메시지인 assistant 와 그 파트·조각은 assistant, 나머지는 없음', () => {
    const scope = new TurnScope(S, U)
    expect(scope.of(...info({ id: U, role: 'user' }))).toBe('user')
    expect(scope.of(...updated({ type: 'text', id: 'prt_echo', messageID: U, text: 'hello' }))).toBe('user') // 내 글의 에코
    expect(scope.of(...updated({ type: 'text', id: 'prt_x' }))).toBeUndefined() // 아직 모르는 메시지
    expect(scope.of(...info({ id: A, role: 'assistant', parentID: U }))).toBe('assistant')
    expect(scope.of(...updated({ type: 'text', id: 'prt_x' }))).toBe('assistant')
    expect(scope.of(...delta('prt_x', 'h'))).toBe('assistant')
    expect(scope.owns(A)).toBe(true)
  })

  it('같은 세션에 다른 클라이언트가 보낸 턴의 답·다른 세션(task 자식)은 섞이지 않는다', () => {
    const scope = new TurnScope(S, U)
    expect(scope.of(...info({ id: 'msg_b', role: 'assistant', parentID: 'msg_other' }))).toBeUndefined()
    expect(scope.of('message.updated', { sessionID: 'ses_child', info: { id: 'msg_c', sessionID: 'ses_child', role: 'assistant', parentID: U } })).toBeUndefined()
    expect(scope.of('message.part.delta', { sessionID: 'ses_child', messageID: A, partID: 'p', delta: 'x' })).toBeUndefined()
    expect(scope.owns('msg_b')).toBe(false)
  })
})

describe('TurnTracker', () => {
  it('생각: 빈 글로 시작, 조각(field 가 "text" 여도 partID 로 생각)은 누적, time.end 의 완성본으로 덮고 그 뒤 조각은 버린다', () => {
    const tracker = new TurnTracker()
    expect(tracker.observe(...updated({ type: 'reasoning', id: 'prt_r', text: '', time: { start: 1 } }))).toEqual({ kind: 'think', id: `${A}:prt_r`, text: '', done: false })
    expect(tracker.observe(...delta('prt_r', '**Plan** a'))).toMatchObject({ kind: 'think', text: '**Plan** a', done: false })
    expect(tracker.observe(...delta('prt_r', ' b'))).toMatchObject({ text: '**Plan** a b' })
    expect(tracker.observe(...updated({ type: 'reasoning', id: 'prt_r', text: '**Plan** a b c', time: { start: 1, end: 2 } }))).toMatchObject({ text: '**Plan** a b c', done: true })
    expect(tracker.observe(...delta('prt_r', 'late'))).toBeUndefined()
  })

  it('글: 시작·조각·완성본. 답 글은 글 줄을 나타난 순서대로 이은 것 (생각·도구는 빠진다)', () => {
    const tracker = new TurnTracker()
    tracker.observe(...updated({ type: 'reasoning', id: 'prt_r', text: 'think', time: { start: 1, end: 2 } }))
    tracker.observe(...updated({ type: 'text', id: 'prt_t', text: '', time: { start: 3 } }))
    expect(tracker.observe(...delta('prt_t', 'echo: hell'))).toMatchObject({ kind: 'text', text: 'echo: hell', done: false })
    expect(tracker.observe(...updated({ type: 'text', id: 'prt_t', text: 'echo: hello', time: { start: 3, end: 4 } }))).toMatchObject({ text: 'echo: hello', done: true })
    expect(tracker.text()).toBe('echo: hello')
  })

  it('시작(빈 글)이 조각보다 늦게 와도 쌓인 조각을 지우지 않는다. 모르는 파트의 조각은 버린다', () => {
    const tracker = new TurnTracker()
    expect(tracker.observe(...delta('prt_unknown', 'x'))).toBeUndefined()
    tracker.observe(...updated({ type: 'text', id: 'prt_t', text: '', time: { start: 3 } }))
    tracker.observe(...delta('prt_t', 'Hi'))
    expect(tracker.observe(...updated({ type: 'text', id: 'prt_t', text: '', time: { start: 3 } }))).toBeUndefined()
  })

  it('도구: pending(준비) → running(실행 중, 설명) → bash 실시간 출력 → completed(끝, 결과). 같은 part id 를 덮어쓴다', () => {
    const tracker = new TurnTracker()
    const tool = (state: Record<string, unknown>) => updated({ type: 'tool', id: 'prt_b', tool: 'bash', callID: 'call_1', state })
    expect(tracker.observe(...tool({ status: 'pending', input: {}, raw: '' }))).toEqual({ kind: 'tool', id: `${A}:prt_b`, name: 'bash', status: 'preparing' })
    expect(tracker.observe(...tool({ status: 'running', input: { command: 'sleep 2; echo hi', description: 'Wait two seconds' }, time: { start: 1 } }))).toMatchObject({
      status: 'running',
      summary: 'Wait two seconds',
      input: '{"command":"sleep 2; echo hi","description":"Wait two seconds"}',
    })
    expect(tracker.observe(...tool({ status: 'running', input: { command: 'x' }, metadata: { output: 'hi\n' }, time: { start: 1 } }))).toMatchObject({ result: 'hi\n' })
    expect(tracker.observe(...tool({ status: 'completed', input: { command: 'x', description: 'D' }, output: 'hi\n', metadata: { exit: 0 }, time: { start: 1, end: 2 } }))).toMatchObject({
      status: 'done',
      result: 'hi\n',
    })
  })

  it('도구 실패는 error 줄 (레거시 error 는 문자열). 단계·스텝 파트는 줄이 아니다', () => {
    const tracker = new TurnTracker()
    expect(
      tracker.observe(...updated({ type: 'tool', id: 'prt_b', tool: 'bash', callID: 'c', state: { status: 'error', input: { command: 'pwd' }, error: 'The user rejected permission to use this specific tool call.' } })),
    ).toMatchObject({ status: 'error', error: 'The user rejected permission to use this specific tool call.', name: 'bash' })
    expect(tracker.observe(...updated({ type: 'step-start', id: 'prt_s' }))).toBeUndefined()
    expect(tracker.observe(...updated({ type: 'step-finish', id: 'prt_f', reason: 'stop', tokens: {} }))).toBeUndefined()
    expect(tracker.observe('session.idle', { sessionID: S })).toBeUndefined()
  })
})

describe('toolSummary', () => {
  it('bash 는 description, 없으면 command 첫 줄. 다른 도구는 흔한 인자', () => {
    expect(toolSummary({ command: 'ls -la\necho', description: 'List files' })).toBe('List files')
    expect(toolSummary({ command: 'ls -la\necho' })).toBe('ls -la')
    expect(toolSummary({ filePath: '/p/a.ts' })).toBe('/p/a.ts')
    expect(toolSummary({ pattern: 'TODO' })).toBe('TODO')
    expect(toolSummary(undefined)).toBeUndefined()
  })
})

describe('messageItems (지난 대화)', () => {
  it('reasoning·text·tool 파트를 같은 줄 모양으로 — 끝난 기록이라 done. 합성 글·단계 파트는 줄이 아니다', () => {
    expect(
      messageItems([
        { type: 'step-start', id: 'p0', messageID: 'm' },
        { type: 'reasoning', id: 'p1', messageID: 'm', text: 'think' },
        { type: 'text', id: 'p2', messageID: 'm', text: 'Let me check' },
        { type: 'tool', id: 'p3', messageID: 'm', tool: 'bash', state: { status: 'completed', input: { command: 'ls', description: 'List' }, output: 'a' } },
        { type: 'tool', id: 'p4', messageID: 'm', tool: 'read', state: { status: 'error', input: { filePath: '/x' }, error: 'nope' } },
        { type: 'text', id: 'p5', messageID: 'm', text: 'hidden', synthetic: true },
        { type: 'step-finish', id: 'p6', messageID: 'm' },
      ]),
    ).toEqual([
      { kind: 'think', id: 'm:p1', text: 'think', done: true },
      { kind: 'text', id: 'm:p2', text: 'Let me check', done: true },
      { kind: 'tool', id: 'm:p3', name: 'bash', status: 'done', input: '{"command":"ls","description":"List"}', summary: 'List', result: 'a' },
      { kind: 'tool', id: 'm:p4', name: 'read', status: 'error', input: '{"filePath":"/x"}', summary: '/x', error: 'nope' },
    ])
  })
})
