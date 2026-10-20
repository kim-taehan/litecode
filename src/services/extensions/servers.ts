import fs from 'node:fs'
import path from 'node:path'
import type { ExtensionServer, ExtensionServerOptions, ExtensionServerStatus } from '../../../shared/extensions.ts'
import { execProgram } from '../exec.ts'
import { keepTail } from '../outputBuffer.ts'
import type { KeyCipher } from '../providers.ts'
import { leftoverAlive, reapServerRecord, startServer, type ServerHandle, type ServerOptions, type ServerState } from './server.ts'
import { prepareSonarAdmin, sonarPassword, type AdminSecrets } from './serverAdmin.ts'
import { projectTsconfigs, reportTaskId, sonarProjectKey, sonarScanArgs } from './sonarAnalysis.ts'

// 확장마다의 내장 서버 (이슈 #537) — ctx.extensions 가 쥔다. 띄우기·내리기·상태는 server.ts 의 실행기, 관리자 준비는 serverAdmin.ts.
// 데이터는 `<root>/data/<id>/server/` (SonarQube 의 data·logs·temp, server.log, server.pid.json, admin.json) — 확장을 지우면 자료 폴더째 지워진다.
// 관리자 비밀(admin.json: 비밀번호·토큰)은 safeStorage 로 봉해 여기 둔다. 확장의 secrets.json 과 따로라 패널이 secrets.get 으로 읽지 못한다 —
// 토큰은 패널에 주지 않고, 메인이 내장 서버로 가는 network.fetch 에만 붙인다(token).

const TOKEN_NAME = 'litecode'
const ADMIN_FILE = 'admin.json'

/** 분석(스캐너) 기한 — 이 저장소(340파일) 전체가 15초였다(실측 §11). 큰 저장소를 보고 넉넉히 */
const ANALYZE_TIMEOUT_MS = 15 * 60_000
const ANALYZE_OUTPUT = 4_000

export type AnalyzeResult =
  | { ok: true; projectKey: string; taskId?: string; skipped: string[] }
  | { ok: false; error: 'analysis-unsupported' | 'server-not-running' | 'busy' | 'scope-empty' | 'analysis-failed'; detail?: string }

export const DEFAULT_SERVER_OPTIONS: ExtensionServerOptions = { startWithApp: false, stopWithApp: true }

export interface ExtensionServersOptions {
  /** 확장 저장소 루트 */
  root: string
  cipher?: KeyCipher
  /** 상태 주소·관리자 API 를 부르는 fetch (기본 globalThis.fetch — 127.0.0.1 만 부른다) */
  fetch?: typeof globalThis.fetch
  /** 상태가 바뀌었다 — 서비스가 목록을 다시 낸다 */
  onChange(): void
  /** 시험용 기한 (server.ts 의 기본값을 덮는다) */
  timing?: Pick<ServerOptions, 'readyTimeoutMs' | 'pollMs' | 'killGraceMs'>
}

export class ExtensionServers {
  private handles = new Map<string, ServerHandle>()
  /** 마지막 상태 — onState 로 받는다(startServer 는 돌려주기 전에 첫 상태를 낸다) */
  private states = new Map<string, ServerState>()
  /** 앱이 꺼지는 중 — 서비스가 내려간 뒤라 바뀜을 알리지 않는다 */
  private released = false
  private tokens = new Map<string, string>()
  /** 분석이 도는 확장 — 한 번에 하나 */
  private analyzing = new Set<string>()

  constructor(private options: ExtensionServersOptions) {}

  dataDir(id: string): string {
    return path.join(path.resolve(this.options.root), 'data', id, 'server')
  }

  /** 지난 실행이 남긴 우리 서버가 살아 있나 — stopWithApp 을 끈 확장이면 앱이 켜질 때 다시 잡는다 */
  leftoverAlive(id: string, extensionDir: string): boolean {
    return leftoverAlive(this.dataDir(id), extensionDir)
  }

