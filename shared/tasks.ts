// 백그라운드 하위 작업 (이슈 #319) — 모델이 `litecode_task_start` 로 띄우고, 메인 턴은 기다리지 않고 끝난다. 작업은 ctx.chat 이 쥐고
// (따로 만든 엔진 세션에서 ctx.llm.chat 한 턴), 끝나면(완료·실패·중지) 그 대화에 출처 'task' 의 새 턴으로 결과를 넣는다.
// 타입·상수·글 만들기뿐이다 (Node·Electron·React 를 모른다). 모델이 읽는 글은 화면 언어와 무관하게 영어

import type { TurnItem } from './contract.ts'

/** 앱 MCP 서버의 도구 이름 — 엔진 이름은 `litecode_task_start` */
export const TASK_START_TOOL = 'task_start'
/** 작업 상태 보기 (읽기 전용) — 엔진 이름은 `litecode_task_status`. 작업 세션에선 숨긴다 */
export const TASK_STATUS_TOOL = 'task_status'

/** 실행 중 작업이 이만큼 조용하면(진행 줄 변화 없음) 죽이지 않고 작업 줄에 표시하고 메인에게 한 번 알린다 — 활동이 다시 오면 풀리고 다시 무장한다 */
export const TASK_QUIET_MS = 180_000
/** 작업 턴의 무응답 하드 한도 — 작업 턴은 ctx.llm 의 평소 한도(120초·도구 인자 600초) 대신 이것 하나로만 끊는다(게이트웨이가 정말 죽은 경우).
 *  그 전의 판단은 메인·사람에게 (위 TASK_QUIET_MS 알림) */
export const TASK_STALL_TIMEOUT_MS = 600_000

/** 작업 종류 — explore 는 읽기 전용(계획 모드 규칙으로 돈다), general 은 그 대화의 모드로 돈다 */
export const TASK_AGENTS = ['explore', 'general'] as const
export type TaskAgent = (typeof TASK_AGENTS)[number]

/** 대화 하나에서 **동시에 실행**되는 작업 수 — 나머지는 대기(queued)로 줄 서고 앞이 끝나면 시작한다 (#321). 단일 게이트웨이가 동시 요청을 줄 세워
 *  뒤 요청이 첫 응답을 120초(MODEL_STALL_TIMEOUT_MS) 안에 못 받아 4개가 모두 실패했다 (실사용 2026-10-12, Qwen 27B) */
export const MAX_RUNNING_TASKS = 2
/** 설정 > 일반 "동시에 실행할 하위 작업"(settings.json `maxRunningTasks`)이 고를 수 있는 범위 — 기본은 MAX_RUNNING_TASKS */
export const RUNNING_TASKS_MIN = 1
export const RUNNING_TASKS_MAX = 8
/** 대화 하나에 실행 + 대기 작업 합계 상한 — 동시 실행 수를 이보다 크게 고르면 그 수 (taskCap) */
export const MAX_TASKS = 4

export function isRunningTaskLimit(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= RUNNING_TASKS_MIN && (value as number) <= RUNNING_TASKS_MAX
}

/** 설정 값 → 동시 실행 수. 없거나 숫자가 아니면 기본값, 범위 밖이면 가까운 끝으로, 소수는 내린다 */
export function runningTaskLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MAX_RUNNING_TASKS
  return Math.min(RUNNING_TASKS_MAX, Math.max(RUNNING_TASKS_MIN, Math.floor(value)))
}

/** 실행 + 대기 합계 상한 — 동시 실행 수보다 작지 않다 */
export function taskCap(limit: number): number {
  return Math.max(MAX_TASKS, limit)
}
export const TASK_DESCRIPTION_MAX = 120
export const TASK_PROMPT_MAX = 20_000
/** 결과 글을 메인 대화에 넣을 때 이 길이까지만 */
export const TASK_RESULT_MAX = 12_000

/** 끝난 모양 — 결과 턴의 글에 실린다 */
export type TaskEnd = 'completed' | 'failed' | 'stopped'

