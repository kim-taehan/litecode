import { describe, expect, it } from 'vitest'
import type { Subtask, TurnItem } from '../../shared/ipc.ts'
import { capRows, compactTokens, elapsed, jobList, lastLine, leadJob, quietMinutes, recentLines, runningLine, runningPhase, VISIBLE_ROWS } from '../../renderer/jobsView.ts'

const subtask = (id: string, status: Subtask['status'], items: TurnItem[] = []): Subtask => ({ kind: 'subtask', id, agent: 'general', description: id, status, items })

describe('jobList — 진행 줄에서 하위 작업을 도는 것과 끝난 것으로', () => {
  it('준비·진행 중은 도는 것, 완료·실패·중단은 끝난 것 — 나타난 순서 그대로, 하위 작업이 아닌 줄은 뺀다', () => {
    const items: TurnItem[] = [
      { kind: 'think', id: 't', text: 'split', done: true },
      subtask('a', 'done'),
      subtask('b', 'running'),
      subtask('c', 'error'),
      subtask('d', 'preparing'),
      subtask('e', 'stopped'),
    ]
    const list = jobList(items)
    expect(list.running.map((item) => item.id)).toEqual(['b', 'd'])
    expect(list.finished.map((item) => item.id)).toEqual(['a', 'c', 'e'])
  })

  it('하위 작업이 없는 턴은 둘 다 비어 있다 (버튼을 안 띄운다)', () => {
    expect(jobList([{ kind: 'tool', id: 'x', name: 'bash', status: 'running' }])).toEqual({ running: [], finished: [] })
  })
})

describe('recentLines·lastLine — 생각·도구 줄만', () => {
  const items: TurnItem[] = [
    { kind: 'think', id: '1', text: '**토큰 검증**으로\n둘째 줄', done: true },
    { kind: 'tool', id: '2', name: 'read', status: 'done', summary: 'src/a.ts' },
    { kind: 'text', id: '3', text: '중간 글', done: true },
    { kind: 'tool', id: '4', name: 'bash', status: 'error', summary: 'npm test', error: 'x' },
    { kind: 'tool', id: '5', name: 'edit', status: 'running', summary: 'src/b.ts' },
    { kind: 'tool', id: '6', name: 'srv_do', status: 'preparing', mcp: { server: 'srv', tool: 'do' } },
  ]

  it('생각은 요약 한 줄, 도구는 "이름 요약" 고정폭 + 상태. 글 줄은 뺀다', () => {
    expect(recentLines(items, 10)).toEqual([
      { id: '1', text: '토큰 검증으로', mono: false },
      { id: '2', text: 'read src/a.ts', mono: true, state: 'done' },
      { id: '4', text: 'bash npm test', mono: true, state: 'error' },
      { id: '5', text: 'edit src/b.ts', mono: true, state: 'running' },
      { id: '6', text: 'srv/do', mono: true, state: 'running' },
    ])
  })

  it('최근 것만 (오래된 것부터), 마지막 줄이 지금 하는 일', () => {
    expect(recentLines(items, 2).map((line) => line.id)).toEqual(['5', '6'])
    expect(lastLine(items.slice(0, 5))?.text).toBe('edit src/b.ts')
    expect(lastLine([])).toBeUndefined()
    expect(lastLine([{ kind: 'think', id: 'e', text: '', done: false }])).toBeUndefined()
  })
})

describe('runningLine — 스트리밍 한 줄에 보일 지금 하는 일 (이슈 #416)', () => {
  it('마지막 생각·도구 줄을 lastLine 과 같이 본다', () => {
    const items: TurnItem[] = [
      { kind: 'think', id: '1', text: '생각 요약', done: true },
      { kind: 'text', id: '2', text: '글', done: true },
      { kind: 'tool', id: '3', name: 'bash', status: 'running', summary: 'npm test' },
    ]
    expect(runningLine(items)).toEqual({ id: '3', text: 'bash npm test', mono: true, state: 'running' })
    expect(runningLine(items.slice(0, 2))).toEqual({ id: '1', text: '생각 요약', mono: false })
    expect(runningLine([])).toBeUndefined()
  })

  it('하위 작업 줄도 본다 — lastLine 과 달리 "agent · 설명"', () => {
    const withSub: TurnItem[] = [
      { kind: 'think', id: '1', text: '생각', done: true },
      subtask('b', 'running'),
    ]
    expect(runningLine(withSub)).toEqual({ id: 'b', text: 'general · b', mono: false })
    expect(lastLine(withSub)?.id).toBe('1')
    // 설명도 에이전트도 없으면 건너뛴다
    const empty = { ...subtask('c', 'running'), agent: '', description: '' }
    expect(runningLine([empty])).toBeUndefined()
  })
})

