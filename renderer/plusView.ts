// 입력창 `+` 메뉴와 스킬·MCP 팝업(이슈 #43)의 화면용 순수 함수. 묶음(scope)은 메인(ctx.mcp·ctx.skills)이 정하고 화면은 가르기만 한다

export type PlusScope = 'project' | 'all'

/** 팝업의 두 묶음 — "이 프로젝트만" / "모든 프로젝트". 순서는 받은 그대로 */
export function byScope<T extends { scope: PlusScope }>(items: readonly T[]): Record<PlusScope, T[]> {
  return { project: items.filter((item) => item.scope === 'project'), all: items.filter((item) => item.scope === 'all') }
}

interface McpRow {
  enabled: boolean
  status?: string
  shadowed?: boolean
}

/** 서버 줄의 상태 — 가려진 것(이름이 겹쳐 안 붙임) > 이 프로젝트에서 끈 것 > opencode 상태. 프로젝트가 없어 상태를 모르면 undefined */
export function mcpState(server: McpRow): string | undefined {
  if (server.shadowed) return 'shadowed'
  if (!server.enabled) return 'disabled'
  return server.status
}

const FAILED = ['failed', 'needs_auth', 'needs_client_registration']

/** `+` 메뉴의 "연결 N · 실패 M" — 실패에는 인증 필요도 넣는다(둘 다 도구를 못 쓴다) */
export function mcpCounts(servers: readonly McpRow[]): { connected: number; failed: number } {
  const states = servers.map(mcpState)
  return { connected: states.filter((state) => state === 'connected').length, failed: states.filter((state) => !!state && FAILED.includes(state)).length }
}
