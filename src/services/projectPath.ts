import path from 'node:path'

/** 폴더(root) 기준 상대 경로(`/` 구분) — 폴더 밖이거나 폴더 자신이면 undefined. 글자로만 본다: 링크까지 가리려면 둘 다 realpath 한 값을 준다.
 *  이름이 `..` 로 시작하는 파일(`..env`)은 폴더 안이다 */
export function insideOf(root: string, file: string): string | undefined {
  const relative = path.relative(root, file)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined
  return relative.split(path.sep).join('/')
}
