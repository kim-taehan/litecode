import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { tr } from '../i18n.ts'

// opencode 실행 파일을 찾는다 — closed-code/desktop `electron/opencode/binary.ts` 의 순서를 따른다.
// 순서: `OPENCODE_BIN` > 앱에 동봉 > PATH > 알려진 설치 자리. 동봉이 PATH 를 이긴다 — 실측한 버전(1.18.18)으로 고정한다.
// 동봉은 설치본에만 있다 — 개발(`npm run dev`)에서 resourcesPath 는 electron 배포물 자리라, 부르는 쪽(main.ts)이 app.isPackaged 일 때만 넘긴다.
//
// macOS 에서 Finder·Dock 으로 띄운 앱은 셸 PATH 를 못 받는다 (`/usr/bin:/bin:/usr/sbin:/sbin` 뿐, closed-code 실측) —
// 터미널에서 `opencode` 가 보여도 앱에서는 안 보이므로 알려진 자리를 직접 뒤진다.
// 못 찾으면 본 자리를 전부 돌려준다 — 화면의 오류 한 줄이 사용자가 가진 유일한 단서다.
//
// 찾은 경로를 realpath 로 풀지 않는다 — PID 기록(engine.ts)이 `ps` 의 argv[0] 과 이 문자열을 대조한다 (closed-code pidStore 실측).

export interface BinaryLookup {
  /** 찾은 실행 파일. 못 찾으면 undefined */
  path?: string
  /** 본 자리 전부 */
  searched: string[]
}

/** 설치본에 실린 opencode·rg 자리 (electron-builder.yml `extraResources` 의 `to` 와 같아야 한다) */
export function bundledPaths(resourcesPath: string, platform: NodeJS.Platform = process.platform): { opencode: string; rgDir: string } {
  return {
    opencode: join(resourcesPath, 'opencode', platform === 'win32' ? 'opencode.exe' : 'opencode'),
    rgDir: join(resourcesPath, 'rg'),
  }
}

function knownDirs(home: string): string[] {
  return [join(home, '.bun', 'bin'), join(home, '.opencode', 'bin'), join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function findOpencodeBinary(
  env: NodeJS.ProcessEnv = process.env,
  executable: (file: string) => boolean = isExecutable,
  bundled?: string,
): BinaryLookup {
  const searched: string[] = []
  const explicit = env['OPENCODE_BIN']?.trim()
  if (explicit) {
    searched.push(`${explicit} (OPENCODE_BIN)`)
    if (executable(explicit)) return { path: explicit, searched }
  }
  if (bundled) {
    searched.push(tr('error.binaryBundled', { path: bundled }))
    if (executable(bundled)) return { path: bundled, searched }
  }

  const fromPath = (env['PATH'] ?? '').split(delimiter).filter((dir) => dir.trim() !== '')
  for (const dir of [...fromPath, ...knownDirs(env['HOME']?.trim() || homedir())]) {
    const candidate = join(dir, process.platform === 'win32' ? 'opencode.exe' : 'opencode')
    if (searched.includes(candidate)) continue // PATH 와 알려진 자리에 같은 폴더가 있을 수 있다
    searched.push(candidate)
    if (executable(candidate)) return { path: candidate, searched }
  }
  return { searched }
}

export function notFoundMessage(lookup: BinaryLookup): string {
  return [
    tr('error.binaryNotFound'),
    tr('error.binarySearched'),
    ...lookup.searched.map((entry) => `  · ${entry}`),
  ].join('\n')
}
