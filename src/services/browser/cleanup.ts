import { execFile } from 'node:child_process'
import path from 'node:path'

// 남은 Chrome 정리 (이슈 #147). Chrome 은 opencode → MCP 서버(Playwright) → Chrome 으로 떠서 앱이 쥔 PID 가 없다. 끊기·엔진 종료 같은 정상 길에서는
// MCP 서버가 Chrome 을 닫지만, MCP 서버가 강제 종료되면 Chrome 이 남는다 (실측 01aj §2 J, 1/1). 그래서 기능을 끄거나 앱을 끌 때, 그리고 뜰 때 한 번
// **우리 전용 프로필(`--user-data-dir=<userData>/browser/profile`)로 뜬 브라우저만** 찾아 닫는다.
// 사용자의 평소 Chrome 은 절대 건드리지 않는다 — 고르는 기준은 명령줄에 우리 프로필 경로가 통째로 있는 것 하나다(이름·부모 프로세스로 짐작하지 않는다).
// Windows 는 하지 않는다 — 명령줄 읽기(CIM)와 종료를 실측하지 않았다. 확실하지 않은 정리는 안 하는 쪽이다.

/** `ps -o pid=,command=` 출력에서 그 프로필로 뜬 브라우저 본체의 PID. 도우미 프로세스(`--type=…`)는 본체가 끝나면 같이 끝나므로 고르지 않는다 */
export function browserPids(ps: string, profileDir: string): number[] {
  if (!path.isAbsolute(profileDir)) return []
  const needle = ` --user-data-dir=${profileDir}`
  return ps.split('\n').flatMap((line) => {
    const at = line.indexOf(needle)
    if (at < 0 || line.includes(' --type=')) return []
    // 경로 바로 뒤가 줄 끝이거나 다음 인자여야 한다 — `…/profile2`·`…/profile/sub` 는 우리 것이 아니다
    const rest = line.slice(at + needle.length)
    if (rest !== '' && !rest.startsWith(' ')) return []
    const pid = Number(line.trim().split(/\s+/, 1)[0])
    return Number.isInteger(pid) && pid > 1 ? [pid] : []
  })
}

export interface CloseBrowsersOptions {
  platform?: string
  /** 프로세스 목록 (`pid 명령줄` 한 줄씩) — 단위 테스트가 바꾼다 */
  list?: () => Promise<string>
  kill?: (pid: number) => void
  self?: number
}

function listProcesses(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-axww', '-o', 'pid=,command='], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
  })
}

/** 그 프로필로 뜬 브라우저에 끝내라고 알린다 (SIGTERM — Chrome 이 스스로 창·도우미를 정리한다). 던지지 않는다 — 못 찾거나 못 읽으면 아무것도 안 한다 */
export async function closeBrowsers(profileDir: string, opts: CloseBrowsersOptions = {}): Promise<void> {
  if ((opts.platform ?? process.platform) === 'win32') return
  const kill = opts.kill ?? ((pid: number) => void process.kill(pid, 'SIGTERM'))
  try {
    for (const pid of browserPids(await (opts.list ?? listProcesses)(), profileDir)) {
      if (pid === (opts.self ?? process.pid)) continue
      try {
        kill(pid)
      } catch {
        // 그 사이 끝났다
      }
    }
  } catch (error) {
    console.warn('[browser] 남은 브라우저를 찾지 못했다 — 정리하지 않는다:', (error as Error).message)
  }
}
