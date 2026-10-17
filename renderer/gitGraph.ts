// 기록 탭 그래프 레이아웃 (이슈 #400 #403) — parents 가 있는 커밋 줄에서 레인(줄) 배치를 계산한다. 순수 함수: DOM·React 를 모르고,
// P2 가 줄마다 작은 SVG 로 그린다(줄 높이 고정이라 가상 스크롤과 맞다).
//
// 레인은 "각 레인이 기다리는 부모 해시" 배열이다. 커밋(최근→옛순)을 하나씩 처리하며:
// - 이 커밋을 기다리던 레인(위 커밋의 부모)이 있으면 그 레인에 점(왼쪽이 도트 레인), 없으면 빈 레인에 새로 잡는다(새 페이지 첫 줄도 여기)
// - 첫 부모는 도트 레인을 그대로 잇고, 다른 부모(머지)는 기다리는 레인에 합류하거나 빈 레인에 새로 잡아 곡선으로 잇는다
//   (그 부모가 첫 부모의 바로 위 — 분기점 = 첫 부모 커밋 자체 — 면 같은 직선이므로 별도 레인·곡선 없이 그대로 잇는다, #413)
// - 아직 안 읽힌 부모(다음 페이지에 올 커밋)는 그 레인을 기다리며 남긴다 — 그래서 state 를 이어줘야 한다.
//   (P3 의 필터로 부모가 아예 목록에서 빠지면 그 레인은 기다림이 남는다 — P3 에서 다룬다)
// 상태(state.lanes)를 넘겨주면 페이지 단위로 이어 계산된다.

import type { GitLogCommit } from '../shared/git.ts'

/** 레인 색 — 레인 번호 % 8 (git.css 에서 --log-lane-0…7 로 정의, P2) */
export const LANE_COLORS = [
  'var(--log-lane-0)',
  'var(--log-lane-1)',
  'var(--log-lane-2)',
  'var(--log-lane-3)',
  'var(--log-lane-4)',
  'var(--log-lane-5)',
  'var(--log-lane-6)',
  'var(--log-lane-7)',
] as const

/** 한 줄에 볼 수 있는 레인 수 — 넘는 레인은 P2 가 오른쪽 끝으로 접어 그린다 */
export const LANE_CAP = 8

/** 곡선 — from(도트 레인) 쪽에서 to(다른 레인) 쪽으로. 같은 줄 안에서 그린다 */
export interface GraphDiagonal {
  /** 도트가 있는 레인 (선이 시작되는 쪽) */
  from: number
  /** 잇히는 레인 (선이 끝나고 그 레인으로 내려가는 쪽) */
  to: number
}

/** 한 줄의 그래프 데이터 (commits[i] 와 짝) */
export interface GraphRow {
  /** 커밋 점이 있는 레인 */
  lane: number
  /** 점 색 (레인 색) */
  color: string
  /** 위에서(이전 줄) 들어오는 선이 있는 레인 — 도트의 레인 포함 */
  up: number[]
  /** 아래(다음 줄)로 나가는 선이 있는 레인 — 도트의 레인·머지 곡선이 내린 레인 포함, 지나가는 세로선도 둘 다에 든다 */
  down: number[]
  /** 곡선 (머지·분기) */
  diagonal: GraphDiagonal[]
  /** 폭 상한(LANE_CAP)을 넘는 레인의 선이 있는 줄 — P2 가 오른쪽 끝으로 접는다 */
  folded: boolean
}

/** 페이지 단위로 이어 계산하는 상태 — lanes: 각 레인이 기다리는 부모 해시(없으면null) */
export interface GraphState {
  lanes: Array<string | null>
}

export function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length]!
}

/** 폭 상한 (#409 필터) — 필터로 부모가 목록에서 빠지면 기다리는 레인이 쌓일 텐데, 이보다 넓지 않게 막는다 */
export interface GraphOptions {
  /** 레인 수 상한 (기본 = 없음). 차면: 새로 내릴 머지 선은 끊고, 도트는 맨 오른쪽 레인을 빼앗는다 */
  maxLanes?: number
}

