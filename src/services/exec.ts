import { spawn, type ChildProcess } from 'node:child_process'
import { streamText } from './outputBuffer.ts'

// 셸 명령 하나를 띄우는 공용 실행기 — `!명령`(ctx.shell)과 훅(ctx.hooks, 이슈 #102)이 같은 규칙으로 돈다 (원래 shell.ts 안에 있던 부분).
// - 로그인 셸(`$SHELL -lc`)로 띄운다 — Finder 로 띄운 앱은 PATH 가 짧아 npm·node 를 못 찾는다 (01h §6a). Windows 는 cmd
// - 프로세스 그룹으로 띄워 멈춤·기한에 자식(파이프·백그라운드)까지 끈다 (SIGTERM → KILL_GRACE_MS 뒤 SIGKILL)
// - Windows 는 프로세스 그룹이 없다 — `taskkill /pid <pid> /T /F` 로 cmd 와 그 자식을 한 번에 끈다.
//   **Windows 쪽은 인자 모양만 단위 테스트로 고정했고 실제 실행은 미검증이다** (이슈 #126 오류 3, tests/unit/exec.test.ts)
// - env 는 앱 자신의 env(+ 부른 쪽이 더한 값). 서버 비밀번호는 메인 env 에 원래 없지만 혹시 몰라 지운다
// - stdin 을 주면 그 글을 쓰고 닫는다. 안 주면 닫힌 채다 (입력이 필요한 명령은 곧 실패한다)
// - 출력은 스트림마다 UTF-8 디코더로 풀어(조각 경계의 한글) onOutput 으로 넘긴다 — 얼마나 쥘지는 부른 쪽이 정한다 (outputBuffer.ts)

const KILL_GRACE_MS = 2_000

/** 띄울 셸과 인자 — 로그인 셸에 명령 하나. Windows 는 cmd.
 *  cmd 는 `/s` 일 때 `/c` 뒤 글의 맨 앞·맨 뒤 큰따옴표만 떼고 그 사이는 그대로 읽는다 — 그래서 명령을 통째로 한 번 감싼다.
 *  이 인자는 `windowsVerbatimArguments` 로 띄워야 한다 (안 그러면 Node 가 명령 안의 `"` 를 cmd 가 모르는 `\"` 로 바꾼다) */
export function shellCommand(command: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): [string, string[]] {
  if (platform === 'win32') return [env['ComSpec'] || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`]]
  return [env['SHELL'] || '/bin/sh', ['-lc', command]]
}

export interface ExecEnd {
  /** 종료 코드 — 시그널로 끝났거나 실행이 안 됐으면 null */
  exitCode: number | null
  /** done: 스스로 끝남, stopped: 멈춤, timeout: 기한 초과, error: 실행 자체가 안 됨 */
  status: 'done' | 'stopped' | 'timeout' | 'error'
  error?: string
}

export interface ExecOptions {
  command: string
  /** 있는 폴더 (부른 쪽이 확인한다) */
  cwd: string
  timeoutMs: number
  /** 앱 env 에 더할 값 */
  env?: Record<string, string>
  stdin?: string
  onOutput(stream: 'stdout' | 'stderr', text: string): void
}

export interface ExecHandle {
  /** 끝나면(멈춤·기한·실행 실패 포함) 풀린다 — 던지지 않는다. 남은 출력은 그 전에 onOutput 으로 다 나간다 */
  done: Promise<ExecEnd>
  stop(why: 'stopped' | 'timeout'): void
}

export function execShell(opts: ExecOptions): ExecHandle {
  const [file, args] = shellCommand(opts.command)
  const env = { ...process.env, ...opts.env }
  delete env['OPENCODE_SERVER_PASSWORD']
  let stop: ExecHandle['stop'] = () => {}
  const done = new Promise<ExecEnd>((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env,
        detached: process.platform !== 'win32',
        stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: true, // Windows 에서만 뜻이 있다 (shellCommand 의 따옴표)
      })
    } catch (error) {
      return resolve({ exitCode: null, status: 'error', error: (error as Error).message }) // 띄우기부터 던졌다 (잘못된 인자 등)
    }
    let reason: 'stopped' | 'timeout' | undefined
    let settled = false

    const signal = (name: NodeJS.Signals): void => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, name)
        else child.kill(name)
      } catch {
        // 이미 끝났다
      }
    }
    /** Windows — cmd 와 그 자식까지. taskkill 을 못 띄우면 cmd 만이라도 끈다 */
    const killTree = (pid: number): void => {
      try {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill())
      } catch {
        child.kill()
      }
    }
    const streams = (['stdout', 'stderr'] as const).map((name) => {
      const decoded = streamText()
      child[name]!.on('data', (data: Buffer) => opts.onOutput(name, decoded.push(data)))
      return { name, decoded }
    })
    const finish = (end: ExecEnd): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const { name, decoded } of streams) opts.onOutput(name, decoded.end()) // 끊긴 채 끝난 바이트
      resolve(end)
    }
    stop = (why) => {
      if (settled || reason) return
      reason = why
      if (process.platform === 'win32' && child.pid) return killTree(child.pid)
      signal('SIGTERM')
      setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS).unref()
    }
    const timer = setTimeout(() => stop('timeout'), opts.timeoutMs)

    child.on('error', (error) => finish({ exitCode: null, status: 'error', error: error.message }))
    child.on('close', (code) => finish({ exitCode: code, status: reason ?? 'done' }))
    if (opts.stdin !== undefined) {
      child.stdin!.on('error', () => {}) // 읽지 않고 끝난 명령 (EPIPE)
      child.stdin!.end(opts.stdin)
    }
  })
  return { done, stop: (why) => stop(why) }
}
