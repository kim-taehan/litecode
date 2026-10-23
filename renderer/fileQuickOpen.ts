// 파일 퀵오픈(⌘P, 이슈 #624)의 순수 조각 — 매칭은 shared/fileMatch.ts(메인·렌더러 같은 규칙), 여기는 표시용 분할.

/** 퀵오픈에 올리는 행 수 상한 — 넘어도 그 자리에서 자르다가 글자를 더 치면 다시 거른다 */
export const QUICK_LIMIT = 50

/** 글자를 needle(문자 구분 없이, 모든 곳)로 쪼개서 매칭 부분을 표시한다 — 인텔리제이 처럼 맞는 글자를 진하게 */
export function markText(text: string, needle: string): { text: string; hit: boolean }[] {
  if (!needle) return [{ text, hit: false }]
  const lower = text.toLowerCase()
  const n = needle.toLowerCase()
  const parts: { text: string; hit: boolean }[] = []
  let at = 0
  for (;;) {
    const i = lower.indexOf(n, at)
    if (i < 0) break
    if (i > at) parts.push({ text: text.slice(at, i), hit: false })
    parts.push({ text: text.slice(i, i + n.length), hit: true })
    at = i + n.length
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false })
  return parts
}
