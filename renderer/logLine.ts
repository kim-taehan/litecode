// 기록 탭 줄의 순수 계산 (#400 #405) — 날짜 문구와 refs → 칩. 화면(GitLog)만 쓴다.

import type { GitLogCommit, GitLogRef } from '../shared/git.ts'

const DAY = 86_400_000

/** 둘째 줄의 때 — 오늘/어제는 요일 + 시각(`오늘 PM 5:12`), 그 밖은 `YYYY. M. D.` (시안 ⑤) */
export function logWhen(at: number, now: number): string {
  const a = new Date(at)
  const n = new Date(now)
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const when = timeOfDay(a)
  if (day(a) === day(n)) return `오늘 ${when}`
  if (day(a) === day(n) - DAY) return `어제 ${when}`
  return `${a.getFullYear()}. ${a.getMonth() + 1}. ${a.getDate()}.`
}

/** `PM 5:12` — 12시간째, 시각의 0은 없다 */
export function timeOfDay(d: Date): string {
  let h = d.getHours()
  const meridian = h < 12 ? 'AM' : 'PM'
  h = h % 12
  if (h === 0) h = 12
  return `${meridian} ${h}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** refs → 칩 목록 — 원격(`origin/x`)과 같은 이름의 브랜치·HEAD 가 있으면 `origin & x` 로 합친다.
 *  `origin/HEAD`(원격 HEAD 상징) 는 빼고, 아이콘 색은 줄(레인) 색이므로 여기서는 형태만 준다 */
export interface LogChip {
  icon: 'branch' | 'tag'
  text: string
}

export function logChips(commit: GitLogCommit): LogChip[] {
  const local = new Set<string>()
  for (const ref of commit.refs) {
    if (ref.kind === 'head' && ref.name) local.add(ref.name)
    if (ref.kind === 'branch') local.add(ref.name)
  }
  const chips: LogChip[] = []
  const usedRenames = new Set<string>()
  for (const ref of commit.refs) {
    if (ref.kind !== 'remote') continue
    if (ref.name.endsWith('/HEAD')) continue
    const slash = ref.name.indexOf('/')
    const prefix = slash > 0 ? ref.name.slice(0, slash) : ref.name
    const base = slash > 0 ? ref.name.slice(slash + 1) : ref.name
    if (local.has(base)) {
      chips.push({ icon: 'branch', text: `${prefix} & ${base}` })
      usedRenames.add(ref.name)
    } else chips.push({ icon: 'branch', text: ref.name })
  }
  // 원격 칩으로 합친 브랜치는 다시 안 보이고, 합쳐지지 않은 브랜치(·HEAD) 는 남는다
  for (const ref of commit.refs) {
    if (ref.kind === 'head' || ref.kind === 'branch') {
      const renamed = [...usedRenames].some((name) => name.endsWith(`/${ref.name}`))
      if (!renamed) chips.push({ icon: 'branch', text: ref.name })
    } else if (ref.kind === 'tag') chips.push({ icon: 'tag', text: ref.name })
  }
  return chips
}
