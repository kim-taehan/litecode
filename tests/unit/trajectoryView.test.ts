import { describe, expect, it } from 'vitest'
import type { TrajectoryRecord } from '../../src/services/trajectory.ts'
import { groupTurns, matchesSearch, timeline } from '../../renderer/trajectoryView.ts'

// Trajectory 화면의 계산 — 턴 묶기, 검색, 시간축 3레인(Input·Model·Tools). dsh ui-trajectory 의 timeline 모양을 따른다:
// sequence(같은 너비) / duration(실제 시간, 아무것도 안 돈 구간은 압축).

const records: TrajectoryRecord[] = [
  { kind: 'user', text: '첫 질문 [bash:ls]', at: 1_000 },
  { kind: 'assistant', text: '', start: 1_000, firstAt: 1_100, end: 1_200 },
  { kind: 'tool', name: 'bash', input: '{"command":"ls"}', result: 'a.txt\nb.txt', start: 1_150, end: 1_190 },
  { kind: 'assistant', text: 'tool: a.txt', start: 1_200, firstAt: 1_250, end: 1_300 },
  { kind: 'user', text: '둘째', at: 61_300 }, // 1분 쉼
  { kind: 'assistant', text: 'echo: 둘째', start: 61_300, firstAt: 61_400, end: 61_500, error: 'boom' },
]

describe('groupTurns', () => {
  it('user 마다 새 턴, 레코드 번호(id)는 전체 순서', () => {
    const turns = groupTurns(records)
    expect(turns.map((turn) => turn.items.map((item) => item.id))).toEqual([[0, 1, 2, 3], [4, 5]])
    expect(turns.map((turn) => turn.number)).toEqual([1, 2])
  })
})

describe('matchesSearch', () => {
  it('공백으로 나눈 단어를 모두 포함해야 한다 (대소문자 무시) — 도구는 이름·인자·결과·오류를 본다', () => {
    expect(matchesSearch(records[2]!, 'BASH b.txt')).toBe(true)
    expect(matchesSearch(records[2]!, 'bash nope')).toBe(false)
    expect(matchesSearch(records[5]!, 'boom')).toBe(true)
    expect(matchesSearch(records[0]!, '')).toBe(true)
  })
})

describe('timeline', () => {
  it('sequence: 레코드마다 같은 너비 한 칸, 레인은 user→Input·assistant→Model·tool→Tools', () => {
    const { spans, total } = timeline(records, 'sequence')
    expect(total).toBe(6)
    expect(spans.map((span) => [span.lane, span.start, span.end])).toEqual([
      [0, 0, 1], [1, 1, 2], [2, 2, 3], [1, 3, 4], [0, 4, 5], [1, 5, 6],
    ])
    expect(spans[1]!.firstAt).toBeUndefined() // 같은 너비에선 대기를 나누지 않는다
    expect(spans[5]!.error).toBe(true)
  })

  it('duration: 실제 길이 — Model 막대는 대기(start→firstAt)와 생성을 나누고, 아무것도 안 돈 1분은 압축한다', () => {
    const { spans, total } = timeline(records, 'duration')
    const model = spans.filter((span) => span.lane === 1)
    expect(model.map((span) => span.end - span.start)).toEqual([200, 100, 200])
    expect(model[0]!.firstAt! - model[0]!.start).toBe(100)
    // 쉰 구간(1_300 → 61_300)이 압축돼 전체가 실제 경과(60.5초)보다 훨씬 짧다
    expect(total).toBeLessThan(1_000)
    expect(spans[4]!.start).toBeGreaterThan(spans[3]!.end)
  })

  it('끝나지 않은 레코드는 막대 대신 시작 표시만 한다 (지어낸 길이 없음)', () => {
    const { spans } = timeline([{ kind: 'user', text: 'a', at: 0 }, { kind: 'assistant', text: '', start: 0, firstAt: 5 }], 'duration')
    expect(spans[1]).toMatchObject({ start: 0, end: 0, open: true })
  })
})
