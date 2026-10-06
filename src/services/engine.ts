import { Context, Service } from 'cordis'
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { mergePath } from './loginPath.ts'
import { findOpencodeBinary, notFoundMessage } from './opencodeBinary.ts'
import { startKeyProxy, type KeyProxy } from './keyProxy.ts'
import { keepTail, streamText } from './outputBuffer.ts'
import type { ProviderConfig } from './providers.ts'
import type { Mode } from '../../shared/modes.ts'
import { matchesTool, UNGATED_TOOLS } from '../../shared/hooks.ts'
import { BROWSER_DENIED_TOOLS, BROWSER_MCP_NAME, BROWSER_QUIET_TOOLS, BROWSER_READ_TOOLS } from '../../shared/browser.ts'
import { engineLimit } from '../../shared/outputLimit.ts'
import { tr } from '../i18n.ts'
import { removeAppPluginDirs } from './enginePlugins.ts'
import './providers.ts'
import type {} from './features.ts' // ctx.features·'features/changed' 타입
import type {} from './settings.ts' // ctx.settings·'settings/changed' 타입

// 앱이 띄우는 opencode 서버 하나의 수명 (ctx.engine). ctx.llm 은 이 서비스에서 주소·인증을 받아 쓰고, 그 밖의 누구도
// opencode 를 모른다. 프로젝트마다 띄우지 않는다 — 세션마다 location.directory 로 폴더를 가른다 (01_probe Q1).
//
// 설정 전달은 실측(2026-09-30, opencode 1.18.18, _workspace/01_probe.md)을 따른다:
// - (이력 — 실측은 신규 세대 /api/session/* 로 했다. 채팅은 지금 레거시 경로다) 신규 세대가 읽는 설정은 `OPENCODE_CONFIG_DIR` 폴더(있으면 전역 폴더를 대신한다) + 세션 폴더의 opencode.json 뿐이다.
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
  /** 앱이 붙이는 MCP 서버의 opencode 설정 — 로컬 서버의 자식 env 에서 이 서버의 비밀(서버 비밀번호 등)을 빈 값으로 덮는다 (engineMcpConfig) */
  mcpConfig(def: EngineMcp): Record<string, unknown>
  /** 이 서버의 설정에 그 권한 이름의 도구 실행 전 게이트(ask 규칙)를 얹었나 (toolGate) — 얹지 않은 권한의 승인 요청은 모드나 사용자 설정이 원래 묻는 것이다 */
  gated(permission: string): boolean
}

