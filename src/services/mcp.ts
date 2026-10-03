import { Context, Service } from 'cordis'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EngineMcp } from './engine.ts'
import { realDirectory, type McpStatus } from './llm.ts'
import { listMcpTools, type McpTool } from './mcpClient.ts'
import type { KeyCipher } from './providers.ts'
import { tr } from '../i18n.ts'
import './llm.ts'

// MCP 서버 (ctx.mcp, 이슈 #28). 채팅은 opencode 레거시 경로라 MCP 도구가 네이티브로 실린다 — 이 서비스는 "어떤 서버를 어느 폴더에 붙일지" 만 쥔다.
// opencode 와의 대화(상태·추가·끊기)는 ctx.llm 의 mcp* 를 거친다 (엔진 경계 — 여기서는 opencode 주소·이벤트를 모른다).
//
// 출처 셋 (사용자 결정 2026-10-02, _workspace/00_next_mcp.md):
// - 앱: 설정 > MCP 에서 만든 서버. 정의는 userData mcp.json, 비밀 값(로컬 env·원격 헤더 중 "비밀" 로 표시한 것)은 safeStorage 로 mcp-secrets.json
//   (providers 키와 같은 방식, 화면엔 설정 여부만). 비밀이 저장된 서버는 명령·주소를 바꾸면 비밀을 다시 넣어야 한다 (저장된 비밀이 다른 곳으로 안 가게)
// - 프로젝트: 그 폴더의 `.mcp.json`(Claude Code 모양)·`opencode.json(c)`·`.opencode/opencode.json(c)` 의 mcp — **자동 실행**(사용자 결정, 그 폴더 코드를
//   실행하는 위험을 받아들임). OPENCODE_DISABLE_PROJECT_CONFIG=1 은 그대로라(프로젝트 provider·플러그인 막기) 앱이 mcp 만 읽어 붙인다.
//   `{env:}`·`{file:}` 는 풀지 않는다 — 풀면 프로젝트 파일이 앱 env·파일을 아무 서버로나 보낼 수 있다
// - 개인 설정: 사용자 ~/.config/opencode 의 mcp — opencode 가 스스로 띄운다. 여기서는 보여 주기만 (읽기 전용)
//
// 붙이는 길 = 레거시 동적 추가 POST /mcp?directory= (#28 실측). opencode.json 에 쓰지 않는 이유: ① 넘긴 헤더·env 가 디스크·opencode env·API
// 어디에도 안 남는다(설정 파일이면 bash 도구가 읽는다) ② 바꿔도 엔진 재시작이 없다 ③ 프로젝트 서버는 어차피 그 폴더 인스턴스에만 붙여야 한다.
// 대가: 동적 추가는 엔진 재시작으로 사라지고 폴더마다 따로다 → 매 턴(llm/before-turn) 그 폴더 상태를 보고 없거나 바뀐 것만 다시 붙인다.
// 서버 프로세스는 폴더(인스턴스)마다 하나씩 뜬다 — opencode 레거시 방식 그대로 (upstream #51003 메모리 문제는 남는다).
//
// 도구 목록: opencode 에 MCP 도구 목록 API 가 없다 → 앱이 직접 잠깐 붙어 묻는다 (mcpClient.ts). 정의가 같으면 앱 실행 동안 기억한다.

declare module 'cordis' {
  interface Context {
    mcp: McpService
  }
}

export type McpSource = 'app' | 'personal' | 'project'

/** 로컬 env 하나 또는 원격 헤더 하나 — 저장 모양 (비밀이면 value 없음) */
export interface McpVarRecord {
  name: string
  value?: string
  secret: boolean
}

/** 앱이 저장하는 서버 정의 (mcp.json) */
export interface McpServerRecord {
  name: string
  type: 'local' | 'remote'
  command?: string[]
  url?: string
  /** 로컬이면 environment, 원격이면 headers */
  vars: McpVarRecord[]
  enabled: boolean
}

/** 화면에 주는 값 — 비밀 값은 없고 설정 여부(hasValue)만 */
export interface McpVarSummary {
  name: string
  value?: string
  secret: boolean
  hasValue: boolean
}