describe('runningPhase — 진행 줄의 지금 상태별 문구 (#605)', () => {
  it('맨 뒤 활성 줄의 종류로: 답 글 > 생각 > 도구 > 하위 작업', () => {
    expect(runningPhase([{ kind: 'text', id: '1', text: '…', done: false }])).toEqual({ kind: 'writing' })
    expect(runningPhase([{ kind: 'think', id: '1', text: '…', done: false }])).toEqual({ kind: 'thinking' })
    expect(runningPhase([{ kind: 'tool', id: '1', name: 'bash', status: 'running', summary: 'test' }])).toEqual({ kind: 'tool', name: 'bash' })
    expect(runningPhase([{ kind: 'tool', id: '1', name: 'bash', status: 'preparing' }])).toEqual({ kind: 'tool', name: 'bash' })
    expect(runningPhase([subtask('b', 'running')])).toEqual({ kind: 'subtask' })
    expect(runningPhase([subtask('b', 'queued')])).toEqual({ kind: 'subtask' })
  })

  it('MCP 도구는 "서버/도구" 이름 (jobLine 과 같은 규칙)', () => {
    expect(runningPhase([{ kind: 'tool', id: '1', name: 'raw', status: 'running', mcp: { server: 'srv', tool: 'do' } }])).toEqual({ kind: 'tool', name: 'srv/do' })
  })

  it('끝난 줄은 건너뛰고 활성 것만 — 아무도 없으면 undefined (채팅은 "딥다이빙 중" 으로)', () => {
    expect(
      runningPhase([
        { kind: 'think', id: '1', text: 'x', done: true },
        { kind: 'text', id: '2', text: 'y', done: true },
        { kind: 'tool', id: '3', name: 'bash', status: 'done' },
        subtask('b', 'done'),
      ]),
    ).toBeUndefined()
    expect(runningPhase([])).toBeUndefined()
  })

  it('먼저 끝난 생각 뒤를 도는 도구가 지금 하는 일', () => {
    const items: TurnItem[] = [
      { kind: 'think', id: '1', text: 'x', done: true },
      { kind: 'tool', id: '2', name: 'edit', status: 'running', summary: 'a.ts' },
    ]
    expect(runningPhase(items)).toEqual({ kind: 'tool', name: 'edit' })
  })

  it('재시도 대기(게이트웨이 500 등)는 사유까지 (문구는 화면이 붙인다)', () => {
    expect(
      runningPhase([
        { kind: 'text', id: '1', text: 'y', done: true },
        { kind: 'retry', id: '2', attempt: 1, message: '500', status: 'waiting' },
      ]),
    ).toEqual({ kind: 'retry', attempt: 1, message: '500' })
    // 재시도가 끝난 뒤(active 줄 없음)는 다시 undefined
    expect(
      runningPhase([
        { kind: 'retry', id: '2', attempt: 1, message: '500', status: 'done' },
        { kind: 'text', id: '1', text: 'y', done: true },
      ]),
    ).toBeUndefined()
  })
})

describe('elapsed·compactTokens', () => {
  it('경과 시간은 좁은 칸에 맞게', () => {
    expect(elapsed(-5)).toBe('0s')
    expect(elapsed(12_900)).toBe('12s')
    expect(elapsed(65_000)).toBe('1m05s')
    expect(elapsed(3_720_000)).toBe('1h02m')
  })

  it('토큰은 3.1k 모양', () => {
    expect(compactTokens(87)).toBe('87')
    expect(compactTokens(3_140)).toBe('3.1k')
    expect(compactTokens(3_000)).toBe('3k')
    expect(compactTokens(12_800)).toBe('12k')
    expect(compactTokens(1_250_000)).toBe('1.2M')
  })
})

