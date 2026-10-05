import { checkHookDraft, hookTimeout, preToolUnreachable, TOOL_HOOK_EVENTS, type HookDraft, type HookDraftError, type HookEvent, type HookRecent, type HookRow, type HookScope } from '../shared/hooks.ts'

// 훅 팝업(이슈 #102 3단계 — 입력창 `+` 메뉴 > 훅)의 화면용 순수 함수. 묶음·켜짐·걸리는지는 메인(ctx.hooks)이 정해 준 줄(HookRow)에 있고,
// 검증은 메인과 같은 함수(shared/hooks.ts checkHookDraft)다 — 여기는 폼 글자 ↔ 초안, 세기, 고르기만

/** `+` 메뉴의 "켜짐 N" — 이 프로젝트에서 실제로 도는 훅 수 (두 묶음 합) */
export function hooksOn(rows: readonly Pick<HookRow, 'on'>[]): number {
  return rows.filter((row) => row.on).length
}

/** 그 이벤트가 매처(도구 이름)를 보나 */
export function usesMatcher(event: HookEvent): boolean {
  return TOOL_HOOK_EVENTS.includes(event)
}

/** 추가·편집 폼의 칸 — 기한은 친 글자 그대로 (비우면 기본값) */
export interface HookForm {
  event: HookEvent
  matcher: string
  command: string
  timeout: string
  scope: HookScope
}

/** 폼의 처음 값 — 고치는 훅의 값, 새 훅은 "도구 실행 전 · 이 프로젝트만" */
export function formOf(row?: HookRow): HookForm {
  if (!row) return { event: 'PreToolUse', matcher: '', command: '', timeout: '', scope: 'project' }
  return { event: row.event, matcher: row.matcher, command: row.command, timeout: row.timeout === undefined ? '' : String(row.timeout), scope: row.scope }
}

/** 폼 → 메인에 보낼 초안, 틀렸으면 무엇이 틀렸는지. 기한 칸은 숫자만 받는다 (`1.5`·`10초` 는 틀린 기한) */
export function formDraft(form: HookForm, original?: Pick<HookRow, 'scope' | 'key'>): { draft: HookDraft } | { error: HookDraftError } {
  const typed = form.timeout.trim()
  if (typed && !/^\d+$/.test(typed)) return { error: 'timeout' }
  return checkHookDraft({
    ...(original && { original: { scope: original.scope, key: original.key } }),
    scope: form.scope,
    event: form.event,
    matcher: form.matcher,
    command: form.command,
    ...(typed && { timeout: Number(typed) }),
  })
}

/** 기한 칸이 비었을 때 보이는 기본값(초) */
export function defaultSeconds(event: HookEvent): number {
  return hookTimeout(event)
}

/** 폼의 매처가 걸리지 않는 도구만 가리키나 (도구 실행 전 훅만) — 저장은 되지만 한 번도 돌지 않는다고 경고한다 */
export function formUnreachable(form: Pick<HookForm, 'event' | 'matcher'>): boolean {
  return form.event === 'PreToolUse' && preToolUnreachable(form.matcher)
}

/** 그 훅의 최근 실행 — 새것부터 limit 건. 기록에는 매처가 없어 이벤트와 명령으로 가린다 */
export function recentOf(records: readonly HookRecent[], hook: Pick<HookRow, 'event' | 'command'>, limit = 5): HookRecent[] {
  return records.filter((record) => record.event === hook.event && record.command === hook.command).slice(-limit).reverse()
}

/** 후보가 나온 파일 이름들 (나온 순서, 겹치지 않게) — "…/settings.json · …/settings.local.json" */
export function candidateFiles(candidates: readonly { file: string }[]): string {
  return [...new Set(candidates.map((candidate) => candidate.file))].join(' · ')
}

/** 가져오기 확인 창의 고르기 — 누른 것을 넣거나 뺀다 */
export function toggled(selected: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selected)
  if (!next.delete(key)) next.add(key)
  return next
}
