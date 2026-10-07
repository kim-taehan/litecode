import type { KeyProxy } from './keyProxy.ts'
import type { ProviderConfig } from './providers.ts'
import type { Mode } from '../../shared/modes.ts'
import { matchesTool, UNGATED_TOOLS } from '../../shared/hooks.ts'
import { BROWSER_DENIED_TOOLS, BROWSER_MCP_NAME, BROWSER_QUIET_TOOLS, BROWSER_READ_TOOLS } from '../../shared/browser.ts'
import { engineLimit } from '../../shared/outputLimit.ts'
import { PROJECT_SKILLS_DIR } from '../../shared/skills.ts'

// ctx.engine 이 생성하는 opencode.json 의 규칙 표와 순수 생성 함수 (이슈 #183 에서 engine.ts 에서 옮겼다 — 본문은 그대로).
// 프로세스 수명·키 프록시·재시작·자식 env 는 engine.ts 에 있다. 바깥은 지금도 engine.ts 의 재내보내기로 이 이름들을 받는다

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
const PROJECT_SKILL_PATHS = [PROJECT_SKILLS_DIR, '.opencode/skill']
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
