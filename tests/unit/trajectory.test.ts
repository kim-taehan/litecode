import { describe, expect, it } from 'vitest'
import { trajectoryRecords } from '../../src/services/trajectory.ts'
import type { EngineMessage } from '../../src/services/llm.ts'
import type { EnginePart } from '../../src/services/turnProgress.ts'

// opencode 레거시 `GET /session/{id}/message?directory=` → Trajectory 중립 레코드. 모양은 이슈 #20 L2 실측(opencode 1.18.18):
// assistant 메시지 하나 = 스텝 하나(time.created = 스텝 시작 — LLM 요청 전, completed = 스텝 끝), 응답이 오기 시작한 때는 첫 글·생각 파트의
// time.start 나 도구 state.time.start. 도구 파트 {type:"tool", tool, callID, state:{status, input, output, error(문자열), metadata, time:{start,end}}}.
// 프로젝트 지시문은 앱이 매 턴 system 으로 싣고 user info.system 에 남는다 — 앞 턴과 달라진 user 뒤에 CONTEXT

const S = 'ses_1'
const user = (id: string, text: string, created: number, extra: Record<string, unknown> = {}): EngineMessage => ({
  info: { id, sessionID: S, role: 'user', time: { created }, ...extra },
  parts: [{ type: 'text', id: `${id}:t`, messageID: id, text }],
})
const assistant = (id: string, parent: string, created: number, completed: number | undefined, parts: EnginePart[], extra: Record<string, unknown> = {}): EngineMessage => ({
  info: { id, sessionID: S, role: 'assistant', parentID: parent, time: completed === undefined ? { created } : { created, completed }, ...extra },
  parts: [{ type: 'step-start', id: `${id}:s` }, ...parts],
})
const tool = (name: string, input: unknown, state: Record<string, unknown>): EnginePart => ({ type: 'tool', id: 'prt_tool', tool: name, callID: 'call_1', state: { input, ...state } })
const TOKENS = { input: 700, output: 50, reasoning: 0, cache: { read: 300, write: 0 } }

