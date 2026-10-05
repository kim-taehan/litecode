// 대화 모드 — 입력창 칩 하나 (사용자 결정 2026-10-02, _workspace/00_next_modes.md). 메인(검증·엔진)과 화면(칩·설정)이 같이 쓴다.
// 엔진 쪽 뜻(opencode 에이전트·권한)은 ctx.engine 만 안다 (engine.ts MODE_AGENT) — 화면은 이 이름만 안다.
// plan: 읽기·검색만 / build: opencode 기본(편집·명령 허용, 폴더 밖·.env 는 묻는다) / ask: 편집·명령·웹마다 묻는다 / full: 다 묻지 않는다

export const MODES = ['plan', 'build', 'ask', 'full'] as const
export type Mode = (typeof MODES)[number]

export const DEFAULT_MODE: Mode = 'build'

/** Shift+Tab 이 도는 모드 — 전체 권한은 확인 대화상자를 거쳐 메뉴로만 고른다 */
export const CYCLE_MODES: readonly Mode[] = ['plan', 'build', 'ask']

export function isMode(value: unknown): value is Mode {
  return (MODES as readonly unknown[]).includes(value)
}

/** 그 모드가 권한 하나를 어떻게 다루나 — **도구 실행 전 게이트(훅)를 얹기 전의** 규칙 (이슈 #102 2단계, 01af §6-1 의 3).
 *  엔진 설정(engine.ts 의 에이전트 권한)과 같은 표를 중립 이름으로 적은 것이다 — 게이트 때문에 온 승인 요청과 모드가 원래 묻는 요청을 가른다:
 *  훅이 통과시킨 요청이 allow 면 묻지 않고 실행하고, ask 면 승인 카드를 그대로 띄운다. **모르면 ask** (카드를 띄우는 쪽이 안전하다).
 *  permission 은 권한 이름(bash·edit·read·task…, MCP 도구는 `<서버>_<도구>`), resources 는 요청의 대상(명령·경로·하위 에이전트 이름),
 *  child 는 하위 작업(자식 세션)의 요청 — 하위 작업은 부모 모드의 권한을 물려받지 않는다 (매번 묻기의 하위 작업만 묻는다) */
export type ModeRule = 'allow' | 'ask' | 'deny'

/** 묻지 않고 실행해도 되는 것으로 아는 내장 권한 — 여기 없는 이름은 ask 다 */
const PLAIN_PERMISSIONS = ['bash', 'edit', 'read', 'glob', 'grep', 'task', 'webfetch', 'websearch', 'skill', 'todowrite']
/** 계획이 막고 매번 묻기가 묻는 것 */
const GUARDED_PERMISSIONS = ['edit', 'bash', 'webfetch', 'websearch']
/** 매번 묻기에서만 쓰는 하위 에이전트 (engine.ts SUBAGENT_ASK) */
const ASKING_SUBAGENT = 'general-ask'
const APP_SEND_TOOLS = ['litecode_send_to_session', 'litecode_start_session']
const APP_READ_TOOLS = ['litecode_list_sessions', 'litecode_read_session']

/** `.env` 파일 읽기 — 엔진 기본이 묻는다 (`.env.example` 은 아니다) */
function readsEnvFile(resources: readonly string[]): boolean {
  return resources.some((resource) => /\.env(\.|$)/.test(resource) && !resource.endsWith('.env.example'))
}

export function modePermission(mode: Mode, permission: string, opts: { resources?: readonly string[]; child?: boolean } = {}): ModeRule {
  const resources = opts.resources ?? []
  const child = opts.child === true
  /** 묻는 쪽 — 매번 묻기와 그 하위 작업 */
  const asking = mode === 'ask'
  /** 전체 권한의 메인 대화만 폴더 밖·.env 도 묻지 않는다 (하위 작업은 엔진 기본 에이전트다) */
  const unguarded = mode === 'full' && !child
  if (permission === 'external_directory' || permission === 'doom_loop') return unguarded ? 'allow' : 'ask'
  if (permission === 'plan_enter' || permission === 'plan_exit') return 'ask' // 앱이 쓰지 않는 엔진 도구 — 모르는 것으로
  if (permission.includes('_')) {
    // MCP 도구 (`<서버>_<도구>`)
    if (APP_SEND_TOOLS.includes(permission)) return child || mode === 'plan' ? 'deny' : 'ask'
    if (permission === 'litecode_present') return child ? 'deny' : 'allow'
    if (child) return asking ? 'ask' : 'allow'
    if (APP_READ_TOOLS.includes(permission) || permission === 'litecode_open_file') return 'allow'
    if (permission === 'litecode_open_terminal') return mode === 'plan' ? 'deny' : 'allow'
    return mode === 'plan' ? 'deny' : asking ? 'ask' : 'allow'
  }
  if (!PLAIN_PERMISSIONS.includes(permission)) return 'ask'
  if (permission === 'task') {
    if (child || mode === 'plan') return 'deny'
    const subagents = resources.length > 0 ? resources : ['']
    return subagents.every((name) => (name === ASKING_SUBAGENT) === asking) ? 'allow' : 'deny'
  }
  if (GUARDED_PERMISSIONS.includes(permission)) {
    if (mode === 'plan') return 'deny'
    if (asking) return 'ask'
  }
  if (permission === 'read' && readsEnvFile(resources) && !unguarded) return 'ask'
  return 'allow'
}
