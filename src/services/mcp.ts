import { Context, Service } from 'cordis'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EngineMcp } from './engineConfig.ts'
import type { McpStatus } from './llm.ts'
import { realDirectory } from './projectPath.ts'
import { listMcpTools, type McpTool } from './mcpClient.ts'
import type { KeyCipher } from './providers.ts'
import { readJsonFileSync, writeJsonFileSync } from './jsonFile.ts'
import { insideOf } from './projectPath.ts'
import { tr } from '../i18n.ts'
import { BROWSER_MCP_NAME } from '../../shared/browser.ts'
import { hiddenTools, toolSelectionOf, type McpToolSelection } from '../../shared/mcpTools.ts'
import './llm.ts'

// MCP 서버 (ctx.mcp, 이슈 #28). 채팅은 opencode 레거시 경로라 MCP 도구가 네이티브로 실린다 — 이 서비스는 "어떤 서버를 어느 폴더에 붙일지" 만 쥔다.
// opencode 와의 대화(상태·추가·끊기)는 ctx.llm 의 mcp* 를 거친다 (엔진 경계 — 여기서는 opencode 주소·이벤트를 모른다).
//
// 출처 셋 (사용자 결정 2026-10-02, _workspace/00_next_mcp.md):
// - 앱: `+` 메뉴의 MCP 팝업(#43)에서 만든 서버. 정의는 userData mcp.json, 비밀 값(로컬 env·원격 헤더 중 "비밀" 로 표시한 것)은 safeStorage 로 mcp-secrets.json
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
//
// 프로젝트 기준 (이슈 #43, 사용자 결정 2026-10-04 — _workspace/00_next_plus_popup.md). 화면은 입력창 `+` 메뉴의 MCP 팝업이고 두 묶음이다:
// - "이 프로젝트만": 프로젝트 폴더의 정의(위 "프로젝트", 읽기 전용) + **앱에서 그 프로젝트에만 추가한 서버**. 뒤의 것은 프로젝트 폴더가 아니라
//   앱 안(userData mcp-projects.json, 프로젝트 realpath 별)에 둔다 — 비밀이 프로젝트 폴더·git 에 들어가지 않게. 비밀은 같은 mcp-secrets.json
// - "모든 프로젝트": 앱 서버(mcp.json — 예전 모양 그대로)와 개인 설정
// - 켜기/끄기는 **그 프로젝트에서만**: mcp-projects.json 의 프로젝트별 enabled 가 기본값을 덮는다. 기본값은 앱 서버 = 정의의 enabled
//   (예전 앱 전체 스위치로 꺼 둔 서버는 모든 프로젝트에서 꺼진 채로 남는다), 폴더 정의 = 파일의 enabled, 개인 설정 = 켜짐.
//   개인 설정 서버는 opencode 가 스스로 띄우므로 끈 프로젝트에서는 매 턴 끊고(disconnect), 다시 켜면 잇는다(connect)
// - 이름: opencode 인스턴스에서 이름 하나 = 서버 하나다. 앱 서버끼리는 묶음이 달라도 저장할 때 거절하고(같은 프로젝트의 전용 서버·모든 프로젝트
//   서버·어느 프로젝트든 전용 서버와 겹치는 모든 프로젝트 서버), 폴더 정의는 앱 서버(어느 묶음이든)와 이름이 같으면 붙이지 않는다(shadowed)
//
// 내장 서버 (이슈 #51, _workspace/01z_desktop_mcp.md 3-1): 앱 자신이 띄운 MCP 서버(ctx.appMcp)를 registerBuiltin 으로 받아 사용자 서버와 같은
// 길(매 턴 붙이기·프로젝트별 켜기)로 붙인다. 이름 `litecode`(와 브라우저 기능의 `chrome`, #147)는 예약이다 — 사용자는 그 이름으로 저장할 수 없고, 폴더 정의·예전에 저장된 앱 서버는
// 붙이지 않는다(shadowed). 엔진 설정이 `litecode_*` 도구에 따로 권한을 주므로(계획 모드에서도 허용 등) 남의 서버가 그 이름을 쓰면 안 된다.
// 팝업에는 "모든 프로젝트" 묶음 맨 끝에 읽기 전용 한 줄(주소·토큰은 화면에 안 준다)
//
// 서버 안의 도구 고르기 (이슈 #164): 켜기 값처럼 **프로젝트별**로 mcp-projects.json 의 tools(서버 이름 → {off?, only?}, shared/mcpTools.ts)에 둔다 —
// 앱 서버("모든 프로젝트" 서버 포함)·폴더 정의·개인 설정 모두. 프로젝트 폴더의 `.mcp.json` 은 고치지 않는다. 내장 서버는 고르지 않는다(코드로 줄였다).
// 매 턴 붙이기 뒤에 그 폴더에서 숨길 도구 이름(MCP 서버가 준 이름)을 ctx.llm.hideMcpTools 로 넘긴다 — 모델 요청에서 빼는 방법은 ctx.llm 이 안다.
// only 모양은 서버의 도구 목록이 있어야 나머지를 알 수 있어 그 서버에 붙어 묻는다(정의가 같으면 앱 실행 동안 기억). 못 물으면 그 서버는 숨기지 않는다

