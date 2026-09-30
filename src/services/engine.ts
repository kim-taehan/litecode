import { Context, Service } from 'cordis'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { findOpencodeBinary, notFoundMessage } from './opencodeBinary.ts'
import { startKeyProxy, type KeyProxy } from './keyProxy.ts'
import type { ProviderConfig } from './providers.ts'
import './providers.ts'

// 앱이 띄우는 opencode 서버 하나의 수명 (ctx.engine). ctx.llm 은 이 서비스에서 주소·인증을 받아 쓰고, 그 밖의 누구도
// opencode 를 모른다. 프로젝트마다 띄우지 않는다 — 세션마다 location.directory 로 폴더를 가른다 (01_probe Q1).
//
// 설정 전달은 실측(2026-09-30, opencode 1.18.18, _workspace/01_probe.md)을 따른다:
// - 신규 세대(/api/session/*)가 읽는 설정은 `OPENCODE_CONFIG_DIR` 폴더(있으면 전역 폴더를 대신한다) + 세션 폴더의 opencode.json 뿐이다.
//   OPENCODE_CONFIG_CONTENT·OPENCODE_CONFIG 는 턴이 prompted 에서 멈춘다 → 앱 전용 폴더에 opencode.json 을 생성한다
// - **진짜 키는 opencode 프로세스에 두지 않는다** (파일에도 env 에도). opencode 는 자기 env 를 프로젝트 플러그인·bash 도구에 넘긴다
//   (03_qa 재현, --pure 로 못 막음). provider baseURL 은 메인 프로세스의 키 프록시(keyProxy.ts) 주소, apiKey 는 프록시 토큰이다
// - 레거시 GET /provider·/config/providers 가 설정의 키(이제 토큰)를 돌려준다 → 실행마다 난수 OPENCODE_SERVER_PASSWORD 를 건다
//   (Basic opencode:<pw>). **남는 한계:** 이 비밀번호는 opencode env 에 있어 플러그인·bash 가 읽는다 — 그걸로 얻는 건 토큰과
//   이 opencode 의 세션 조작이지 진짜 키가 아니다
// - 설정은 재시작해야 적용된다. 재시작·크래시 때 진행 중 턴은 끝 이벤트 없이 사라진다 → connection().closed 로 알린다
// - XDG_CONFIG_HOME 은 안 바꾼다 — opencode 가 띄우는 bash·git 이 물려받는다. 세션 저장소만 OPENCODE_DB 로 뗀다
//
// 부모가 kill -9 로 죽어도 opencode 는 산다 (closed-code pidStore 실측) → 띄운 PID 를 파일에 적고 다음 실행에서 거둔다.
// 끌 때는 우리가 띄운 자식만 끈다 — 사용자가 띄운 opencode 가 같은 기계에 있다.

declare module 'cordis' {
  interface Context {
    engine: EngineService
  }
}

/** ctx.llm 이 opencode 에 닿는 데 필요한 전부 */
export interface EngineConnection {
  url: string
  /** 모든 요청에 싣는다 (Basic 인증) */
  headers: Record<string, string>
  /** 이 서버가 끝나면(재시작·크래시·종료) abort 된다 — opencode 는 끊긴 턴의 끝 이벤트를 주지 않는다 */
  closed: AbortSignal
  /** opencode.json 에 그 provider 의 baseURL 로 적은 주소(키 프록시). 카탈로그의 api.url 이 이것과 다르면 폴더 설정이 덮은 것 */
  providerBaseURL(providerId: string): string
}

export interface EngineOptions {
  /** OPENCODE_CONFIG_DIR — 앱이 opencode.json 을 생성한다. opencode 가 여기에 package.json·node_modules 도 만든다 */
  configDir: string
  /** OPENCODE_DB — 사용자 CLI opencode 의 세션 기록과 가른다 */
  db: string
  /** 띄운 PID 기록 — 앱이 곱게 못 끝났을 때 다음 실행이 거둔다 */
  pidFile: string
  /** 자식에 물려줄 환경 (기본 process.env) */
  env?: NodeJS.ProcessEnv
  /** 설치본에 실린 opencode·rg (opencodeBinary.ts bundledPaths). 개발 실행에는 없다 */
  bundled?: { opencode: string; rgDir: string }
}

interface RunningServer extends EngineConnection {
  pid: number
  stop(): Promise<void>
}

interface ServerRecord {
  pid: number
  /** spawn 에 넘긴 명령줄 그대로 (`<bin> serve --hostname 127.0.0.1 --port <p> --pure`) */
  command: string
  /** `ps -o lstart=` — 같은 PID 를 나중에 물려받은 프로세스와 가른다 */
  started?: string
  url: string
}

const READY_TIMEOUT_MS = 60_000 // 주소를 잡은 뒤에도 /doc 이 수십 초 무응답인 때가 있다 (live-test 스킬 기록)
const KILL_GRACE_MS = 5_000
const MAX_OUTPUT = 4_000

