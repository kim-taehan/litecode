import { describe, expect, it } from 'vitest'
import { trajectoryRecords } from '../../src/services/trajectory.ts'

// opencode `GET /api/session/{id}/message?order=asc` → Trajectory 중립 레코드. 모양은 01e 실측(opencode 1.18.18):
// assistant 메시지 하나 = 스텝 하나(time.created = step.started = 응답이 오기 시작한 때, completed = step.ended),
// 도구 파트 {type:"tool", id, name, state:{status, input, content, structured, error?}, time:{created, ran, completed}}.
// Model 막대는 직전 시각(커서)부터 — step.started 는 응답이 온 때라 대기 시간이 빠진다 (01e 2c).

const user = (text: string, created: number) => ({ type: 'user', text, time: { created } })
const assistant = (created: number, completed: number | undefined, content: unknown[], extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  time: completed === undefined ? { created } : { created, completed },
  finish: 'stop',
  content,
  ...extra,
})
const tool = (name: string, input: unknown, state: Record<string, unknown>, time: Record<string, number>) => ({
  type: 'tool',
  id: 'call_1',
  name,
  state: { input, ...state },
  time,
})
const TOKENS = { input: 700, output: 50, reasoning: 0, cache: { read: 300, write: 0 } }

describe('trajectoryRecords', () => {
  it('도구 턴: user → 텍스트 없는 assistant(도구) → 도구 → 답 assistant. Model 막대는 직전 시각부터', () => {
    const raw = [
      user('list [bash:ls -la]', 75490),
      assistant(
        75659,
        75700,
        [tool('bash', { command: 'ls -la', description: 'fake' }, { status: 'completed', content: [{ type: 'text', text: 'total 8\nfile' }], structured: { exit: 0 } }, { created: 75661, ran: 75665, completed: 75698 })],
        { finish: 'tool-calls', tokens: TOKENS },
      ),
      assistant(75773, 75776, [{ type: 'text', id: 'text-0', text: 'tool: total 8' }], { tokens: TOKENS }),
    ]
    expect(trajectoryRecords(raw)).toEqual([
      { kind: 'user', text: 'list [bash:ls -la]', at: 75490 },
      { kind: 'assistant', text: '', start: 75490, firstAt: 75659, end: 75700, tokens: { input: 700, output: 50, reasoning: 0, cacheRead: 300 } },
      {
        kind: 'tool',
        name: 'bash',
        input: '{"command":"ls -la","description":"fake"}',
        result: 'total 8\nfile',
        start: 75661,
        ranAt: 75665,
        end: 75698,
        exit: 0,
      },
      // 다음 스텝의 커서는 직전 스텝·도구 중 가장 늦게 끝난 시각
      { kind: 'assistant', text: 'tool: total 8', start: 75700, firstAt: 75773, end: 75776, tokens: { input: 700, output: 50, reasoning: 0, cacheRead: 300 } },
    ])
  })

  it('파일을 바꾼 도구는 structured.files 에서 diffs 를 싣는다 (01p)', () => {
    const file = { file: 'a.txt', patch: '@@ -1 +1 @@\n-a\n+A\n', additions: 1, deletions: 1, status: 'modified' }
    const raw = [
      user('edit', 1),
      assistant(2, 5, [tool('edit', { path: '/p/a.txt' }, { status: 'completed', content: [{ type: 'text', text: 'ok' }], structured: { files: [file] } }, { created: 3, completed: 4 })]),
    ]
    expect(trajectoryRecords(raw)[2]).toMatchObject({ kind: 'tool', diffs: [{ path: 'a.txt', status: 'modified', added: 1, removed: 1, patch: file.patch }] })
    expect(trajectoryRecords([user('x', 1), assistant(2, 5, [tool('bash', {}, { status: 'completed', structured: { exit: 0 } }, { created: 3 })])])[2]).not.toHaveProperty('diffs')
  })

  it('도구 실패는 error.message 를 싣는다 (코드는 없다)', () => {
    const failed = tool('read', { filePath: '/nope' }, { status: 'error', error: { type: 'unknown', message: 'Invalid tool input: Missing key\n  at ["path"]' } }, { created: 10, ran: 11, completed: 12 })
    const [, , record] = trajectoryRecords([user('x', 1), assistant(5, 13, [failed], { finish: 'tool-calls' })])
    expect(record).toEqual({
      kind: 'tool',
      name: 'read',
      input: '{"filePath":"/nope"}',
      result: '',
      error: 'Invalid tool input: Missing key\n  at ["path"]',
      start: 10,
      ranAt: 11,
      end: 12,
    })
  })

  it('LLM 실패한 스텝은 assistant 에 error 를 싣는다', () => {
    const records = trajectoryRecords([user('[fail]', 1), assistant(3, 4, [], { finish: 'error', error: { type: 'unknown', message: 'Provider request failed with HTTP 500' } })])
    expect(records[1]).toEqual({ kind: 'assistant', text: '', start: 1, firstAt: 3, end: 4, error: 'Provider request failed with HTTP 500' })
  })

  it('지시문(AGENTS.md)이 바뀐 system 메시지는 CONTEXT 레코드다 — 경로를 뽑는다', () => {
    const system = {
      type: 'system',
      text: 'These instructions replace all previously loaded ambient instructions.\n\nInstructions from: /tmp/p/AGENTS.md\n# rules',
      time: { created: 20 },
    }
    expect(trajectoryRecords([user('again', 10), system])[1]).toEqual({ kind: 'context', text: '지시문 바뀜 · /tmp/p/AGENTS.md', at: 20 })
  })

  it('끝나지 않은 스텝·도구는 end 가 없다 (진행 중이거나 끊김)', () => {
    const running = tool('bash', { command: 'sleep 9' }, { status: 'running' }, { created: 6, ran: 7 })
    const [, step, call] = trajectoryRecords([user('a', 1), assistant(5, undefined, [running])])
    expect(step).toEqual({ kind: 'assistant', text: '', start: 1, firstAt: 5 })
    expect(call).toEqual({ kind: 'tool', name: 'bash', input: '{"command":"sleep 9"}', result: '', start: 6, ranAt: 7 })
  })

  it('말풍선이 아닌 다른 종류(모델 바꿈·압축 등)는 건너뛴다', () => {
    expect(trajectoryRecords([user('a', 1), { type: 'model-switched', time: { created: 2 } }, { type: 'synthetic', text: 'x' }])).toEqual([
      { kind: 'user', text: 'a', at: 1 },
    ])
  })

  it('빈 세션은 빈 목록이다', () => {
    expect(trajectoryRecords([])).toEqual([])
  })
})