export function isTaskAgent(value: unknown): value is TaskAgent {
  return typeof value === 'string' && (TASK_AGENTS as readonly string[]).includes(value)
}

/** 작업 세션에 보낼 첫 글 — 그 세션은 메인 대화를 모르고 사람에게 묻지 못한다 */
export function taskPrompt(description: string, prompt: string): string {
  return [
    'You are running a background sub-task for another conversation. Work on your own: nobody can answer questions or approve actions here,',
    'so anything that needs approval is refused. Finish with a concise final report — it is passed back to the conversation that started you.',
    // 도구 인자를 만드는 동안 엔진은 아무 이벤트도 안 낸다 — 아주 긴 인자는 무응답 한도에 걸릴 수 있다 (#321, limits.ts TOOL_INPUT_STALL_TIMEOUT_MS)
    'Write long files in several smaller steps (create the file, then append or edit section by section) rather than one huge write.',
    '',
    `Task: ${description}`,
    '',
    prompt,
  ].join('\n')
}

/** 메인 대화에 넣을 결과 글 */
export function taskReport(task: { number: number; agent: TaskAgent; description: string; end: TaskEnd; text?: string; error?: string }): string {
  const body =
    task.end === 'completed'
      ? clip(task.text?.trim() || '(no final text)')
      : task.end === 'stopped'
        ? task.error
          ? `The task was interrupted before it finished (${task.error}).` // 엔진 재시작 등 — 사람이 멈춘 것이 아니다
          : 'The user stopped this task before it finished.'
        : `The task failed: ${task.error ?? 'unknown error'}`
  return [
    `<task-result number="${task.number}" agent="${task.agent}" status="${task.end}">`,
    `<description>${task.description}</description>`,
    body,
    '</task-result>',
    '',
    `Background task ${task.number} has ended (${task.end}). Use this result to continue the user's work; other tasks may still be running. Tell the user briefly what came back.`,
  ].join('\n')
}

function clip(text: string): string {
  return text.length > TASK_RESULT_MAX ? `${text.slice(0, TASK_RESULT_MAX)}…[truncated ${text.length - TASK_RESULT_MAX} chars]` : text
}

/** 진행 줄 하나 → 마지막 활동 한 마디 (모델이 읽는다 — 영어). 도구는 이름과 상태 — 인자를 만드는 중(preparing)이면 긴 파일을 쓰는 중일 수 있다 */
export function taskActivity(item: TurnItem): string {
  if (item.kind === 'tool') {
    const name = item.mcp ? `${item.mcp.server}_${item.mcp.tool}` : item.name
    return `tool ${name} (${item.status === 'preparing' ? 'preparing input' : item.status})`
  }
  if (item.kind === 'think') return 'thinking'
  if (item.kind === 'text') return 'writing its answer'
  return item.kind
}

// 작업 탭(#325)은 진행 줄의 전문(생각·응답 글·도구 입출력)을 그린다 — 엔진이 주는 진행 줄은 이미 잘리지 않은 전문이라, 작업 줄에 쌓을 때
// 상한만 건다. 목록 전체가 EMIT_MS 마다 화면으로 가고, 끝난 작업도 대화마다 FINISHED_KEEP 개 남는다
/** 작업 하나에 남길 진행 줄 수 — 넘으면 오래된 것부터 버리고 수를 센다 (Subtask.omitted) */
export const TASK_ITEMS_MAX = 200
/** 생각·응답 글 한 줄의 글자 상한 */
export const TASK_ITEM_TEXT_MAX = 20_000
/** 도구 입력·결과·오류 각각의 글자 상한 */
export const TASK_TOOL_TEXT_MAX = 8_000

function clipTo(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text
}

