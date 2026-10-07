import fs from 'node:fs/promises'
import path from 'node:path'

/** 폴더(root) 기준 상대 경로(`/` 구분) — 폴더 밖이거나 폴더 자신이면 undefined. 글자로만 본다: 링크까지 가리려면 둘 다 realpath 한 값을 준다.
 *  이름이 `..` 로 시작하는 파일(`..env`)은 폴더 안이다 */
export function insideOf(root: string, file: string): string | undefined {
  const relative = path.relative(root, file)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined
  return relative.split(path.sep).join('/')
}

/** 폴더면 realpath 를, 아니면(없는 경로·파일·상대 경로) undefined 를 준다.
 *  opencode 는 없는 경로로도 세션을 200 으로 만들지만 그 세션은 모든 요청이 500 이고, 그 경로는 서버 재시작 전까지
 *  계속 500 이다 (폴더를 나중에 만들어도) — 사용자 opencode 를 오염시키므로 opencode 에 닿기 전에 거른다.
 *  realpath 인 이유: opencode 는 경로를 문자열 그대로 저장·비교한다 (2026-09-30 실측, 01_probe Q3). */
export async function realDirectory(directory: string): Promise<string | undefined> {
  if (!path.isAbsolute(directory)) return undefined
  try {
    const real = await fs.realpath(directory)
    return (await fs.stat(real)).isDirectory() ? real : undefined
  } catch {
    return undefined
  }
}