/** commits(최근→옛순)의 그래프를 계산한다. state 를 주면 그 전 페이지의 레인 상태를 이어간다 */
export function layoutGraph(commits: readonly GitLogCommit[], state: GraphState = { lanes: [] }, options: GraphOptions = {}): { rows: GraphRow[]; state: GraphState } {
  const maxLanes = options.maxLanes ?? Infinity
  const lanes: Array<string | null> = state.lanes ? state.lanes.slice() : []
  const rows: GraphRow[] = []
  // 직선 브랜치 판정(#413)은 부모 커밋 객체가 필요 — 이미 읽힌(페이지에 든) 커밋만 보인다
  const byHash = new Map(commits.map((commit): [string, GitLogCommit] => [commit.hash, commit]))

  /** second 가 first 라는 1커밋 브랜치의 끝이면 true — first 의 바로 위(분기점 = first)에서 갈라진 1커밋 */
  const isStraightChild = (first: string, second: string): boolean => {
    const obj = byHash.get(second)
    return Boolean(obj && obj.parents.length === 1 && obj.parents[0] === first)
  }

  /** 가장 왼쪽 빈 레인 — 없으면 맨 오른쪽에 하나 더한다 */
  const freeLane = (): number => {
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === null) return i
    }
    return lanes.length
  }

  const sortLanes = (lanes: Set<number>): number[] => [...lanes].sort((a, b) => a - b)

  for (const commit of commits) {
    const up = new Set<number>()
    const down = new Set<number>()
    const diagonal: GraphDiagonal[] = []

    // 이 커밋을 기다리던 레인 — 왼쪽이 도트 레인, 나머지는 선을 합쳐 도트에 잇고 레인은 낸다
    const followers: number[] = []
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === commit.hash) followers.push(i)
    }
    let lane: number
    if (followers.length > 0) {
      lane = followers[0]!
      up.add(lane)
      for (const other of followers.slice(1)) {
        lanes[other] = null
        up.add(other)
        diagonal.push({ from: other, to: lane })
      }
      lanes[lane] = null
    } else {
      // 기다리는 레인 없음 — 새 페이지 첫 줄·필터로 부모가 숨겨진 줄·root. 선은 이 줄에서 시작한다
      lane = freeLane()
      if (lane >= lanes.length) {
        if (lanes.length > 0 && lanes.length >= maxLanes) {
          // 폭 상한 — 맨 오른쪽 레인을 빼앗는다 (기다리던 선은 끊김)
          lane = lanes.length - 1
          lanes[lane] = null
        } else lanes.push(null)
      }
    }

    const parents = commit.parents ?? []
    // 직선 브랜치 (#413) — 두 번째 부모가 첫 부모 바로 위의 1커밋이면(분기점 = 첫 부모 커밋) 별도 레인·곡선 없이
    // 도트 레인을 두 번째 부모로 잇는다 — 그 다음 줄(두 번째 부모)에서 도트가 같은 레인에 내려앉아 첫 부모까지 곧게 이어진다
    const first = parents[0]
    const straight = parents.length === 2 && first && isStraightChild(first, parents[1]!) ? parents[1]! : undefined

    // 첫 부모 — 도트 레인을 그대로 잇는다 (직선 브랜치면 두 번째 부모가 먼저, 첫 부모는 그 뒤에서 이어진다)
    if (parents[0]) {
      lanes[lane] = straight ?? parents[0]!
      down.add(lane)
    }

    // 지나가는 레인 — 이 줄이 오기 전에 이미 기다리던 레인만 위·아래로 뚫린다 (지금 막 내린 선이 없는 lane 포함)
    for (let i = 0; i < lanes.length; i++) {
      if (i === lane) continue
      if (lanes[i] !== null) {
        up.add(i)
        down.add(i)
      }
    }

    // 다른 부모 (머지) — 기다리는 레인이 있으면 그 레인(지나가는 세로선에 곡선이 잇힘), 없으면 빈 레인에 새로 내린다
    for (let k = 1; k < parents.length; k++) {
      const parent = parents[k]!
      if (parent === straight) continue // 도트 레인에 이미 이어둔 직선 브랜치
      let other = lanes.indexOf(parent)
      if (other < 0) {
        const free = freeLane()
        // 폭 상한 — 새 레인을 여는 것뿐이면 그 선은 끊는다 (기다림은 안 남는다)
        if (free >= lanes.length && lanes.length >= maxLanes) continue
        other = free
        if (other >= lanes.length) lanes.push(null)
      }
      lanes[other] = parent
      down.add(other)
      diagonal.push({ from: lane, to: other })
    }

    // 맨 오른쪽이 빈 레인이면 낸다 (그래프가 좁도록)
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()

    const farthest = Math.max(lane, ...up, ...down, ...diagonal.map((line) => Math.max(line.from, line.to)))
    rows.push({
      lane,
      color: laneColor(lane),
      up: sortLanes(up),
      down: sortLanes(down),
      diagonal,
      folded: farthest >= LANE_CAP,
    })
  }

  return { rows, state: { lanes } }
}