describe('trajectoryRecords', () => {
  it('도구 턴: user → 텍스트 없는 assistant(도구) → 도구 → 답 assistant. Model 막대는 직전 시각부터, 응답 시작은 첫 출력 파트 시각', () => {
    const raw = [
      user('u1', 'list [bash:ls -la]', 75490),
      assistant('a1', 'u1', 75500, 75700, [tool('bash', { command: 'ls -la', description: 'fake' }, { status: 'completed', output: 'total 8\nfile', metadata: { exit: 0, output: 'total 8\nfile' }, time: { start: 75661, end: 75698 } })], {
        tokens: TOKENS,
      }),
      assistant('a2', 'u1', 75701, 75776, [{ type: 'text', id: 'prt_t', text: 'tool: total 8', time: { start: 75773, end: 75775 } }], { tokens: TOKENS }),
    ]
    expect(trajectoryRecords(raw)).toEqual([
      { kind: 'user', text: 'list [bash:ls -la]', at: 75490 },
      { kind: 'assistant', text: '', start: 75490, firstAt: 75661, end: 75700, tokens: { input: 700, output: 50, reasoning: 0, cacheRead: 300 } },
      { kind: 'tool', name: 'bash', input: '{"command":"ls -la","description":"fake"}', result: 'total 8\nfile', start: 75661, end: 75698, exit: 0 },
      // 다음 스텝의 커서는 직전 스텝·도구 중 가장 늦게 끝난 시각
      { kind: 'assistant', text: 'tool: total 8', start: 75700, firstAt: 75773, end: 75776, tokens: { input: 700, output: 50, reasoning: 0, cacheRead: 300 } },
    ])
  })

  it('파일을 바꾼 도구는 metadata 에서 diffs 를 싣는다 — 경로는 세션 폴더 기준 상대 (toolDiffs)', () => {
    const patch = 'Index: /p/a.txt\n===\n--- /p/a.txt\n+++ /p/a.txt\n@@ -1 +1 @@\n-a\n+A\n'
    const edit = tool('edit', { filePath: '/p/a.txt' }, { status: 'completed', output: 'ok', metadata: { filediff: { file: '/p/a.txt', patch, additions: 1, deletions: 1 } }, time: { start: 3, end: 4 } })
    expect(trajectoryRecords([user('u', 'edit', 1), assistant('a', 'u', 2, 5, [edit])], '/p')[2]).toMatchObject({
      kind: 'tool',
      diffs: [{ path: 'a.txt', status: 'modified', added: 1, removed: 1, patch }],
    })
    const bash = tool('bash', {}, { status: 'completed', output: '', metadata: { exit: 0 }, time: { start: 3 } })
    expect(trajectoryRecords([user('u', 'x', 1), assistant('a', 'u', 2, 5, [bash])], '/p')[2]).not.toHaveProperty('diffs')
  })

  it('도구 실패는 error 문자열을 싣는다 (코드는 없다)', () => {
    const failed = tool('read', { path: '/nope' }, { status: 'error', error: 'The read tool was called with invalid arguments: SchemaError(Missing key\n  at ["filePath"])', time: { start: 10, end: 12 } })
    const [, , record] = trajectoryRecords([user('u', 'x', 1), assistant('a', 'u', 5, 13, [failed])])
    expect(record).toEqual({
      kind: 'tool',
      name: 'read',
      input: '{"path":"/nope"}',
      result: '',
      error: 'The read tool was called with invalid arguments: SchemaError(Missing key\n  at ["filePath"])',
      start: 10,
      end: 12,
    })
  })

  it('LLM 실패한 스텝은 assistant 에 error 를 싣는다', () => {
    const records = trajectoryRecords([user('u', '[fail]', 1), assistant('a', 'u', 3, 4, [], { error: { name: 'APIError', data: { message: 'Provider request failed with HTTP 400' } } })])
    expect(records[1]).toEqual({ kind: 'assistant', text: '', start: 1, firstAt: 3, end: 4, error: 'Provider request failed with HTTP 400' })
  })

  it('지시문(user info.system)이 앞 턴과 달라지면 그 user 뒤에 CONTEXT 레코드 — 경로를 뽑는다. 첫 턴·같은 지시문은 없다', () => {
    const rules = (text: string) => ({ system: `Instructions from: /tmp/p/AGENTS.md\n${text}` })
    const records = trajectoryRecords([
      user('u1', 'first', 10, rules('# 1')),
      assistant('a1', 'u1', 11, 12, []),
      user('u2', 'same', 20, rules('# 1')),
      assistant('a2', 'u2', 21, 22, []),
      user('u3', 'again', 30, rules('# 2')),
      assistant('a3', 'u3', 31, 32, []),
      user('u4', 'removed', 40),
    ])
    expect(records.filter((record) => record.kind === 'user' || record.kind === 'context')).toEqual([
      { kind: 'user', text: 'first', at: 10 },
      { kind: 'user', text: 'same', at: 20 },
      { kind: 'user', text: 'again', at: 30 },
      { kind: 'context', text: '지시문 바뀜 · /tmp/p/AGENTS.md', at: 30 },
      { kind: 'user', text: 'removed', at: 40 },
      { kind: 'context', text: '지시문 바뀜', at: 40 },
    ])
  })

  it('끝나지 않은 스텝·도구는 end 가 없다 (진행 중이거나 끊김)', () => {
    const running = tool('bash', { command: 'sleep 9' }, { status: 'running', time: { start: 6 } })
    const [, step, call] = trajectoryRecords([user('u', 'a', 1), assistant('a', 'u', 5, undefined, [running])])
    expect(step).toEqual({ kind: 'assistant', text: '', start: 1, firstAt: 6 })
    expect(call).toEqual({ kind: 'tool', name: 'bash', input: '{"command":"sleep 9"}', result: '', start: 6 })
  })

  it('자동 요약(요약 user·요약 답·합성 Continue)은 레코드가 아니다 — 그 뒤 답 스텝은 남는다', () => {
    const records = trajectoryRecords([
      user('u', 'a', 1),
      { info: { id: 'c', sessionID: S, role: 'user', time: { created: 2 } }, parts: [{ type: 'compaction', id: 'pc', auto: true }] },
      assistant('s', 'c', 3, 4, [{ type: 'text', id: 'ps', text: '## Objective', time: { start: 3 } }], { summary: true, agent: 'compaction' }),
      { info: { id: 'k', sessionID: S, role: 'user', time: { created: 5 } }, parts: [{ type: 'text', id: 'pk', text: 'Continue if you have next steps', synthetic: true }] },
      assistant('a', 'k', 6, 7, [{ type: 'text', id: 'pa', text: 'done', time: { start: 6 } }]),
    ])
    expect(records.map((record) => record.kind)).toEqual(['user', 'assistant'])
    expect(records[1]).toMatchObject({ text: 'done' })
  })

  it('빈 세션은 빈 목록이다', () => {
    expect(trajectoryRecords([])).toEqual([])
  })
})