  /** 지난 실행이 남긴 서버를 거둔다(살아 있으면 내리고 기록을 지운다) — 지금 이 앱이 쥔 서버가 있으면 건드리지 않는다 */
  async reap(id: string, extensionDir: string): Promise<void> {
    if (this.active(id)) return
    await reapServerRecord(this.dataDir(id), extensionDir, this.options.timing?.killGraceMs)
  }

  /** 떠 있거나 뜨는 중·내리는 중 */
  active(id: string): boolean {
    const phase = this.states.get(id)?.phase
    return phase !== undefined && phase !== 'stopped' && phase !== 'failed'
  }

  status(id: string, server: ExtensionServer, options: ExtensionServerOptions): ExtensionServerStatus {
    const state: ServerState = this.states.get(id) ?? { phase: 'stopped' }
    return {
      phase: state.phase,
      ...(state.detail !== undefined && { detail: state.detail }),
      ...(state.error !== undefined && { error: state.error }),
      port: server.port,
      url: `http://127.0.0.1:${server.port}`,
      options,
    }
  }

  /** 띄운다 — 이미 떠 있거나 뜨는 중이면 아무것도 안 한다. 결과는 상태로 (onChange) */
  start(id: string, server: ExtensionServer, extensionDir: string): void {
    if (this.active(id)) return
    this.tokens.delete(id)
    const handle = startServer(server, {
      extensionDir,
      dataDir: this.dataDir(id),
      onState: (state) => {
        this.states.set(id, state)
        if (!this.released) this.options.onChange()
      },
      ...(server.admin === 'sonarqube' && { prepare: (baseUrl: string) => this.prepareSonar(id, baseUrl) }),
      ...(this.options.fetch && { fetch: this.options.fetch }),
      ...this.options.timing,
    })
    this.handles.set(id, handle)
  }

  async stop(id: string): Promise<void> {
    this.tokens.delete(id)
    const handle = this.handles.get(id)
    if (handle && this.active(id)) await handle.stop()
  }

  /** 앱 종료 — keep 이 false 인 서버에 정상 종료 신호만 보내고 기다리지 않는다. 서버는 앱이 꺼진 뒤에도 스스로 마저 내려간다
   *  (정상 종료 7~12초 — 앱 종료 기한 8초 안에 다른 서비스 정리를 막지 않게). 못 내려가고 남으면 다음 실행이 기록을 보고 거둔다 */
  release(keep: (id: string) => boolean): void {
    const leaving = [...this.handles].filter(([id]) => this.active(id) && !keep(id))
    this.released = true
    for (const [, handle] of leaving) void handle.stop()
  }

  /** 그 프로젝트의 SonarQube 프로젝트 키 (이슈 #545) */
  projectKey(project: { directory: string; name: string }): string {
    return sonarProjectKey(project.directory, project.name)
  }

