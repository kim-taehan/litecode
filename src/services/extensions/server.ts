import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { ExtensionServer, ExtensionServerFailure, ExtensionServerPhase } from '../../../shared/extensions.ts'
import { isEntryPath } from './paths.ts'

// 확장의 내장 서버 (이슈 #537) — 확장의 JS 는 메인에서 돌리지 않는다. 대신 manifest 의 선언형 `server` 를 앱이 읽고 그대로만 띄운다.
// 근거 실측은 _workspace/01_probe_537.md (SonarQube 26.10 CE + jlink 로 만든 Java 21 런타임, macOS arm64).
// - 실행 파일·작업 폴더는 확장 폴더 안의 상대 경로만(zip 항목과 같은 규칙, paths.ts). 인자는 문자열 배열로 셸 없이 띄운다
// - 자리표시는 앱이 채우는 넷뿐: ${extensionDir} · ${dataDir}(userData 아래 확장별) · ${port}(선언한 고정 포트) · ${freePort:이름}(띄울 때 고른 빈 포트).
//   SonarQube 의 내장 DB(H2)는 포트를 0 으로 주면 못 뜬다 — 그래서 앱이 빈 포트를 골라 넣는다 (실측 §4)
// - 127.0.0.1 고정: 준비 판정 주소도 127.0.0.1 이다. 서버 쪽 바인드 주소는 선언의 인자가 정한다(SonarQube 는 -Dsonar.web.host=127.0.0.1)
// - 단계: port(포트가 비었나) → launching(띄움, 상태 주소 무응답) → starting(상태 주소가 준비 아닌 값을 줌 — detail 에 그 값) → admin(관리자 준비) → running
// - 내리기: 프로세스 그룹째 SIGTERM → 기한 → SIGKILL. SonarQube 는 자식 셋(검색 엔진·웹·계산 엔진)을 따로 띄우고, 부모만 죽이면 자식이 포트를 쥔 채
//   남는다 (실측 §6). 정상 종료는 8~12초였다. Windows 는 프로세스 그룹이 없어 taskkill /T /F 로 곧장 끈다 — **Windows 는 미검증**
// - 던지지 않는다: 실패는 상태(failed + 실패 코드)로 낸다
// - 출력은 파이프가 아니라 데이터 폴더의 server.log 로 — 앱이 꺼진 뒤에도 서버가 돌 수 있다(stopWithApp 끔). 파이프면 앱이 꺼질 때 끊긴다
// - 띄운 PID 를 데이터 폴더의 server.pid.json 에 적는다 (engine.ts 의 PID 기록과 같은 까닭 — 앱이 강제로 꺼지면 그룹 전체가 남는다).
//   다음 띄우기는 먼저 기록을 본다: 그 PID 가 살아 있고 명령줄(ps)에 그 확장 폴더 경로가 있으면 우리 서버다 — 준비됐으면 다시 잡고(adopt), 아니면 그룹째 내린다.
//   (실행 파일 경로가 아니라 폴더로 보는 것은 셸 스크립트가 exec 로 바꿔 띄우는 서버도 있어서다 — 그래도 인자에 확장 폴더 안 경로가 남는다)
//   다른 프로그램이 그 PID 를 이어받았으면 건드리지 않는다. **Windows 는 기록을 지우기만 한다(미검증 — ps 가 없다)**

/** 앱이 아는 관리자 준비 — 이름마다 앱 안의 순수 로직이 있다 (serverAdmin.ts) */
const ADMIN_KINDS = ['sonarqube'] as const

/** 선언의 모양은 화면과 같이 쓴다 (shared/extensions.ts) */
export type ServerDeclaration = ExtensionServer

export type ServerDeclarationField = 'shape' | 'command' | 'cwd' | 'args' | 'env' | 'port' | 'health' | 'admin'

const PLACEHOLDER = /\$\{([^}]*)\}/g
const FIXED_PLACEHOLDERS = new Set(['extensionDir', 'dataDir', 'port'])
const FREE_PORT = /^freePort:([a-zA-Z][a-zA-Z0-9]*)$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

const knownPlaceholders = (text: string): boolean => [...text.matchAll(PLACEHOLDER)].every(([, name]) => FIXED_PLACEHOLDERS.has(name!) || FREE_PORT.test(name!))
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== ''

