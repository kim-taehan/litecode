// 훅 (이슈 #102, 설계 _workspace/01af_hooks.md §6) — 이벤트에 거는 사용자 셸 명령. 타입 + 순수 함수뿐이다 (Node·Electron·엔진을 모른다).
// 저장 형식은 Claude Code `hooks` 형식의 부분집합이고 이벤트 이름도 Claude Code 것 그대로다 (이미 가진 훅을 옮겨 올 수 있게, 사용자 결정).

export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'Notification'] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

/** 도구 이름으로 거르는 이벤트 — 그 밖의 이벤트는 매처를 보지 않는다 */
export const TOOL_HOOK_EVENTS: readonly HookEvent[] = ['PreToolUse', 'PostToolUse']

/** 막을 수 있는 이벤트 — 그 밖의 이벤트에서 종료 코드 2 는 그냥 실패다 (막을 것이 없다) */
export const BLOCKING_HOOK_EVENTS: readonly HookEvent[] = ['PreToolUse', 'UserPromptSubmit', 'Stop']

/** passed: 종료 코드 0. blocked: 종료 코드 2 (stderr 가 사유). failed: 그 밖의 코드·기한 초과·실행 실패 — 막지 않는다 */
export type HookOutcome = 'passed' | 'blocked' | 'failed'

/** 훅 하나 — 저장 형식의 `{matcher, hooks:[{type:"command", command, timeout}]}` 를 펼친 것 */
export interface HookDef {
  event: HookEvent
  /** 도구 이름의 `|` 나열 또는 정규식, 비우면 전부 (도구 이벤트만) */
  matcher: string
  command: string
  /** 기한(초) — 없으면 이벤트 기본값 (hookTimeout) */
  timeout?: number
  /** 꺼 둔 훅은 false (저장 형식의 `"enabled": false` — Claude Code 에는 없는 필드) */
  enabled: boolean
}

/** 프로젝트에서 본 훅 하나 — 어느 묶음의 것인지와 그 프로젝트에서의 켜짐 */
export interface HookEntry extends HookDef {
  /** all: 모든 프로젝트(hooks.json), project: 이 프로젝트만(hooks-projects.json) */
  scope: 'all' | 'project'
  /** 프로젝트별 켜기 값의 열쇠 (hookKey) */
  key: string
  /** 그 프로젝트에서 실제로 도는가 — 프로젝트별 켜기 값이 enabled 를 덮는다 */
  on: boolean
}

/** 기한(초): 턴을 붙드는 것(프롬프트 제출·도구 실행 전)은 30, 그 밖은 60. 훅마다 timeout 으로 바꾸고 상한은 600 (사용자 결정) */
export const HOOK_TIMEOUT_MAX = 600
export function hookTimeout(event: HookEvent, timeout?: number): number {
  const base = event === 'UserPromptSubmit' || event === 'PreToolUse' ? 30 : 60
  return Math.min(timeout ?? base, HOOK_TIMEOUT_MAX)
}

/** 턴 끝 훅이 대화를 이어 가게 하는 것은 연속 이만큼까지 (사용자 결정) */
export const STOP_CHAIN_MAX = 3

/** 프로젝트별 켜기 값의 열쇠 — 훅에는 이름이 없어 내용으로 가린다 (같은 내용의 훅 둘은 함께 켜지고 꺼진다) */
export function hookKey(hook: Pick<HookDef, 'event' | 'matcher' | 'command'>): string {
  return `${hook.event}|${hook.matcher}|${hook.command}`
}

/** 매처가 그 도구에 맞는가. 비었거나 `*` 면 전부. 그 밖엔 전체 일치 정규식(`edit|write`·`mcp_.*`)으로, 대소문자를 가리지 않는다 —
 *  Claude Code 이름(`Bash`·`Edit`·`Write`·`Read`·`Task`)이 엔진의 소문자 이름과 같은 것으로 맞는다. 잘못된 정규식은 "안 맞음" */
export function matchesTool(matcher: string, tool: string): boolean {
  const pattern = matcher.trim()
  if (!pattern || pattern === '*') return true
  try {
    return new RegExp(`^(?:${pattern})$`, 'i').test(tool)
  } catch {
    return false
  }
}
