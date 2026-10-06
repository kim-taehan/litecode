import type { Language } from './i18n/index.ts'

// MCP 서버 안에서 도구를 골라 끄기 (이슈 #164) — 메인(ctx.mcp)과 화면(McpPopup)이 같이 쓰는 순수 함수.
// 선택은 프로젝트별·서버별로 앱 안(mcp-projects.json)에 둔다. 프로젝트 폴더의 `.mcp.json` 은 고치지 않는다.
// 모양 `{ off?, only? }`:
// - only 가 있으면 그 목록만 켠다 — 서버가 나중에 더한 도구는 **꺼진 채로** 들어온다 ([전부 끄기] 뒤에 하나씩 켠 서버)
// - 없으면 off 목록만 끈다 — 새 도구는 켜진 채로 들어온다
// - 선택이 없으면(undefined) 전부 켜짐
// 토큰 어림: 서버가 준 도구 정의(이름·설명·입력 스키마)를 JSON 으로 이은 글자 수 ÷ 3.5 — 정확하지 않아 화면은 "약" 으로 말한다.

export interface McpToolSelection {
  off?: string[]
  only?: string[]
}

/** [전부 끄기] — 이후 체크하는 도구가 only 에 더해진다 */
export const ALL_TOOLS_OFF: McpToolSelection = { only: [] }

/** 머리 띠가 주황이 되는 선 — 도구 수 또는 토큰 어림이 이것을 넘으면 */
export const TOOL_BUDGET_MAX_TOOLS = 64
export const TOOL_BUDGET_MAX_TOKENS = 5_000

/** 글자 수 ÷ 이 값 = 토큰 어림 */
const CHARS_PER_TOKEN = 3.5

/** 그 도구가 켜져 있나 */
export function toolOn(selection: McpToolSelection | undefined, name: string): boolean {
  if (!selection) return true
  if (selection.only) return selection.only.includes(name)
  return !(selection.off ?? []).includes(name)
}

/** 체크 하나를 바꾼 선택 — only 모드면 only 에, 아니면 off 에 더하거나 뺀다. 끈 것이 하나도 없으면 undefined(전부 켜짐) */
export function withTool(selection: McpToolSelection | undefined, name: string, on: boolean): McpToolSelection | undefined {
  if (selection?.only) {
    const only = selection.only.filter((entry) => entry !== name)
    return { only: on ? [...only, name] : only }
  }
  const off = (selection?.off ?? []).filter((entry) => entry !== name)
  const next = on ? off : [...off, name]
  return next.length > 0 ? { off: next } : undefined
}

/** 서버의 도구 이름 중 꺼진 것 — 모델에 안 보일 도구 */
export function hiddenTools(selection: McpToolSelection | undefined, names: readonly string[]): string[] {
  return names.filter((name) => !toolOn(selection, name))
}

/** 파일에서 읽은 값 → 선택 (모양이 다르면 undefined — 전부 켜짐) */
export function toolSelectionOf(value: unknown): McpToolSelection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const strings = (list: unknown): string[] | undefined => (Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : undefined)
  const { off, only } = value as { off?: unknown; only?: unknown }
  if (strings(only)) return { only: strings(only)! }
  const offList = strings(off)
  return offList && offList.length > 0 ? { off: offList } : undefined
}

/** 도구 정의 하나의 토큰 어림 (서버가 준 그대로 — name·description·inputSchema) */
export function estimateToolTokens(tool: { name: string; description?: unknown; inputSchema?: unknown }): number {
  return Math.ceil(JSON.stringify(tool).length / CHARS_PER_TOKEN)
}

interface BudgetTool {
  name: string
  tokens?: number
}

interface BudgetServer {
  enabled: boolean
  status?: string
  shadowed?: boolean
  tools?: readonly BudgetTool[]
  toolSelection?: McpToolSelection
}

/** 서버 하나가 모델에 싣는 것 — 켠 도구 수·토큰 어림. 도구 목록이 없으면(연결 전) undefined */
export function serverCost(server: Pick<BudgetServer, 'tools' | 'toolSelection'>): { count: number; tokens: number; total: number } | undefined {
  if (!server.tools) return undefined
  const on = server.tools.filter((tool) => toolOn(server.toolSelection, tool.name))
  return { count: on.length, total: server.tools.length, tokens: on.reduce((sum, tool) => sum + (tool.tokens ?? 0), 0) }
}

/** 목록 머리 띠 — AI 에게 가는 도구 합계. 연결된(켜짐·가려지지 않음) 서버의 켠 도구만 센다. heavy 면 주황 띠 */
export function toolBudget(servers: readonly BudgetServer[]): { count: number; tokens: number; heavy: boolean } {
  let count = 0
  let tokens = 0
  for (const server of servers) {
    if (!server.enabled || server.shadowed || server.status !== 'connected') continue
    const cost = serverCost(server)
    if (!cost) continue
    count += cost.count
    tokens += cost.tokens
  }
  return { count, tokens, heavy: count > TOOL_BUDGET_MAX_TOOLS || tokens > TOOL_BUDGET_MAX_TOKENS }
}

/** 도구 검색 — 이름·설명에 글이 든 것 (대소문자 무시). 빈 글이면 전부 */
export function filterTools<T extends { name: string; description?: string }>(tools: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...tools]
  return tools.filter((tool) => tool.name.toLowerCase().includes(needle) || (tool.description ?? '').toLowerCase().includes(needle))
}

/** 토큰 어림을 짧게 — ko: 190 · 2.4천 · 3만, en: 190 · 2.4k · 30k. 1000 아래는 10 단위로 */
export function shortTokens(tokens: number, language: Language): string {
  if (tokens < 1_000) return String(Math.max(10, Math.round(tokens / 10) * 10))
  const short = (value: number) => String(Math.round(value * 10) / 10)
  if (language === 'ko') return tokens < 10_000 ? `${short(tokens / 1_000)}천` : `${short(tokens / 10_000)}만`
  return `${short(tokens / 1_000)}k`
}
