/** 파일 퀵오픈(⌘P, 이슈 #624)의 매칭 — 메인(목록)과 렌더러(표시)가 같은 규칙을 쓰도록 shared.
 *  규칙 = `@` 메뉴 포함 검색과 같음(전자 fileIndex.pathsContaining): 파일명에 들어가는 것이 먼저, 그 안에서는 짧은 경로가
 *  먼저(같은 길이는 알파벳), 경로 마디에만 들어가는 것은 뒤에. 대소문자 무시. 빈 글이면 아무것도 아니다. */
export function matchFiles(files: string[], needle: string, limit = 100): string[] {
  const q = needle.trim().toLowerCase()
  if (q === '') return []
  const inName: string[] = []
  const inPath: string[] = []
  for (const file of files) {
    const text = file.toLowerCase()
    if (!text.includes(q)) continue
    ;(text.slice(text.lastIndexOf('/') + 1).includes(q) ? inName : inPath).push(file)
  }
  const byShort = (a: string, b: string): number => a.length - b.length || a.localeCompare(b)
  return [...inName.sort(byShort), ...inPath.sort(byShort)].slice(0, limit)
}