declare module 'cordis' {
  interface Context {
    mcp: McpService
  }
}

export type McpSource = 'app' | 'personal' | 'project' | 'builtin'
/** 앱 MCP 서버(ctx.appMcp)의 이름 — 모델이 보는 도구는 `litecode_<도구>`. 예약 */
export const APP_MCP_NAME = 'litecode'
/** 내장 서버만 쓰는 이름 — 엔진 설정이 그 이름의 도구(`litecode_*`·`chrome_*`)에 따로 권한을 준다. 그 내장 서버가 올라와 있지 않아도(기능 꺼짐) 예약이다 */
const RESERVED_NAMES: readonly string[] = [APP_MCP_NAME, BROWSER_MCP_NAME]
/** 내장 서버의 그 폴더용 정의 — 아직 붙일 수 없으면(서버가 안 떴다) undefined */
export type BuiltinMcp = (workdir: string) => EngineMcp | undefined
/** 팝업의 묶음 — "이 프로젝트만"(앱이 그 프로젝트에 저장한 서버·폴더 정의) / "모든 프로젝트"(앱 서버·개인 설정) */
export type McpScope = 'project' | 'all'

/** mcp-projects.json 의 프로젝트 하나 (키는 프로젝트 realpath) */
interface McpProjectRecord {
  /** 앱에서 "이 프로젝트만" 으로 추가한 서버 */
  servers: McpServerRecord[]
  /** 이 프로젝트에서 켜고 끈 값 (서버 이름 → 켜짐). 없는 이름은 기본값 */
  enabled: Record<string, boolean>
  /** 이 프로젝트에서 서버 안의 도구를 고른 값 (서버 이름 → 선택, 이슈 #164). 없는 이름은 전부 켜짐. 옛 파일엔 없다 */
  tools: Record<string, McpToolSelection>
}

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
  scope: McpScope
  /** 프로젝트 폴더 정의가 적힌 파일 (`.mcp.json`·`opencode.json` 등, 프로젝트 기준 상대 경로) */
  origin?: string
  /** 개인 설정 파일에 없는(그래서 모양을 모르는) 서버는 없다 */
  type?: 'local' | 'remote'
  command?: string[]
  url?: string
  vars: McpVarSummary[]
  /** 그 프로젝트에서 켜져 있나 (프로젝트 없이 물으면 기본값) */
  enabled: boolean
  /** opencode 상태 (connected·failed·disabled·needs_auth…). 열린 프로젝트가 없으면 없다 */
  status?: string
  error?: string
  /** 앱이 직접 물은 도구 목록 (연결됨일 때) */
  tools?: McpTool[]
  toolsError?: string
  /** 이 프로젝트에서 고른 도구 (이슈 #164). 없으면 전부 켜짐 */
  toolSelection?: McpToolSelection
  /** 프로젝트 서버가 앱 서버와 이름이 겹쳐 붙이지 않았다 (예약 이름 `litecode` 를 쓴 서버도) */
  shadowed?: boolean
}

