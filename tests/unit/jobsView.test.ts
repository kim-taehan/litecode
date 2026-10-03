import { describe, expect, it } from 'vitest'
import type { Subtask, TurnItem } from '../../shared/ipc.ts'
import { compactTokens, elapsed, jobList, lastLine, recentLines } from '../../renderer/jobsView.ts'

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
