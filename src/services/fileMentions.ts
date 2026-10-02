import fs from 'node:fs/promises'
import path from 'node:path'

// 답의 파일 언급 칩 — 답 안의 인라인 코드(`src/a.ts`)가 그 프로젝트의 실제 파일이면 칩으로 그린다 (dsh ui-primitives markdown 의
// fileMentions: 렌더러는 경로처럼 보이는 것을 추측하지 않고, 실제 파일 목록을 아는 쪽이 판정한다). 답은 모델이 쓴 글이라
// 프로젝트 폴더 밖(../·절대 경로로 다른 곳)은 있는지조차 알려 주지 않는다.

/** 한 번에 묻는 개수 상한 — 답 하나의 인라인 코드 수로는 넉넉하다 */
export const MAX_MENTIONS = 200

/** token 이 프로젝트 안의 파일이면 그 절대 경로(realpath), 아니면 undefined */
export async function projectFile(directory: string, token: string): Promise<string | undefined> {
  if (!token || token.length > 1_000 || /[\u0000-\u001f]/.test(token)) return undefined
  try {
    const root = await fs.realpath(directory)
    const real = await fs.realpath(path.resolve(root, token))
    if (!real.startsWith(root + path.sep)) return undefined
    return (await fs.stat(real)).isFile() ? real : undefined
  } catch {
    return undefined
  }
}

/** tokens 중 프로젝트 안의 파일인 것만 (받은 글자 그대로) */
export async function existingFiles(directory: string, tokens: readonly string[]): Promise<string[]> {
  const unique = [...new Set(tokens.filter((token) => typeof token === 'string'))].slice(0, MAX_MENTIONS)
  const found = await Promise.all(unique.map(async (token) => ((await projectFile(directory, token)) ? token : undefined)))
  return found.filter((token): token is string => token !== undefined)
}