/** 진행 줄 하나를 작업 줄에 실을 크기로 — 글자 상한, 도구의 diff(작업 화면에선 안 쓴다)는 뺀다 */
export function capTaskItem(item: TurnItem): TurnItem {
  if (item.kind === 'think' || item.kind === 'text') return item.text.length > TASK_ITEM_TEXT_MAX ? { ...item, text: clipTo(item.text, TASK_ITEM_TEXT_MAX) } : item
  if (item.kind !== 'tool') return item
  const { diffs: _diffs, ...tool } = item
  return {
    ...tool,
    ...(tool.input !== undefined && { input: clipTo(tool.input, TASK_TOOL_TEXT_MAX) }),
    ...(tool.result !== undefined && { result: clipTo(tool.result, TASK_TOOL_TEXT_MAX) }),
    ...(tool.error !== undefined && { error: clipTo(tool.error, TASK_TOOL_TEXT_MAX) }),
  }
}

/** 작업 줄의 진행 줄에 하나를 더하거나 바꾼다(같은 id) — 상한을 넘으면 앞에서 버리고 버린 수를 더한다 */
export function addTaskItem(items: readonly TurnItem[], omitted: number, item: TurnItem): { items: TurnItem[]; omitted: number } {
  const capped = capTaskItem(item)
  const index = items.findIndex((existing) => existing.id === capped.id)
  const next = index === -1 ? [...items, capped] : items.map((existing, at) => (at === index ? capped : existing))
  const over = next.length - TASK_ITEMS_MAX
  return over > 0 ? { items: next.slice(over), omitted: omitted + over } : { items: next, omitted }
}

/** 작업 상태 도구가 돌려줄 한 작업 */
export interface TaskStatusEntry {
  number: number
  agent: TaskAgent
  description: string
  state: 'running' | 'queued' | TaskEnd
  startedAt?: number
  endedAt?: number
  /** 마지막 활동 시각 (실행 중에만) — 시작 시각에서 시작한다 */
  lastActivityAt?: number
  lastActivity?: string
  /** TASK_QUIET_MS 를 넘겨 조용하다 */
  quiet: boolean
  error?: string
}

/** 작업 상태 도구의 결과 글 */
export function taskStatusText(entries: readonly TaskStatusEntry[], now: number): string {
  if (entries.length === 0) return 'There are no background tasks in this conversation.'
  const lines = entries.map((task) => {
    const head = `- Task ${task.number} (${task.agent}) "${task.description}": `
    if (task.state === 'queued') return `${head}waiting in the queue (not started yet).`
    if (task.state === 'running') {
      const last = task.lastActivityAt === undefined ? '' : `; last activity ${duration(now - task.lastActivityAt)} ago${task.lastActivity ? ` (${task.lastActivity})` : ''}`
      const quiet = task.quiet ? ` — quiet for over ${Math.round(TASK_QUIET_MS / 60_000)} minutes` : ''
      return `${head}running for ${duration(now - (task.startedAt ?? now))}${last}${quiet}.`
    }
    const took = task.startedAt !== undefined && task.endedAt !== undefined ? ` after ${duration(task.endedAt - task.startedAt)}` : ''
    return `${head}${task.state}${took}${task.error ? ` (${task.error})` : ''}.`
  })
  return [
    `Background tasks in this conversation (${entries.length}):`,
    ...lines,
    '',
    'A quiet task may still be working (for example while it writes a long file). You cannot stop a task yourself — keep waiting, or tell the user so they can stop it from the task bar.',
  ].join('\n')
}

/** 메인에게 보내는 "조용함" 알림 글 */
export function taskQuietNotice(task: { number: number; description: string; quietMs: number; lastActivity?: string }): string {
  const minutes = Math.round(task.quietMs / 60_000)
  return [
    `<task-notice number="${task.number}" status="quiet">`,
    `Background task ${task.number} ("${task.description}") has shown no activity for ${minutes} minutes${task.lastActivity ? ` (last activity: ${task.lastActivity})` : ''}. It has not been stopped.`,
    '</task-notice>',
    '',
    `Call litecode_${TASK_STATUS_TOOL} to check it, then decide: keep waiting, or tell the user briefly so they can stop it from the task bar. Do not start a duplicate task.`,
  ].join('\n')
}

/** 경과 시간 — 45s · 3m05s */
function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}
