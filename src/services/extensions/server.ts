import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { keepTail, streamText } from '../outputBuffer.ts'
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

/** 앱이 아는 관리자 준비 — 이름마다 앱 안의 순수 로직이 있다 (serverAdmin.ts) */
const ADMIN_KINDS = ['sonarqube'] as const

export interface ServerDeclaration {
  /** 확장 폴더 기준 실행 파일 */
  command: string
  args: string[]
  /** 앱 env 에 더할 값 */
  env: Record<string, string>
  /** 확장 폴더 기준 작업 폴더 — 없으면 확장 폴더 */
  cwd?: string
  /** 127.0.0.1 의 고정 포트 */
  port: number
  /** 준비 판정 — GET path 의 JSON 에서 field 가 ready 면 준비됨 */
  health: { path: string; field: string; ready: string }
  admin?: (typeof ADMIN_KINDS)[number]
}

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

export type ServerPhase = 'port' | 'launching' | 'starting' | 'admin' | 'running' | 'stopping' | 'stopped' | 'failed'
/** port-in-use: 포트를 누가 쓴다 · spawn-failed: 실행 파일을 못 띄움 · exited: 서버가 스스로 끝남 · not-ready: 기한 안에 준비가 안 됨 · admin-failed: 관리자 준비 실패 */
export type ServerFailure = 'port-in-use' | 'spawn-failed' | 'exited' | 'not-ready' | 'admin-failed'

export interface ServerState {
  phase: ServerPhase
  /** starting: 상태 주소가 준 값(STARTING 등) · failed: 덧붙일 사유(관리자 준비의 실패 코드, 띄우기 오류) */
  detail?: string
  error?: ServerFailure
  /** failed 때 서버 출력의 끝 — 기동 실패 사유는 출력의 끝에 있다 */
  output?: string
}

export interface ServerOptions {
  extensionDir: string
  /** 확장별 데이터 폴더 — 없으면 띄우기 전에 만든다 */
  dataDir: string
  onState(state: ServerState): void
  /** 준비된 뒤 한 번 — 던지면 서버를 내리고 admin-failed (Error.message 가 detail) */
  prepare?(baseUrl: string): Promise<void>
  fetch?: typeof globalThis.fetch
  /** 준비 기한 — SonarQube 첫 기동은 이 기계에서 49초, 데이터가 있으면 21초였다 (실측 §3). 느린 PC 를 보고 넉넉히 */
  readyTimeoutMs?: number
  pollMs?: number
  /** SIGTERM 뒤 SIGKILL 까지 — 정상 종료 8~12초 실측의 약 세 배 */
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

export function startServer(declaration: ServerDeclaration, opts: ServerOptions): ServerHandle {
  const doFetch = opts.fetch ?? globalThis.fetch
  const output = keepTail(MAX_OUTPUT)
  let current: ServerState = { phase: 'port' }
  let child: ChildProcess | undefined
  let exited: Promise<void> = Promise.resolve()
  let stopping: Promise<void> | undefined

  const set = (state: ServerState): void => {
    current = state
    opts.onState(state)
  }
  const settled = (): boolean => current.phase === 'stopping' || current.phase === 'stopped'
  /** 서버가 스스로 끝나면 close 처리기가 그 사이에 failed 로 바꾼다 — 기다린 뒤에는 이것으로 다시 읽는다 */
  const failed = (): boolean => current.phase === 'failed'
  /** 멈춤이 끼어들었다 — 멈춤이 끝난 상태(stopped)로 풀린다 */
  const halted = async (): Promise<ServerState> => {
    await stopping
    return current
  }
  const fail = (error: ServerFailure, detail?: string): ServerState => {
    const state: ServerState = { phase: 'failed', error, ...(detail !== undefined && { detail }), output: output.text().trim() }
    set(state)
    return state
  }

  const signal = (name: NodeJS.Signals): void => {
    if (!child?.pid) return
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child?.kill())
      else process.kill(-child.pid, name)
    } catch {
      // 이미 끝났다
    }
  }
  const kill = async (): Promise<void> => {
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
    signal('SIGTERM')
    const timer = setTimeout(() => signal('SIGKILL'), opts.killGraceMs ?? KILL_GRACE_MS)
    await exited
    clearTimeout(timer)
  }

  const run = async (): Promise<ServerState> => {
    set({ phase: 'port' })
    if (await portInUse(declaration.port)) return fail('port-in-use')
    const freePorts: Record<string, number> = {}
    for (const name of freePortNames(declaration)) freePorts[name] = await freePort()
    const launch = resolveLaunch(declaration, { extensionDir: opts.extensionDir, dataDir: opts.dataDir, freePorts })
    fs.mkdirSync(opts.dataDir, { recursive: true })
    if (settled()) return halted()

    set({ phase: 'launching' })
    const env = { ...process.env, ...launch.env }
    delete env['OPENCODE_SERVER_PASSWORD']
    const spawned = spawn(launch.file, launch.args, { cwd: launch.cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    for (const stream of [spawned.stdout, spawned.stderr]) {
      const decoded = streamText()
      stream?.on('data', (part: Buffer) => output.push(decoded.push(part)))
    }
    const started = await new Promise<string | undefined>((resolve) => {
      spawned.once('spawn', () => resolve(undefined))
      spawned.once('error', (error) => resolve(error.message))
    })
    if (started !== undefined) return fail('spawn-failed', started)
    child = spawned
    // 부모가 끝나면(스스로든 멈춤이든) 그룹에 남은 자식을 쓸어 낸다 — SonarQube 는 부모만 죽으면 자식이 포트를 쥔 채 남는다 (실측 §6).
    // 남은 자식이 출력 파이프를 쥐고 있으면 close 가 안 온다 — 이것이 그 파이프도 닫는다
    if (process.platform !== 'win32') spawned.once('exit', () => signal('SIGKILL'))
    // close — 출력까지 다 흘러나온 뒤다 (exit 은 파이프에 남은 사유보다 먼저 올 수 있다)
    exited = new Promise((resolve) => spawned.once('close', () => resolve()))
    void exited.then(() => {
      if (!settled() && !failed()) fail('exited')
    })

    const deadline = Date.now() + (opts.readyTimeoutMs ?? READY_TIMEOUT_MS)
    while (true) {
      if (settled()) return halted()
      if (failed()) return current
      const value = await probe(doFetch, launch.healthUrl, declaration.health.field)
      if (value === declaration.health.ready) break
      if (value !== undefined && (current.phase !== 'starting' || current.detail !== value)) set({ phase: 'starting', detail: value })
      if (Date.now() > deadline) {
        const last = current.detail
        await kill()
        return fail('not-ready', last)
      }
      await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? POLL_MS))
    }

    if (opts.prepare) {
      set({ phase: 'admin' })
      try {
        await opts.prepare(launch.baseUrl)
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
