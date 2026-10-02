import { Context, Service } from 'cordis'
import { spawn, type ChildProcess } from 'node:child_process'
import { realDirectory } from './llm.ts'

// `!명령` 실행 (ctx.shell) — 사용자가 입력창에 친 명령을 프로젝트 폴더에서 한 번 돌려 결과를 대화 카드로 남긴다 (closed-code
// electron/session/shellRunner.ts 의 규칙, 01h 권고). **LLM 을 거치지 않고 opencode 와도 무관하다** — 맥락에는 사용자가 카드의
// "AI 에게 보내기" 를 누를 때만 들어간다(ctx.llm.addContext). opencode 권한 규칙을 안 거치는 것은 사용자가 손으로 친 명령이라서다.
// - 로그인 셸(`$SHELL -lc`)로 띄운다 — Finder 로 띄운 앱은 PATH 가 짧아 npm·node 를 못 찾는다 (01h §6a)
// - stdin 은 닫는다(입력이 필요한 명령은 곧 실패한다 — 그런 건 터미널 칸에서). stdout·stderr 는 터미널처럼 합친다
// - 출력은 앞에서 OUTPUT_LIMIT 까지만 (화면·IPC·디스크를 통째로 막지 않게), 기한 TIMEOUT_MS 를 넘기거나 ■ 로 멈추면 프로세스 그룹을 끈다
// - 앱을 끄면(서비스가 내려가면) 돌던 명령도 끈다

declare module 'cordis' {
  interface Context {
    shell: ShellService
  }
  interface Events {
    /** 돌고 있는 명령의 출력 조각 (상한 안쪽만) */
    'shell/data'(runId: string, chunk: string): void
  }
}

export const OUTPUT_LIMIT = 100 * 1024
export const TIMEOUT_MS = 60_000
const KILL_GRACE_MS = 2_000

/** 끝난 명령 하나 */
export interface ShellResult {
  command: string
  output: string
  /** 종료 코드 — 시그널로 끝났거나 실행이 안 됐으면 null */
  exitCode: number | null
  /** done: 스스로 끝남, stopped: ■ 로 멈춤, timeout: 기한 초과, error: 실행 자체가 안 됨(셸 없음·폴더 없음) */
  status: 'done' | 'stopped' | 'timeout' | 'error'
  /** 출력이 OUTPUT_LIMIT 에서 잘렸다 */
  truncated: boolean
  error?: string
}

/** 띄울 셸과 인자 — 로그인 셸에 명령 하나. Windows 는 cmd */
export function shellCommand(command: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): [string, string[]] {
  if (platform === 'win32') return [env['ComSpec'] || 'cmd.exe', ['/d', '/s', '/c', command]]
  return [env['SHELL'] || '/bin/sh', ['-lc', command]]
}

export class ShellService extends Service {
  private running = new Map<string, { child: ChildProcess; stop(reason: 'stopped' | 'timeout'): void }>()

  /** timeoutMs 는 테스트만 줄인다 (기본 TIMEOUT_MS) */
  constructor(
    ctx: Context,
    private opts: { timeoutMs?: number } = {},
  ) {
    super(ctx, 'shell')
    ctx.effect(() => () => {
      for (const run of this.running.values()) run.stop('stopped')
    })
  }

  /** 프로젝트 폴더에서 돌리고 끝나면 결과를 준다. 출력 조각은 'shell/data' 로 흘린다 */
  async run(runId: string, directory: string, command: string): Promise<ShellResult> {
    const cwd = await realDirectory(directory)
    if (!cwd) return { command, output: '', exitCode: null, status: 'error', truncated: false, error: `작업 디렉터리가 없다: ${directory}` }
    const [file, args] = shellCommand(command)
    return new Promise((resolve) => {
      // 그룹으로 띄워 ■·기한에 자식(파이프·백그라운드)까지 끈다. 서버 비밀번호는 메인 env 에 원래 없지만 혹시 몰라 지운다
      const env = { ...process.env }
      delete env['OPENCODE_SERVER_PASSWORD']
      const child = spawn(file, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      let truncated = false
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
      const finish = (result: Omit<ShellResult, 'command' | 'output' | 'truncated'>): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.running.delete(runId)
        resolve({ command, output, truncated, ...result })
      }
      const collect = (data: Buffer): void => {
        if (truncated) return
        let chunk = data.toString()
        if (output.length + chunk.length > OUTPUT_LIMIT) {
          chunk = chunk.slice(0, OUTPUT_LIMIT - output.length)
          truncated = true
        }
        output += chunk
        if (chunk) this.ctx.emit('shell/data', runId, chunk)
      }
      const stop = (why: 'stopped' | 'timeout'): void => {
        if (settled || reason) return
        reason = why
        signal('SIGTERM')
        setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS).unref()
      }
      const timer = setTimeout(() => stop('timeout'), this.opts.timeoutMs ?? TIMEOUT_MS)

      child.stdout!.on('data', collect)
      child.stderr!.on('data', collect)
      child.on('error', (error) => finish({ exitCode: null, status: 'error', error: error.message }))
      child.on('close', (code) => finish({ exitCode: code, status: reason ?? 'done' }))
      this.running.set(runId, { child, stop })
    })
  }

  /** ■ — 돌고 있으면 멈춘다 (결과는 run 이 status 'stopped' 로 준다) */
  stop(runId: string): boolean {
    const run = this.running.get(runId)
    run?.stop('stopped')
    return !!run
  }
}

/** 카드를 AI 에게 넣을 때의 본문 — 모델은 이 명령을 본 적이 없으니 무엇을 어디서 돌렸는지부터 (closed-code ChatPane 형식).
 *  출력은 마크다운으로 해석되지 않게 코드 블록으로 감싼다 (출력에 ``` 가 있으면 더 긴 울타리) */
export function shellContext(result: Pick<ShellResult, 'command' | 'output' | 'exitCode' | 'status' | 'truncated'>, directory: string): string {
  const fence = '`'.repeat(Math.max(3, ...[...result.output.matchAll(/`{3,}/g)].map((match) => match[0].length + 1)))
  const ending =
    result.status === 'stopped' ? '사용자가 중단함'
    : result.status === 'timeout' ? `${TIMEOUT_MS / 1000}초를 넘겨 중단됨`
    : result.exitCode === null ? '실행되지 않음'
    : `종료 코드 ${result.exitCode}`
  return [
    `사용자가 프로젝트 폴더(${directory})에서 직접 실행한 셸 명령과 그 출력입니다.`,
    '',
    `$ ${result.command}`,
    `(${ending})`,
    '',
    fence,
    result.output.trimEnd(),
    fence,
    ...(result.truncated ? ['', `(출력이 ${OUTPUT_LIMIT / 1024}KB 에서 잘렸습니다)`] : []),
  ].join('\n')
}
