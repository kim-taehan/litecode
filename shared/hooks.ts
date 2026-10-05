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

// ── 화면(이슈 #102 3단계 — `+` 메뉴 > 훅 팝업·가져오기·시험 실행)이 쓰는 모양과 판정. 여기까지도 순수 함수뿐이다

export type HookScope = HookEntry['scope']

/** 도구 실행 전 훅이 걸리지 않는 내장 도구 — 지금 엔진 경로에 없는 도구다 (ctx.engine 의 toolGate 도 이 목록을 쓴다, engine.ts 의 ⚠️) */
export const UNGATED_TOOLS: readonly string[] = ['websearch']

/** 도구 실행 전 훅의 매처가 걸리지 않는 도구만 가리키나 — 그 훅은 한 번도 돌지 않는다 (화면이 경고한다). 이름의 `|` 나열만 본다 */
export function preToolUnreachable(matcher: string): boolean {
  const names = matcher.split('|').map((name) => name.trim().toLowerCase())
  return names.every((name) => UNGATED_TOOLS.includes(name))
}

/** 팝업의 줄 하나 — 훅 + 화면이 그릴 값 */
export interface HookRow extends HookEntry {
  /** 실제 기한(초) — 안 적었으면 이벤트 기본값 */
  seconds: number
  /** 도구 실행 전 훅인데 매처가 걸리지 않는 도구만 가리킨다 */
  unreachable: boolean
}

export function hookRow(entry: HookEntry): HookRow {
  return { ...entry, seconds: hookTimeout(entry.event, entry.timeout), unreachable: entry.event === 'PreToolUse' && preToolUnreachable(entry.matcher) }
}

/** 추가·편집 폼이 보내는 것 */
export interface HookDraft {
  /** 고치는 훅 (없으면 새 훅) */
  original?: { scope: HookScope; key: string }
  scope: HookScope
  event: HookEvent
  /** 도구 이벤트가 아니면 버린다 */
  matcher: string
  command: string
  /** 기한(초, 1~HOOK_TIMEOUT_MAX 의 정수) — 없으면 이벤트 기본값 */
  timeout?: number
}

export type HookDraftError = 'event' | 'scope' | 'command' | 'matcher' | 'timeout'

/** 폼(또는 IPC 로 온 아무 값) → 다듬은 초안, 틀렸으면 무엇이 틀렸는지. 메인이 저장·시험 실행 전에, 화면이 버튼을 켜기 전에 같은 함수로 본다.
 *  매처는 도구 이벤트에서만 남기고 정규식으로 읽혀야 한다 (못 읽는 매처는 어느 도구에도 안 맞는다 — matchesTool) */
export function checkHookDraft(value: unknown): { draft: HookDraft } | { error: HookDraftError } {
  const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const event = input['event'] as HookEvent
  if (!HOOK_EVENTS.includes(event)) return { error: 'event' }
  const scope = input['scope']
  if (scope !== 'all' && scope !== 'project') return { error: 'scope' }
  const command = typeof input['command'] === 'string' ? input['command'].trim() : ''
  if (!command) return { error: 'command' }
  const matcher = TOOL_HOOK_EVENTS.includes(event) && typeof input['matcher'] === 'string' ? input['matcher'].trim() : ''
  try {
    new RegExp(matcher === '*' ? '' : matcher)
  } catch {
    return { error: 'matcher' }
  }
  const timeout = input['timeout']
  if (timeout !== undefined && !(typeof timeout === 'number' && Number.isInteger(timeout) && timeout >= 1 && timeout <= HOOK_TIMEOUT_MAX)) return { error: 'timeout' }
  const original = input['original'] as { scope?: unknown; key?: unknown } | null | undefined
  if (original !== undefined && !(original && (original.scope === 'all' || original.scope === 'project') && typeof original.key === 'string')) return { error: 'scope' }
  return {
    draft: {
      ...(original && { original: { scope: original.scope as HookScope, key: original.key as string } }),
      scope,
      event,
      matcher,
      command,
      ...(timeout !== undefined && { timeout }),
    },
  }
}

/** 시험 실행 결과 — 견본 입력으로 한 번 돌린 것 (대화·실행 기록에는 남지 않는다) */
export interface HookTestResult {
  outcome: HookOutcome
  exitCode: number | null
  seconds: number
  /** 막은 사유·실패 사유 */
  reason?: string
  stdout: string
  stderr: string
  /** 훅이 stdin 으로 받은 견본 JSON */
  stdin: string
}

/** 프로젝트 폴더가 가진 훅 정의 파일 — 자동으로 실행하지 않고 가져오기 후보로만 읽는다 (사용자 결정) */
export const PROJECT_HOOK_FILES: readonly string[] = ['.claude/settings.json', '.claude/settings.local.json']

/** 가져오기 후보 하나 — 프로젝트 폴더의 파일에서 찾은 훅 (아직 이 PC 에 복사하지 않았다) */
export interface HookCandidate {
  key: string
  event: HookEvent
  matcher: string
  command: string
  timeout?: number
  /** 실제 기한(초) */
  seconds: number
  /** 찾은 파일 (프로젝트 기준) */
  file: string
  /** 바깥으로 내용을 보낼 법한 명령이다 (sendsOutside) */
  outbound: boolean
}

const OUTBOUND = /\b(?:curl|wget|nc|ncat|netcat|ssh|scp|sftp|rsync|ftp|telnet)\b|https?:\/\/|\/dev\/tcp\//i

/** 바깥(네트워크)으로 내용을 보낼 법한 명령인가 — 가져오기 확인 창의 경고용. **단순 글자 판정**이다: 흔한 전송 도구 이름과 http(s) 주소만 본다.
 *  스크립트 파일 안에서 보내는 것·다른 도구는 못 잡는다 (경고가 없다고 안전한 명령은 아니다) */
export function sendsOutside(command: string): boolean {
  return OUTBOUND.test(command)
}

/** 최근 실행 기록 하나 (화면용 — 메모리에만 있고 앱을 끄면 사라진다) */
export interface HookRecent {
  at: number
  event: HookEvent
  command: string
  outcome: HookOutcome
  seconds: number
  reason?: string
  exitCode: number | null
}

const STOP_FEEDBACK = 'Stop hook feedback:'

/** 턴 끝 훅이 막았을 때 이어 보내는 글 — 모델이 읽는다 (Claude Code 와 같은 머리) */
export function stopFeedback(reason: string): string {
  return `${STOP_FEEDBACK}\n${reason}`
}

/** 그 user 글이 턴 끝 훅이 이어 보낸 것이면 그 사유 (아니면 undefined) — 화면이 내 말풍선 대신 구분되는 줄로 그리고 입력 기록(↑)에서 뺀다.
 *  글의 머리로 가린다: 다시 연 대화(엔진 기록)에는 출처가 없다 */
export function stopFeedbackReason(text: string): string | undefined {
  const trimmed = text.trimStart()
  return trimmed.startsWith(STOP_FEEDBACK) ? trimmed.slice(STOP_FEEDBACK.length).trim() : undefined
}