/** 팝업의 저장·연결 테스트. originalName 이 있으면 그 서버를 고친다. 비밀 var 의 빈 value 는 "저장된 값 그대로" */
export interface McpServerInput {
  originalName?: string
  /** 새 서버를 넣을 묶음 (기본 all). 고칠 때는 그 서버가 있는 묶음 그대로다 */
  scope?: McpScope
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
  /** 프로젝트별 서버·켜기 값 JSON (프로젝트 realpath → {servers, enabled}) */
  projectsFile?: string
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
  /** 프로젝트(realpath) → 그 프로젝트 전용 서버·켜기 값 */
  private projects: Record<string, McpProjectRecord> = {}
  /** 서버 → var 이름 → 암호문(base64). 프로젝트 전용 서버의 키는 `<프로젝트 경로>#<이름>` (secretKey) */
  private secrets: Record<string, Record<string, string>> = {}
  /** 폴더(realpath) → 이 프로젝트에서 꺼서 앱이 끊은 개인 설정 서버 — 다시 켜면 잇는다 */
  private paused = new Map<string, Set<string>>()
  /** 폴더(realpath) → 붙인 서버 이름 → 정의 지문. 엔진 재시작으로 사라졌는지는 opencode 상태로 본다 */
  private attached = new Map<string, Map<string, string>>()
  /** 폴더(realpath) → 앱이 그 인스턴스에 한 번이라도 붙인 이름. 지운 서버는 opencode 상태에 disabled 로 남는다(지우는 API 가 없다) —
   *  목록에서 그것을 "개인 설정" 으로 보이지 않으려고 */
  private ever = new Map<string, Set<string>>()
  /** 폴더마다 붙이기를 한 줄로 */
  private chains = new Map<string, Promise<void>>()
  /** 정의 지문 → 도구 목록 */
  private toolCache = new Map<string, Promise<{ tools?: McpTool[]; error?: string }>>()
  /** 내장 서버 (이름 → 그 폴더용 정의) */
  private builtins = new Map<string, BuiltinMcp>()
  /** 숨길 도구를 ctx.llm 에 넘긴 폴더 — 기능을 끄면 비운다 */
  private hiding = new Set<string>()

  constructor(
    ctx: Context,
    private opts: McpServiceOptions = {},
  ) {
    super(ctx, 'mcp')
    this.servers = ((opts.file && (readJsonFileSync(opts.file, 'array') as McpServerRecord[] | undefined)) || []).filter((server) => typeof server?.name === 'string')
    this.secrets = (opts.secretsFile && (readJsonFileSync(opts.secretsFile, 'object') as Record<string, Record<string, string>> | undefined)) || {}
    const projects = (opts.projectsFile && (readJsonFileSync(opts.projectsFile, 'object') as Record<string, Partial<McpProjectRecord>> | undefined)) || {}
    this.projects = Object.fromEntries(Object.entries(projects).map(([dir, entry]) => [dir, { servers: entry?.servers ?? [], enabled: entry?.enabled ?? {}, tools: toolSelections(entry?.tools) }]))
    ctx.on('llm/before-turn', (directory) => this.prepare(directory))
    // 기능을 끄면(묶음이 내려가면) 붙인 앱·프로젝트 서버를 끊는다 — 개인 설정 서버는 opencode 것이라 그대로다
    // 내려가는 중엔 ctx.llm 을 못 꺼낸다 (inactive context) — 올라올 때 쥔다
    ctx.effect(() => {
      const llm = this.ctx.llm
      return () => {
        for (const workdir of this.hiding) llm.hideMcpTools(workdir, {}) // 개인 설정 서버는 남아 있다 — 숨김을 풀어 둔다
        this.hiding.clear()
        return this.detachAll(llm)
      }
    })
  }