export interface McpServerSummary {
  name: string
  source: McpSource
  /** 개인 설정 파일에 없는(그래서 모양을 모르는) 서버는 없다 */
  type?: 'local' | 'remote'
  command?: string[]
  url?: string
  vars: McpVarSummary[]
  enabled: boolean
  /** opencode 상태 (connected·failed·disabled·needs_auth…). 열린 프로젝트가 없으면 없다 */
  status?: string
  error?: string
  /** 앱이 직접 물은 도구 목록 (연결됨일 때) */
  tools?: McpTool[]
  toolsError?: string
  /** 프로젝트 서버가 앱 서버와 이름이 겹쳐 붙이지 않았다 */
  shadowed?: boolean
}

/** 설정 화면의 저장·연결 테스트. originalName 이 있으면 그 서버를 고친다. 비밀 var 의 빈 value 는 "저장된 값 그대로" */
export interface McpServerInput {
  originalName?: string
  name: string
  type: 'local' | 'remote'
  command?: string[]
  url?: string
  vars: { name: string; value: string; secret: boolean }[]
  enabled?: boolean
}

export interface McpTestResult {
  ok: boolean
  tools?: McpTool[]
  error?: string
}

export interface McpServiceOptions {
  /** 서버 정의 JSON. 없으면 메모리에만 */
  file?: string
  /** 암호화한 비밀 JSON (서버 → 이름 → base64) */
  secretsFile?: string
  cipher?: KeyCipher
  /** 개인 설정 위치(XDG_CONFIG_HOME·HOME)와 로컬 서버 env 를 읽을 환경 (기본 process.env) */
  env?: NodeJS.ProcessEnv
  /** 프로젝트가 없을 때 로컬 서버를 띄울 폴더 (연결 테스트) */
  fallbackCwd?: string
}

/** opencode 연결 기한 — 기본 30초면 멈춘 서버 하나가 첫 턴을 30초 붙잡는다 (#28 실측: timeout 이 연결 기한이 된다) */
const CONNECT_TIMEOUT_MS = 15_000
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/** 화면이 이름만 보고 비밀로 다룰 env·헤더 (기본 값 — 사용자가 바꿀 수 있다) */
export const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i

export class McpService extends Service {
  static readonly inject = ['llm']

  private servers: McpServerRecord[] = []
  /** 서버 → var 이름 → 암호문(base64) */
  private secrets: Record<string, Record<string, string>> = {}
  /** 폴더(realpath) → 붙인 서버 이름 → 정의 지문. 엔진 재시작으로 사라졌는지는 opencode 상태로 본다 */
  private attached = new Map<string, Map<string, string>>()
  /** 폴더(realpath) → 앱이 그 인스턴스에 한 번이라도 붙인 이름. 지운 서버는 opencode 상태에 disabled 로 남는다(지우는 API 가 없다) —
   *  목록에서 그것을 "개인 설정" 으로 보이지 않으려고 */
  private ever = new Map<string, Set<string>>()
  /** 폴더마다 붙이기를 한 줄로 */
  private chains = new Map<string, Promise<void>>()
  /** 정의 지문 → 도구 목록 */
  private toolCache = new Map<string, Promise<{ tools?: McpTool[]; error?: string }>>()

  constructor(
    ctx: Context,
    private opts: McpServiceOptions = {},
  ) {
    super(ctx, 'mcp')
    this.servers = (opts.file && readJson<McpServerRecord[]>(opts.file)) || []
    this.secrets = (opts.secretsFile && readJson<Record<string, Record<string, string>>>(opts.secretsFile)) || {}
    ctx.on('llm/before-turn', (directory) => this.prepare(directory))
    // 기능을 끄면(묶음이 내려가면) 붙인 앱·프로젝트 서버를 끊는다 — 개인 설정 서버는 opencode 것이라 그대로다
    // 내려가는 중엔 ctx.llm 을 못 꺼낸다 (inactive context) — 올라올 때 쥔다
    ctx.effect(() => {
      const llm = this.ctx.llm
      return () => this.detachAll(llm)
    })
  }

