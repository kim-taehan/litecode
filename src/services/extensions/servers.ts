import fs from 'node:fs'
import path from 'node:path'
import type { ExtensionServer, ExtensionServerOptions, ExtensionServerStatus } from '../../../shared/extensions.ts'
import type { KeyCipher } from '../providers.ts'
import { hasServerRecord, startServer, type ServerHandle, type ServerOptions, type ServerState } from './server.ts'
import { prepareSonarAdmin, sonarPassword, type AdminSecrets } from './serverAdmin.ts'

// 확장마다의 내장 서버 (이슈 #537) — ctx.extensions 가 쥔다. 띄우기·내리기·상태는 server.ts 의 실행기, 관리자 준비는 serverAdmin.ts.
// 데이터는 `<root>/data/<id>/server/` (SonarQube 의 data·logs·temp, server.log, server.pid.json, admin.json) — 확장을 지우면 자료 폴더째 지워진다.
// 관리자 비밀(admin.json: 비밀번호·토큰)은 safeStorage 로 봉해 여기 둔다. 확장의 secrets.json 과 따로라 패널이 secrets.get 으로 읽지 못한다 —
// 토큰은 패널에 주지 않고, 메인이 내장 서버로 가는 network.fetch 에만 붙인다(token).

const TOKEN_NAME = 'litecode'
const ADMIN_FILE = 'admin.json'

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

  constructor(private options: ExtensionServersOptions) {}

  dataDir(id: string): string {
    return path.join(path.resolve(this.options.root), 'data', id, 'server')
  }

  /** 지난 실행이 남긴 서버 기록이 있나 — 앱이 켜질 때 다시 잡으러 간다 */
  hasLeftover(id: string): boolean {
    return hasServerRecord(this.dataDir(id))
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

  /** 내장 서버로 가는 요청에 붙일 토큰 — 관리자 준비가 끝났을 때만 */
  token(id: string): string | undefined {
    return this.tokens.get(id)
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