/** manifest 의 `server` 검사 — 첫 번째로 틀린 필드 하나 */
export function parseServerDeclaration(raw: unknown): { ok: true; server: ServerDeclaration } | { ok: false; field: ServerDeclarationField } {
  if (!isRecord(raw)) return { ok: false, field: 'shape' }
  const { command, cwd, args, env = {}, port, health, admin } = raw
  if (typeof command !== 'string' || !isEntryPath(command)) return { ok: false, field: 'command' }
  if (cwd !== undefined && (typeof cwd !== 'string' || !isEntryPath(cwd))) return { ok: false, field: 'cwd' }
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string' && knownPlaceholders(arg))) return { ok: false, field: 'args' }
  if (!isRecord(env) || !Object.entries(env).every(([name, value]) => ENV_NAME.test(name) && typeof value === 'string' && knownPlaceholders(value))) {
    return { ok: false, field: 'env' }
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) return { ok: false, field: 'port' }
  if (!isRecord(health) || typeof health.path !== 'string' || !health.path.startsWith('/') || !nonEmpty(health.field) || !nonEmpty(health.ready)) {
    return { ok: false, field: 'health' }
  }
  if (admin !== undefined && !ADMIN_KINDS.includes(admin as never)) return { ok: false, field: 'admin' }
  return {
    ok: true,
    server: {
      command,
      args: args as string[],
      env: env as Record<string, string>,
      ...(cwd !== undefined && { cwd }),
      port,
      health: { path: health.path, field: health.field, ready: health.ready },
      ...(admin !== undefined && { admin: admin as ServerDeclaration['admin'] }),
    },
  }
}

export interface ServerLaunch {
  file: string
  args: string[]
  env: Record<string, string>
  cwd: string
  baseUrl: string
  healthUrl: string
}

/** 선언의 ${freePort:이름} 이름들 — 띄울 때 이름마다 빈 포트를 하나씩 고른다 */
function freePortNames(declaration: ServerDeclaration): string[] {
  const texts = [...declaration.args, ...Object.values(declaration.env)]
  return [...new Set(texts.flatMap((text) => [...text.matchAll(PLACEHOLDER)].flatMap(([, name]) => FREE_PORT.exec(name!)?.[1] ?? [])))]
}

/** 자리표시를 채우고 경로를 절대 경로로 — 선언은 parseServerDeclaration 을 지난 것 */
export function resolveLaunch(declaration: ServerDeclaration, where: { extensionDir: string; dataDir: string; freePorts: Record<string, number> }): ServerLaunch {
  const fill = (text: string): string =>
    text.replace(PLACEHOLDER, (_, name: string) => {
      if (name === 'extensionDir') return where.extensionDir
      if (name === 'dataDir') return where.dataDir
      if (name === 'port') return String(declaration.port)
      return String(where.freePorts[FREE_PORT.exec(name)![1]!])
    })
  const baseUrl = `http://127.0.0.1:${declaration.port}`
  return {
    file: path.join(where.extensionDir, declaration.command),
    args: declaration.args.map(fill),
    env: Object.fromEntries(Object.entries(declaration.env).map(([name, value]) => [name, fill(value)])),
    cwd: declaration.cwd === undefined ? where.extensionDir : path.join(where.extensionDir, declaration.cwd),
    baseUrl,
    healthUrl: baseUrl + declaration.health.path,
  }
}

export type ServerPhase = ExtensionServerPhase
export type ServerFailure = ExtensionServerFailure

export interface ServerState {
  phase: ServerPhase
  /** starting: 상태 주소가 준 값(STARTING 등) · failed: 덧붙일 사유(관리자 준비의 실패 코드, 띄우기 오류) */
  detail?: string
  error?: ServerFailure
  /** failed 때 서버 출력(server.log)의 끝 — 기동 실패 사유는 출력의 끝에 있다 */
  output?: string
}