  /** MCP 팝업 목록 — directory 는 지금 프로젝트(그 폴더 인스턴스의 상태·그 프로젝트의 서버와 켜기 값). 없으면 앱·개인 서버만, 상태 없이.
   *  순서: 이 프로젝트만(앱이 저장한 것 → 폴더 정의) → 모든 프로젝트(앱 → 개인 설정) */
  async list(directory?: string): Promise<McpServerSummary[]> {
    const workdir = directory ? await realDirectory(directory) : undefined
    let status: Record<string, McpStatus> = {}
    if (workdir) {
      await this.prepare(workdir)
      status = await this.ctx.llm.mcpStatus(workdir).catch(() => ({}))
    }
    const mine = (workdir && this.projects[workdir]) || undefined
    const on = (name: string, fallback: boolean): boolean => mine?.enabled[name] ?? fallback
    const own = mine?.servers ?? []
    const ownNames = new Set(own.map((server) => server.name))
    const appNames = new Set([...this.servers.map((server) => server.name), ...ownNames, ...RESERVED_NAMES])
    // 예약 이름으로 저장돼 있던 앱 서버(이 기능 전의 것)는 붙이지 않는다
    const reserved = (server: McpServerRecord) => RESERVED_NAMES.includes(server.name) && { shadowed: true }
    const entries: { summary: McpServerSummary; def?: EngineMcp }[] = [
      ...own.map((server) => ({
        summary: { ...appSummary(server, 'project', this.secrets[secretKey(server.name, workdir)] ?? {}), enabled: on(server.name, server.enabled), ...reserved(server) },
        def: reserved(server) ? undefined : this.engineDef(server, workdir),
      })),
      ...(workdir ? projectServers(workdir) : []).map(({ name, def, enabled, origin }) => ({
        summary: { ...readOnlySummary(name, 'project', def), origin, enabled: on(name, enabled), ...(appNames.has(name) && { shadowed: true }) },
        def: appNames.has(name) ? undefined : def,
      })),
      // 같은 이름의 전용 서버가 있으면(파일을 손으로 고친 경우) 전용 서버가 이긴다 — 모든 프로젝트 것은 이 프로젝트에서 안 보인다
      ...this.servers.filter((server) => !ownNames.has(server.name)).map((server) => ({
        summary: { ...appSummary(server, 'all', this.secrets[server.name] ?? {}), enabled: on(server.name, server.enabled), ...reserved(server) },
        def: reserved(server) ? undefined : this.engineDef(server),
      })),
    ]
    const known = new Set([...entries.map((entry) => entry.summary.name), ...RESERVED_NAMES, ...this.builtins.keys()])
    for (const { name, def, enabled } of personalServers(this.opts.env ?? process.env)) {
      if (known.has(name)) continue
      known.add(name)
      entries.push({ summary: { ...readOnlySummary(name, 'personal', def), enabled: on(name, enabled) }, def: substituted(def) ? undefined : def })
    }
    const ours = (workdir && this.ever.get(workdir)) || new Set<string>()
    for (const name of Object.keys(status)) {
      if (!known.has(name) && !ours.has(name)) entries.push({ summary: { name, source: 'personal', scope: 'all', vars: [], enabled: on(name, true) } })
    }
    // 내장 서버 — 맨 끝에 한 줄. 주소·토큰은 화면에 주지 않는다 (def 는 도구 목록을 묻는 데만 쓴다)
    if (workdir) {
      for (const [name, define] of this.builtins) entries.push({ summary: { name, source: 'builtin', scope: 'all', vars: [], enabled: on(name, true) }, def: define(workdir) })
    }

    return Promise.all(
      entries.map(async ({ summary, def }) => {
        const selection = summary.source !== 'builtin' ? mine?.tools[summary.name] : undefined
        if (selection) summary.toolSelection = selection
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

  /** 앱 서버를 넣거나 고친다. 다음 목록 읽기·다음 턴에 그 폴더에 다시 붙는다.
   *  directory 는 지금 프로젝트 — 새 서버의 scope 가 project 면 그 프로젝트에만 저장하고, 고칠 때는 그 프로젝트의 전용 서버를 먼저 찾는다 */
  save(input: McpServerInput, directory?: string): void {
    const workdir = directory ? realpathOf(directory) : undefined
    const mine = (workdir && this.projects[workdir]?.servers) || []
    const edited = input.originalName !== undefined
    const own = edited ? mine.find((server) => server.name === input.originalName) : undefined
    const existing = own ?? (edited ? this.servers.find((server) => server.name === input.originalName) : undefined)
    if (edited && !existing) throw new Error(tr('mcp.error.gone'))
    const scope: McpScope = edited ? (own ? 'project' : 'all') : (input.scope ?? 'all')
    if (scope === 'project' && !workdir) throw new Error(tr('mcp.error.noProject'))
    const owner = scope === 'project' ? workdir : undefined
    const { record, secrets } = this.resolve(input, existing, owner)
    if (RESERVED_NAMES.includes(record.name)) throw new Error(tr('mcp.error.nameReserved', { name: record.name }))
    // 이름 하나 = 서버 하나 — 이 프로젝트에서 보이는 앱 서버끼리, 그리고 모든 프로젝트 서버는 어느 프로젝트의 전용 서버와도 겹치지 않게
    if ([...this.servers, ...(scope === 'project' ? mine : [])].some((server) => server.name === record.name && server !== existing)) {
      throw new Error(tr('mcp.error.nameTaken', { name: record.name }))
    }
    if (scope === 'all') {
      const clash = Object.entries(this.projects).find(([, entry]) => entry.servers.some((server) => server.name === record.name))
      if (clash) throw new Error(tr('mcp.error.nameTakenProject', { name: record.name, project: path.basename(clash[0]) }))
    }
    const cipher = this.opts.cipher
    if (Object.keys(secrets).length > 0 && !cipher?.available()) throw new Error(tr('error.keyStorage'))
    const replaced = (list: McpServerRecord[]) => (existing ? list.map((server) => (server === existing ? record : server)) : [...list, record])
    if (owner) this.project(owner).servers = replaced(mine)
    else this.servers = replaced(this.servers)
    if (existing) {
      delete this.secrets[secretKey(existing.name, owner)]
      // 이름을 바꿔도 프로젝트별 켜기 값은 따라간다
      for (const entry of owner ? [this.project(owner)] : Object.values(this.projects)) {
        if (existing.name === record.name) continue
        if (existing.name in entry.tools) {
          entry.tools[record.name] = entry.tools[existing.name]!
          delete entry.tools[existing.name]
        }
        if (!(existing.name in entry.enabled)) continue
        entry.enabled[record.name] = entry.enabled[existing.name]!
        delete entry.enabled[existing.name]
      }
    }
    if (Object.keys(secrets).length > 0) {
      this.secrets[secretKey(record.name, owner)] = Object.fromEntries(Object.entries(secrets).map(([name, value]) => [name, cipher!.encrypt(value).toString('base64')]))
    }
    this.forget(existing?.name ?? record.name)
    this.persist()
  }

  /** 대화로 서버를 더하기 전의 검사 (이슈 #145 — 앱 MCP 의 create(kind mcp_server)). 입력 모양·예약 이름·**그 프로젝트에서 이미 보이는 이름**(앱 서버·
   *  그 프로젝트 전용·폴더 정의·개인 설정 — save 는 앱 서버끼리만 본다). toFile 이면 프로젝트의 `.mcp.json` 을 고쳐 쓸 수 있는지도 본다.
   *  안 되면 사유를 던진다 */
  checkNew(input: McpServerInput, directory: string, toFile = false): void {
    const workdir = realpathOf(directory)
    const { record } = this.resolve({ ...input, originalName: undefined }, undefined)
    if (RESERVED_NAMES.includes(record.name) || this.builtins.has(record.name)) throw new Error(tr('mcp.error.nameReserved', { name: record.name }))
    const visible = [...this.servers, ...(this.projects[workdir]?.servers ?? []), ...projectServers(workdir), ...personalServers(this.opts.env ?? process.env)]
    if (visible.some((server) => server.name === record.name)) throw new Error(tr('mcp.error.nameTaken', { name: record.name }))
    if (toFile) readProjectFile(workdir)
  }

  /** 프로젝트 폴더의 `.mcp.json`(Claude Code 모양 — projectServers 가 읽는 그 모양)에 서버 하나를 더한다 (이슈 #145). 있던 서버·다른 열쇠는
   *  그대로 두고, 파일이 깨져 있으면 덮어쓰지 않고 던진다. 링크를 풀어 프로젝트 폴더 안일 때만 쓴다. **비밀 값은 프로젝트 파일에 적지 않는다** —
   *  비밀이 있는 서버는 save 의 project 묶음(앱 안)으로 넣는다. 돌려주는 것은 쓴 파일의 경로. 다음 턴에 그 폴더에 붙는다 */
  addToProjectFile(input: McpServerInput, directory: string): string {
    this.checkNew(input, directory)
    const workdir = realpathOf(directory)
    const { record, secrets } = this.resolve({ ...input, originalName: undefined }, undefined)
    if (Object.keys(secrets).length > 0) throw new Error(tr('mcp.error.projectFileSecret'))
    const { file, config } = readProjectFile(workdir)
    const values = Object.fromEntries(record.vars.map((entry) => [entry.name, entry.value ?? '']))
    const more = Object.keys(values).length > 0
    const entry =
      record.type === 'remote'
        ? { type: 'http', url: record.url, ...(more && { headers: values }) }
        : { command: record.command![0], ...(record.command!.length > 1 && { args: record.command!.slice(1) }), ...(more && { env: values }) }
    const servers = (config['mcpServers'] ?? {}) as Record<string, unknown>
    fs.writeFileSync(file, `${JSON.stringify({ ...config, mcpServers: { ...servers, [record.name]: entry } }, null, 2)}\n`)
    return file
  }

  /** 앱 서버를 지운다 — directory(지금 프로젝트)의 전용 서버를 먼저 찾고, 없으면 모든 프로젝트 서버. 그 이름의 켜기 값도 같이 지운다 */
  remove(name: string, directory?: string): void {
    const workdir = directory ? realpathOf(directory) : undefined
    const mine = (workdir && this.projects[workdir]) || undefined
    if (mine?.servers.some((server) => server.name === name)) {
      mine.servers = mine.servers.filter((server) => server.name !== name)
      delete mine.enabled[name]
      delete mine.tools[name]
      delete this.secrets[secretKey(name, workdir)]
    } else {
      this.servers = this.servers.filter((server) => server.name !== name)
      for (const entry of Object.values(this.projects)) {
        delete entry.enabled[name]
        delete entry.tools[name]
      }
      delete this.secrets[name]
    }
    this.persist() // 붙어 있던 폴더에서는 다음 붙이기가 끊는다 (attached 에 남아 있다)
  }

  /** 그 프로젝트에서만 켜고 끈다 (앱 서버·폴더 정의·개인 설정 모두 — 정의는 안 고친다). 다음 목록 읽기·다음 턴에 붙이거나 끊는다 */
  setEnabled(name: string, enabled: boolean, directory: string): void {
    this.project(realpathOf(directory)).enabled[name] = enabled
    this.persist()
  }

  /** 그 프로젝트에서만 서버 안의 도구를 고른다 (이슈 #164 — 정의·`.mcp.json` 은 안 고친다). undefined 면 전부 켜짐. 다음 턴부터 모델에 안 보인다.
   *  내장 서버는 고르지 않는다 */
  setTools(name: string, selection: McpToolSelection | undefined, directory: string): void {
    if (RESERVED_NAMES.includes(name) || this.builtins.has(name)) throw new Error(tr('mcp.error.nameReserved', { name }))
    const tools = this.project(realpathOf(directory)).tools
    const chosen = toolSelectionOf(selection)
    if (chosen) tools[name] = chosen
    else delete tools[name]
    this.persist()
  }

  /** 저장하지 않고 붙어 본다 — 도구 목록 또는 사유. directory 는 로컬 서버를 띄울 폴더(지금 프로젝트) */
  async test(input: McpServerInput, directory?: string): Promise<McpTestResult> {
    try {
      const workdir = directory ? await realDirectory(directory) : undefined
      const own = input.originalName !== undefined && workdir ? this.projects[workdir]?.servers.find((server) => server.name === input.originalName) : undefined
      const existing = own ?? (input.originalName !== undefined ? this.servers.find((server) => server.name === input.originalName) : undefined)
      const { record, secrets } = this.resolve(input, existing, own ? workdir : undefined)
      const cwd = workdir || this.opts.fallbackCwd || os.homedir()
      const tools = await listMcpTools(defOf(record, secrets), { cwd, env: this.opts.env })
      return { ok: true, tools }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  }

  /** 그 폴더 인스턴스에 그 프로젝트에서 켠 서버(앱·프로젝트 전용·폴더 정의)를 붙이고, 더는 붙일 것이 아닌 것은 끊는다. 폴더마다 한 줄로 돈다 */
  prepare(workdir: string): Promise<void> {
    const previous = this.chains.get(workdir) ?? Promise.resolve()
    const next = previous
      .then(() => this.attach(workdir))
      .catch((error: unknown) => {
        console.error('[mcp] 붙이기 실패', workdir, (error as Error).message)
        return new Map<string, EngineMcp>()
      })
      .then((wanted) => this.hide(workdir, wanted))
      .catch((error: unknown) => console.error('[mcp] 도구 숨기기 실패', workdir, (error as Error).message))
    this.chains.set(workdir, next)
    return next
  }

  /** 내장 서버를 올린다 — 돌려준 함수가 내린다 (ctx.effect 로 건다). 매 턴 그 폴더용 정의를 물어 사용자 서버와 같은 길로 붙인다 */
  registerBuiltin(name: string, define: BuiltinMcp): () => void {
    this.builtins.set(name, define)
    this.reattach(name)
    return () => {
      if (this.builtins.get(name) === define) this.builtins.delete(name) // 붙어 있던 폴더에서는 다음 붙이기가 끊는다
    }
  }

  /** 그 서버를 다음 붙이기에서 다시 붙이게 한다 — 엔진은 붙일 때만 도구 목록을 읽는다 (내장 서버의 도구가 바뀌었을 때) */
  reattach(name: string): void {
    this.forget(name)
    this.toolCache.clear()
  }

  /** 붙인(붙일) 서버 이름 → 정의를 돌려준다 — 숨길 도구를 고를 때 도구 목록을 묻는 데 쓴다 */
  private async attach(workdir: string): Promise<Map<string, EngineMcp>> {
    const mine = this.projects[workdir]
    const on = (name: string, fallback: boolean): boolean => mine?.enabled[name] ?? fallback
    const own = mine?.servers ?? []
    const ownNames = new Set(own.map((server) => server.name))
    const appNames = new Set([...this.servers.map((server) => server.name), ...ownNames, ...RESERVED_NAMES])
    const folder = projectServers(workdir)
    const wanted = new Map<string, EngineMcp>()
    for (const { name, def, enabled } of folder) if (on(name, enabled) && !appNames.has(name)) wanted.set(name, def)
    for (const server of this.servers) if (!ownNames.has(server.name) && on(server.name, server.enabled)) wanted.set(server.name, this.engineDef(server))
    for (const server of own) if (on(server.name, server.enabled)) wanted.set(server.name, this.engineDef(server, workdir))
    for (const name of RESERVED_NAMES) wanted.delete(name) // 예약 이름으로 저장돼 있던 앱 서버 — 내장 서버만 그 이름을 쓴다
    for (const [name, define] of this.builtins) {
      const def = on(name, true) ? define(workdir) : undefined
      if (def) wanted.set(name, def)
    }
    // 이 프로젝트에서 끈 이름 중 앱·폴더 정의가 아닌 것 = 개인 설정 서버 (opencode 가 스스로 띄운다)
    const ours = new Set([...appNames, ...folder.map((server) => server.name), ...this.builtins.keys()])
    const off = Object.keys(mine?.enabled ?? {}).filter((name) => !mine!.enabled[name] && !ours.has(name))
    const paused = this.paused.get(workdir) ?? new Set<string>()
    const record = this.attached.get(workdir) ?? new Map<string, string>()
    if (wanted.size === 0 && record.size === 0 && off.length === 0 && paused.size === 0) return wanted // 붙일 것도 끊을 것도 없다 — opencode 에 묻지 않는다
    this.attached.set(workdir, record)
    this.paused.set(workdir, paused)
    const status = await this.ctx.llm.mcpStatus(workdir)
    await Promise.all(
      [...wanted].map(async ([name, def]) => {
        const print = fingerprint(def)
        if (name in status && record.get(name) === print) return
        // 내장 서버엔 timeout 을 주지 않는다 — 엔진에선 이 값이 도구 호출 기한도 된다 (01z 1-4)
        await this.ctx.llm.mcpAdd(workdir, name, this.builtins.has(name) ? def : { ...def, timeout: def.timeout ?? CONNECT_TIMEOUT_MS })
        record.set(name, print)
        this.ever.set(workdir, (this.ever.get(workdir) ?? new Set()).add(name))
      }),
    )
    for (const name of [...record.keys()]) {
      if (wanted.has(name)) continue
      record.delete(name)
      if (status[name] && status[name].status !== 'disabled') await this.ctx.llm.mcpDisconnect(workdir, name)
    }
    for (const name of off) {
      if (!status[name] || status[name].status === 'disabled') continue
      await this.ctx.llm.mcpDisconnect(workdir, name)
      paused.add(name)
    }
    for (const name of [...paused]) {
      if (off.includes(name)) continue
      paused.delete(name)
      if (status[name]?.status === 'disabled') await this.ctx.llm.mcpConnect(workdir, name)
    }
    return wanted
  }

  /** 그 프로젝트에서 고른 도구 중 꺼진 것을 ctx.llm 에 넘긴다 (이슈 #164). wanted 는 붙인 서버의 정의 — 없으면(개인 설정) 개인 설정 파일의 정의로 묻는다 */
  private async hide(workdir: string, wanted: Map<string, EngineMcp>): Promise<void> {
    const chosen = this.projects[workdir]?.tools ?? {}
    const hidden: Record<string, string[]> = {}
    for (const [name, selection] of Object.entries(chosen)) {
      if (RESERVED_NAMES.includes(name) || this.builtins.has(name)) continue
      if (!selection.only) {
        if (selection.off?.length) hidden[name] = [...selection.off]
        continue
      }
      const personal = personalServers(this.opts.env ?? process.env).find((server) => server.name === name)?.def
      const def = wanted.get(name) ?? (personal && !substituted(personal) ? personal : undefined)
      if (!def) continue
      const listed = await this.tools(def, workdir)
      if (listed.tools) hidden[name] = hiddenTools(selection, listed.tools.map((tool) => tool.name))
    }
    this.hiding.add(workdir)
    this.ctx.llm.hideMcpTools(workdir, hidden)
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

  /** 앱이 저장한 서버(모든 프로젝트·프로젝트 전용)의 env·헤더 값 전부 — 비밀 표시와 무관하게. 문제 신고 묶음(ctx.report)이 글에서 지우는 데만
   *  쓴다 (이슈 #177). 화면·파일·로그로 내보내지 않는다 */
  varValues(): string[] {
    const owned: [McpServerRecord, string | undefined][] = [
      ...this.servers.map((server) => [server, undefined] as [McpServerRecord, undefined]),
      ...Object.entries(this.projects).flatMap(([workdir, entry]) => entry.servers.map((server) => [server, workdir] as [McpServerRecord, string])),
    ]
    return owned.flatMap(([server, owner]) => {
      const def = this.engineDef(server, owner)
      return Object.values((def.type === 'remote' ? def.headers : def.environment) ?? {})
    })
  }

  /** owner 는 프로젝트 전용 서버의 프로젝트(realpath) */
  private engineDef(server: McpServerRecord, owner?: string): EngineMcp {
    const sealed = this.secrets[secretKey(server.name, owner)] ?? {}
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
  private resolve(input: McpServerInput, existing: McpServerRecord | undefined, owner?: string): { record: McpServerRecord; secrets: Record<string, string> } {
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

    const sealed = existing ? (this.secrets[secretKey(existing.name, owner)] ?? {}) : {}
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

  /** 그 프로젝트의 기록 — 없으면 만든다 */
  private project(workdir: string): McpProjectRecord {
    return (this.projects[workdir] ??= { servers: [], enabled: {}, tools: {} })
  }

  private persist(): void {
    if (this.opts.file) writeJsonFileSync(this.opts.file, this.servers, { mode: 0o600 })
    if (this.opts.secretsFile) writeJsonFileSync(this.opts.secretsFile, this.secrets, { mode: 0o600 })
    if (this.opts.projectsFile) writeJsonFileSync(this.opts.projectsFile, this.projects, { mode: 0o600 })
  }
}

/** 비밀 파일의 키 — 모든 프로젝트 서버는 이름 그대로(예전 모양), 프로젝트 전용 서버는 `<프로젝트 경로>#<이름>`.
 *  이름엔 `#`·경로 구분자가 못 들어가므로(NAME_PATTERN) 둘이 겹치지 않는다 */
function secretKey(name: string, owner?: string): string {
  return owner ? `${owner}#${name}` : name
}

/** 파일의 tools → 서버별 선택 (모양이 다른 값은 버린다 — 전부 켜짐) */
function toolSelections(value: unknown): Record<string, McpToolSelection> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([name, entry]) => {
    const selection = toolSelectionOf(entry)
    return selection ? [[name, selection]] : []
  }))
}

/** 프로젝트 기록의 키 — realpath (ctx.projects·ctx.llm 과 같은 값). 폴더가 없어졌으면 받은 그대로 */
function realpathOf(directory: string): string {
  try {
    return fs.realpathSync(directory)
  } catch {
    return directory
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

function appSummary(server: McpServerRecord, scope: McpScope, sealed: Record<string, string>): McpServerSummary {
  return {
    name: server.name,
    source: 'app',
    scope,
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
function readOnlySummary(name: string, source: 'personal' | 'project', def: EngineMcp): McpServerSummary {
  const vars = def.type === 'remote' ? def.headers : def.environment
  return {
    name,
    source,
    scope: source === 'project' ? 'project' : 'all',
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
  /** 프로젝트 폴더 정의가 적힌 파일 (프로젝트 기준 상대 경로) */
  origin?: string
}

/** 프로젝트 폴더의 MCP 정의 — `.mcp.json` → `opencode.json(c)` → `.opencode/opencode.json(c)` 순으로 겹쳐 뒤가 이긴다 (opencode 의 프로젝트·.opencode 순서).
 *  위 폴더(git 루트까지)는 안 본다 */
export function projectServers(directory: string): ParsedServer[] {
  const merged = new Map<string, ParsedServer>()
  for (const server of claudeServers(readJsonc(path.join(directory, '.mcp.json')))) merged.set(server.name, { ...server, origin: '.mcp.json' })
  for (const file of ['opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc']) {
    for (const server of opencodeServers(readJsonc(path.join(directory, file)))) merged.set(server.name, { ...server, origin: file })
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

/** 고쳐 쓸 프로젝트의 `.mcp.json` — 없으면 빈 것. 폴더 밖을 가리키는 링크·JSON 이 아닌 글·모양이 다른 파일이면 던진다 (덮어쓰지 않는다).
 *  주석이 든 파일도 받지 않는다 — 고쳐 쓰면 주석이 사라진다 */
function readProjectFile(workdir: string): { file: string; config: Record<string, unknown> } {
  const file = path.join(workdir, '.mcp.json')
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) return { file, config: {} }
  let real: string | undefined
  try {
    real = fs.realpathSync(file)
  } catch {
    // 끊어진 링크 — 아래에서 거절
  }
  if (!real || insideOf(workdir, real) === undefined) throw new Error(tr('mcp.error.projectFileOutside'))
  let config: unknown
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw new Error(tr('mcp.error.projectFileBroken'))
  }
  if (!isObject(config) || (config['mcpServers'] !== undefined && !isObject(config['mcpServers']))) throw new Error(tr('mcp.error.projectFileBroken'))
  return { file, config }
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

