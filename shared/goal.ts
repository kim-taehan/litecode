// 목표 — "이 목표가 끝날 때까지 계속" (이슈 #285, dsh goal·tool-goal·command-goal·goal-round-driver 의 아이디어만 가져와 새로 썼다).
// 대화마다 목표 하나를 앱이 저장한다(Conversation.goal). 사람은 `/goal`·입력 카드 위 줄로, 모델은 앱 MCP 도구 litecode_goal_*로 다루고,
// 턴이 끝날 때 목표가 진행 중이면 앱(ctx.goal)이 다음 턴을 자동으로 보낸다. 여기는 타입과 순수한 상태 전이뿐이다 (Node·React 를 모른다).
//
// dsh 와 다른 점: 단계는 넷(active·paused·done·blocked), 개정 번호(compare-and-set)·이벤트 로그는 없다 — 저장은 sessions.json 한 줄.
// 자동 라운드 상한은 연속 8번(상수 하나)이고 닿으면 blocked 가 아니라 paused(사유 limit) — `/goal resume` 이 다시 센다.
// 자동 이어가기 권한은 저장하지 않는다(dsh 의 armed 와 같다) — 앱을 다시 켜면 진행 중이던 목표는 paused(사유 restart)로 돌아온다.

export type GoalStatus = 'active' | 'paused' | 'done' | 'blocked'

/** 멈춘 까닭 — 화면이 언어에 맞게 보인다 (goal.reason.<값>).
 *  user: 사람이 멈춤 · stopped: ■ 중지 · failed: 턴이 오류로 끝남 · declined: 승인·질문을 거절 · attention: 승인·질문 카드가 떴다 ·
 *  limit: 자동 라운드 한도 · restart: 앱(또는 이 기능)을 다시 켰다 */
export type GoalPauseReason = 'user' | 'stopped' | 'failed' | 'declined' | 'attention' | 'limit' | 'restart'

export interface Goal {
  /** 목표 본문 (사람이 친 그대로) */
  text: string
  status: GoalStatus
  /** 연속 자동 라운드 수 — 만들기·계속(resume)·사람이 직접 보낸 턴에서 0 으로 */
  rounds: number
  /** paused 일 때 그 까닭 */
  reason?: GoalPauseReason
  /** 모델이 done·blocked 와 함께 남긴 말 */
  note?: string
}

/** 연속 자동 라운드 상한 — 닿으면 paused(limit) */
export const GOAL_MAX_ROUNDS = 8
/** 목표 본문 상한 (글자) — 매 라운드 프롬프트에 실린다 */
export const GOAL_TEXT_MAX = 2000
/** 모델이 남기는 말 상한 */
export const GOAL_NOTE_MAX = 500

export const GOAL_GET_TOOL = 'goal_get'
export const GOAL_UPDATE_TOOL = 'goal_update'

const REASONS: readonly GoalPauseReason[] = ['user', 'stopped', 'failed', 'declined', 'attention', 'limit', 'restart']
const STATUSES: readonly GoalStatus[] = ['active', 'paused', 'done', 'blocked']

/** `/goal` 뒤의 글 — 비면 보기, 그 낱말 하나뿐이면 멈춤·계속·지우기, 그 밖은 새 목표 (dsh command-goal: 제어 낱말은 입력 전체일 때만) */
export type GoalCommand = { kind: 'show' } | { kind: 'pause' } | { kind: 'resume' } | { kind: 'clear' } | { kind: 'set'; text: string }

export function parseGoalCommand(args: string): GoalCommand {
  const text = String(args ?? '').trim()
  if (!text) return { kind: 'show' }
  if (text === 'pause' || text === 'resume' || text === 'clear') return { kind: text }
  return { kind: 'set', text }
}

/** 새 목표 — 있던 목표는 무엇이든 바꾼다 */
export function createGoal(text: string): Goal {
  return { text: text.trim().slice(0, GOAL_TEXT_MAX), status: 'active', rounds: 0 }
}

/** 진행 중인 목표만 멈춘다 — 아니면 undefined */
export function pauseGoal(goal: Goal | undefined, reason: GoalPauseReason): Goal | undefined {
  return goal?.status === 'active' ? { text: goal.text, status: 'paused', rounds: goal.rounds, reason } : undefined
}