export interface ServerOptions {
  extensionDir: string
  /** 확장별 데이터 폴더 — 없으면 띄우기 전에 만든다. server.log·server.pid.json 도 여기 */
  dataDir: string
  onState(state: ServerState): void
  /** 준비된 뒤 한 번(다시 잡았을 때도) — 던지면 서버를 내리고 admin-failed (Error.message 가 detail) */
  prepare?(baseUrl: string): Promise<void>
  fetch?: typeof globalThis.fetch
  /** 준비 기한 — SonarQube 첫 기동은 이 기계에서 45~50초, 데이터가 있으면 21~24초였다 (실측 §3). 느린 PC 를 보고 넉넉히 */
  readyTimeoutMs?: number
  pollMs?: number
  /** SIGTERM 뒤 SIGKILL 까지 — 정상 종료 7~12초 실측의 약 세 배 */
  killGraceMs?: number
}

export interface ServerHandle {
  /** running 이나 failed·stopped 에 닿으면 풀린다 — 던지지 않는다 */
  ready: Promise<ServerState>
  state(): ServerState
  /** 내린다 — 뜨는 중이어도 된다. 여러 번 불러도 된다 */
  stop(): Promise<void>
}

const READY_TIMEOUT_MS = 300_000
const POLL_MS = 1_000
const KILL_GRACE_MS = 30_000
const MAX_OUTPUT = 4_000
const PROBE_TIMEOUT_MS = 2_000
/** 다시 잡은 서버(우리 자식이 아니라 exit 이벤트가 없다)가 살아 있는지 보는 간격 */
const WATCH_MS = 1_000

export const SERVER_LOG = 'server.log'
export const SERVER_RECORD = 'server.pid.json'

/** 띄운 서버의 기록 — pid 는 프로세스 그룹 id 와 같다(detached). dir 은 확장 폴더 — 다시 잡을 때 그 PID 가 우리 것인지 명령줄로 본다 */
interface ServerRecord {
  pid: number
  dir: string
}

/** 데이터 폴더에 기록이 있나 */
export function hasServerRecord(dataDir: string): boolean {
  return fs.existsSync(path.join(dataDir, SERVER_RECORD))
}

/** 지난 실행이 남긴 우리 서버가 아직 살아 있나 — 기록의 PID 가 살아 있고, 기록의 폴더가 이 확장 폴더이며, 그 PID 의 명령줄에 그 폴더가 있을 때만 (QA 03_qa_537) */
export function leftoverAlive(dataDir: string, extensionDir: string): boolean {
  const record = readRecord(path.join(dataDir, SERVER_RECORD))
  return record !== undefined && record.dir === extensionDir && process.platform !== 'win32' && alive(record.pid) && owned(record)
}

/** 지난 실행이 남긴 기록을 정리한다 — 우리 서버가 살아 있으면 그룹째 내리고(SIGTERM → 기한 → SIGKILL), 죽었거나 남의 PID 면 기록만 지운다.
 *  앱을 켤 때 "같이 띄우기" 가 아닌 확장에 쓴다 — 기록이 남았다고 새로 띄우지 않는다 (QA 03_qa_537 차단) */
export async function reapServerRecord(dataDir: string, extensionDir: string, graceMs = KILL_GRACE_MS): Promise<void> {
  const file = path.join(dataDir, SERVER_RECORD)
  const record = readRecord(file)
  if (record !== undefined && leftoverAlive(dataDir, extensionDir)) {
    signalGroup(record.pid, 'SIGTERM')
    if (!(await waitGone(record.pid, graceMs))) signalGroup(record.pid, 'SIGKILL')
    await waitGone(record.pid, graceMs)
  }
  fs.rmSync(file, { force: true })
}

/** 띄운 서버(또는 다시 잡은 서버) 하나 — 우리 자식이면 이벤트로, 다시 잡은 것이면 주기적으로 살아 있나를 본다 */
interface Running {
  pid: number
  /** 그룹의 우두머리가 끝나면 풀린다 */
  exited: Promise<void>
}

