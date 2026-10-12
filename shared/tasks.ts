// 백그라운드 하위 작업 (이슈 #319) — 모델이 `litecode_task_start` 로 띄우고, 메인 턴은 기다리지 않고 끝난다. 작업은 ctx.chat 이 쥐고
// (따로 만든 엔진 세션에서 ctx.llm.chat 한 턴), 끝나면(완료·실패·중지) 그 대화에 출처 'task' 의 새 턴으로 결과를 넣는다.
// 타입·상수·글 만들기뿐이다 (Node·Electron·React 를 모른다). 모델이 읽는 글은 화면 언어와 무관하게 영어

/** 앱 MCP 서버의 도구 이름 — 엔진 이름은 `litecode_task_start` */
export const TASK_START_TOOL = 'task_start'

/** 작업 종류 — explore 는 읽기 전용(계획 모드 규칙으로 돈다), general 은 그 대화의 모드로 돈다 */
export const TASK_AGENTS = ['explore', 'general'] as const
export type TaskAgent = (typeof TASK_AGENTS)[number]

/** 대화 하나에서 동시에 도는 작업 상한 */
export const TASKS_RUNNING_MAX = 4
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
