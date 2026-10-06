// 브라우저 기능 (이슈 #147) — AI 가 Chrome 창을 조종한다. 동봉한 Playwright MCP(@playwright/mcp 0.0.83)를 내장 MCP 서버로 붙인다 (ctx.browser).
// 여기는 메인(엔진 권한 규칙·모드 판정)과 화면이 같이 아는 것만: 서버 이름과 도구 갈래. 실측 _workspace/01aj_playwright_mcp.md §4.
// 도구 이름은 그 버전의 `tools/list` 그대로다(기본 25개) — 0.0.x 라 버전마다 바뀐다. 버전을 올리면 목록을 다시 대조한다 (단위 테스트가 25개를 센다).

/** 내장 MCP 서버 이름 — 모델이 보는 도구는 `chrome_browser_click` … (`browser` 로 하면 `browser_browser_click` 이 된다). ctx.mcp 가 예약한다 */
export const BROWSER_MCP_NAME = 'chrome'

/** 읽기 — 묻지 않는다. 계획 모드에서도 쓴다 */
export const BROWSER_READ_TOOLS = [
  'browser_snapshot',
  'browser_find',
  'browser_console_messages',
  'browser_network_requests',
  'browser_network_request',
  'browser_take_screenshot',
  'browser_wait_for',
] as const

/** 페이지 밖으로 나가는 것이 없는 조작 (창 크기·미디어 흉내·페이지 닫기) — 기본·전체 권한에서 묻지 않는다 */
export const BROWSER_QUIET_TOOLS = ['browser_resize', 'browser_emulate_media', 'browser_close'] as const

/** 페이지를 바꾸거나 밖으로 내보낼 수 있는 것 — **전체 권한에서도 묻는다**: 페이지 내용은 그대로 모델에 들어가고(프롬프트 주입) 주소·입력·스크립트는
 *  프로젝트 내용을 임의 주소로 실어 보낼 수 있는데, 승인 요청의 patterns 가 `["*"]` 뿐이라 주소별 규칙을 못 건다 (다른 프로젝트에 보내기 도구와 같은 모양) */
export const BROWSER_ASK_TOOLS = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_tabs',
  'browser_click',
  'browser_hover',
  'browser_drag',
  'browser_press_key',
  'browser_type',
  'browser_fill_form',
  'browser_select_option',
  'browser_handle_dialog',
  'browser_evaluate',
] as const

/** 늘 막는다 — run_code_unsafe 는 MCP 프로세스(사용자 권한의 node)에서 도는 임의 코드라 bash 승인을 우회하고, file_upload·drop 은 로컬 파일을 사이트로 올린다 */
export const BROWSER_DENIED_TOOLS = ['browser_run_code_unsafe', 'browser_file_upload', 'browser_drop'] as const

export type BrowserToolKind = 'read' | 'quiet' | 'ask' | 'deny'

/** 권한 이름(`<서버>_<도구>`)이 브라우저 도구면 그 갈래 — **목록에 없는 `chrome_*` 는 ask** (새 도구가 생겨도 allow 가 기본이 되지 않게). 브라우저 도구가 아니면 undefined */
export function browserToolKind(permission: string): BrowserToolKind | undefined {
  if (!permission.startsWith(`${BROWSER_MCP_NAME}_`)) return undefined
  const tool = permission.slice(BROWSER_MCP_NAME.length + 1)
  const within = (tools: readonly string[]): boolean => tools.includes(tool)
  return within(BROWSER_DENIED_TOOLS) ? 'deny' : within(BROWSER_READ_TOOLS) ? 'read' : within(BROWSER_QUIET_TOOLS) ? 'quiet' : 'ask'
}

/** 승인 카드에 보일 인자 한 줄 — 가는 주소(navigate·tabs), 넣을 글(type), 실행할 코드(evaluate), 누를 키, 그 밖엔 대상 설명. input 은 승인 요청의 인자 JSON */
export function browserApprovalDetail(tool: string, input: string | undefined): string | undefined {
  if (!tool.startsWith('browser_') || input === undefined) return undefined
  try {
    const args = JSON.parse(input) as Record<string, unknown>
    return ['url', 'text', 'function', 'key', 'element'].map((name) => args?.[name]).find((value): value is string => typeof value === 'string' && value !== '')
  } catch {
    return undefined
  }
}
