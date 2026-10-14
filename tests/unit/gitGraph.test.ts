import { describe, expect, it } from 'vitest'
import { LANE_CAP, LANE_COLORS, layoutGraph, laneColor, type GraphRow } from '../../renderer/gitGraph.ts'
import type { GitLogCommit } from '../../shared/git.ts'

// 기록 탭 그래프 레이아웃 (#400 #403) — 고정 입력(직선·다이아몬드·교차 머지·레인 재사용·옥토퍼스·1000개)으로만 댄다.
// 부모 해시로 커밋을 잇는다 — id 가 곧 해시. 줄 순서는 최근→옛순(진짜 git log 와 같다).

const c = (id: string, parents: string[] = []): GitLogCommit => ({
  hash: id,
  short: id.slice(0, 7),
  subject: id,
  author: 't',
  time: 0,
  pushed: true,
  refs: [],
  parents,
})

const rowsOf = (commits: GitLogCommit[], state?: Parameters<typeof layoutGraph>[1]) => layoutGraph(commits, state)

const shape = (rows: GraphRow[]) => rows.map((row) => ({ lane: row.lane, up: row.up, down: row.down, diagonal: row.diagonal, folded: row.folded }))

describe('layoutGraph — 고정 입력', () => {
  it('직선 — 한 레인으로 뚫려 내려간다, root 에서 끝난다', () => {
    const { rows, state } = rowsOf([c('c', ['b']), c('b', ['a']), c('a')])
    expect(shape(rows)).toEqual([
      { lane: 0, up: [], down: [0], diagonal: [], folded: false },
      { lane: 0, up: [0], down: [0], diagonal: [], folded: false },
      { lane: 0, up: [0], down: [], diagonal: [], folded: false },
    ])
    expect(state.lanes).toEqual([])
  })

  it('다이아몬드 머지 — 머지에서 갈라지고(곡선 나감) root 에서 합쳐진다(곡선 들어옴)', () => {
    const { rows, state } = rowsOf([c('M', ['A', 'B']), c('A', ['C']), c('B', ['C']), c('C')])
    expect(shape(rows)).toEqual([
      { lane: 0, up: [], down: [0, 1], diagonal: [{ from: 0, to: 1 }], folded: false }, // M: 갈라짐
      { lane: 0, up: [0, 1], down: [0, 1], diagonal: [], folded: false }, // A: 옆 레인은 세로로 지나감
      { lane: 1, up: [0, 1], down: [0, 1], diagonal: [], folded: false }, // B
      { lane: 0, up: [0, 1], down: [], diagonal: [{ from: 1, to: 0 }], folded: false }, // C: 합쳐짐
    ])
    expect(state.lanes).toEqual([])
  })

  it('교차 머지 (branch 가 main 을 먼저 머지) — 기다리던 레인에 곡선이 합류한다', () => {
    // M2 가 main 의 A 를 이미 머지해 둔 뒤, M 이 M2 를 머지 — A 를 기다리던 레인 0 에 M2 에서 곡선이 잇는다
    const { rows, state } = rowsOf([c('M', ['A', 'M2']), c('M2', ['B', 'A']), c('A', ['C']), c('B', ['C']), c('C')])
    expect(shape(rows)).toEqual([
      { lane: 0, up: [], down: [0, 1], diagonal: [{ from: 0, to: 1 }], folded: false },
      { lane: 1, up: [0, 1], down: [0, 1], diagonal: [{ from: 1, to: 0 }], folded: false },
      { lane: 0, up: [0, 1], down: [0, 1], diagonal: [], folded: false },
      { lane: 1, up: [0, 1], down: [0, 1], diagonal: [], folded: false },
      { lane: 0, up: [0, 1], down: [], diagonal: [{ from: 1, to: 0 }], folded: false },
    ])
    expect(state.lanes).toEqual([])
  })

  it('레인 재사용 — 끝난 레인 자리가 같은 색으로 다시 쓰인다', () => {
    // 다이아몬드 2개 — 두 번째 분기의 옆 레인은 첫 번째의 자리(번호 1)와 색을 쓴다
    const { rows } = rowsOf([
      c('m2', ['a2', 'b2']),
      c('b2', ['a2']),
      c('a2', ['m1']),
      c('m1', ['a1', 'b1']),
      c('b1', ['a1']),
      c('a1', ['c1']),
      c('c1'),
    ])
    const [b2] = rows.filter((row) => row.lane === 1)
    const [b1] = rows.filter((row) => row.lane === 1).slice(-1)
    expect(b2.color).toBe(laneColor(1))
    expect(b1.color).toBe(b2.color) // 같은 자리(번호 1) 재사용
    expect(rows[0]).toMatchObject({ lane: 0, diagonal: [{ from: 0, to: 1 }] }) // m2: 갈라짐
    expect(rows[3]).toMatchObject({ lane: 0, diagonal: [{ from: 0, to: 1 }] }) // m1: 같은 레인에 다시 갈라짐
    expect(rows.every((row) => row.lane <= 1)).toBe(true)
  })

  it('옥토퍼스 머지 — 모든 부모 레인에 곡선이 나간다', () => {
    const { rows, state } = rowsOf([c('M', ['A', 'B', 'C']), c('A'), c('B'), c('C')])
    expect(rows[0]).toEqual({
      lane: 0,
      color: laneColor(0),
      up: [],
      down: [0, 1, 2],
      diagonal: [{ from: 0, to: 1 }, { from: 0, to: 2 }],
      folded: false,
    })
    expect(state.lanes).toEqual([])
  })

  it('폭 상한 — 8개를 넘는 레인은 folded, 색은 8색 순환', () => {
    const roots = Array.from({ length: LANE_CAP + 2 }, (_, i) => `r${i}`)
    const { rows } = rowsOf([c('M', roots), ...roots.map((id) => c(id))])
    expect(rows[0].diagonal).toHaveLength(LANE_CAP + 1) // r1…r9 까지 곡선
    // rows[0] = M 이라 rK 는 rows[K+1]
    expect(rows[LANE_CAP + 1]).toMatchObject({ lane: LANE_CAP, folded: true }) // r8 → 레인 8
    expect(rows[LANE_CAP + 2]).toMatchObject({ lane: LANE_CAP + 1, folded: true }) // r9 → 레인 9
    expect(rows[LANE_CAP + 1].color).toBe(laneColor(LANE_CAP))
    expect(laneColor(8)).toBe(LANE_COLORS[0]) // 8색 순환
  })

  it('페이지 연속 — state 를 넘기면 줄이 끊기지 않고 이어진다', () => {
    const all = [c('N', ['M']), c('M', ['A', 'B']), c('A', ['C']), c('B', ['C']), c('C')]
    const one = rowsOf(all)
    const first = rowsOf(all.slice(0, 1))
    const second = rowsOf(all.slice(1), first.state)
    expect(second.rows[0]).toMatchObject({ lane: 0, up: [0] }) // M 줄에 위선 — N 줄에서 이어졌다
    expect(shape(second.rows)).toEqual(shape(one.rows.slice(1)))
    expect(second.state.lanes).toEqual(one.state.lanes)
  })

  it('안 읽은 부모(다음 페이지에 올 커밋) — 그 레인을 기다리며 남기고, 새 커밋은 빈 레인을 쓴다', () => {
    const { rows, state } = rowsOf([c('a', ['x']), c('b')])
    expect(shape(rows)).toEqual([
      { lane: 0, up: [], down: [0], diagonal: [], folded: false },
      { lane: 1, up: [0], down: [0], diagonal: [], folded: false },
    ])
    expect(state.lanes).toEqual(['x'])
  })

  it('1000개 — 100마다 분기·머지가 이어지는 이력, 줄이 일탈하지 않는다', () => {
    const list: GitLogCommit[] = [c('root')]
    let prev = 'root'
    for (let i = 1; i < 1000; i++) {
      if (i % 100 === 0) {
        const side = `s${i}`
        list.push(c(side, [prev]))
        const merge = `m${i}`
        list.push(c(merge, [prev, side]))
        prev = merge
      } else {
        list.push(c(`c${i}`, [prev]))
        prev = `c${i}`
      }
    }
    list.push(c('tip', [prev]))
    const { rows, state } = rowsOf([...list].reverse())
    expect(rows).toHaveLength(list.length)
    expect(rows.every((row) => row.lane <= 1)).toBe(true) // 한 번에 두 레인까지만
    expect(state.lanes.length).toBeLessThanOrEqual(2)
    const branched = rows.filter((row) => row.diagonal.length > 0)
    expect(branched.length).toBe(18) // 100마다 9 사이클 — 갈라짐 9 + 합쳐짐 9
  })

  it('빈 입력', () => {
    expect(rowsOf([])).toEqual({ rows: [], state: { lanes: [] } })
    expect(rowsOf([], { lanes: ['h1', null] })).toMatchObject({ rows: [], state: { lanes: ['h1', null] } })
  })
})