/** 멈췄거나 막힌 목표를 다시 — 라운드를 새로 센다. 끝난(done)·진행 중인 목표는 undefined */
export function resumeGoal(goal: Goal | undefined): Goal | undefined {
  return goal && (goal.status === 'paused' || goal.status === 'blocked') ? { text: goal.text, status: 'active', rounds: 0 } : undefined
}

/** 모델이 알린 끝 — 진행 중이거나 멈춘 목표만 (이미 끝났거나 막힌 목표는 undefined) */
export function finishGoal(goal: Goal | undefined, status: 'done' | 'blocked', note?: string): Goal | undefined {
  if (!goal || (goal.status !== 'active' && goal.status !== 'paused')) return undefined
  const said = typeof note === 'string' ? note.trim().slice(0, GOAL_NOTE_MAX) : ''
  return { text: goal.text, status, rounds: goal.rounds, ...(said && { note: said }) }
}

/** 자동 라운드 하나를 센다 — 한도에 닿았으면 undefined (부른 쪽이 paused(limit)로) */
export function nextRound(goal: Goal): Goal | undefined {
  return goal.rounds >= GOAL_MAX_ROUNDS ? undefined : { ...goal, rounds: goal.rounds + 1 }
}

/** 입력 카드 위 목표 줄의 버튼 — 진행 중이면 멈춤, 멈췄거나 막혔으면 계속, 언제나 지우기 */
export function goalActions(goal: Goal): ('pause' | 'resume' | 'clear')[] {
  if (goal.status === 'active') return ['pause', 'clear']
  if (goal.status === 'paused' || goal.status === 'blocked') return ['resume', 'clear']
  return ['clear']
}

/** 파일·IPC 에서 읽은 값 — 모양이 맞을 때만 */
export function goalOf(value: unknown): Goal | undefined {
  const entry = value as Partial<Goal> | null | undefined
  if (!entry || typeof entry !== 'object' || typeof entry.text !== 'string' || !entry.text || !STATUSES.includes(entry.status as GoalStatus)) return undefined
  const rounds = typeof entry.rounds === 'number' && Number.isInteger(entry.rounds) && entry.rounds >= 0 ? entry.rounds : 0
  return {
    text: entry.text,
    status: entry.status as GoalStatus,
    rounds,
    ...(entry.status === 'paused' && REASONS.includes(entry.reason as GoalPauseReason) && { reason: entry.reason }),
    ...(typeof entry.note === 'string' && entry.note && { note: entry.note }),
  }
}

/** 목표 본문의 첫 줄 — 입력 카드 위 줄·자동 라운드 말풍선에 */
export function goalHeadline(text: string): string {
  return (text.split('\n').find((line) => line.trim()) ?? text).trim()
}

// 모델이 읽는 글은 화면 언어와 무관하게 영어다 (앱 MCP 도구 설명과 같은 규칙)
const TOOL_GUIDE =
  'When the whole objective is achieved and verified, call the litecode_goal_update tool with status "done" and a one-line note. ' +
  'If you cannot continue without the user (missing access, a decision only they can make), call it with status "blocked" and the concrete reason in note. ' +
  'Difficulty or remaining work is not blocked. Otherwise leave the goal open; the app will ask you to continue.'

/** `/goal <목표>` 의 첫 프롬프트 */
export function goalStartPrompt(text: string): string {
  return ['<goal>', `Objective: ${JSON.stringify(text)}`, '', 'Work toward this objective in this conversation, across as many turns as needed.', TOOL_GUIDE, '</goal>'].join('\n')
}

/** 자동 라운드 하나의 프롬프트 (dsh goal-round-driver 의 <goal_round> 아이디어) */
export function goalRoundPrompt(goal: Goal, round: number): string {
  return [
    '<goal_round>',
    `Objective: ${JSON.stringify(goal.text)}`,
    `Round: ${round}/${GOAL_MAX_ROUNDS}`,
    '',
    'Continue working toward the objective. Check the current workspace and tool results instead of assuming earlier narration is still current. Make concrete progress and verify it.',
    TOOL_GUIDE,
    '</goal_round>',
  ].join('\n')
}