  /** 설정 > MCP 목록 — directory 는 지금 프로젝트(그 폴더 인스턴스의 상태·프로젝트 서버). 없으면 앱·개인 서버만, 상태 없이 */
  async list(directory?: string): Promise<McpServerSummary[]> {
    const workdir = directory ? await realDirectory(directory) : undefined
    let status: Record<string, McpStatus> = {}
    if (workdir) {
      await this.prepare(workdir)
      status = await this.ctx.llm.mcpStatus(workdir).catch(() => ({}))
    }
    const project = workdir ? projectServers(workdir) : []
    const appNames = new Set(this.servers.map((server) => server.name))
    const entries: { summary: McpServerSummary; def?: EngineMcp }[] = [
      ...this.servers.map((server) => ({ summary: appSummary(server, this.secrets[server.name] ?? {}), def: this.engineDef(server) })),
      ...project.map(({ name, def, enabled }) => ({
        summary: { ...readOnlySummary(name, 'project', def), enabled, ...(appNames.has(name) && { shadowed: true }) },
        def: appNames.has(name) ? undefined : def,
      })),
    ]
    const known = new Set(entries.map((entry) => entry.summary.name))
    for (const { name, def, enabled } of personalServers(this.opts.env ?? process.env)) {
      if (known.has(name)) continue
      known.add(name)
      entries.push({ summary: { ...readOnlySummary(name, 'personal', def), enabled }, def: substituted(def) ? undefined : def })
    }
    const ours = (workdir && this.ever.get(workdir)) || new Set<string>()
    for (const name of Object.keys(status)) if (!known.has(name) && !ours.has(name)) entries.push({ summary: { name, source: 'personal', vars: [], enabled: true } })

    return Promise.all(
      entries.map(async ({ summary, def }) => {
        const state = workdir && !summary.shadowed ? status[summary.name] : undefined
        if (state) Object.assign(summary, { status: state.status, ...(state.error && { error: state.error }) })
        else if (workdir && !summary.enabled) summary.status = 'disabled'
        if (summary.status === 'connected' && def) {
          const listed = await this.tools(def, workdir!)
          if (listed.tools) summary.tools = listed.tools
          if (listed.error) summary.toolsError = listed.error
        }
        return summary
      }),
    )
  }

  /** 앱 서버를 넣거나 고친다. 다음 목록 읽기·다음 턴에 그 폴더에 다시 붙는다 */
  save(input: McpServerInput): void {
    const existing = input.originalName !== undefined ? this.servers.find((server) => server.name === input.originalName) : undefined
    if (input.originalName !== undefined && !existing) throw new Error(tr('mcp.error.gone'))
    const { record, secrets } = this.resolve(input, existing)
    if (this.servers.some((server) => server.name === record.name && server !== existing)) throw new Error(tr('mcp.error.nameTaken', { name: record.name }))
    const cipher = this.opts.cipher
    if (Object.keys(secrets).length > 0 && !cipher?.available()) throw new Error(tr('error.keyStorage'))
    this.servers = existing ? this.servers.map((server) => (server === existing ? record : server)) : [...this.servers, record]
    if (existing) delete this.secrets[existing.name]
    if (Object.keys(secrets).length > 0) {
      this.secrets[record.name] = Object.fromEntries(Object.entries(secrets).map(([name, value]) => [name, cipher!.encrypt(value).toString('base64')]))
    }
    this.forget(existing?.name ?? record.name)
    this.persist()
  }

  remove(name: string): void {
    this.servers = this.servers.filter((server) => server.name !== name)
    delete this.secrets[name]
    this.persist() // 붙어 있던 폴더에서는 다음 붙이기가 끊는다 (attached 에 남아 있다)
  }

  setEnabled(name: string, enabled: boolean): void {
    const server = this.servers.find((entry) => entry.name === name)
    if (!server) throw new Error(tr('mcp.error.gone'))
    server.enabled = enabled
    this.forget(name)
    this.persist()
  }

