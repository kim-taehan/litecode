// 마지막 활동 시각을 대화 목록에 짧게 — dsh 세션 행과 같은 모양(now · 38min · 1h · 1d). 단위마다 내림한다
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function ago(at: number, now: number): string {
  const elapsed = now - at
  if (elapsed < MINUTE) return 'now' // 시계가 살짝 어긋나 음수여도
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}min`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`
  return `${Math.floor(elapsed / DAY)}d`
}
