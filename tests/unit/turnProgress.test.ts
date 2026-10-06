import { describe, expect, it } from 'vitest'
import { messageItems, subtaskSessions, toolSummary, TurnScope, TurnTracker } from '../../src/services/turnProgress.ts'

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

describe('TurnScope — 자동 요약 (이슈 #20 L2 실측 순서)', () => {
  const C = 'msg_compaction'
  const K = 'msg_continue'
  it('이 턴 안의 요약 user(compaction 파트)와 그 뒤 user 하나(Continue)를 이 턴 것으로 받는다 — 요약 답은 summary, Continue 의 답은 이 턴 답', () => {
    const scope = new TurnScope(S, U)
    scope.of(...info({ id: U, role: 'user' }))
    scope.of(...info({ id: A, role: 'assistant', parentID: U }))
    expect(scope.of(...info({ id: C, role: 'user' }))).toBeUndefined() // 아직 모른다 — 파트가 와야 요약 user 인지 안다
    expect(scope.of(...updated({ type: 'compaction', id: 'prt_c', messageID: C, auto: true, overflow: false }))).toBe('user')
    expect(scope.of(...info({ id: 'msg_sum', role: 'assistant', parentID: C, summary: true, agent: 'compaction' }))).toBe('summary')
    expect(scope.of(...updated({ type: 'text', id: 'prt_s', messageID: 'msg_sum', text: '## Objective' }))).toBe('summary')
    expect(scope.of(...delta('prt_s', 'x', 'msg_sum'))).toBe('summary')
    expect(scope.of(...info({ id: K, role: 'user' }))).toBe('user') // 이음 — 합성 Continue 든 앞 user 의 복사본이든
    expect(scope.of(...info({ id: 'msg_after', role: 'assistant', parentID: K }))).toBe('assistant')
    expect(scope.owns('msg_after')).toBe(true)
    expect(scope.owns('msg_sum')).toBe(false)
    expect(scope.of(...info({ id: 'msg_next', role: 'user' }))).toBeUndefined() // 그다음 user 는 다른 턴
  })

  it('요약이 실패하면(요약 답 error) 이음이 없다 — 그 뒤 user 는 이 턴 것이 아니다. 내 user 전의 요약 user 도 아니다', () => {
    const scope = new TurnScope(S, U)
    expect(scope.of(...updated({ type: 'compaction', id: 'p0', messageID: 'msg_before' }))).toBeUndefined()
    scope.of(...info({ id: U, role: 'user' }))
    scope.of(...info({ id: C, role: 'user' }))
    scope.of(...updated({ type: 'compaction', id: 'prt_c', messageID: C }))
    expect(scope.of(...info({ id: 'msg_sum', role: 'assistant', parentID: C, summary: true, error: { name: 'ContextOverflowError' } }))).toBe('summary')
    expect(scope.of(...info({ id: 'msg_other', role: 'user' }))).toBeUndefined()
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

  // 이슈 #102 2단계 (01af §4): 사유를 실어 거절하면 엔진이 고정 문구 뒤에 사유를 붙인다 — 실행 전에 막힌 호출이다. 화면엔 사유만 간다
  it('실행 전에 막힌 도구: 엔진의 고정 문구를 떼고 사유만 싣고 blocked 로 표시한다 — 사용자의 거절(사유 없음)은 그대로', () => {
    const tracker = new TurnTracker()
    const error = 'The user rejected permission to use this specific tool call with the following feedback: rm -rf 는 금지입니다'
    const item = tracker.observe(...updated({ type: 'tool', id: 'prt_b', tool: 'bash', callID: 'c', state: { status: 'error', input: { command: 'rm -rf build' }, error } }))
    expect(item).toMatchObject({ status: 'error', error: 'rm -rf 는 금지입니다', blocked: true })
    const rejected = tracker.observe(...updated({ type: 'tool', id: 'prt_c', tool: 'bash', callID: 'd', state: { status: 'error', input: {}, error: 'The user rejected permission to use this specific tool call.' } }))
    expect(rejected).not.toHaveProperty('blocked')
  })
})

describe('TurnTracker — 요약·재시도·diff (이슈 #20 L2)', () => {
  it('요약 줄: running → done(또는 failed). 끝난 줄은 다시 안 바뀐다', () => {
    const tracker = new TurnTracker()
    expect(tracker.compaction('msg_c', 'running')).toEqual({ kind: 'compaction', id: 'msg_c:compaction', status: 'running' })
    expect(tracker.compaction('msg_c', 'running')).toBeUndefined()
    expect(tracker.compaction('msg_c', 'done')).toEqual({ kind: 'compaction', id: 'msg_c:compaction', status: 'done' })
    expect(tracker.compaction('msg_c', 'failed')).toBeUndefined()
    expect(tracker.compaction('msg_d', 'failed')).toMatchObject({ status: 'failed' })
  })

  it('재시도 줄: session.status retry 면 waiting(몇 번째·사유), 다시 busy 면 done. 그 뒤 또 재시도하면 새 줄', () => {
    const tracker = new TurnTracker()
    expect(tracker.status({ type: 'busy' })).toBeUndefined()
    expect(tracker.status({ type: 'retry', attempt: 1, message: 'Internal Server Error' })).toEqual({ kind: 'retry', id: 'retry:0', attempt: 1, message: 'Internal Server Error', status: 'waiting' })
    expect(tracker.status({ type: 'retry', attempt: 2, message: 'Internal Server Error' })).toMatchObject({ id: 'retry:0', attempt: 2, status: 'waiting' })
    expect(tracker.status({ type: 'busy' })).toMatchObject({ id: 'retry:0', status: 'done' })
    expect(tracker.status({ type: 'busy' })).toBeUndefined()
    expect(tracker.status({ type: 'retry', attempt: 1, message: 'x' })).toMatchObject({ id: 'retry:1', status: 'waiting' })
  })

  it('끝난 edit 도구는 metadata.filediff 로 diffs 를 싣는다 — 경로는 세션 폴더 기준 상대', () => {
    const tracker = new TurnTracker('/p')
    const patch = 'Index: /p/a.txt\n===\n--- /p/a.txt\n+++ /p/a.txt\n@@ -1 +1 @@\n-a\n+A\n'
    const item = tracker.observe(
      ...updated({ type: 'tool', id: 'prt_e', tool: 'edit', callID: 'c', state: { status: 'completed', input: { filePath: '/p/a.txt' }, output: 'Edit applied successfully.', metadata: { filediff: { file: '/p/a.txt', patch } } } }),
    )
    expect(item).toMatchObject({ status: 'done', diffs: [{ path: 'a.txt', status: 'modified', added: 1, removed: 1, patch }] })
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

// 이슈 #31 실측 (2026-10-02, opencode 1.18.18, 가짜 LLM `[calls:…]` 로 task 2개): 부모 task 파트 running 에 metadata.sessionId(자식) → 자식 세션 이벤트가
// 같은 /event 에 자식 sessionID 로 (user 에코 → assistant → 파트 → step-finish → 자식 session.idle) → 부모 task 파트 completed
describe('TurnTracker — 하위 작업 (task, 이슈 #31)', () => {
  const task = (id: string, child: string, state: Record<string, unknown>) =>
    updated({
      type: 'tool',
      id,
      tool: 'task',
      callID: `call_${id}`,
      state: { input: { subagent_type: 'general', description: `job ${id}`, prompt: '[bash:sleep 3] child' }, metadata: { parentSessionId: S, sessionId: child }, ...state },
    })
  const childInfo = (child: string, id: string, role: 'user' | 'assistant') => ['message.updated', { sessionID: child, info: { id, sessionID: child, role } }] as const
  const childPart = (child: string, messageID: string, part: Record<string, unknown>) =>
    ['message.part.updated', { sessionID: child, part: { sessionID: child, messageID, ...part } }] as const

  it('task 파트는 하위 작업 줄 — 준비(빈 인자) → 진행(에이전트·설명·시작 시각) → 완료(끝 시각), 실패는 사유', () => {
    const tracker = new TurnTracker()
    expect(tracker.observe(...updated({ type: 'tool', id: 't1', tool: 'task', callID: 'c', state: { status: 'pending', input: {} } }))).toEqual({
      kind: 'subtask',
      id: `${A}:t1`,
      agent: '',
      description: '',
      status: 'preparing',
      items: [],
    })
    expect(tracker.observe(...task('t1', 'ses_c1', { status: 'running', time: { start: 100 } }))).toEqual({
      kind: 'subtask',
      id: `${A}:t1`,
      agent: 'general',
      description: 'job t1',
      status: 'running',
      startedAt: 100,
      items: [],
    })
    expect(tracker.observe(...task('t1', 'ses_c1', { status: 'completed', output: '<task id="ses_c1" state="completed">…', time: { start: 100, end: 4100 } }))).toMatchObject({
      status: 'done',
      startedAt: 100,
      endedAt: 4100,
    })
    expect(tracker.observe(...task('t2', 'ses_c2', { status: 'error', error: 'The user has specified a rule which prevents…', time: { start: 100, end: 200 } }))).toMatchObject({
      status: 'error',
      error: 'The user has specified a rule which prevents…',
    })
    // 부모를 멈추면 opencode 가 task 를 "Task cancelled" 로 끝낸다 — 실패가 아니라 중단
    const stopped = tracker.observe(...task('t3', 'ses_c3', { status: 'error', error: 'Task cancelled', time: { start: 100, end: 200 } }))
    expect(stopped).toMatchObject({ status: 'stopped' })
    expect(stopped).not.toHaveProperty('error')
  })

  it('자식 세션 이벤트는 그 하위 작업 줄 안으로 — user 에코는 버리고 도구·글을 쌓고 스텝 토큰을 더한다. 두 하위 작업이 섞이지 않는다', () => {
    const tracker = new TurnTracker()
    tracker.observe(...task('t1', 'ses_c1', { status: 'running', time: { start: 100 } }))
    tracker.observe(...task('t2', 'ses_c2', { status: 'running', time: { start: 101 } }))
    expect(tracker.isChild('ses_c1')).toBe(true)
    expect(tracker.isChild('ses_other')).toBe(false)
    expect(tracker.child(...childInfo('ses_c1', 'mu1', 'user'))).toBeUndefined()
    expect(tracker.child(...childPart('ses_c1', 'mu1', { type: 'text', id: 'pe', text: '[bash:sleep 3] child' }))).toBeUndefined() // 에코
    tracker.child(...childInfo('ses_c1', 'ma1', 'assistant'))
    tracker.child(...childInfo('ses_c2', 'ma2', 'assistant'))
    expect(tracker.child(...childPart('ses_c1', 'ma1', { type: 'tool', id: 'pb', tool: 'bash', state: { status: 'running', input: { command: 'sleep 3', description: 'Wait' } } }))).toMatchObject({
      kind: 'subtask',
      id: `${A}:t1`,
      items: [{ kind: 'tool', id: 'ma1:pb', name: 'bash', status: 'running', summary: 'Wait' }],
    })
    expect(tracker.child(...childPart('ses_c2', 'ma2', { type: 'text', id: 'pt', text: 'B done', time: { start: 1, end: 2 } }))).toMatchObject({
      id: `${A}:t2`,
      items: [{ kind: 'text', text: 'B done', done: true }],
    })
    expect(tracker.child(...childPart('ses_c1', 'ma1', { type: 'step-finish', id: 'pf', tokens: { input: 700, output: 50, reasoning: 0, cache: { read: 300, write: 0 } } }))).toMatchObject({
      id: `${A}:t1`,
      tokens: 1050,
    })
    expect(tracker.child('session.idle', { sessionID: 'ses_c1' })).toBeUndefined()
    // 부모 task 파트가 끝나도 자식 줄·토큰은 남는다
    expect(tracker.observe(...task('t1', 'ses_c1', { status: 'completed', output: 'x', time: { start: 100, end: 300 } }))).toMatchObject({
      status: 'done',
      tokens: 1050,
      items: [{ name: 'bash' }],
    })
    expect(tracker.subtaskOf('ses_c2')).toMatchObject({ agent: 'general', description: 'job t2' })
    // 하위 작업 줄 id → 그 자식 세션 (하나만 멈출 때, #32)
    expect(tracker.childSession(`${A}:t2`)).toBe('ses_c2')
    expect(tracker.childSession('other:t9')).toBeUndefined()
    expect(tracker.text()).toBe('') // 자식 글은 부모 답이 아니다
  })

  it('task 파트보다 먼저 온 자식 이벤트(session.created 로 안 자식)도 잇는 순간 실린다', () => {
    const tracker = new TurnTracker()
    tracker.adoptChild('ses_c1')
    tracker.child(...childInfo('ses_c1', 'ma1', 'assistant'))
    expect(tracker.child(...childPart('ses_c1', 'ma1', { type: 'text', id: 'pt', text: 'early', time: { start: 1, end: 2 } }))).toBeUndefined() // 아직 줄이 없다
    expect(tracker.observe(...task('t1', 'ses_c1', { status: 'running', time: { start: 100 } }))).toMatchObject({ items: [{ kind: 'text', text: 'early' }] })
  })
})

describe('하위 작업 기록 (다시 열기)', () => {
  const parts = [
    {
      type: 'tool',
      id: 'p1',
      messageID: 'm',
      tool: 'task',
      state: { status: 'completed', input: { subagent_type: 'general', description: 'job 0' }, output: 'x', metadata: { sessionId: 'ses_c' }, time: { start: 10, end: 50 } },
    },
    { type: 'tool', id: 'p2', messageID: 'm', tool: 'task', state: { status: 'running', input: { subagent_type: 'explore', description: 'job 1' }, metadata: { sessionId: 'ses_gone' }, time: { start: 11 } } },
  ]

  it('subtaskSessions 는 task 파트의 자식 세션 id', () => {
    expect(subtaskSessions([{ parts }])).toEqual(['ses_c', 'ses_gone'])
  })

  it('messageItems 에 자식 기록을 주면 task 줄 안에 자식의 줄(user 빼고)과 토큰 합. 못 읽은 자식은 빈 줄', () => {
    const tokens = { input: 700, output: 50, cache: { read: 300 } }
    const children = new Map([
      [
        'ses_c',
        [
          { info: { id: 'cu', role: 'user' as const }, parts: [{ type: 'text', id: 'q', messageID: 'cu', text: 'prompt' }] },
          { info: { id: 'ca', role: 'assistant' as const, tokens }, parts: [{ type: 'tool', id: 'b', messageID: 'ca', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'a' } }] },
          { info: { id: 'cb', role: 'assistant' as const, tokens }, parts: [{ type: 'text', id: 't', messageID: 'cb', text: 'tool: a' }] },
        ],
      ],
    ])
    expect(messageItems(parts, '', undefined, children)).toEqual([
      {
        kind: 'subtask',
        id: 'm:p1',
        agent: 'general',
        description: 'job 0',
        status: 'done',
        startedAt: 10,
        endedAt: 50,
        tokens: 2100,
        items: [
          { kind: 'tool', id: 'ca:b', name: 'bash', status: 'done', input: '{"command":"ls"}', summary: 'ls', result: 'a' },
          { kind: 'text', id: 'cb:t', text: 'tool: a', done: true },
        ],
      },
      { kind: 'subtask', id: 'm:p2', agent: 'explore', description: 'job 1', status: 'running', startedAt: 11, items: [] },
    ])
  })
})

// 이슈 #83 실측 (2026-10-05, opencode 1.18.18, _workspace/01ae_todo.md 1절): todowrite 파트는 pending{input:{}} → running{input:{todos}} →
// completed{metadata:{todos, truncated}, title:"N todos"} | error. 목록의 정본은 completed 의 metadata.todos (그 시점 목록 전체)
describe('할 일 목록 (todowrite, 이슈 #83)', () => {
  const todos = [
    { content: 'read a.txt', status: 'completed', priority: 'high' },
    { content: 'edit b.txt', status: 'in_progress', priority: 'medium' },
    { content: 'run tests', status: 'pending', priority: 'low' },
    { content: 'write docs', status: 'cancelled', priority: 'low' },
  ]
  const mapped = [
    { text: 'read a.txt', status: 'done' },
    { text: 'edit b.txt', status: 'active' },
    { text: 'run tests', status: 'pending' },
    { text: 'write docs', status: 'cancelled' },
  ]
  const part = (state: Record<string, unknown>) => ({ type: 'tool', id: 'p1', messageID: 'm', tool: 'todowrite', state })
  const completed = (list: unknown) => part({ status: 'completed', input: { todos: list }, output: '[]', metadata: { todos: list, truncated: false }, title: '2 todos' })

  it('끝난 todowrite 파트의 metadata.todos 를 중립 모양으로 싣는다 — content → text, in_progress → active, completed → done, priority 는 버린다', () => {
    expect(messageItems([completed(todos)])[0]).toMatchObject({ kind: 'tool', name: 'todowrite', status: 'done', todos: mapped })
  })

  it('모르는 status 는 pending, 항목의 id 는 버린다 (엔진이 status 를 검사하지 않는다)', () => {
    const [item] = messageItems([completed([{ content: 'one', status: 'done', priority: 'urgent', id: '7' }, { content: 'two', priority: 'low' }])])
    expect((item as { todos: object[] }).todos).toEqual([{ text: 'one', status: 'pending' }, { text: 'two', status: 'pending' }])
  })

  it('빈 목록도 성공이다 — 빈 todos', () => {
    expect(messageItems([completed([])])[0]).toMatchObject({ status: 'done', todos: [] })
  })

  it('running·error 파트엔 todos 가 없다 — 틀린 인자도 running 에 input.todos 가 실린 뒤 error 가 된다', () => {
    const running = messageItems([part({ status: 'running', input: { todos }, time: { start: 1 } })])[0]
    const failed = messageItems([part({ status: 'error', input: { todos }, error: 'The todowrite tool was called with invalid arguments' })])[0]
    expect(running).not.toHaveProperty('todos')
    expect(failed).toMatchObject({ status: 'error' })
    expect(failed).not.toHaveProperty('todos')
  })

  it('metadata.todos 가 배열이 아니면 싣지 않고, 다른 도구의 metadata.todos 는 보지 않는다', () => {
    expect(messageItems([part({ status: 'completed', input: { todos }, output: '' })])[0]).not.toHaveProperty('todos')
    expect(messageItems([{ type: 'tool', id: 'p2', messageID: 'm', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: '', metadata: { todos } } }])[0]).not.toHaveProperty('todos')
  })

  it('실시간도 같은 길 — completed 가 오면 그 줄에 todos 가 실린다', () => {
    const tracker = new TurnTracker()
    expect(tracker.observe(...updated({ type: 'tool', id: 'p1', tool: 'todowrite', state: { status: 'running', input: { todos } } }))).not.toHaveProperty('todos')
    expect(tracker.observe(...updated({ type: 'tool', id: 'p1', tool: 'todowrite', state: { status: 'completed', input: { todos }, output: '[]', metadata: { todos } } }))).toMatchObject({ status: 'done', todos: mapped })
  })
})

// 이슈 #91 — 결과물 선언(앱 MCP 의 present, 엔진 이름 litecode_present). 엔진은 MCP 결과의 구조화된 내용을 파트에 남기지 않는다 →
// 도구가 "전부 받아들였을 때만 성공" 이므로 completed 파트의 인자가 곧 받아들인 목록이다 (appMcp/tools/present.ts)
describe('결과물 선언 (litecode_present, 이슈 #91)', () => {
  const root = '/work/proj'
  const files = [{ path: 'report.md', title: ' Report ' }, { path: '/work/proj/src/a.ts' }, { path: './out/../out/index.html', title: '' }]
  const part = (state: Record<string, unknown>, tool = 'litecode_present') => ({ type: 'tool', id: 'p1', messageID: 'm', tool, state })

  it('성공한 호출의 인자를 프로젝트 기준 상대 경로로 싣는다 — 절대·./.. 경로는 풀고, 제목은 다듬고 빈 제목은 뺀다', () => {
    const [item] = messageItems([part({ status: 'completed', input: { files }, output: 'Presented 3 files…' })], root)
    expect(item).toMatchObject({ kind: 'tool', status: 'done', mcp: { server: 'litecode', tool: 'present' } })
    expect((item as { presented: object[] }).presented).toEqual([{ path: 'report.md', title: 'Report' }, { path: 'src/a.ts' }, { path: 'out/index.html' }])
  })

  it('이름이 `..` 로 시작하는 폴더 안 파일은 폴더 안이다 — 절대 경로로 받아도 상대 경로로 싣는다', () => {
    const input = { files: [{ path: '/work/proj/..env' }, { path: '..notes/a.md' }, { path: '../outside.md' }] }
    const [item] = messageItems([part({ status: 'completed', input, output: '' })], root)
    expect((item as { presented: object[] }).presented).toEqual([{ path: '..env' }, { path: '..notes/a.md' }, { path: '../outside.md' }])
  })

  it('running·error 파트엔 없다 — 거절된 호출의 인자는 결과물이 아니다', () => {
    expect(messageItems([part({ status: 'running', input: { files }, time: { start: 1 } })], root)[0]).not.toHaveProperty('presented')
    expect(messageItems([part({ status: 'error', input: { files }, error: 'Nothing was presented.' })], root)[0]).not.toHaveProperty('presented')
  })

  it('다른 도구의 files 인자는 보지 않고, 모양이 틀린 항목은 버린다', () => {
    expect(messageItems([part({ status: 'completed', input: { files }, output: '' }, 'other_present')], root)[0]).not.toHaveProperty('presented')
    const [item] = messageItems([part({ status: 'completed', input: { files: [{ path: 'a.md' }, { title: 'x' }, 'b.md', { path: 3 }] }, output: '' })], root)
    expect((item as { presented: object[] }).presented).toEqual([{ path: 'a.md' }])
    expect(messageItems([part({ status: 'completed', input: { files: 'a.md' }, output: '' })], root)[0]).not.toHaveProperty('presented')
  })

  it('실시간도 같은 길 — completed 가 오면 그 줄에 실린다', () => {
    const tracker = new TurnTracker(root)
    expect(tracker.observe(...updated({ type: 'tool', id: 'p1', tool: 'litecode_present', state: { status: 'running', input: { files } } }))).not.toHaveProperty('presented')
    expect(tracker.observe(...updated({ type: 'tool', id: 'p1', tool: 'litecode_present', state: { status: 'completed', input: { files }, output: 'ok' } }))).toMatchObject({
      status: 'done',
      presented: [{ path: 'report.md', title: 'Report' }, { path: 'src/a.ts' }, { path: 'out/index.html' }],
    })
  })
})