describe('leadJob — 입력 카드 위 접힌 줄이 가리키는 대표 작업 (이슈 #295)', () => {
  const at = (id: string, startedAt?: number): Subtask => ({ ...subtask(id, 'running'), startedAt })

  it('가장 먼저 시작한 것 — 나타난 순서와 다르더라도', () => {
    expect(leadJob([at('a', 300), at('b', 100), at('c', 200)])?.id).toBe('b')
  })

  it('시작 시각이 없는(준비 중) 것은 뒤로, 같으면 나타난 순서', () => {
    expect(leadJob([at('a'), at('b', 500)])?.id).toBe('b')
    expect(leadJob([at('a'), at('b')])?.id).toBe('a')
    expect(leadJob([at('a', 100), at('b', 100)])?.id).toBe('a')
  })

  it('도는 것이 없으면 undefined (줄을 안 띄운다)', () => {
    expect(leadJob([])).toBeUndefined()
  })
})

describe('jobList(items, ended) — 턴이 끝난 뒤 입력 카드 위 줄에 남는 끝난 작업 (이슈 #295)', () => {
  it('턴이 끝났으면 전부 끝난 것 — 남은 준비·진행 중은 "중단됨" 으로 (중지 버튼이 안 남게)', () => {
    const list = jobList([subtask('a', 'done'), subtask('b', 'running'), subtask('c', 'preparing'), subtask('d', 'error')], true)
    expect(list.running).toEqual([])
    expect(list.finished.map((item) => [item.id, item.status])).toEqual([
      ['a', 'done'],
      ['b', 'stopped'],
      ['c', 'stopped'],
      ['d', 'error'],
    ])
  })

  it('턴이 도는 중이면 지금과 같다', () => {
    expect(jobList([subtask('b', 'running')], false).running.map((item) => item.id)).toEqual(['b'])
  })
})

describe('capRows — 3줄까지만, 나머지는 "+N개 더 보기" (이슈 #295)', () => {
  const rows = ['a', 'b', 'c', 'd', 'e']

  it('기본은 3줄', () => {
    expect(VISIBLE_ROWS).toBe(3)
  })

  it('넘치면 앞의 3줄과 남은 개수', () => {
    expect(capRows(rows, false)).toEqual({ shown: ['a', 'b', 'c'], more: 2 })
  })

  it('다 보기면 전부, 남은 것 0', () => {
    expect(capRows(rows, true)).toEqual({ shown: rows, more: 0 })
  })

  it('3줄 이하는 자르지 않는다', () => {
    expect(capRows(['a', 'b', 'c'], false)).toEqual({ shown: ['a', 'b', 'c'], more: 0 })
    expect(capRows([], false)).toEqual({ shown: [], more: 0 })
  })
})

describe('jobList — 차례를 기다리는 백그라운드 작업 (queued, 이슈 #321)', () => {
  it('대기 중인 작업은 도는 것에 든다 — 시작 시각이 없어 대표 작업은 실행 중인 것', () => {
    const job = (id: string, status: Subtask['status'], startedAt?: number): Subtask => ({ kind: 'subtask', id, agent: 'explore', description: id, status, items: [], ...(startedAt !== undefined && { startedAt }) })
    const { running, finished } = jobList([job('a', 'running', 10), job('b', 'queued'), job('c', 'done', 5)])
    expect(running.map((item) => item.id)).toEqual(['a', 'b'])
    expect(finished.map((item) => item.id)).toEqual(['c'])
    expect(leadJob(running)?.id).toBe('a')
  })
})

describe('quietMinutes — 조용한 백그라운드 작업 표시 ("N분째 조용함")', () => {
  const task = (patch: Partial<Subtask>): Subtask => ({ kind: 'subtask', id: 't', agent: 'explore', description: 'd', status: 'running', items: [], ...patch })
  it('실행 중이고 quietSince 가 있을 때만 — 분 단위(내림, 최소 1)', () => {
    expect(quietMinutes(task({}), 1_000_000)).toBeUndefined()
    expect(quietMinutes(task({ quietSince: 0 }), 185_000)).toBe(3)
    expect(quietMinutes(task({ quietSince: 0 }), 10_000)).toBe(1)
    expect(quietMinutes(task({ quietSince: 0, status: 'done' }), 185_000)).toBeUndefined()
  })
})
