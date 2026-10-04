// 사이드바 대화 목록의 순수 부분 (이슈 #79) — 제목 찾기와 고정한 대화 올리기

/** 제목이 찾는 말의 낱말을 전부 담고 있나 — 대소문자 무시, 순서 무관. 빈 찾는 말은 전부 통과 */
export function matchesTitle(title: string, query: string): boolean {
  const haystack = title.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word))
}

/** 고정한 대화를 위로 — 묶음 안의 순서는 그대로 */
export function pinnedFirst<T extends { pinned?: boolean }>(list: readonly T[]): T[] {
  return [...list.filter((entry) => entry.pinned), ...list.filter((entry) => !entry.pinned)]
}
