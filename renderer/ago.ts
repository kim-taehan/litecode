// 마지막 활동 시각을 대화 목록에 짧게 — dsh 세션 행과 같은 모양(now · 38min · 1h · 1d · 4mo · 1y). 단위마다 내림한다.
// 달은 30일, 해는 365일 단위 (dsh ui-primitives relative-time)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function ago(at: number, now: number): string {
  const elapsed = now - at
  if (elapsed < MINUTE) return 'now' // 시계가 살짝 어긋나 음수여도
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}min`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`
  if (elapsed < 30 * DAY) return `${Math.floor(elapsed / DAY)}d`
  if (elapsed < 365 * DAY) return `${Math.floor(elapsed / (30 * DAY))}mo`
  return `${Math.floor(elapsed / (365 * DAY))}y`
}