export interface EngineOptions {
  /** OPENCODE_CONFIG_DIR — 앱이 opencode.json 과 npm 설치 표식(package.json·package-lock.json·빈 node_modules)을 생성한다 */
  configDir: string
  /** OPENCODE_DB — 사용자 CLI opencode 의 세션 기록과 가른다 */
  db: string
  /** 띄운 PID 기록 — 앱이 곱게 못 끝났을 때 다음 실행이 거둔다 */
  pidFile: string
  /** 자식에 물려줄 환경 (기본 process.env) */
  env?: NodeJS.ProcessEnv
  /** 설치본에 실린 opencode·rg (opencodeBinary.ts bundledPaths). 개발 실행에는 없다 */
  bundled?: { opencode: string; rgDir: string }
  /** 프로젝트 opencode 설정을 막는다 (OPENCODE_DISABLE_PROJECT_CONFIG, engineEnv 참고). 기본 꺼짐 — L1(레거시 보내기 + AGENTS.md 주입)과 같이 켠다 */
  blockProjectConfig?: boolean
  /** 로그인 셸의 PATH 를 읽는 함수(loginPath.ts) — 앱 실행마다 한 번 읽어 자식 PATH 앞에 합친다 (#84). 테스트는 안 준다 */
  loginPath?: () => Promise<string | undefined>
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

const PURGE_TIMEOUT_MS = 30_000
// 지운 대화 본문을 DB 파일에서 걷어낸다 (2026-10-01 실측, _workspace/01_probe.md). DELETE 뒤에도 본문은 WAL 에, 체크포인트 뒤에는
// main 의 빈 페이지에 남는다(secure_delete 기본값) — TRUNCATE 체크포인트 → VACUUM → 다시 TRUNCATE 해야 세 파일 모두 0 이 된다.
// sqlite 는 opencode 실행 파일을 BUN_BE_BUN=1 로 띄워 bun 의 bun:sqlite 로 연다 — Electron 33(Node 20)엔 node:sqlite 가 없고 의존성을
// 늘리지 않으려고. **문서화 안 된 bun 동작에 기댄다** (opencode 1.18.18 = bun 1.3.14 에서 확인). 버전이 바뀌어 안 먹으면 정리는 로그만
// 남기고 넘어가고, 실물 테스트(DB 파일에 표식 0건)가 깨진다. opencode 가 떠 있어도 됐다 — 다만 잠금을 opencode busy_timeout(5초) 넘게
// 쥐면 그동안의 opencode 쓰기가 실패하므로, 답을 기다리는 턴이 없을 때만 부른다(ctx.llm). busy_timeout 은 우리가 기다리는 쪽이다
const PURGE_SCRIPT = [
  'const { Database } = require("bun:sqlite")',
  'const db = new Database(process.env.LITECODE_PURGE_DB)',
  'db.run("PRAGMA busy_timeout=2000")',
  'const before = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get()',
  'db.run("VACUUM")',
  'const after = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get()',
  'db.close()',
  'console.log(JSON.stringify({ busy: before.busy || after.busy }))',
].join(';')
// 모드 = opencode primary 에이전트 하나 (01k). ctx.llm 이 매 프롬프트의 agent 로 고른다 (레거시 경로 — 세션에 묶이지 않는다).
// 정의는 이 파일이 생성하는 opencode.json 에만 있다 — 위층은 모드 이름(shared/modes.ts)만 안다.
// - plan: opencode 기본 plan 을 덮어쓴다. 기본 plan 은 편집만 막고(bash 허용, .opencode/plans/*.md 쓰기 허용) "계획만 세워라" 프롬프트도
//   신규 세대엔 없다(01k). 규칙은 뒤가 이긴다 — edit·bash·webfetch deny 를 덧붙이면 그 도구들이 LLM 요청에서 빠지고 plans 예외도 막힌다
//   (2026-10-02 실측 3/3: tools = glob·grep·question·read·skill·todowrite·websearch, plans md 안 생김)
// - build: opencode 기본 그대로 (폴더 밖·.env 읽기는 묻는다)
// - litecode-ask / litecode-full: 사용자 정의 에이전트. build 의 system 첫 줄을 못 받으므로 prompt 로 준다(01f). 기본 규칙에 question deny 가
//   있어 ask 는 다시 허용한다. full 은 "*":"allow" — 폴더 밖·.env 도 안 묻는다(01f)
// ⚠️ 없는 에이전트 이름도 opencode 는 200/204 로 받고 모든 도구 허용으로 돈다 — ctx.llm 이 /api/agent 로 먼저 확인한다
export const MODE_AGENT: Record<Mode, string> = { plan: 'plan', build: 'build', ask: 'litecode-ask', full: 'litecode-full' }
/** opencode 1.18.18 build 에이전트의 system (GET /api/agent) 그대로 */
const BUILD_PROMPT =
  'You are an AI coding agent. Help the user accomplish software engineering tasks by inspecting the workspace, making targeted changes, and using tools according to the configured permissions.'
const PLAN_PROMPT = [
  'You are an AI coding agent in plan mode. Help the user plan software engineering tasks by inspecting the workspace with read-only tools.',
  'Do not modify files or run commands — editing, shell and web fetch tools are unavailable in this mode.',
  'Answer with a concrete step-by-step plan. The user will switch to an execution mode to carry it out.',
].join(' ')
// 하위 작업(레거시 task, 이슈 #31 실측 2026-10-02): 자식 세션은 **부모 모드의 권한을 물려받지 않는다** — 자식 세션 권한은 task deny 하나뿐이고 하위 에이전트
// (general·explore) 자기 규칙으로 돈다. 그래서 매번 묻기에서 general 이 bash 를 묻지 않고 실행했고(1/1), explore 도 레거시에선 bash 가 있어(도구 목록 실측)
// 계획 모드에서 파일을 만들었다(1/1). → 매번 묻기는 묻는 하위 에이전트(SUBAGENT_ASK — general 과 같은 설명, 편집·명령·웹을 묻는다)만 쓰게 하고,
// 계획은 task 를 막는다(도구가 빠진다). 그 하위 에이전트는 다른 모드에서 막는다 — 전역 규칙(build) + 전체 권한의 "*":allow 뒤. 규칙은 뒤가 이기고,
// 막힌 하위 에이전트는 task 설명의 목록에서도 빠진다 (hidden 으로는 안 빠졌다)
export const SUBAGENT_ASK = 'general-ask'
const GENERAL_DESCRIPTION =
  'General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.'
const SUBAGENT_ASK_DENY = { task: { [SUBAGENT_ASK]: 'deny' } }
type Permission = Record<string, string | Record<string, string>>
// 웹 도구(webfetch·websearch)는 켰을 때 이 규칙을 따른다 — 계획 deny, 매번 묻기 ask, 기본·전체 허용 (이슈 #14)
export const ENGINE_AGENTS: Record<string, { mode?: string; prompt?: string; description?: string; permission: Permission }> = {
  plan: { prompt: PLAN_PROMPT, permission: { edit: 'deny', bash: 'deny', webfetch: 'deny', websearch: 'deny', task: 'deny' } },
  // 기본 모드는 opencode 기본 그대로다 — 여기 적는 것은 권한 규칙을 얹을 자리뿐이다 (MCP_TOOL_RULES 의 보내기 도구 ask, 이슈 #55).
  // 권한만 적은 build 는 다른 동작이 그대로였다 (도구 목록 동일, 01z 1-3)
  [MODE_AGENT.build]: { permission: {} },
  [MODE_AGENT.ask]: {
    mode: 'primary',
    prompt: BUILD_PROMPT,
    permission: { edit: 'ask', bash: 'ask', webfetch: 'ask', websearch: 'ask', question: 'allow', task: { '*': 'deny', [SUBAGENT_ASK]: 'allow' } },
  },
  [MODE_AGENT.full]: { mode: 'primary', prompt: BUILD_PROMPT, permission: { '*': 'allow', ...SUBAGENT_ASK_DENY } },
  // general 과 같다(todowrite deny, 시스템 프롬프트 없음) + 매번 묻기와 같은 묻기
  [SUBAGENT_ASK]: { mode: 'subagent', description: GENERAL_DESCRIPTION, permission: { todowrite: 'deny', edit: 'ask', bash: 'ask', webfetch: 'ask', websearch: 'ask' } },
}

// 웹 도구 끄기 (이슈 #14, 실측 2026-10-02 opencode 1.18.18 — 가짜 LLM 이 받은 요청의 tools 로 봤다). deny 면 도구가 LLM 요청에서 빠진다.
// 전역 `permission`(또는 `tools: {x: false}` — 결과 같음)만으로는 **에이전트 규칙에 진다**: litecode-ask 의 webfetch:ask·litecode-full 의
// "*":allow 가 되살린다. 규칙은 뒤가 이기므로 정의한 에이전트마다 맨 뒤에 deny 를 덧붙인다. build(정의 없음)와 레거시 task 의 하위 에이전트
// (explore·general)는 전역 deny 로 빠졌다. 신규 /api prompt·레거시 prompt_async 둘 다 4 모드 모두에서 빠졌다 (레거시엔 원래 websearch 가 없다)
const WEB_TOOLS_DENY = { webfetch: 'deny', websearch: 'deny' }

/** 웹 도구 규칙을 빼고 맨 뒤에 deny 를 붙인다 — 객체 펼치기는 있던 키의 자리를 지키므로 지운 뒤 붙인다 */
function withWebDenied(permission: Permission): Permission {
  const rest = Object.fromEntries(Object.entries(permission).filter(([name]) => !(name in WEB_TOOLS_DENY)))
  return { ...rest, ...WEB_TOOLS_DENY }
}

// 스킬 (이슈 #7, 레거시 실측 2026-10-02 opencode 1.18.18 — 가짜 LLM 이 받은 요청·레거시 GET /skill 로 봤다):
// - 레거시는 앱 CONFIG_DIR/skills 를 읽고 시스템 프롬프트 끝 `<available_skills>`(이름·설명·위치)에 싣는다. 매 요청 다시 만든다 — 옛 대화에
//   `<system-update>` 가 따로 붙지 않는다. 목록·본문은 폴더별로 캐시돼 재시작해야 바뀐다
// - OPENCODE_DISABLE_PROJECT_CONFIG(engineEnv)가 프로젝트 `.opencode/skills` 도 끈다. `skills.paths` 에 상대 경로 `.opencode/skills` 를 주면
//   다시 읽힌다(세션 폴더 기준 — git 루트까지 올라가지 않는다). 프로젝트 opencode.json·MCP·npm 설치는 그대로 막혀 있다(.opencode 에 설치 0)
// - `~/.claude/skills`·`.claude/skills` 는 OPENCODE_DISABLE_CLAUDE_CODE·_EXTERNAL_SKILLS 로 꺼져 있고, `skills.paths` 에 주면 읽힌다
//   ("Claude Code 스킬 함께 쓰기", 기본 꺼짐 — 사용자 결정). `~/.agents/skills` 는 안 읽는다
// - 내장 customize-opencode(opencode 설정 안내 16KB)는 `permission.skill["customize-opencode"]="deny"` 로 프롬프트에서 빠진다. 전역만으로는
//   litecode-full 의 "*":allow 가 되살린다 → 웹 도구 deny 처럼 에이전트마다 맨 뒤에도 붙인다. `skill: "deny"` 면 도구·목록이 통째로 빠진다(기능 끔)
const PROJECT_SKILL_PATHS = ['.opencode/skills', '.opencode/skill']
const CLAUDE_SKILL_PATHS = ['~/.claude/skills', '.claude/skills']
const HIDDEN_SKILLS = { 'customize-opencode': 'deny' }

/** 엔진에 실을 스킬 — enabled: 설정 > 기능의 스킬, claude: "Claude Code 스킬 함께 쓰기" */
export interface EngineSkills {
  enabled: boolean
  claude: boolean
}

/** 그 규칙을 지우고 맨 뒤에 붙인다 (규칙은 뒤가 이긴다) */
function withLast(permission: Record<string, unknown>, name: string, rule: unknown): Record<string, unknown> {
  const { [name]: _dropped, ...rest } = permission
  return { ...rest, [name]: rule }
}

const READY_TIMEOUT_MS = 60_000 // 주소를 잡은 뒤에도 /doc 이 수십 초 무응답인 때가 있다 (live-test 스킬 기록)
const KILL_GRACE_MS = 5_000
const MAX_OUTPUT = 4_000

/** 이 프로세스가 띄워 아직 살아 있는 opencode 자식 — 앱 종료 기한이 지나면 서비스 상태와 무관하게 죽일 수 있게 쥔다 */
const liveChildren = new Set<ChildProcess>()

/** 살아 있는 opencode 자식을 바로 죽인다(SIGKILL). 앱 종료의 마지막 수단 — 서비스 정리(stop: SIGTERM → KILL_GRACE_MS → SIGKILL)가
 *  기한 안에 못 끝났을 때 메인이 부른다. GUI 앱에는 자식을 데려갈 터미널이 없어 남기면 유령이 된다 */
export function killEngineProcesses(): void {
  for (const child of liveChildren) {
    try {
      child.kill('SIGKILL')
    } catch {
      // 그 사이 끝났다
    }
  }
}

/** 앱이 붙이는 MCP 서버 (opencode McpLocalConfig·McpRemoteConfig 모양, 이슈 #28). timeout 은 연결·도구 목록 기한(ms) */
export type EngineMcp =
  | { type: 'local'; command: string[]; environment?: Record<string, string>; timeout?: number }
  | { type: 'remote'; url: string; headers?: Record<string, string>; timeout?: number }

/** MCP 자식에 빈 값으로 덮어 넘길 env 이름. opencode 는 MCP 자식에 자기 env 전체(서버 비밀번호·DB 경로 포함)를 넘긴다
 *  (01u 실측 5, 01w 3-2). 설정의 environment 에 빈 값을 넣으면 덮인다(1/1, 동적 추가 POST /mcp 도 같다 — #28 실측) — 지우는 길은 없다.
 *  이름 규칙은 dsh 의 stdio env 걸러 내기 */
export function hiddenEnvNames(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((name) => /^(OPENCODE|LITECODE)_/.test(name) || /KEY|PASSWORD|SECRET|TOKEN/i.test(name))
}

/** opencode 에 넘길 MCP 서버 설정 하나 — 로컬이면 hidden 이름을 빈 값으로 덮고 정의의 environment 를 그 위에. 원격은 OAuth 를 끈다
 *  (401 이면 well-known·동적 등록을 시도한다 — 폐쇄망에선 의미 없다, 01u 실측 3) */
export function engineMcpConfig(def: EngineMcp, hidden: readonly string[]): Record<string, unknown> {
  if (def.type === 'remote') return { ...def, oauth: false }
  return { ...def, environment: { ...Object.fromEntries(hidden.map((name) => [name, ''])), ...def.environment } }
}

// MCP 도구 권한 (이슈 #28, 실측 2026-10-02 opencode 1.18.18 레거시). MCP 도구 이름은 `<서버>_<도구>` 이고(서버·도구 이름의 [A-Za-z0-9_-] 밖
// 글자는 `_`) 권한 이름도 그 이름이다. 서버 이름을 미리 모르므로(프로젝트 서버는 그 폴더를 열 때 붙는다) 와일드카드 `*_*` 로 건다 — deny 면
// 그 도구가 LLM 요청에서 빠지고, ask 면 permission.asked{permission:"<서버>_<도구>", patterns:["*"]} 가 온다 (각 1/1).
// `*_*` 는 밑줄이 있는 내장 권한(external_directory·doom_loop·plan_enter·plan_exit)에도 걸린다 → 계획은 기본값을 다시 적는다(opencode 기본은
// external_directory·doom_loop 모두 ask. 대가: 기본의 "임시 폴더 허용" 하나가 ask 가 된다 — tool-output 허용은 opencode 가 맨 뒤에 다시 붙인다).
// 기본·전체 권한은 opencode 기본(허용)이다. 웹 도구 deny(#14)는 이 뒤에 붙고 겹치지 않는다
//
// 앱 MCP 서버의 도구(`litecode_*`, 이슈 #51 — 실측 2026-10-04 _workspace/01z_desktop_mcp.md 1-3·3-5): **`*_*` 뒤에 개별 이름을 적으면 그 도구만
// 다르게 된다**(뒤가 이긴다, 12조합 3/3). 화면만 여는 도구(open — 파일·터미널)는 묻지 않는다 — 계획·매번 묻기 모두(터미널은 채워만 두고 실행이
// 사용자 손에 있다). 매번 묻기의 하위 작업(general-ask)은 와일드카드대로 묻는다. (open_file·open_terminal 이 둘이던 때는 계획에서 터미널만 뺐다 —
// 도구 수 줄이기로 하나가 되며 규칙이 도구 이름 단위라 계획에서도 터미널에 채울 수 있게 됐다, 2026-10-06)
// 그 이름은 ctx.mcp 가 예약한다 — 사용자·폴더 서버는 `litecode` 라는 이름으로 못 붙는다
//
// 세션 도구 (이슈 #55·#137, 01z 1-3·1-6·3-5 — 실측한 모양 그대로. 이름은 #137 에서 다른 프로젝트용으로 바뀌었다: list_projects·read_project·
// send_to_project, 새 대화를 만드는 도구는 없앴다): 목록(list_projects)은 묻지 않는다. **보내기·읽기는 전역 deny + 기본 모드 에이전트에만 ask** —
// 그래야 하위 작업(general·explore)과 모르는 에이전트의 도구 목록에서 빠진다(9/9. 규칙이 없으면 general 이 보고 부른다, 6/6). 전체 권한은
// `"*":"allow"` 뒤의 개별 ask 가 묻게 하고(3/3), 매번 묻기는 `*_*: ask` 가 전역 deny 뒤에 와 묻는다. 계획은 `*_*: deny` 그대로라 보내기 도구가
// 없고(사용자 결정), 읽기는 그 뒤의 개별 ask 로 묻는다. general-ask 는 자기 `*_*: ask` 가 전역 deny 를 되살리므로 **그 뒤에 개별 deny 가 따로**
// 있어야 한다 (웹 도구 deny 와 같은 함정). ⚠️ 승인에 `always` 로 답하면 그 폴더의 모든 세션에서 더는 묻지 않는다 — ctx.llm.reply 는 once·reject 만 보낸다.
// 읽기는 #137 에서 한때 물었으나 지금은 묻지 않는다(위 READ_TOOL_ALLOW). ⚠️ 읽기의 "전역 deny + 에이전트 ask"·계획의 "`*_*: deny` 뒤 개별 ask" 는
// 따로 실측하지 않았다 — 보내기의 같은 모양(9/9)과 "뒤가 이긴다"(12조합 3/3)에 기댄다
//
// 결과물 선언 (present, 이슈 #91): 화면을 조작하지 않는 읽기 전용 선언이라 **네 모드 모두 묻지 않는다**(계획 포함). 하위 작업은 못 쓴다 — 결과물은 메인
// 대화가 선언한다(카드도 메인 줄만 모은다, dsh 와 같은 결론). 모양은 보내기 도구와 같다: 전역 deny 로 general·explore·모르는 에이전트에서 빼고
// 모드 에이전트마다 개별 allow, general-ask 는 자기 `*_*: ask` 뒤에 개별 deny. ⚠️ "전역 deny + 에이전트 allow" 는 실측하지 않았다 —
// 보내기 도구의 "전역 deny + 에이전트 ask"(9/9)와 같은 규칙 순서(뒤가 이긴다)에 기댄다
// 읽기는 묻지 않는다(사용자 2026-10-06 "읽기도 매번 승인해야 되니?") — 같은 PC·같은 사용자의 다른 프로젝트 대화를 읽을 뿐 아무것도 바꾸지 않는다. 매번 묻기 모드(`*_*: ask`)는 그대로 묻는다
const READ_TOOL_ALLOW = { litecode_read_project: 'allow' }
const SEND_TOOLS_ASK = { litecode_send_to_project: 'ask', ...READ_TOOL_ALLOW }
const PRESENT_ALLOW = { litecode_present: 'allow' }
const PRESENT_DENY = { litecode_present: 'deny' }
const SEND_TOOLS_DENY = { litecode_send_to_project: 'deny', litecode_read_project: 'deny' }
// 만들기 도구 (이슈 #145 — create, kind 로 스킬·MCP 서버·훅. 처음엔 도구 셋이었다): 보내기 도구와 같은 모양이다 — 전역 deny + 기본·전체 권한에 개별 ask, 매번 묻기는
// 와일드카드 ask, 계획은 `*_*: deny` 그대로(도구가 없다), general-ask 는 맨 뒤 개별 deny. **전체 권한에서도 묻는다** — 훅·MCP 는 이 PC 에서 명령이
// 도는 일이라 "전체 권한" 이 대신 승인하지 않는다 (사용자 결정 2026-10-06). ⚠️ 따로 실측하지 않았다 — 보내기의 같은 모양(9/9)에 기댄다
const MAKE_TOOLS_ASK = { litecode_create: 'ask' }
const MAKE_TOOLS_DENY = { litecode_create: 'deny' }
const LIST_TOOL_ALLOW = { litecode_list_projects: 'allow' }
const MCP_TOOL_RULES: Record<string, Record<string, string>> = {
  plan: { '*_*': 'deny', litecode_open: 'allow', ...LIST_TOOL_ALLOW, ...READ_TOOL_ALLOW, ...PRESENT_ALLOW, external_directory: 'ask', doom_loop: 'ask' },
  [MODE_AGENT.build]: { ...SEND_TOOLS_ASK, ...MAKE_TOOLS_ASK, ...PRESENT_ALLOW },
  [MODE_AGENT.ask]: { '*_*': 'ask', litecode_open: 'allow', ...LIST_TOOL_ALLOW, ...PRESENT_ALLOW, plan_enter: 'deny', plan_exit: 'deny' },
  [MODE_AGENT.full]: { ...SEND_TOOLS_ASK, ...MAKE_TOOLS_ASK, ...PRESENT_ALLOW },
  // 매번 묻기의 하위 작업도 MCP 도구를 묻는다 — 하위 에이전트는 부모 모드 규칙을 안 물려받는다 (#31)
  [SUBAGENT_ASK]: { '*_*': 'ask', plan_enter: 'deny', plan_exit: 'deny', ...PRESENT_DENY, ...MAKE_TOOLS_DENY, ...SEND_TOOLS_DENY },
}

// 브라우저 도구 (`chrome_*`, 이슈 #147 — 실측·권고 _workspace/01aj_playwright_mcp.md §4, 도구 갈래는 shared/browser.ts). ctx.browser 가 동봉한
// Playwright MCP 를 내장 서버 `chrome` 으로 붙인다(이름은 ctx.mcp 가 예약). 규칙은 기능이 꺼져 있어도 늘 적는다 — 서버가 없으면 걸릴 도구가 없고,
// 기능을 켤 때 엔진을 다시 띄우지 않아도 된다. engineConfig 가 만든 설정 **위에 따로 얹는다**(withBrowserRules) — 다른 규칙 표를 건드리지 않는다:
// - 전역 `chrome_*: deny` — 하위 작업(general·explore)과 모르는 에이전트는 못 쓴다 (도구 25개의 스키마 26KB 도 그 요청에서 빠진다).
//   모드 에이전트가 아닌 정의(general-ask, 게이트가 만든 general·explore)는 자기 `*_*: ask` 가 전역 deny 를 되살리므로 맨 뒤에 다시 deny
// - 기본·전체 권한: `chrome_*: ask` 뒤에 읽기·조용한 조작만 allow, 늘 막는 셋은 deny. **모르는 `chrome_*` 도구는 ask** — 버전을 올려 새 도구가
//   생겨도 allow 가 기본이 되지 않는다. 전체 권한에서도 묻는 이유는 shared/browser.ts BROWSER_ASK_TOOLS (보내기 도구와 같은 모양: `"*": allow` 뒤의 ask)
// - 계획: `*_*: deny` 밑에서 읽기만 allow. ⚠️ 읽기 도구도 `filename` 인자를 주면 프로젝트 폴더에 파일을 쓴다(01aj §2 G — edit 권한을 안 거친다)
// - 매번 묻기: `*_*: ask` 가 전부 묻는다 — 전역 deny 를 되살리므로 늘 막는 셋만 다시 deny
// - 훅 게이트가 MCP 에 걸렸으면(gated) allow 를 ask 로 적는다 — withGate 가 하는 일("allow 인 것만 ask 로")을 이 묶음에도. 판정을 통과한 요청을
//   묻지 않고 실행할지는 ctx.llm 이 shared/modes.ts modePermission 으로 가른다 (같은 표 — 단위 테스트가 댄다)
// ⚠️ `chrome_*` 처럼 서버 이름을 앞에 둔 와일드카드는 따로 실측하지 않았다 — `*_*`(#28)·"뒤가 이긴다"(12조합 3/3)와 같은 매처에 기댄다.
//   deny 한 개별 이름이 LLM 요청에서 빠지는 것·개별 ask 가 permission.asked 로 오는 것은 실측했다 (01aj §2 M, 각 1/1)
const BROWSER_WILDCARD = `${BROWSER_MCP_NAME}_*`
const browserRules = (tools: readonly string[], action: string): Record<string, string> => Object.fromEntries(tools.map((tool) => [`${BROWSER_MCP_NAME}_${tool}`, action]))
const BROWSER_ALWAYS_DENY = browserRules(BROWSER_DENIED_TOOLS, 'deny')
const BROWSER_OFF = { [BROWSER_WILDCARD]: 'deny' }

/** 그 에이전트 권한 맨 뒤에 얹을 브라우저 규칙 — 모드 에이전트가 아니면 통째로 deny */
function browserAgentRules(agent: string, gated: boolean): Record<string, string> {
  const quiet = gated ? 'ask' : 'allow'
  if (agent === MODE_AGENT.plan) return browserRules(BROWSER_READ_TOOLS, quiet)
  if (agent === MODE_AGENT.ask) return BROWSER_ALWAYS_DENY
  if (agent !== MODE_AGENT.build && agent !== MODE_AGENT.full) return BROWSER_OFF
  return { [BROWSER_WILDCARD]: 'ask', ...browserRules([...BROWSER_READ_TOOLS, ...BROWSER_QUIET_TOOLS], quiet), ...BROWSER_ALWAYS_DENY }
}

/** engineConfig 가 만든 설정에 브라우저 도구 규칙을 얹는다 — 전역과 에이전트마다 맨 뒤에 (규칙은 뒤가 이긴다). gated 는 훅 게이트가 MCP 도구에 걸렸나 */
export function withBrowserRules(config: Record<string, unknown>, gated: boolean): Record<string, unknown> {
  const agents = config['agent'] as Record<string, { permission: Permission }>
  return {
    ...config,
    agent: Object.fromEntries(Object.entries(agents).map(([name, def]) => [name, { ...def, permission: { ...def.permission, ...browserAgentRules(name, gated) } }])),
    permission: { ...(config['permission'] as Permission), ...BROWSER_OFF },
  }
}

// 도구 실행 전 게이트 (이슈 #102 2단계, 실측 _workspace/01af_hooks.md §4 — 플러그인 없이 "실행 전에 막기"). 도구 실행 전 판정을 받을 도구의 권한에
// `ask` 규칙을 얹으면 실행 직전에 permission.asked 가 오고(5/5), ctx.llm 이 판정('llm/pre-tool')을 물어 once / reject+message 로 답한다.
// - 무엇에 거나: 매처(도구 이름의 `|` 나열·정규식, shared/hooks.ts matchesTool)가 맞는 내장 도구의 **권한 이름**(write·apply_patch → edit).
//   내장 도구 이름의 나열이 아닌 매처(빈 매처 = 전부, 정규식, MCP 도구 이름)는 MCP 도구에도 건다 — 서버 이름을 미리 모르므로 와일드카드 `*_*`
// - 어디에 거나: 에이전트마다 **맨 뒤에**(규칙은 뒤가 이긴다 — 전체 권한의 "*":allow 도 덮는다, 사용자 결정) — 네 모드 + 하위 에이전트
//   general·explore·general-ask (자식은 부모 모드 권한을 안 물려받는다, #31). **그 에이전트에서 allow 인 것만 ask 로 바꾼다**: deny 는 그대로(계획의
//   편집·명령, 끈 웹 도구·스킬 — ask 를 얹으면 도구가 되살아난다), 이미 ask 인 것도 그대로. 패턴별 규칙(task·skill)은 allow 인 패턴만 ask 로
// - 에이전트의 "지금 규칙" 은 엔진이 합치는 순서로 본다 (바이너리 코드 판독 2026-10-05, 1.18.18): 기본 → 내장 에이전트 규칙 → 전역 permission →
//   에이전트 permission, 마지막으로 맞는 규칙이 이긴다 (권한 이름도 와일드카드로 맞춘다). 기본·내장 규칙은 아래 두 표에 allow 가 아닌 것만 옮겨 적었다
// - `*_*` 는 밑줄 있는 내장 권한에도 걸린다 (MCP_TOOL_RULES 와 같은 함정) → deny 였던 밑줄 이름(하위 작업의 보내기·결과물 도구, plan_exit 등)은
//   와일드카드 뒤에 deny 를 다시 적는다. external_directory·doom_loop 는 ask 가 된다 (전체 권한에서도 — 판정 뒤 모드가 허용하면 ctx.llm 이 once)
// - 게이트가 비면 설정은 한 글자도 달라지지 않는다 (general·explore 정의도 없다)
// ⚠️ **glob·grep·webfetch 에 ask 를 얹으면 정본 목록 `GET /permission` 이 400 이 된다** (01ai, 동봉 1.18.18): 요청 metadata 가 도구 인자 그대로라
//   빠진 선택 인자(glob·grep 의 path, webfetch 의 timeout)가 응답 검증에 걸린다 (로그 `schema rejection … [0]["metadata"]["path"]`) — 그 요청이 대기 중인
//   동안 그 폴더의 목록 전체가. 처음엔 ctx.llm 이 요청을 못 읽어 턴이 멈춰서 이 셋을 게이트에서 뺐다. 지금은 건다: ctx.llm 이 목록을 못 읽으면
//   permission.asked 이벤트의 요청으로 잇는다 (#107 — 판정·once·reject 까지 각 3/3, 01ai "훅 게이트"). 답(POST …/reply)은 원래 정상이다.
//   websearch 만 걸지 않는다 — 레거시 경로에 그 도구가 없다 (이름은 알아서 MCP 로 번지지는 않는다).
//   처음 격리 실행에서 확인한 것(각 1회): bash·edit·write·read·task·todowrite·skill, 전체 권한에서도 묻는 것, 계획의 read, 자식 general·explore·general-ask 의 bash,
//   reject+message 뒤 턴이 이어지는 것, general·explore 에 권한만 적은 정의. MCP 도구는 01af §4(개별 이름 ask)·#28(`*_*` ask), gpt- 모델의 apply_patch 는 미확인
export interface EngineGate {
  /** 게이트를 걸 내장 권한 이름 (정렬) */
  permissions: string[]
  /** MCP 도구(`<서버>_<도구>`) 전부에도 건다 */
  mcp: boolean
}

/** 내장 도구 이름 → 권한 이름 (01af §7 함정 3) */
const TOOL_PERMISSION: Record<string, string> = {
  bash: 'bash',
  edit: 'edit',
  write: 'edit',
  apply_patch: 'edit',
  multiedit: 'edit',
  read: 'read',
  glob: 'glob',
  grep: 'grep',
  webfetch: 'webfetch',
  task: 'task',
  skill: 'skill',
  todowrite: 'todowrite',
}
const MCP_WILDCARD = '*_*'
/** opencode 기본 규칙 중 allow 가 아닌 것 */
const DEFAULT_RULES: Permission = { question: 'deny', plan_enter: 'deny', plan_exit: 'deny', external_directory: 'ask', doom_loop: 'ask' }
/** 내장 에이전트가 기본 위에 얹는 규칙 (앱 설정이 덮지 않는 것만) */
const BUILTIN_AGENT_RULES: Record<string, Permission> = {
  build: { question: 'allow', plan_enter: 'allow' },
  plan: { question: 'allow', plan_exit: 'allow' },
  general: { todowrite: 'deny' },
  // 바이너리 그대로: "*" deny 뒤에 grep·glob·list·bash·webfetch·websearch·read allow (list·websearch 는 게이트 대상이 아니라 옮기지 않았다).
  // 끈 웹 도구는 이 뒤의 전역 deny 가 이긴다
  explore: { '*': 'deny', grep: 'allow', glob: 'allow', bash: 'allow', webfetch: 'allow', read: 'allow', external_directory: 'ask' },
}
/** 앱이 정의하지 않지만 게이트는 걸어야 하는 내장 하위 에이전트 */
const BUILTIN_SUBAGENTS = ['general', 'explore']

/** 매처들 → 게이트. 잘못된 정규식은 아무것도 걸지 않는다 */
export function toolGate(matchers: readonly string[]): EngineGate {
  const permissions = new Set<string>()
  let mcp = false
  for (const matcher of matchers) {
    const pattern = matcher.trim()
    try {
      new RegExp(pattern === '*' ? '' : pattern)
    } catch {
      continue
    }
    for (const [tool, permission] of Object.entries(TOOL_PERMISSION)) if (matchesTool(pattern, tool)) permissions.add(permission)
    const builtin = (name: string): boolean => name in TOOL_PERMISSION || UNGATED_TOOLS.includes(name)
    if (!pattern.split('|').every((name) => builtin(name.trim().toLowerCase()))) mcp = true
  }
  return { permissions: [...permissions].sort(), mcp }
}

/** 그 권한 이름에 게이트가 걸렸나 */
export function isGated(gate: EngineGate, permission: string): boolean {
  return gate.permissions.includes(permission) || (gate.mcp && permission.includes('_'))
}

/** 겹쳐 놓은 규칙(앞이 먼저)에서 그 권한에 맞는 규칙들 — 뒤(이기는 쪽)부터 */
function rulesFor(name: string, layers: readonly Permission[]): (string | Record<string, string>)[] {
  return [...layers].reverse().flatMap((layer) =>
    Object.keys(layer)
      .reverse()
      .filter((rule) => rule === name || rule === '*' || (rule === MCP_WILDCARD && name.includes('_')))
      .map((rule) => layer[rule]!),
  )
}

/** 그 권한에 마지막으로 맞는 규칙 (없으면 엔진 기본 allow) */
function ruleFor(name: string, layers: readonly Permission[]): string | Record<string, string> {
  return rulesFor(name, layers)[0] ?? 'allow'
}

/** 그 권한의 규칙에서 allow 를 ask 로 바꾼 것 — 바뀌는 것이 없으면 undefined. 패턴별 규칙(task·skill)은 allow 인 패턴만 바꾸고, 어느 패턴에도
 *  안 맞는 대상은 그 밑의 규칙을 따르므로(예: 전역 `task: {general-ask: deny}` 밑의 "*") 그것이 allow 일 때만 `"*": ask` 를 맨 앞에 둔다 */
function askInstead(name: string, layers: readonly Permission[]): string | Record<string, string> | undefined {
  const rules = rulesFor(name, layers)
  const rule = rules[0] ?? 'allow'
  if (typeof rule === 'string') return rule === 'allow' ? 'ask' : undefined
  const rest = rules.find((entry) => typeof entry === 'string' || '*' in entry) ?? 'allow'
  const others = '*' in rule ? undefined : typeof rest === 'string' ? rest : rest['*']
  const patterns = Object.entries(rule)
  if (others !== 'allow' && patterns.every(([, action]) => action !== 'allow')) return undefined
  return { ...(others === 'allow' && { '*': 'ask' }), ...Object.fromEntries(patterns.map(([pattern, action]) => [pattern, action === 'allow' ? 'ask' : action])) }
}

/** 에이전트 권한 맨 뒤에 게이트를 얹는다. below 는 그 에이전트 규칙 밑에 깔리는 것들 (기본·내장 에이전트 규칙·전역) */
function withGate(permission: Permission, below: readonly Permission[], gate: EngineGate): Permission {
  const layers = [...below, permission]
  let gated: Record<string, unknown> = permission
  for (const name of gate.permissions) {
    const rule = askInstead(name, layers)
    if (rule !== undefined) gated = withLast(gated, name, rule)
  }
  if (gate.mcp) {
    const any = ruleFor('_', layers) // 밑줄 이름 일반 — "*"·"*_*" 만 맞는다
    if (any === 'allow') gated = withLast(gated, MCP_WILDCARD, 'ask')
    const named = new Set(layers.flatMap((layer) => Object.keys(layer)).filter((name) => name.includes('_') && name !== MCP_WILDCARD))
    for (const name of named) {
      const rule = ruleFor(name, layers)
      // 와일드카드를 얹었으면 deny 를 그 뒤에 다시, 안 얹었으면(이미 ask·deny) 개별로 허용된 도구만 ask 로
      if (any === 'allow' ? rule === 'deny' : rule === 'allow') gated = withLast(gated, name, any === 'allow' ? 'deny' : 'ask')
    }
  }
  return gated as Permission
}

/** 에이전트마다 게이트를 얹는다 — 앱이 정의하지 않은 내장 하위 에이전트(general·explore)는 얹을 것이 있을 때만 권한뿐인 정의를 더한다 */
function gatedAgents(agents: Record<string, { permission: Permission }>, global: Permission, gate: EngineGate): Record<string, { permission: Permission }> {
  const below = (name: string): Permission[] => [DEFAULT_RULES, BUILTIN_AGENT_RULES[name] ?? {}, global]
  const gated = Object.fromEntries(Object.entries(agents).map(([name, def]) => [name, { ...def, permission: withGate(def.permission, below(name), gate) }]))
  for (const name of BUILTIN_SUBAGENTS) {
    const permission = withGate({}, below(name), gate)
    if (Object.keys(permission).length > 0) gated[name] = { permission }
  }
  return gated
}

/** 생성할 opencode.json — 모든 provider 가 키 프록시를 거친다. 진짜 키·저장된 baseURL 은 없다 */
export function engineConfig(
  providers: ProviderConfig[],
  proxy: Pick<KeyProxy, 'token' | 'baseURLFor'>,
  extra: { mcp?: Record<string, EngineMcp>; childEnv?: NodeJS.ProcessEnv; webTools?: boolean; skills?: EngineSkills; gate?: EngineGate } = {},
): Record<string, unknown> {
  const provider: Record<string, unknown> = {}
  for (const config of providers) {
    // provider·모델 id 는 우리 id 그대로 — ctx.llm 이 그대로 넘긴다
    provider[config.id] = {
      npm: '@ai-sdk/openai-compatible',
      name: config.displayName,
      options: { baseURL: proxy.baseURLFor(config.id), apiKey: proxy.token },
      // 컨텍스트 길이를 주면 opencode 가 /api/model 의 limit 으로 그대로 안다 (01_probe 2026-10-01). 한도를 줘야 자동 압축이 돈다 (01o)
      // output 은 빼면 안 된다 — limit 에 output 이 없으면 설정 파일 전체가 무시돼 provider 가 사라진다 (01o).
      // 레거시는 output 을 요청 max_tokens 로 싣고 문턱(context − output)에서 뺀다 — 0 이면 둘 다 32000 이라 작은 모델에서 요약이 끝없이 돈다.
      // 그래서 최대 출력을 비우면 컨텍스트의 1/4 를 넣는다 (이슈 #27 실측, shared/outputLimit.ts)
      models: Object.fromEntries(
        config.models.map((model) => {
          const limit = engineLimit(model)
          // 이미지 입력을 켠 모델만 modalities 를 싣는다 — 이게 있어야 file 파트 이미지가 image_url 로 나간다(`attachment: true` 만으론 안 된다, 01y 함정 3)
          return [model.id, { name: model.displayName, ...(limit && { limit }), ...(model.imageInput && { modalities: { input: ['text', 'image'], output: ['text'] } }) }]
        }),
      ),
    }
  }
  const hidden = hiddenEnvNames(extra.childEnv ?? {})
  const mcp = extra.mcp && Object.fromEntries(Object.entries(extra.mcp).map(([name, def]) => [name, engineMcpConfig(def, hidden)]))
  const agents = Object.fromEntries(
    Object.entries(ENGINE_AGENTS).map(([name, def]) => [name, { ...def, permission: { ...def.permission, ...MCP_TOOL_RULES[name] } }]),
  )
  const agent = extra.webTools
    ? agents
    : Object.fromEntries(Object.entries(agents).map(([name, def]) => [name, { ...def, permission: withWebDenied(def.permission) }]))
  // 스킬 규칙은 skills 를 줄 때만 (ctx.engine 은 늘 준다) — 끔이면 도구째, 켬이면 내장 customize-opencode 만 뺀다. 웹 도구 규칙 뒤, 맨 끝
  const skillRule = extra.skills && (extra.skills.enabled ? HIDDEN_SKILLS : 'deny')
  const permission = { ...SUBAGENT_ASK_DENY, ...SEND_TOOLS_DENY, ...MAKE_TOOLS_DENY, ...PRESENT_DENY, ...(!extra.webTools && WEB_TOOLS_DENY), ...(skillRule && { skill: skillRule }) }
  const ruled: Record<string, { permission: Permission }> = skillRule
    ? Object.fromEntries(Object.entries(agent).map(([name, def]) => [name, { ...def, permission: withLast(def.permission, 'skill', skillRule) as Permission }]))
    : agent
  return {
    $schema: 'https://opencode.ai/config.json',
    provider,
    // 도구 실행 전 게이트는 모든 규칙 뒤에 (이슈 #102) — 게이트가 비면 아무것도 얹지 않는다
    agent: extra.gate && (extra.gate.mcp || extra.gate.permissions.length > 0) ? gatedAgents(ruled, permission, extra.gate) : ruled,
    permission,
    ...(extra.skills?.enabled && { skills: { paths: [...PROJECT_SKILL_PATHS, ...(extra.skills.claude ? CLAUDE_SKILL_PATHS : [])] } }),
    // 레거시는 매 스텝 작업 폴더의 스냅샷을 사용자 데이터 폴더에 만든다(큰 저장소에서 비용). litecode 는 revert 를 안 쓴다 (01w 1절)
    snapshot: false,
    ...engineDefaults(providers),
    ...(mcp && { mcp }),
  }
}

/** opencode 가 묻지 않고 밖으로 나가는 기능을 앱 값으로 고정한다 (01x, 이슈 #19). 레거시는 사용자 ~/.config/opencode/opencode.json 도 읽지만
 *  이 폴더(CONFIG_DIR) 값이 이긴다(01x 2-5 실측) — 원격 instructions 배열만은 합쳐져 못 지운다(사용자 결정 대기) */
function engineDefaults(providers: ProviderConfig[]): Record<string, unknown> {
  // 모델 없이 만든 세션은 바이너리 내장 opencode Zen(opencode.ai/zen, 키 없음)으로 프롬프트를 보낸다 — enabled_providers 로는 안 막히고
  // model 이 막는다(01x 2-4, 5/5). ctx.llm 은 늘 모델을 주므로 이중 방어다. 고를 모델이 없으면 없는 모델을 가리키지 않게 뺀다
  const first = providers.find((config) => config.models.length > 0)
  return {
    ...(first && { model: `${first.id}/${first.models[0]!.id}` }),
    // 레거시 provider 목록에서 Zen 을 빼고, 사용자 전역의 enabled_providers 가 앱 provider 를 끄는 것(모든 턴 Model not found, 01x 4)을 덮는다
    enabled_providers: providers.map((config) => config.id),
    share: 'disabled', // share:"auto" 면 세션마다 opncd.ai 로 대화 전체를 동기화한다 (01x 5)
    autoupdate: false, // serve 에선 안 돈다(정적) — 보험
    lsp: false, // 켜지면 레거시가 파일을 쓸 때 언어 서버를 npm·gem·github 에서 받는다 — 막힌 망에서 72~972초 (01x 7)
    formatter: false, // 레거시 write·edit 뒤 파일을 고치고, prettier·biome 은 npm 설치 (01x 8)
  }
}

// npm 설치 막기 (01w 4절, 사용자 결정 00_next_legacy 3). opencode 는 설정 폴더(앱 CONFIG_DIR·사용자 $XDG_CONFIG_HOME/opencode·
// ~/.opencode·프로젝트 .opencode) 중 쓰기 가능한 곳마다 @opencode-ai/plugin 을 백그라운드 npm 설치한다 — 끄는 플래그는 없다.
// node_modules/ 가 있고 package.json 의 의존성(+플러그인)이 package-lock.json packages[""] 에 다 있으면 건너뛴다(코드 Npm.install,
// 표식만으로 레지스트리 요청 0 — 1/1). 우리는 사용자 플러그인이 없어 본체는 필요 없다. 프로젝트 .opencode 는 blockProjectConfig 를 켜야 빠진다
const PLUGIN_PACKAGE = '@opencode-ai/plugin'
const PLUGIN_VERSION = '1.18.18' // 동봉 opencode 버전 (scripts/fetch-opencode.mjs)

/** 표식을 둘 폴더. create=false 면 이미 있을 때만 (opencode 도 없는 ~/.opencode 는 안 본다 — 01w "있다면") */
export function installMarkerDirs(configDir: string, env: NodeJS.ProcessEnv): { dir: string; create: boolean }[] {
  const home = env['HOME']?.trim() || os.homedir()
  const xdgConfig = env['XDG_CONFIG_HOME']?.trim() || path.join(home, '.config')
  return [
    { dir: configDir, create: true },
    // opencode 가 기동 때 스스로 만드는 전역 설정 폴더다 — 우리가 먼저 만들어도 같다
    { dir: path.join(xdgConfig, 'opencode'), create: true },
    { dir: path.join(home, '.opencode'), create: false },
  ]
}

/** 없는 표식만 만든다 — 있는 것은 내용이 달라도 안 덮고, 폴더의 다른 파일은 안 본다. 잠금 파일은 package.json 이 플러그인만
 *  가질 때만 둔다(다른 의존성이 있으면 사용자 것이라 맞지 않는 잠금을 지어내지 않는다 — 그 폴더는 설치가 시도된다) */
export function plantInstallMarkers(dir: string): void {
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
  const pkgFile = path.join(dir, 'package.json')
  writeIfMissing(pkgFile, { dependencies: { [PLUGIN_PACKAGE]: PLUGIN_VERSION } })
  let deps: Record<string, string>
  try {
    deps = (JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as { dependencies?: Record<string, string> }).dependencies ?? {}
  } catch {
    return // 망가진 package.json — 사용자 것이다
  }
  if (Object.keys(deps).some((name) => name !== PLUGIN_PACKAGE)) return
  writeIfMissing(path.join(dir, 'package-lock.json'), {
    lockfileVersion: 3,
    packages: { '': { dependencies: { [PLUGIN_PACKAGE]: deps[PLUGIN_PACKAGE] ?? PLUGIN_VERSION } } },
  })
}

function writeIfMissing(file: string, value: unknown): void {
  try {
    fs.writeFileSync(file, JSON.stringify(value), { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/** 기동 전에 표식을 둔다. 못 쓰는 폴더는 넘어간다 — opencode 도 쓰기 불가 폴더엔 설치하지 않는다 */
function prepareInstallMarkers(configDir: string, env: NodeJS.ProcessEnv): void {
  for (const { dir, create } of installMarkerDirs(configDir, env)) {
    try {
      if (create) fs.mkdirSync(dir, { recursive: true })
      else if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue
      plantInstallMarkers(dir)
    } catch (error) {
      console.warn('[engine] 설치 표식을 못 뒀다', dir, (error as Error).message)
    }
  }
}

/** 자식에 물려주지 않는 env 이름 — 앱이 정한 OPENCODE_* 는 engineEnv 가 다시 넣는다 (01x 2-8 "망·외부 켜기"·"설정 주입") */
const INHERITED_ENGINE_ENV = /^(OPENCODE_|OTEL_|EXA_API_KEY$|PARALLEL_API_KEY$)/i

const LOOPBACK_NO_PROXY = ['127.0.0.1', 'localhost']

/** opencode 자식 프로세스 env — 진짜 키는 없다 (키 프록시) */
export function engineEnv(
  base: NodeJS.ProcessEnv,
  opts: { configDir: string; db: string; password: string; rgDir?: string; blockProjectConfig?: boolean },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    // 물려받은 opencode 설정 env 는 버린다 (01x 7, 이슈 #19) — OPENCODE_EXPERIMENTAL 하나로 레거시에 exa 검색·lsp 도구가 생기고, OTEL_* 는
    // trace 를 내보내고, OPENCODE_CONFIG_CONTENT 등은 앱 설정을 흔든다. 개발 셸에만 OPENCODE_DISABLE_* 가 있어 개발·테스트와 Finder 실행본이
    // 달랐다 — 앱이 아래에 정한 것만 남긴다. OPENCODE_SERVER_USERNAME 도 여기서 빠진다(Basic 사용자명은 기본값 opencode 로 고정)
    ...Object.fromEntries(Object.entries(base).filter(([name]) => !INHERITED_ENGINE_ENV.test(name))),
    OPENCODE_CONFIG_DIR: opts.configDir,
    OPENCODE_DB: opts.db,
    OPENCODE_SERVER_PASSWORD: opts.password,
    // models.opencode.ai 카탈로그 받기를 끈다 — 폐쇄망에서 나가는 시도 6번이 사라지고 카탈로그·턴은 그대로 된다 (01b_offline 실측 2/2)
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    // 아래 셋은 생성한 opencode.json 의 share·autoupdate·lsp 와 겹친다 — 설정이 덮이거나 무시돼도 꺼지게 (01x 2-8). LSP_DOWNLOAD 는
    // typescript 서버를 못 막는다(코드에 검사 없음) — 그래서 lsp:false 가 본체다
    OPENCODE_DISABLE_SHARE: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    // Claude Code 자료를 묻지 않고 싣지 않는다 (사용자 결정 2026-10-02: "Claude Code 스킬 함께 쓰기" 기본 꺼짐, 켜는 스위치는 #7).
    // 레거시는 ~/.claude/CLAUDE.md·~/.claude/skills·~/.agents/skills 와 프로젝트 CLAUDE.md·.claude/skills 를 싣는다 — 두 플래그로 다섯 다 빠진다.
    // 신규 세대는 원래 다섯 다 안 싣는다(프로젝트 AGENTS.md 만) — 그래서 지금 동작은 그대로다 (#19 실측 2026-10-02, 1.18.18 각 1)
    OPENCODE_DISABLE_CLAUDE_CODE: '1', // CLAUDE.md(전역·프로젝트) + .claude/skills
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', // .claude·.agents 스킬 탐색 전부 (설정의 skills.paths 는 그대로 읽힌다 — 코드상)
  }
  if (opts.blockProjectConfig) {
    // **레거시가** 프로젝트 opencode.json·.opencode/ 를 안 읽는다 (신규 세대 런타임은 이 플래그를 안 본다 — 프로젝트 설정을 읽고 그 플러그인 파일을
    // 실행한다. 먹는 스위치가 없어 ctx.llm 이 그런 폴더를 걸러 낸다: enginePlugins.ts, 01ah #101). 레거시는 그 안의 MCP 를 묻지 않고 띄우고 .opencode 에 npm 설치를 한다 (01w 3-1,
    // 사용자 결정 00_next_legacy 2). 대가로 프로젝트 AGENTS.md/CLAUDE.md 도 안 읽힌다 — 신규 세대 경로에서도 그렇다(trajectory.live 의
    // AGENTS.md 줄이 깨진다, 2026-10-02). 그래서 ctx.llm 이 AGENTS.md 를 prompt system 으로 넣는 L1 과 같이 켠다
    env['OPENCODE_DISABLE_PROJECT_CONFIG'] = '1'
  }
  // 프록시 변수(HTTP_PROXY·http_proxy)가 있으면 opencode 는 앱의 키 프록시·내장 MCP 서버(127.0.0.1)로 가는 요청도 그 프록시로 보낸다
  // (실측 2026-10-05, 1.18.18 — NO_PROXY·no_proxy 어느 쪽이든 루프백이 있으면 직접 간다, #75). 있던 값 뒤에 루프백을 덧붙인다.
  // Windows 는 이름의 대소문자가 다를 수 있다 — 있던 키를 지우고 둘로 다시 넣는다
  const noProxyKeys = Object.keys(env).filter((name) => name.toUpperCase() === 'NO_PROXY')
  const noProxy = noProxyKeys.flatMap((name) => (env[name] ?? '').split(',')).map((host) => host.trim())
  for (const name of noProxyKeys) delete env[name]
  env['NO_PROXY'] = env['no_proxy'] = [...new Set([...noProxy, ...LOOPBACK_NO_PROXY])].filter(Boolean).join(',')
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
  /** DB 정리는 한 번에 하나만 */
  private purging: Promise<void> = Promise.resolve()
  /** 떠 있는(띄우는 중인) 서버의 opencode.json 에 넣은 웹 도구 켜짐(설정 > 기능 web, 기본 꺼짐)·스킬 설정·게이트 (JSON — 바뀌었는지만 본다).
   *  **띄우는 중인 서버가 아직 설정을 읽기 전이면 없다** — 그 사이에 바뀐 값은 그 기동이 읽으므로 다시 띄울 일이 아니다. 지난 서버의 값과 비교하면
   *  앱 시작 때 뜨는 중에 도착한 게이트(ctx.hooks)가 "달라졌다" 로 보여 엔진이 두 번 떴다 (이슈 #126) */
  private launched?: string
  /** 도구 실행 전 판정을 받을 도구의 매처 (setGate) — 다음 기동이 읽는다 */
  private gateMatchers: readonly string[] = []

  constructor(
    ctx: Context,
    private opts: EngineOptions,
  ) {
    super(ctx, 'engine')
    reapStale(opts.pidFile)
    // 재시작이 실패해도 다음 대화가 다시 띄워 본다 — 다만 조용히 묻히지 않게 사유는 남긴다(키는 안 싣는다: 오류는 프로세스·포트 사유뿐)
    ctx.on('providers/changed', () => void this.restart().catch((error: unknown) => console.error('[engine] 설정 변경 후 재시작 실패', (error as Error).message)))
    // 웹 도구 켜기/끄기 (이슈 #14) — 설정은 재시작해야 먹는다. 떠 있는 서버와 값이 다르면 다시 띄운다(진행 중 턴은 중단됨).
    // 안 떠 있으면 다음 기동이 읽는다(launch). features 는 inject 하지 않는다 — 기능 레지스트리 없이 띄운 엔진(서비스 실물 테스트)은 꺼짐으로 돈다
    ctx.on('features/changed', () => {
      // 훅 기능(이슈 #102)을 끄면 도구 실행 전 게이트도 걷는다 — 판정할 쪽이 없는데 묻기만 하게 두지 않는다
      if (!this.outdated()) return
      void this.restart().catch((error: unknown) => console.error('[engine] 웹 도구·스킬·훅 변경 후 재시작 실패', (error as Error).message))
    })
    // 스킬 (이슈 #7) — 설정 > 기능의 스킬(위 features/changed)과 "Claude Code 스킬 함께 쓰기"(settings) 도 같은 길로 다시 띄운다
    ctx.on('settings/changed', () => {
      if (!this.outdated()) return
      void this.restart().catch((error: unknown) => console.error('[engine] 스킬 설정 변경 후 재시작 실패', (error as Error).message))
    })
    ctx.effect(() => () => this.stop())
  }

  /** 지금 설정의 스킬 — 기능 레지스트리·설정 없이 띄운 엔진(서비스 실물 테스트)은 켬·Claude 꺼짐 */
  private skills(): EngineSkills {
    return { enabled: this.ctx.get('features')?.isEnabled('skills') ?? true, claude: this.ctx.get('settings')?.get().claudeSkills ?? false }
  }

  /** 앱 CONFIG_DIR — ctx.llm 이 엔진이 실행할 플러그인 파일을 찾을 때 이 폴더도 본다 (enginePlugins.ts, #101) */
  get configDir(): string {
    return this.opts.configDir
  }

  /** 도구 실행 전 판정을 받을 도구를 정한다 (이슈 #102 — toolGate). 매처는 도구 이름의 `|` 나열·정규식, 빈 글자는 전부. 떠 있는 서버의 게이트와
   *  **실제로 달라졌을 때만** 다시 띄운다(진행 중 턴은 끊긴다 — 부르는 쪽 ctx.llm 이 도는 턴이 없을 때 부른다). 안 떠 있으면 다음 기동이 읽는다 */
  setGate(matchers: readonly string[]): void {
    this.gateMatchers = [...matchers]
    if (!this.outdated()) return
    void this.restart().catch((error: unknown) => console.error('[engine] 도구 실행 전 게이트 변경 후 재시작 실패', (error as Error).message))
  }

  /** 지금 걸 게이트 — 훅 기능이 꺼져 있으면 없다 (기능 레지스트리 없이 띄운 엔진은 받은 매처 그대로) */
  private gate(): EngineGate {
    return toolGate(this.ctx.get('features')?.isEnabled('hooks') === false ? [] : this.gateMatchers)
  }

  /** 지금 설정으로 띄우면 opencode.json 에 들어갈 웹 도구·스킬·게이트 */
  private wanted(): { webTools: boolean; skills: EngineSkills; gate: EngineGate } {
    return { webTools: this.ctx.get('features')?.isEnabled('web') ?? false, skills: this.skills(), gate: this.gate() }
  }

  /** 떠 있는(띄우는 중인) 서버가 읽은 설정이 지금 설정과 다른가 — 다시 띄워야 한다. 안 떠 있거나 아직 읽기 전이면 아니다 (다음·그 기동이 읽는다) */
  private outdated(): boolean {
    return !!this.current && this.launched !== undefined && JSON.stringify(this.wanted()) !== this.launched
  }

  /** 떠 있나(띄우는 중 포함) — 묻기만 하고 띄우지 않는다. 엔진과 같이 사라지는 것(붙인 MCP)을 치우려고 죽은 엔진을 다시 띄우지 않게 (#126) */
  get up(): boolean {
    return !!this.current
  }

  /** 떠 있는 서버의 연결. 없거나 죽었으면 띄운다 (동시에 불러도 한 번만) */
  connection(): Promise<EngineConnection> {
    if (this.disposed) return Promise.reject(new Error(tr('error.appQuitting')))
    if (!this.current) {
      this.launched = undefined
      // 물러난 기동(restart 로 밀려난 것)이 뒤늦게 읽은 값은 적지 않는다 — 지금 띄우는 서버의 값이 아니다
      const launching: Promise<RunningServer> = this.stopping.then(() =>
        this.launch(
          () => this.forget(launching),
          (read) => void (this.current === launching && (this.launched = read)),
        ),
      )
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

  /** 지운 대화 본문을 DB 파일에서 걷어낸다 (위 PURGE_SCRIPT). 실패·busy 면 로그만 남기고 다음 기회로 — 대화 기능을 막지 않는다.
   *  띄우기 직전에도 스스로 부른다(크래시로 놓친 정리까지). 떠 있을 때는 답을 기다리는 턴이 없을 때만 부를 것 (ctx.llm.purgeDeleted) */
  purgeDeleted(): Promise<void> {
    const base = this.opts.env ?? process.env
    const bin = findOpencodeBinary(base, undefined, this.opts.bundled?.opencode).path
    if (!bin) return Promise.resolve()
    this.purging = this.purging.then(() => purgeDb(bin, this.opts.db, base))
    return this.purging
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

  private loginPath?: Promise<string | undefined>

  /** 자식 env 의 바탕 — Finder 로 띄운 앱의 짧은 PATH 에 로그인 셸의 PATH 를 합친다 (#84). 한 번만 읽고, 못 읽으면 물려받은 PATH 그대로 */
  private async baseEnv(): Promise<NodeJS.ProcessEnv> {
    const base = this.opts.env ?? process.env
    if (!this.opts.loginPath) return base
    const login = await (this.loginPath ??= this.opts.loginPath().catch(() => undefined))
    if (!login) return base
    const key = Object.keys(base).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
    return { ...base, [key]: mergePath(login, base[key]) }
  }

  private async launch(onExit: () => void, onRead: (config: string) => void): Promise<RunningServer> {
    const base = await this.baseEnv()
    const lookup = findOpencodeBinary(base, undefined, this.opts.bundled?.opencode)
    if (!lookup.path) throw new Error(notFoundMessage(lookup))
    const bin = lookup.path

    // 저장된 설정을 요청마다 본다 — 키는 이 메인 프로세스에서만 풀린다
    this.proxy ??= startKeyProxy((id) => {
      const provider = this.ctx.providers.get(id)
      return provider && { baseURL: provider.baseURL, apiKey: this.ctx.providers.apiKey(id) }
    })
    const proxy = await this.proxy
    await this.purgeDeleted() // 다른 연결이 없을 때 — 지난 실행이 정리 전에 끝났어도 여기서 걷힌다
    const password = randomBytes(24).toString('base64url')
    const port = await freePort()
    const env = engineEnv(base, {
      configDir: this.opts.configDir,
      db: this.opts.db,
      password,
      rgDir: this.opts.bundled?.rgDir,
      blockProjectConfig: this.opts.blockProjectConfig,
    })

    fs.mkdirSync(this.opts.configDir, { recursive: true })
    removeAppPluginDirs(this.opts.configDir) // 여기 놓인 파일은 모든 프로젝트에서 엔진 안에 실린다 (#101, enginePlugins.ts)
    const wanted = this.wanted()
    const { gate } = wanted
    onRead(JSON.stringify(wanted)) // 읽자마자 적는다 (사이에 await 없음) — 이 뒤에 바뀐 값은 다시 띄워야 먹는다
    const config = withBrowserRules(engineConfig(this.ctx.providers.all(), proxy, { childEnv: env, ...wanted }), gate.mcp)
    fs.writeFileSync(path.join(this.opts.configDir, 'opencode.json'), JSON.stringify(config, null, 2))
    prepareInstallMarkers(this.opts.configDir, env)

    const args = ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--pure']
    const child = spawn(bin, args, {
      cwd: path.dirname(this.opts.configDir),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    liveChildren.add(child)
    // 끝 MAX_OUTPUT 자를 쥔다 — 기동 실패 사유는 출력의 끝에 있다 (앞만 쥐면 시작 로그에 밀려 잘린다, 참고 레포 검토 02x D).
    // 읽는 곳은 아래 기동 실패 문구 하나뿐이다. 조각 경계의 한글이 깨지지 않게 스트림마다 디코더
    const output = keepTail(MAX_OUTPUT)
    for (const stream of [child.stdout, child.stderr]) {
      const decoded = streamText()
      stream?.on('data', (part: Buffer) => output.push(decoded.push(part)))
    }
    const closer = new AbortController()
    const exited = new Promise<void>((resolve) =>
      child.once('exit', (code, signal) => {
        liveChildren.delete(child)
        closer.abort(new Error(tr('error.opencodeExited', { code: String(code), signal: String(signal) })))
        forgetRecord(this.opts.pidFile, child.pid)
        onExit()
        resolve()
      }),
    )
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', (error) => {
        liveChildren.delete(child) // 못 띄웠다 — exit 은 오지 않는다
        reject(new Error(tr('error.opencodeSpawn', { bin, message: error.message })))
      })
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
      throw new Error(`${(error as Error).message}\n${output.text().trim()}`.trimEnd())
    }
    const hidden = hiddenEnvNames(env)
    return { url, headers, closed: closer.signal, providerBaseURL: (id) => proxy.baseURLFor(id), mcpConfig: (def) => engineMcpConfig(def, hidden), gated: (permission) => isGated(gate, permission), pid: child.pid!, stop }
  }
}

async function purgeDb(bin: string, db: string, base: NodeJS.ProcessEnv): Promise<void> {
  if (!fs.existsSync(db)) return // 열면 빈 DB 를 만든다
  try {
    const stdout = await new Promise<string>((resolve, reject) =>
      execFile(bin, ['-e', PURGE_SCRIPT], { env: { ...base, BUN_BE_BUN: '1', LITECODE_PURGE_DB: db }, timeout: PURGE_TIMEOUT_MS, windowsHide: true }, (error, out) =>
        error ? reject(error) : resolve(out),
      ),
    )
    if ((JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as { busy?: number }).busy) console.warn('[engine] DB 정리: 잠겨 있어 일부 못 했다 — 다음 기회에')
  } catch (error) {
    console.error('[engine] DB 정리 실패 — 다음 기회에', (error as Error).message)
  }
}

async function waitUntilReady(url: string, headers: Record<string, string>, closed: AbortSignal): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let last = ''
  while (Date.now() < deadline) {
    if (closed.aborted) throw new Error(tr('error.opencodeExitedEarly', { message: (closed.reason as Error).message }))
    try {
      const res = await fetch(`${url}/doc`, { headers, signal: AbortSignal.timeout(2_000) })
      if (res.ok) return
      last = `HTTP ${res.status}`
    } catch (error) {
      last = String((error as Error).cause ?? error) // 아직 안 떴다
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(tr('error.opencodeNotReady', { seconds: READY_TIMEOUT_MS / 1000, last }))
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
  if (typeof record?.pid === 'number' && typeof record.command === 'string' && isOurServer(record, observe(record.pid))) {
    try {
      process.kill(record.pid, 'SIGTERM')
    } catch {
      // 그 사이 끝났다
    }
  }
  fs.rmSync(file, { force: true })
}