export function startServer(declaration: ServerDeclaration, opts: ServerOptions): ServerHandle {
  const doFetch = opts.fetch ?? globalThis.fetch
  const logFile = path.join(opts.dataDir, SERVER_LOG)
  const recordFile = path.join(opts.dataDir, SERVER_RECORD)
  const grace = opts.killGraceMs ?? KILL_GRACE_MS
  let current: ServerState = { phase: 'port' }
  let running: Running | undefined
  let stopping: Promise<void> | undefined

  const set = (state: ServerState): void => {
    current = state
    opts.onState(state)
  }
  const settled = (): boolean => current.phase === 'stopping' || current.phase === 'stopped'
  /** 서버가 스스로 끝나면 exit 처리기가 그 사이에 failed 로 바꾼다 — 기다린 뒤에는 이것으로 다시 읽는다 */
  const failed = (): boolean => current.phase === 'failed'
  /** 멈춤이 끼어들었다 — 멈춤이 끝난 상태(stopped)로 풀린다 */
  const halted = async (): Promise<ServerState> => {
    await stopping
    return current
  }
  const fail = (error: ServerFailure, detail?: string): ServerState => {
    const output = logTail(logFile)
    const state: ServerState = { phase: 'failed', error, ...(detail !== undefined && { detail }), ...(output !== '' && { output }) }
    set(state)
    return state
  }

  const kill = async (): Promise<void> => {
    if (running === undefined) return
    const { pid, exited } = running
    if (!alive(pid)) return
    signalGroup(pid, 'SIGTERM')
    const timer = setTimeout(() => signalGroup(pid, 'SIGKILL'), grace)
    await exited
    clearTimeout(timer)
  }

  /** 우두머리가 끝나면 — 그룹에 남은 자식을 쓸어 내고(SonarQube 는 부모만 죽으면 자식이 포트를 쥔 채 남는다, 실측 §6) 기록을 지운다 */
  const watchExit = (pid: number, exited: Promise<void>): Running => {
    void exited.then(() => {
      signalGroup(pid, 'SIGKILL')
      fs.rmSync(recordFile, { force: true })
      if (!settled() && !failed()) fail('exited')
    })
    return { pid, exited }
  }

  /** 지난 기록 — 우리 서버가 준비된 채 살아 있으면 다시 잡는다(true). 아니면 내리고 기록을 지운다 */
  const reclaim = async (healthUrl: string): Promise<boolean> => {
    const record = readRecord(recordFile)
    if (record === undefined) return false
    if (record.dir === opts.extensionDir && process.platform !== 'win32' && alive(record.pid) && owned(record)) {
      if ((await probe(doFetch, healthUrl, declaration.health.field)) === declaration.health.ready) {
        running = watchExit(record.pid, pollUntilGone(record.pid))
        return true
      }
      signalGroup(record.pid, 'SIGTERM')
      if (!(await waitGone(record.pid, grace))) signalGroup(record.pid, 'SIGKILL')
      await waitGone(record.pid, grace)
    }
    fs.rmSync(recordFile, { force: true })
    return false
  }

  const launch = async (file: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<string | undefined> => {
    const out = fs.openSync(logFile, 'w')
    const spawned = (() => {
      try {
        return spawn(file, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', out, out], windowsHide: true })
      } finally {
        fs.closeSync(out) // 자식이 제 사본을 쥐었다
      }
    })()
    const error = await new Promise<string | undefined>((resolve) => {
      spawned.once('spawn', () => resolve(undefined))
      spawned.once('error', (failure) => resolve(failure.message))
    })
    if (error !== undefined) return error
    const pid = spawned.pid!
    // 띄운 직후 앱이 죽어도 PID 는 파일에 있어야 한다 — 동기로 쓴다
    fs.writeFileSync(recordFile, JSON.stringify({ pid, dir: opts.extensionDir } satisfies ServerRecord))
    running = watchExit(pid, new Promise((resolve) => spawned.once('exit', () => resolve())))
    return undefined
  }

  const run = async (): Promise<ServerState> => {
    set({ phase: 'port' })
    fs.mkdirSync(opts.dataDir, { recursive: true })
    const healthUrl = `http://127.0.0.1:${declaration.port}${declaration.health.path}`
    const adopted = await reclaim(healthUrl)
    if (settled()) return halted()
    let baseUrl = `http://127.0.0.1:${declaration.port}`
    if (!adopted) {
      if (await portInUse(declaration.port)) return fail('port-in-use')
      const freePorts: Record<string, number> = {}
      for (const name of freePortNames(declaration)) freePorts[name] = await freePort()
      const resolved = resolveLaunch(declaration, { extensionDir: opts.extensionDir, dataDir: opts.dataDir, freePorts })
      baseUrl = resolved.baseUrl
      if (settled()) return halted()

      set({ phase: 'launching' })
      const env = { ...process.env, ...resolved.env }
      delete env['OPENCODE_SERVER_PASSWORD']
      const error = await launch(resolved.file, resolved.args, env, resolved.cwd)
      if (error !== undefined) return fail('spawn-failed', error)

      const deadline = Date.now() + (opts.readyTimeoutMs ?? READY_TIMEOUT_MS)
      while (true) {
        if (settled()) return halted()
        if (failed()) return current
        const value = await probe(doFetch, healthUrl, declaration.health.field)
        if (value === declaration.health.ready) break
        if (value !== undefined && (current.phase !== 'starting' || current.detail !== value)) set({ phase: 'starting', detail: value })
        if (Date.now() > deadline) {
          const last = current.detail
          await kill()
          return fail('not-ready', last)
        }
        await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? POLL_MS))
      }
    }

    if (opts.prepare) {
      set({ phase: 'admin' })
      try {
        await opts.prepare(baseUrl)
      } catch (error) {
        if (settled()) return halted()
        if (failed()) return current
        const state = fail('admin-failed', (error as Error).message)
        await kill()
        return state
      }
    }
    if (settled()) return halted()
    if (failed()) return current
    set({ phase: 'running' })
    return current
  }

  const ready = run()
  return {
    ready,
    state: () => current,
    stop: () => {
      stopping ??= (async () => {
        set({ phase: 'stopping' })
        await kill()
        set({ phase: 'stopped' })
      })()
      return stopping
    },
  }
}