  /** 저장하지 않고 붙어 본다 — 도구 목록 또는 사유. directory 는 로컬 서버를 띄울 폴더(지금 프로젝트) */
  async test(input: McpServerInput, directory?: string): Promise<McpTestResult> {
    try {
      const existing = input.originalName !== undefined ? this.servers.find((server) => server.name === input.originalName) : undefined
      const { record, secrets } = this.resolve(input, existing)
      const cwd = (directory && (await realDirectory(directory))) || this.opts.fallbackCwd || os.homedir()
      const tools = await listMcpTools(defOf(record, secrets), { cwd, env: this.opts.env })
      return { ok: true, tools }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  }

  /** 그 폴더 인스턴스에 앱(켠 것)·프로젝트 서버를 붙이고, 더는 붙일 것이 아닌 것은 끊는다. 폴더마다 한 줄로 돈다 */
  prepare(workdir: string): Promise<void> {
    const previous = this.chains.get(workdir) ?? Promise.resolve()
    const next = previous.then(() => this.attach(workdir)).catch((error: unknown) => console.error('[mcp] 붙이기 실패', workdir, (error as Error).message))
    this.chains.set(workdir, next)
    return next
  }

  private async attach(workdir: string): Promise<void> {
    const wanted = new Map<string, EngineMcp>()
    const appNames = new Set(this.servers.map((server) => server.name))
    for (const { name, def, enabled } of projectServers(workdir)) if (enabled && !appNames.has(name)) wanted.set(name, def)
    for (const server of this.servers) if (server.enabled) wanted.set(server.name, this.engineDef(server))
    const record = this.attached.get(workdir) ?? new Map<string, string>()
    if (wanted.size === 0 && record.size === 0) return // 붙일 것도 끊을 것도 없다 — opencode 에 묻지 않는다
    this.attached.set(workdir, record)
    const status = await this.ctx.llm.mcpStatus(workdir)
    await Promise.all(
      [...wanted].map(async ([name, def]) => {
        const print = fingerprint(def)
        if (name in status && record.get(name) === print) return
        await this.ctx.llm.mcpAdd(workdir, name, { ...def, timeout: def.timeout ?? CONNECT_TIMEOUT_MS })
        record.set(name, print)
        this.ever.set(workdir, (this.ever.get(workdir) ?? new Set()).add(name))
      }),
    )
    for (const name of [...record.keys()]) {
      if (wanted.has(name)) continue
      record.delete(name)
      if (status[name] && status[name].status !== 'disabled') await this.ctx.llm.mcpDisconnect(workdir, name)
    }
  }

  /** 붙인 것을 모두 끊는다 (기능 끄기). 앱을 끌 때도 불린다 — 엔진이 곧 꺼지므로 기다리는 시간을 짧게 */
  private async detachAll(llm: Pick<Context['llm'], 'mcpDisconnect'>): Promise<void> {
    const work = [...this.attached].flatMap(([workdir, record]) => [...record.keys()].map((name) => llm.mcpDisconnect(workdir, name).catch(() => {})))
    this.attached.clear()
    await Promise.race([Promise.all(work), new Promise((resolve) => setTimeout(resolve, 3_000))])
  }

  /** 그 이름을 붙인 기록을 지운다 — 다음 붙이기가 다시 붙인다 (같은 정의라도 실패했던 연결을 다시 해 본다) */
  private forget(name: string): void {
    for (const record of this.attached.values()) if (record.has(name)) record.set(name, '')
  }

  private async tools(def: EngineMcp, cwd: string): Promise<{ tools?: McpTool[]; error?: string }> {
    const key = `${fingerprint(def)}\u0000${def.type === 'local' ? cwd : ''}`
    let cached = this.toolCache.get(key)
    if (!cached) {
      cached = listMcpTools(def, { cwd, env: this.opts.env }).then(
        (tools) => ({ tools }),
        (error: unknown) => ({ error: (error as Error).message }),
      )
      this.toolCache.set(key, cached)
      void cached.then((result) => result.error && this.toolCache.delete(key)) // 실패는 기억하지 않는다
    }
    return cached
  }

  private engineDef(server: McpServerRecord): EngineMcp {
    const sealed = this.secrets[server.name] ?? {}
    const secrets = Object.fromEntries(
      Object.entries(sealed).flatMap(([name, value]) => {
        try {
          return [[name, this.opts.cipher!.decrypt(Buffer.from(value, 'base64'))]]
        } catch {
          return [] // 못 푼 비밀(다른 기계로 옮긴 파일 등) — 그 값 없이 붙는다
        }
      }),
    )
    return defOf(server, secrets)
  }

  /** 입력 → 저장 모양 + 이번에 쓸 비밀 값 (새로 넣은 것 + 그대로 둔 저장 값). 잘못된 입력이면 던진다 */
  private resolve(input: McpServerInput, existing: McpServerRecord | undefined): { record: McpServerRecord; secrets: Record<string, string> } {
    const name = input.name.trim()
    if (!NAME_PATTERN.test(name)) throw new Error(tr('mcp.error.name'))
    const type = input.type === 'remote' ? 'remote' : 'local'
    const command = type === 'local' ? (input.command ?? []).map((part) => part.trim()).filter(Boolean) : undefined
    const url = type === 'remote' ? input.url?.trim() ?? '' : undefined
    if (command && command.length === 0) throw new Error(tr('mcp.error.noCommand'))
    if (url !== undefined && !isHttpUrl(url)) throw new Error(tr('mcp.error.url'))
    const vars = input.vars.map((entry) => ({ name: entry.name.trim(), value: entry.value, secret: !!entry.secret })).filter((entry) => entry.name || entry.value)
    const namePattern = type === 'remote' ? HEADER_NAME : ENV_NAME
    if (vars.some((entry) => !namePattern.test(entry.name))) throw new Error(tr(type === 'remote' ? 'mcp.error.headerName' : 'mcp.error.envName'))
    if (new Set(vars.map((entry) => entry.name)).size !== vars.length) throw new Error(tr('mcp.error.varDuplicate'))
    // 헤더 값은 HTTP 헤더에 실린다 — 줄바꿈·제어 문자·비ASCII 는 붙여넣기 실수다 (provider 키와 같은 규칙). 메시지에 값은 넣지 않는다
    if (type === 'remote' && vars.some((entry) => entry.value && !/^[\x20-\x7e]+$/.test(entry.value))) throw new Error(tr('error.keyChars'))

    const sealed = existing ? (this.secrets[existing.name] ?? {}) : {}
    const sameTarget = !!existing && existing.type === type && JSON.stringify(existing.command) === JSON.stringify(command) && existing.url === url
    const secrets: Record<string, string> = {}
    for (const entry of vars) {
      if (!entry.secret) continue
      if (entry.value) secrets[entry.name] = entry.value
      else if (entry.name in sealed) {
        // 저장된 비밀은 저장된 명령·주소로만 간다 — 바꾸면 다시 넣어야 한다 (provider 키의 Base URL 규칙과 같다)
        if (!sameTarget) throw new Error(tr('mcp.error.secretReenter', { name: entry.name }))
        secrets[entry.name] = this.opts.cipher!.decrypt(Buffer.from(sealed[entry.name]!, 'base64'))
      } else throw new Error(tr('mcp.error.secretMissing', { name: entry.name }))
    }
    const record: McpServerRecord = {
      name,
      type,
      ...(command && { command }),
      ...(url !== undefined && { url }),
      vars: vars.map((entry) => (entry.secret ? { name: entry.name, secret: true } : { name: entry.name, value: entry.value, secret: false })),
      enabled: input.enabled ?? existing?.enabled ?? true,
    }
    return { record, secrets }
  }

  private persist(): void {
    if (this.opts.file) writeJson(this.opts.file, this.servers)
    if (this.opts.secretsFile) writeJson(this.opts.secretsFile, this.secrets)
  }
}

/** 저장 모양 + 비밀 값 → opencode 에 넘길 정의 */
function defOf(server: McpServerRecord, secrets: Record<string, string>): EngineMcp {
  const values = Object.fromEntries(server.vars.flatMap((entry) => {
    const value = entry.secret ? secrets[entry.name] : entry.value
    return value === undefined ? [] : [[entry.name, value]]
  }))
  return server.type === 'remote'
    ? { type: 'remote', url: server.url!, ...(Object.keys(values).length > 0 && { headers: values }) }
    : { type: 'local', command: server.command!, ...(Object.keys(values).length > 0 && { environment: values }) }
}

function appSummary(server: McpServerRecord, sealed: Record<string, string>): McpServerSummary {
  return {
    name: server.name,
    source: 'app',
    type: server.type,
    ...(server.command && { command: server.command }),
    ...(server.url && { url: server.url }),
    vars: server.vars.map((entry) =>
      entry.secret ? { name: entry.name, secret: true, hasValue: entry.name in sealed } : { name: entry.name, value: entry.value, secret: false, hasValue: true },
    ),
    enabled: server.enabled,
  }
}

/** 프로젝트·개인 서버 — 값은 안 보인다(파일에 토큰이 있을 수 있다), 이름만 */
function readOnlySummary(name: string, source: McpSource, def: EngineMcp): McpServerSummary {
  const vars = def.type === 'remote' ? def.headers : def.environment
  return {
    name,
    source,
    type: def.type,
    ...(def.type === 'local' ? { command: def.command } : { url: def.url }),
    vars: Object.keys(vars ?? {}).map((key) => ({ name: key, secret: true, hasValue: true })),
    enabled: true,
  }
}

function fingerprint(def: EngineMcp): string {
  return createHash('sha256').update(JSON.stringify(def)).digest('hex')
}

/** opencode 치환 문법이 든 정의 — 앱은 풀지 않으므로 그대로 붙어 볼 수 없다 */
function substituted(def: EngineMcp): boolean {
  return JSON.stringify(def).includes('{env:') || JSON.stringify(def).includes('{file:')
}

interface ParsedServer {
  name: string
  def: EngineMcp
  enabled: boolean
}

/** 프로젝트 폴더의 MCP 정의 — `.mcp.json` → `opencode.json(c)` → `.opencode/opencode.json(c)` 순으로 겹쳐 뒤가 이긴다 (opencode 의 프로젝트·.opencode 순서).
 *  위 폴더(git 루트까지)는 안 본다 */
export function projectServers(directory: string): ParsedServer[] {
  const merged = new Map<string, ParsedServer>()
  for (const server of claudeServers(readJsonc(path.join(directory, '.mcp.json')))) merged.set(server.name, server)
  for (const file of ['opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc']) {
    for (const server of opencodeServers(readJsonc(path.join(directory, file)))) merged.set(server.name, server)
  }
  return [...merged.values()]
}

/** 개인 opencode 설정의 mcp (`$XDG_CONFIG_HOME/opencode` 또는 `~/.config/opencode`) — 보여 주기만 한다 */
export function personalServers(env: NodeJS.ProcessEnv): ParsedServer[] {
  const home = env['HOME']?.trim() || os.homedir()
  const dir = path.join(env['XDG_CONFIG_HOME']?.trim() || path.join(home, '.config'), 'opencode')
  const merged = new Map<string, ParsedServer>()
  for (const file of ['config.json', 'opencode.json', 'opencode.jsonc']) for (const server of opencodeServers(readJsonc(path.join(dir, file)))) merged.set(server.name, server)
  return [...merged.values()]
}

/** opencode 설정의 mcp: {이름: {type:"local", command[], environment?, enabled?} | {type:"remote", url, headers?, enabled?}} */
function opencodeServers(config: unknown): ParsedServer[] {
  const mcp = isObject(config) ? config['mcp'] : undefined
  if (!isObject(mcp)) return []
  return Object.entries(mcp).flatMap(([name, value]): ParsedServer[] => {
    if (!isObject(value)) return []
    const enabled = value['enabled'] !== false
    if (value['type'] === 'local' && isStrings(value['command']) && value['command'].length > 0) {
      return [{ name, enabled, def: { type: 'local', command: value['command'], ...(isStringMap(value['environment']) && { environment: value['environment'] }) } }]
    }
    if (value['type'] === 'remote' && typeof value['url'] === 'string') {
      return [{ name, enabled, def: { type: 'remote', url: value['url'], ...(isStringMap(value['headers']) && { headers: value['headers'] }) } }]
    }
    return []
  })
}

/** Claude Code `.mcp.json`: {mcpServers: {이름: {command, args?, env?} | {type:"http"|"sse", url, headers?}}} */
function claudeServers(config: unknown): ParsedServer[] {
  const servers = isObject(config) ? config['mcpServers'] : undefined
  if (!isObject(servers)) return []
  return Object.entries(servers).flatMap(([name, value]): ParsedServer[] => {
    if (!isObject(value)) return []
    if (typeof value['url'] === 'string') {
      return [{ name, enabled: true, def: { type: 'remote', url: value['url'], ...(isStringMap(value['headers']) && { headers: value['headers'] }) } }]
    }
    if (typeof value['command'] === 'string' && value['command']) {
      const args = isStrings(value['args']) ? value['args'] : []
      return [{ name, enabled: true, def: { type: 'local', command: [value['command'], ...args], ...(isStringMap(value['env']) && { environment: value['env'] }) } }]
    }
    return []
  })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((part) => typeof part === 'string')
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((part) => typeof part === 'string')
}

/** 주석(`//`·`/* *\/`)과 끝 쉼표를 허용하는 JSON. 없거나 깨졌으면 undefined */
export function parseJsonc(text: string): unknown {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (char === '"') {
      const start = i
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++
      out += text.slice(start, i + 1)
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (char === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2)
      if (i === -1) break
      i++
    } else out += char
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
  } catch {
    return undefined
  }
}

function readJsonc(file: string): unknown {
  try {
    return parseJsonc(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
  fs.renameSync(temp, file)
}