/** 생성할 opencode.json — 모든 provider 가 키 프록시를 거친다. 진짜 키·저장된 baseURL 은 없다 */
export function engineConfig(providers: ProviderConfig[], proxy: Pick<KeyProxy, 'token' | 'baseURLFor'>): Record<string, unknown> {
  const provider: Record<string, unknown> = {}
  for (const config of providers) {
    // provider·모델 id 는 우리 id 그대로 — ctx.llm 이 그대로 넘긴다
    provider[config.id] = {
      npm: '@ai-sdk/openai-compatible',
      name: config.displayName,
      options: { baseURL: proxy.baseURLFor(config.id), apiKey: proxy.token },
      models: Object.fromEntries(config.models.map((model) => [model.id, { name: model.displayName }])),
    }
  }
  return { $schema: 'https://opencode.ai/config.json', provider }
}

/** opencode 자식 프로세스 env — 진짜 키는 없다 (키 프록시) */
export function engineEnv(base: NodeJS.ProcessEnv, opts: { configDir: string; db: string; password: string; rgDir?: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    OPENCODE_CONFIG_DIR: opts.configDir,
    OPENCODE_DB: opts.db,
    OPENCODE_SERVER_PASSWORD: opts.password,
    // models.opencode.ai 카탈로그 받기를 끈다 — 폐쇄망에서 나가는 시도 6번이 사라지고 카탈로그·턴은 그대로 된다 (01b_offline 실측 2/2)
    OPENCODE_DISABLE_MODELS_FETCH: '1',
  }
  delete env['OPENCODE_SERVER_USERNAME'] // Basic 사용자명은 기본값 opencode 로 고정한다
  if (opts.rgDir) {
    // grep·glob 도구는 rg 를 PATH 에서 찾고, 없으면 github 에서 받으려 한다 — 폐쇄망에선 실패하거나 ~300초 멈춘다 (01b_offline 실측).
    // 동봉 rg 를 맨 앞에 둔다. Windows 는 이름이 Path 일 수 있다 — 있는 키에 붙여야 PATH 가 둘이 되지 않는다
    const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
    env[key] = [opts.rgDir, ...(env[key] ? [env[key]] : [])].join(path.delimiter)
  }
  return env
}

export class EngineService extends Service {
  static readonly inject = ['providers']

  private current?: Promise<RunningServer>
  /** 이전 서버가 다 꺼져야 다음 서버를 띄운다 — 같은 DB·설정 폴더를 두 프로세스가 쥐지 않게 */
  private stopping: Promise<void> = Promise.resolve()
  private disposed = false
  /** 엔진과 수명을 같이 한다 (토큰은 앱 실행마다 바뀐다) */
  private proxy?: Promise<KeyProxy>

  constructor(
    ctx: Context,
    private opts: EngineOptions,
  ) {
    super(ctx, 'engine')
    reapStale(opts.pidFile)
    ctx.on('providers/changed', () => void this.restart().catch(() => {}))
    ctx.effect(() => () => this.stop())
  }

  /** 떠 있는 서버의 연결. 없거나 죽었으면 띄운다 (동시에 불러도 한 번만) */
  connection(): Promise<EngineConnection> {
    if (this.disposed) return Promise.reject(new Error('앱이 종료 중입니다'))
    if (!this.current) {
      const launching: Promise<RunningServer> = this.stopping.then(() => this.launch(() => this.forget(launching)))
      launching.catch(() => this.forget(launching))
      this.current = launching
    }
    return this.current
  }

  /** 설정을 다시 써서 띄운다. 진행 중 턴은 끊긴다 (connection().closed) */
  restart(): Promise<EngineConnection> {
    this.retire()
    return this.connection()
  }

  /** 끄고 다시 띄우지 않는다 — 앱 종료 */
  async stop(): Promise<void> {
    this.disposed = true
    this.retire()
    await this.stopping
    await (await this.proxy?.catch(() => undefined))?.close()
  }

  private retire(): void {
    const old = this.current
    this.current = undefined
    const previous = this.stopping
    this.stopping = (async () => {
      await previous
      const server = await old?.catch(() => undefined)
      await server?.stop()
    })()
  }

  private forget(server: Promise<RunningServer>): void {
    if (this.current === server) this.current = undefined
  }

