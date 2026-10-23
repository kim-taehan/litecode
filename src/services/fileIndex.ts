import { execFile } from 'node:child_process'

// 프로젝트 전체 파일 목록 (이슈 #148) — `@` 메뉴의 포함 검색이 깊은 곳의 파일도 찾게 한다. 엔진의 퍼지 검색은 상위 N 개만 줘서
// 큰 프로젝트에선 이름에 그 글자가 든 파일이 빠졌다. 동봉한 ripgrep 의 `--files` 로 만든다 — .gitignore 를 따르고(빌드 산출물·node_modules 가
// 빠진다) 숨김 파일은 넣되 .git 은 뺀다. 짧게 캐시한다(글자를 칠 때마다 다시 훑지 않게, 새 파일은 몇 초 안에 잡힌다).
// rg 가 없거나 실패하면 빈 목록 — 부르는 쪽은 폴더 목록·엔진 퍼지 결과만으로 간다.

const CACHE_MS = 5_000
const TIMEOUT_MS = 5_000
/** 목록 상한 — 넘으면 잘린 채로 쓴다 (약 200바이트 × 5만 = 10MB) */
const MAX_BYTES = 10 * 1024 * 1024

const cache = new Map<string, { at: number; files: Promise<string[]> }>()

/** 프로젝트 기준 상대 경로(`/` 구분). rg: 실행 파일 경로 */
export function projectFiles(directory: string, rg: string, now = Date.now()): Promise<string[]> {
  const hit = cache.get(directory)
  if (hit && now - hit.at < CACHE_MS) return hit.files
  const files = new Promise<string[]>((resolve) => {
    execFile(rg, ['--files', '--hidden', '--glob', '!.git', '--path-separator', '/'], { cwd: directory, timeout: TIMEOUT_MS, maxBuffer: MAX_BYTES, encoding: 'utf8' }, (error, stdout) => {
      // 상한·기한에 걸려도 그때까지 받은 것은 쓴다 (마지막 줄은 잘렸을 수 있어 버린다)
      const lines = stdout.split('\n')
      if (error) lines.pop()
      resolve(lines.filter(Boolean))
    })
  })
  cache.set(directory, { at: now, files })
  return files
}

/** 경로에 needle 이 든 것 — `@` 메뉴와 파일 퀵오픈(#624) 이 쓰는 공용 매칭: shared/fileMatch.ts 로 이사했다 */
export { matchFiles as pathsContaining } from '../../shared/fileMatch.ts'
