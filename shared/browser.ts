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
  'browser_take_screenshot',
  'browser_wait_for',
] as const

/** 페이지 밖으로 나가는 것이 없는 조작 (창 크기·미디어 흉내·페이지 닫기·이미 열린 페이지 안의 클릭·키·선택) — 기본·전체 권한에서 묻지 않는다 */
export const BROWSER_QUIET_TOOLS = [
  'browser_resize',
  'browser_emulate_media',
  'browser_close',
  // 이미 열린 페이지 안의 조작 — 프로젝트 내용을 새 주소로 실어 보낼 수 없다(주소·입력·스크립트는 아래 ASK). 사용자 요청(2026-10-06 "승인을 계속 요청하네"):
  // 기본·전체 권한에서 묻지 않는다. 로그인해 둔 사이트에서 누르면 그 사이트의 일이 일어난다는 점은 남는다 — 매번 묻기 모드는 전부 묻는다
  'browser_click',
  'browser_hover',
  'browser_drag',
  'browser_press_key',
  'browser_select_option',
  'browser_handle_dialog',
  'browser_navigate_back',
] as const

/** 페이지를 바꾸거나 밖으로 내보낼 수 있는 것 — **전체 권한에서도 묻는다**: 페이지 내용은 그대로 모델에 들어가고(프롬프트 주입) 주소·입력·스크립트는
 *  프로젝트 내용을 임의 주소로 실어 보낼 수 있는데, 승인 요청의 patterns 가 `["*"]` 뿐이라 주소별 규칙을 못 건다 (다른 프로젝트에 보내기 도구와 같은 모양) */
export const BROWSER_ASK_TOOLS = [
  'browser_navigate',
  'browser_tabs',
  'browser_type',
  'browser_fill_form',
  'browser_evaluate',
  // 요청·응답의 헤더와 본문이 모델에 들어간다 — 전용 프로필에 로그인해 두고 쓰므로(쿠키·토큰이 실린다) 읽기지만 묻는다
  'browser_network_requests',
  'browser_network_request',
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

/** 승인 카드의 제목이 되는 동작 — 화면 문구는 `browser.card.<action>` */
export type BrowserAction = 'navigate' | 'back' | 'tabs' | 'type' | 'fill' | 'click' | 'hover' | 'drag' | 'select' | 'key' | 'evaluate' | 'network'

/** 승인 카드에 보일 것 — 무엇을(action) 어디에(target) 무엇으로(text). 값은 줄이지 않는다 (주소·넣을 글을 가리면 승인의 뜻이 없다) */
export interface BrowserApprovalDetail {
  /** 없으면 우리가 모르는 도구다 — 제목 없이 인자만 보인다 */
  action?: BrowserAction
  /** 넣는 칸·고르는 목록·스크립트를 돌릴 요소 (모델이 적은 설명) */
  target?: string
  /** 열 주소 · 넣을 글 · 대상 설명 · 키 · 스크립트. 도구가 기대한 인자가 없거나 모르는 도구면 인자 JSON 전체 */
  text?: string
  /** text 가 코드다 (여러 줄 — 화면이 높이를 묶고 스크롤한다) */
  code?: true
}

const filled = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)
const joined = (parts: (string | undefined)[], separator: string): string | undefined => parts.filter((part) => part !== undefined).join(separator) || undefined

/** 도구별로 보일 것 — 인자 이름은 playwright-core 의 도구 정의 그대로다 (버전을 올리면 다시 댄다). 모르는 도구는 undefined */
function browserAction(tool: string, args: Record<string, unknown>): BrowserApprovalDetail | undefined {
  switch (tool) {
    case 'browser_navigate':
      return { action: 'navigate', text: filled(args['url']) }
    case 'browser_navigate_back':
      return { action: 'back' }
    case 'browser_tabs':
      return { action: 'tabs', text: joined([joined([filled(args['action']), typeof args['index'] === 'number' ? String(args['index']) : undefined], ' '), filled(args['url'])], '\n') }
    case 'browser_type':
      return { action: 'type', target: filled(args['element']), text: filled(args['text']) }
    case 'browser_fill_form': {
      const fields = Array.isArray(args['fields']) ? (args['fields'] as Record<string, unknown>[]) : []
      const rows = fields.map((field) => (typeof field?.['name'] === 'string' && typeof field['value'] === 'string' ? `${field['name']}: ${field['value']}` : undefined))
      return { action: 'fill', text: rows.length > 0 && rows.every((row) => row !== undefined) ? rows.join('\n') : undefined }
    }
    case 'browser_click':
      return { action: 'click', text: filled(args['element']) }
    case 'browser_hover':
      return { action: 'hover', text: filled(args['element']) }
    case 'browser_drag': {
      const from = filled(args['startElement'])
      const to = filled(args['endElement'])
      return { action: 'drag', text: from && to ? `${from} → ${to}` : undefined }
    }
    case 'browser_select_option': {
      const values = Array.isArray(args['values']) ? args['values'].join(', ') : ''
      return { action: 'select', target: filled(args['element']), text: filled(values) }
    }
    case 'browser_press_key':
      return { action: 'key', text: filled(args['key']) }
    case 'browser_evaluate':
      return { action: 'evaluate', target: filled(args['element']), text: filled(args['function']), code: true }
    case 'browser_network_requests':
    case 'browser_network_request':
      return { action: 'network' }
    default:
      return undefined
  }
}

/** 승인 카드에 보일 것 — 여는 주소(navigate·tabs), 넣을 글(type·fill_form), 대상 설명(click·hover·drag·select_option), 실행할 스크립트(evaluate), 누를 키.
 *  **숨기지 않는다**: 모르는 `browser_*` 도구·기대한 인자가 없는 호출은 인자 전체를 JSON 으로 보인다. input 은 승인 요청의 인자 JSON (없으면 보일 것이 없다) */
export function browserApprovalDetail(tool: string, input: string | undefined): BrowserApprovalDetail | undefined {
  if (!tool.startsWith('browser_') || input === undefined) return undefined
  let args: unknown
  try {
    args = JSON.parse(input)
  } catch {
    return { text: input }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { text: input }
  const known = browserAction(tool, args as Record<string, unknown>)
  // 기대한 인자를 못 찾았으면 스크립트로 꾸미지 않는다 — 인자 전체(JSON)다
  const text = known?.text ?? (Object.keys(args).length > 0 ? JSON.stringify(args, null, 2) : undefined)
  return {
    ...(known && { action: known.action }),
    ...(known?.target && { target: known.target }),
    ...(text !== undefined && { text }),
    ...(known?.code && known.text !== undefined && { code: true as const }),
  }
}