  /** [분석] (이슈 #545) — admin: sonarqube 서버만. 동봉 스캐너(server/scanner)를 동봉 런타임(server/runtime)으로 띄워 내장 서버에 올린다.
   *  paths 가 있으면 범위 분석(`<키>__scope` — 전체 결과를 덮지 않는다). 토큰은 env(SONAR_TOKEN)로, 스캐너 캐시(330MB)는 데이터 폴더로(SONAR_USER_HOME).
   *  올린 뒤 서버가 결과를 처리하는 작업 id(taskId)를 준다 — 끝났는지는 패널이 api/ce/task 로 본다 */
  async analyze(id: string, server: ExtensionServer, extensionDir: string, project: { directory: string; name: string }, paths?: readonly string[]): Promise<AnalyzeResult> {
    if (server.admin !== 'sonarqube') return { ok: false, error: 'analysis-unsupported' }
    const token = this.tokens.get(id)
    if (this.states.get(id)?.phase !== 'running' || token === undefined) return { ok: false, error: 'server-not-running' }
    if (this.analyzing.has(id)) return { ok: false, error: 'busy' }
    const projectDir = fs.realpathSync(project.directory)
    const workDir = path.join(this.dataDir(id), 'scanner-work')
    const scan = sonarScanArgs({ serverUrl: `http://127.0.0.1:${server.port}`, projectKey: this.projectKey(project), projectDir, workDir, tsconfigs: projectTsconfigs(projectDir) }, paths, (relative) => insideExisting(projectDir, relative))
    if (!scan.ok) return scan
    this.analyzing.add(id)
    try {
      fs.rmSync(path.join(workDir, 'report-task.txt'), { force: true })
      const output = keepTail(ANALYZE_OUTPUT)
      const end = await execProgram({
        file: path.join(extensionDir, 'server', 'scanner', 'bin', 'sonar-scanner'),
        args: scan.args,
        cwd: projectDir,
        timeoutMs: ANALYZE_TIMEOUT_MS,
        env: { JAVA_HOME: path.join(extensionDir, 'server', 'runtime'), SONAR_TOKEN: token, SONAR_USER_HOME: path.join(this.dataDir(id), 'scanner-home') },
        onOutput: (_stream, text) => output.push(text),
      }).done
      if (end.status !== 'done' || end.exitCode !== 0) return { ok: false, error: 'analysis-failed', detail: (end.error ?? output.text()).trim().slice(-ANALYZE_OUTPUT) }
      const taskId = reportTaskId(workDir)
      return { ok: true, projectKey: scan.projectKey, skipped: scan.skipped, ...(taskId !== undefined && { taskId }) }
    } finally {
      this.analyzing.delete(id)
    }
  }

  /** 내장 서버로 가는 요청에 붙일 토큰 — 관리자 준비가 끝났을 때만 */
  token(id: string): string | undefined {
    // 실행 중일 때만 — 서버가 스스로 끝난 뒤 그 포트를 잡은 다른 프로그램에 토큰을 보내지 않는다 (QA 03_qa_537)
    return this.states.get(id)?.phase === 'running' ? this.tokens.get(id) : undefined
  }

  private async prepareSonar(id: string, baseUrl: string): Promise<void> {
    const cipher = this.options.cipher
    if (!cipher?.available()) throw new Error('secrets-unavailable')
    const file = path.join(this.dataDir(id), ADMIN_FILE)
    const result = await prepareSonarAdmin({
      baseUrl,
      fetch: this.options.fetch ?? globalThis.fetch,
      secrets: readAdmin(file, cipher),
      save: async (secrets) => writeAdmin(file, cipher, secrets),
      newPassword: sonarPassword,
      tokenName: TOKEN_NAME,
    })
    if (!result.ok) throw new Error(result.error)
    this.tokens.set(id, result.token)
  }
}

/** 봉한 관리자 비밀 — 없거나 깨졌거나 풀지 못하면 빈 값(관리자 준비가 처음부터 다시 본다) */
function readAdmin(file: string, cipher: KeyCipher): AdminSecrets {
  try {
    const sealed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    const open = (value: unknown) => (typeof value === 'string' ? cipher.decrypt(Buffer.from(value, 'base64')) : undefined)
    const password = open(sealed.password)
    const token = open(sealed.token)
    return { ...(password !== undefined && { password }), ...(token !== undefined && { token }) }
  } catch {
    return {}
  }
}

/** 임시 파일에 쓰고 바꿔 넣는다 — 쓰다 죽어도 이전 값이 남는다(비밀번호를 잃으면 admin-locked 로 굳는다) */
function writeAdmin(file: string, cipher: KeyCipher, secrets: AdminSecrets): void {
  const seal = (value: string) => cipher.encrypt(value).toString('base64')
  const value = { ...(secrets.password !== undefined && { password: seal(secrets.password) }), ...(secrets.token !== undefined && { token: seal(secrets.token) }) }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
  fs.renameSync(temp, file)
}

/** 범위 경로가 지금 있고 실제 위치가 프로젝트 안인가 — 심볼릭 링크로 밖을 가리키는 것은 뺀다 */
function insideExisting(projectDir: string, relative: string): boolean {
  try {
    const real = fs.realpathSync(path.join(projectDir, relative))
    return real === projectDir || real.startsWith(projectDir + path.sep)
  } catch {
    return false
  }
}
