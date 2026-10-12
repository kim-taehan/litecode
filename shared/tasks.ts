// 백그라운드 하위 작업 (이슈 #319) — 모델이 `litecode_task_start` 로 띄우고, 메인 턴은 기다리지 않고 끝난다. 작업은 ctx.chat 이 쥐고
// (따로 만든 엔진 세션에서 ctx.llm.chat 한 턴), 끝나면(완료·실패·중지) 그 대화에 출처 'task' 의 새 턴으로 결과를 넣는다.
// 타입·상수·글 만들기뿐이다 (Node·Electron·React 를 모른다). 모델이 읽는 글은 화면 언어와 무관하게 영어

/** 앱 MCP 서버의 도구 이름 — 엔진 이름은 `litecode_task_start` */
export const TASK_START_TOOL = 'task_start'

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
