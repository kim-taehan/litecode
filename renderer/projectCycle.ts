// 프로젝트 순환 (#375) — 빠른 열기 패널이 열려 있을 때 ⌘K 로 다음 프로젝트로 이동하는 규칙.
//
// 최근 목록에서 프로젝트를 열면(projects.open) 그 프로젝트가 목록 맨 앞으로 올라온다. 그래서
// "지금 목록의 다음 항목" 을 매번 live 목록으로 셈하면 처음 두 개(마지막으로 연 곳과 그 직전) 사이에서
// 그냥 오간다. 대신 패널이 열렸을 때 보이던 순서(즐겨찾기 먼저 — 사용자가 본 목록)를 스냅샷으로 잡고
// 그 위에서 커서를 앞선다. 표시는 즐겨찾기 우선이라, 스냅샷도 표시 순서(rows 에서 "폴더 열기" 행을 뺀 것)로 잡는다.

/** 스냅샷 커서 — order 가 열렸을 때의 표시 순서(path), index 는 그 안의 현재 위치(목록에 없으면 -1) */
export interface ProjectCycle {
  order: string[]
  index: number
}

/** 패널이 열렸을 때 만든다. 커서는 현재 프로젝트 자리에서 시작 — 거기서 다음이 바로 "다음 프로젝트" */
export function startProjectCycle(order: string[], current?: string): ProjectCycle {
  return { order, index: order.indexOf(current ?? '') }
}

/**
 * 커서에서 다음으로, **지금 보이는 행에 있는** 프로젝트를 찾는다.
 * 필터로 안 보이는 것은 건너뛴다(누르면 무언가 일어나야 하므로). 도는 동안에도 안 보이는 것만 있으면 undefined.
 * 두 개 이하 목록이면 순환할 것이 없어 undefined.
 */
export function nextProjectInCycle(cycle: ProjectCycle, visiblePaths: string[]): { cycle: ProjectCycle; path: string } | undefined {
  if (cycle.order.length <= 1) return undefined
  for (let step = 1; step <= cycle.order.length; step += 1) {
    const path = cycle.order[(cycle.index + step) % cycle.order.length]!
    if (visiblePaths.includes(path)) {
      return { cycle: { order: cycle.order, index: (cycle.index + step) % cycle.order.length }, path }
    }
  }
  return undefined
}
