// 브라우저 기능 (이슈 #147) — AI 가 Chrome 창을 조종한다. 동봉한 Playwright MCP(@playwright/mcp 0.0.83)를 내장 MCP 서버로 붙인다 (ctx.browser).
// 여기는 메인(엔진 권한 규칙·모드 판정)과 화면이 같이 아는 것만: 서버 이름과 도구 갈래. 실측 _workspace/01aj_playwright_mcp.md §4.
// 도구 이름은 그 버전의 `tools/list` 그대로다(기본 25개) — 0.0.x 라 버전마다 바뀐다. 버전을 올리면 목록을 다시 대조한다 (단위 테스트가 25개를 센다).

/** 내장 MCP 서버 이름 — 모델이 보는 도구는 `chrome_browser_click` … (`browser` 로 하면 `browser_browser_click` 이 된다). ctx.mcp 가 예약한다 */
export const BROWSER_MCP_NAME = 'chrome'

/** 읽기 — 묻지 않는다. 계획 모드에서도 쓴다 */
export const BROWSER_READ_TOOLS = ['browser_snapshot', 'browser_console_messages', 'browser_take_screenshot', 'browser_wait_for'] as const

/** 기본·전체 권한에서 묻지 않는 조작. 처음엔 이미 열린 페이지 안의 조작(클릭·키·선택)만 묻지 않았고 주소 열기·탭·글 입력·폼·스크립트는 전체 권한에서도
 *  물었다(프롬프트 주입으로 프로젝트 내용이 임의 주소로 나갈 수 있어서). 사용자 요청(2026-10-06 "기본·전체 권한으로 변경해줘 너무 자주 물어보잖아")으로 이 다섯도
 *  묻지 않는다 — 남는 위험: 읽은 페이지의 글에 속아 프로젝트 내용을 다른 주소로 열거나 입력할 수 있다. **매번 묻기 모드는 전부 묻는다** — 민감한 일은 그 모드로 */
export const BROWSER_QUIET_TOOLS = [
  'browser_click',
  'browser_press_key',
  'browser_select_option',
  'browser_navigate',
  'browser_tabs',
  'browser_type',
  'browser_fill_form',
  'browser_evaluate',
] as const

/** 늘 묻는 것 — 지금은 없다(목록에 없는 새 `chrome_*` 도구는 browserToolKind 가 ask 로 둔다) */
export const BROWSER_ASK_TOOLS = [] as const

/** 모델 도구 목록에서 뺀다 (deny 한 도구는 LLM 에 실리지 않는다 — 실측). 두 가지 이유:
 *  ① 위험 — run_code_unsafe 는 MCP 프로세스(사용자 권한의 node)에서 도는 임의 코드라 bash 승인을 우회하고, file_upload·drop 은 로컬 파일을 사이트로 올린다.
 *  ② 개수 — 도구가 많으면 요청마다 입력이 커지고 작은 모델이 고르기 어렵다(사용자 2026-10-06 "도구가 너무 많다"). 쓸 일이 드문 것(찾기·창 크기·미디어 흉내·
 *  끌기·올리기·대화상자·뒤로 가기·페이지 닫기·네트워크 내용)을 뺀 12개만 남긴다. 필요해지면 이 목록에서 옮긴다 */
export const BROWSER_DENIED_TOOLS = [
  'browser_run_code_unsafe',
  'browser_file_upload',
  'browser_drop',
  'browser_find',
  'browser_resize',
  'browser_emulate_media',
  'browser_close',
  'browser_hover',
  'browser_drag',
  'browser_handle_dialog',
  'browser_navigate_back',
  'browser_network_requests',
  'browser_network_request',
] as const

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