  private async launch(onExit: () => void): Promise<RunningServer> {
    const base = this.opts.env ?? process.env
    const lookup = findOpencodeBinary(base, undefined, this.opts.bundled?.opencode)
    if (!lookup.path) throw new Error(notFoundMessage(lookup))
    const bin = lookup.path

    // 저장된 설정을 요청마다 본다 — 키는 이 메인 프로세스에서만 풀린다
    this.proxy ??= startKeyProxy((id) => {
      const provider = this.ctx.providers.get(id)
      return provider && { baseURL: provider.baseURL, apiKey: this.ctx.providers.apiKey(id) }
    })
    const proxy = await this.proxy
    fs.mkdirSync(this.opts.configDir, { recursive: true })
    fs.writeFileSync(path.join(this.opts.configDir, 'opencode.json'), JSON.stringify(engineConfig(this.ctx.providers.all(), proxy), null, 2))

    const password = randomBytes(24).toString('base64url')
    const port = await freePort()
    const env = engineEnv(base, { configDir: this.opts.configDir, db: this.opts.db, password, rgDir: this.opts.bundled?.rgDir })

    const args = ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--pure']
    const child = spawn(bin, args, {
      cwd: path.dirname(this.opts.configDir),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const collect = (part: Buffer): void => {
      if (output.length < MAX_OUTPUT) output += part.toString()
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    const closer = new AbortController()
    const exited = new Promise<void>((resolve) =>
      child.once('exit', (code, signal) => {
        closer.abort(new Error(`opencode 가 끝났습니다 (code=${code} signal=${signal})`))
        forgetRecord(this.opts.pidFile, child.pid)
        onExit()
        resolve()
      }),
    )
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', (error) => reject(new Error(`opencode 를 실행하지 못했습니다 (${bin}): ${error.message}`)))
    })

    const url = `http://127.0.0.1:${port}`
    writeRecord(this.opts.pidFile, { pid: child.pid!, command: [bin, ...args].join(' '), started: observe(child.pid!).started, url })
    const stop = async (): Promise<void> => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
      await exited
      clearTimeout(timer)
    }

    const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` }
    try {
      await waitUntilReady(url, headers, closer.signal)
    } catch (error) {
      await stop()
      throw new Error(`${(error as Error).message}\n${output.trim()}`.trimEnd())
    }
    return { url, headers, closed: closer.signal, providerBaseURL: (id) => proxy.baseURLFor(id), pid: child.pid!, stop }
  }
}

async function waitUntilReady(url: string, headers: Record<string, string>, closed: AbortSignal): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let last = ''
  while (Date.now() < deadline) {
    if (closed.aborted) throw new Error(`opencode 가 준비 전에 끝났습니다 — ${(closed.reason as Error).message}`)
    try {
      const res = await fetch(`${url}/doc`, { headers, signal: AbortSignal.timeout(2_000) })
      if (res.ok) return
      last = `HTTP ${res.status}`
    } catch (error) {
      last = String((error as Error).cause ?? error) // 아직 안 떴다
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`opencode 가 ${READY_TIMEOUT_MS / 1000}초 안에 준비되지 않았습니다 (마지막 응답: ${last})`)
}

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as net.AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}

// PID 기록 — 한 서버라 기록도 하나다. 동기로 쓴다: 띄운 직후 앱이 죽어도 PID 는 파일에 있어야 한다.
function writeRecord(file: string, record: ServerRecord): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(record))
  } catch {
    // 못 적어도 앱은 떠야 한다 — 대가는 "강제 종료 뒤 유령이 남을 수 있다" 뿐
  }
}

function forgetRecord(file: string, pid: number | undefined): void {
  try {
    if ((JSON.parse(fs.readFileSync(file, 'utf8')) as ServerRecord).pid === pid) fs.rmSync(file)
  } catch {
    // 없거나 망가졌다
  }
}

/** 기록한 그 프로세스가 아직 그대로인가 — PID 는 재사용된다. 명령줄 **전체**(포트·--pure 까지)와 시작 시각이 둘 다 같을 때만 참.
 *  같은 실행 파일로 사용자가 띄운 `opencode serve --hostname 127.0.0.1` 과 가르려면 bin+serve 로는 모자라다 (03_qa 경고).
 *  argv[0] 은 spawn 에 넘긴 문자열 그대로라 기록한 명령줄과 글자까지 같다 (closed-code pidStore 실측) */
export function isOurServer(record: Pick<ServerRecord, 'command' | 'started'>, observed: { command?: string; started?: string }): boolean {
  return !!record.started && observed.command === record.command && observed.started === record.started
}

function observe(pid: number): { command?: string; started?: string } {
  if (process.platform === 'win32') return {} // ps 가 없다 — 확인 못 한 PID 는 안 죽인다
  const ps = (field: string): string | undefined => {
    try {
      return execFileSync('ps', ['-p', String(pid), '-o', `${field}=`], { encoding: 'utf8' }).trim() || undefined
    } catch {
      return undefined // 없는 PID
    }
  }
  return { command: ps('command'), started: ps('lstart') }
}

/** 지난 실행이 남긴 서버를 거둔다. 기록은 무조건 지운다 — 더는 우리 것을 가리키지 않는다 */
function reapStale(file: string): void {
  let record: ServerRecord
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8')) as ServerRecord
  } catch {
    return
  }
  if (typeof record.pid === 'number' && typeof record.command === 'string' && isOurServer(record, observe(record.pid))) {
    try {
      process.kill(record.pid, 'SIGTERM')
    } catch {
      // 그 사이 끝났다
    }
  }
  fs.rmSync(file, { force: true })
}
