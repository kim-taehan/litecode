// 프로젝트 배지 — 글자와 색으로 프로젝트를 구분한다.
// 글자: 앞 두 글자만 쓰면 davis-code·davis-frontend 가 둘 다 "DA" 였다(00_request A1) → 여러 낱말이면 앞 두 낱말의 첫 글자.
// 색: 경로 해시로 팔레트에서 고른다 — 같은 프로젝트는 언제나 같은 색. 첫 색은 시안의 주황(기존 토큰).

export const BADGE_COLORS = ['#c97a4a', '#5b7fb5', '#8a6bb0', '#6e9e75', '#4f969a', '#b8697a'] as const

export function badgeLetters(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s\-_.]+/)
    .filter(Boolean)
  const letters = words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : [...name].slice(0, 2).join('')
  return letters.toUpperCase()
}

export function badgeColor(path: string): string {
  let hash = 2166136261 // FNV-1a
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 16777619)
  return BADGE_COLORS[(hash >>> 0) % BADGE_COLORS.length]!
}