/** 그룹째 신호 — Windows 는 그룹이 없어 taskkill /T /F (신호 종류와 상관없이 곧장 끈다) */
function signalGroup(pid: number, name: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {})
    else process.kill(-pid, name)
  } catch {
    // 이미 끝났다
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 그 PID 의 명령줄에 그 확장 폴더 경로가 있나 — PID 를 다른 프로그램이 이어받았으면 건드리지 않는다 */
function owned(record: ServerRecord): boolean {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(record.pid)], { encoding: 'utf8', timeout: 5_000 }).includes(record.dir + path.sep)
  } catch {
    return false
  }
}

function readRecord(file: string): ServerRecord | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ServerRecord>
    return Number.isInteger(value.pid) && (value.pid as number) > 0 && typeof value.dir === 'string' && value.dir !== '' ? { pid: value.pid!, dir: value.dir } : undefined
  } catch {
    return undefined
  }
}

/** 우리 자식이 아닌 프로세스가 끝나기를 — exit 이벤트가 없어 주기적으로 본다 */
function pollUntilGone(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (alive(pid)) return
      clearInterval(timer)
      resolve()
    }, WATCH_MS)
  })
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (alive(pid)) {
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return true
}

/** server.log 의 끝 MAX_OUTPUT 자 — 기동 실패 사유는 출력의 끝에 있다 */
function logTail(file: string): string {
  return tailText(file, MAX_OUTPUT).trim()
}

/** 로그 파일의 끝 chars 자 — 없으면 빈 글. 파일 전체를 읽지 않고 끝만 읽는다 (패널의 로그 창이 1초마다 부른다, 이슈 #551) */
export function tailText(file: string, chars: number): string {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const length = Math.min(size, chars * 4)
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, size - length)
    return buffer.toString('utf8').slice(-chars).replace(/^\uFFFD+/, '')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** 상태 주소의 JSON 에서 field 값 — 아직 안 떴거나 모양이 다르면 undefined */
async function probe(doFetch: typeof globalThis.fetch, url: string, field: string): Promise<string | undefined> {
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (!res.ok) return undefined
    const value = ((await res.json()) as Record<string, unknown>)[field]
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

/** 127.0.0.1:port 에 누가 받고 있나 — 붙어 보면 0.0.0.0·127.0.0.1 어느 쪽에 묶인 서버든 잡힌다 */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.setTimeout(PROBE_TIMEOUT_MS)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve(true) // 루프백이 답이 없다 — 누가 쥐고 있다고 본다
    })
    socket.once('error', () => resolve(false))
  })
}

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as net.AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}
