import fs from 'node:fs/promises'
import path from 'node:path'

// project.pickPath 의 결과 (이슈 #538) — 대화상자가 준 절대 경로 → 프로젝트 기준 상대 경로. 실제 경로(realpath)로 견주므로 심볼릭 링크는
// 가리키는 곳으로 보고, 프로젝트 밖이면(밖을 가리키는 링크·옆 폴더·사라진 경로) 빼고 개수만 센다 — 확장에 프로젝트 밖의 경로를 주지 않는다.
// 구분자는 `/`(Windows 도), 폴더는 끝에 `/`, 프로젝트 자체는 `./`

export async function projectRelativePaths(directory: string, chosen: readonly string[]): Promise<{ paths: string[]; outside: number }> {
  const root = await fs.realpath(directory)
  const paths: string[] = []
  let outside = 0
  for (const item of chosen) {
    try {
      const real = await fs.realpath(item)
      const relative = path.relative(root, real)
      // `..` 마디만 밖이다 — `..cache`·`..notes.md` 같은 안쪽 이름은 안 (QA 03_qa_538)
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        outside++
        continue
      }
      const folder = (await fs.stat(real)).isDirectory()
      const shown = relative.split(path.sep).join('/')
      paths.push(shown === '' ? './' : folder ? `${shown}/` : shown)
    } catch {
      outside++
    }
  }
  return { paths, outside }
}
