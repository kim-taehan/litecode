// 대화 목표 (ctx.goals, 이슈 #626 — dsh packages/goal 의 충실 이식) — 타입과 순수 함수만 (Node·Electron·React 를 모른다).
// dsh 의 goal/goal + docs/subsystems/goal.md 과 같은 의미:
// - 대화(세션)당 **현재 목표 하나** — 내구 상태는 `goal/change` 이벤트의 전체 스냅샷/톰스톤으로 fold 한다
// - 변경은 전부 GoalRef {id, revision} 로 compare-and-set — revision 이 어긋나면 거절
// - phase(내구 생명주기) 와 activation(프로세스 로컬 자동 이어가기 자격) 이 별개 — activation 은 저장하지 않는다
//
// dsh 에서와 다른 점(litecode): 저장소가 opencode 세션 로그가 아니라 앱의 JSON 이벤트 로그(goals.json)다 — fold·CAS·이벤트
// 모양은 그대로다. 라운드 상한 기본값은 dsh 의 "배포 설정" 에 해당한다 — litecode 는 설정 화면 없이 코드 상수로 둔다

/** 내구 생명주기 — "목표에 무슨 일이 있었나" 를 답한다 (dsh GoalPhase) */
export const GOAL_PHASES = ['active', 'paused', 'blocked', 'complete'] as const
export type GoalPhase = (typeof GOAL_PHASES)[number]

/** 차단(blocked) 사유 — code 는 라우팅용 안정 kebab-case, message 는 사람·모델이 보는 설명 (dsh GoalBlockReason) */
export interface GoalBlockReason {
  code: string
  message: string
}

/** 라운드 상한 기본값 — dsh 의 `defaultMaxGoalRounds`(배포 설정) 에 해당. litecode 는 코드 상수 */
export const GOAL_ROUNDS_DEFAULT = 8
/** 앱 모델 도구 이름 (서버 litecode) — 엔진 권한 규칙(engineConfig)과 화면(승인 카드 숨기기 등)이 같이 쓴다 */
export const GOAL_GET_TOOL = 'litecode_get_goal'
export const GOAL_CREATE_TOOL = 'litecode_create_goal'
export const GOAL_UPDATE_TOOL = 'litecode_update_goal'
/** 모델이 스스로 blocked 라고 말하기까지 필요한 연속 라운드 수 (dsh blockedAfterConsecutiveRounds 기본값 3) */
export const GOAL_BLOCKED_AFTER_ROUNDS = 3
/** 라운드 상한 한계 — create·edit 가 주는 값의 범위 */
export const GOAL_ROUNDS_MAX = 50
/** 목표 본문 상한 (글자) */
export const GOAL_OBJECTIVE_MAX = 500

/** 한 정확한 목표 revision 을 가리키는 compare-and-set 식별자 (dsh GoalRef) */
/** 스냅샷을 올리는 이벤트의 operation (clear 는 톰스톤이라 스냅샷이 없어 제외) */
export type GoalChangeOperation = Exclude<GoalEvent['operation'], 'clear'>

export interface GoalRef {
  id: string
  revision: number
}

/** 모든 내구 변경이 쓰는 전체 스냅샷 (dsh GoalSnapshot) */
export interface GoalSnapshot extends GoalRef {
  /** 사람이 지은 완료 목표 */
  objective: string
  phase: GoalPhase
  /** phase 가 blocked 인 동안에만 있다 */
  blockedReason?: GoalBlockReason
  /** 수용된 목표 라운드의 총 상한 */
  maxGoalRounds: number
}

/** 현재 목표 투영 + 저장 로그에서 유도된 값 (dsh GoalView) */
export interface GoalView extends GoalSnapshot {
  /** 이 목표의 최고 수용 라운드 번호 */
  roundsStarted: number
  createdAt: number
  updatedAt: number
  /** 프로세스 로컬 자동 이어가기 자격 — 저장 안 함 */
  armed: boolean
}

/** 내구 변경 이벤트 — payload 가 변경 후 전체 스냅샷 또는 clear 톰스톤 (dsh goal/change) */
export type GoalEvent =
  | {
      kind: 'goal/change'
      version: 1
      /** 'round' = dsh 의 admitted 라운드 기록 (dsh 는 user/message 속성으로 세웠고 litecode 는 스냅샷에 실는다) */
      operation: 'create' | 'edit' | 'pause' | 'resume' | 'complete' | 'block' | 'round'
      goal: GoalSnapshot
      roundsStarted: number
      createdAt: number
      updatedAt: number
    }
  | {
      kind: 'goal/change'
      version: 1
      operation: 'clear'
      cleared: GoalRef
      clearedAt: number
    }

export class GoalError extends Error {
  constructor(message: string) {
    super(message)
  }
}

export function isGoalPhase(value: unknown): value is GoalPhase {
  return (GOAL_PHASES as readonly unknown[]).includes(value)
}

/** goals.json 의 한 대화 값 — 이벤트만 (fold 가 정본) */
export interface GoalLog {
  events: GoalEvent[]
}

/** 이벤트 로그를 fold 한다 (dsh strict replay) — 잘못된 이벤트(버전·순서·갭·낡은 revision)이면 던진다.
 *  비어 있거나 마지막이 clear 톰스톤이면 undefined (현재 목표가 없다) */
export function foldGoalLog(log: GoalLog | undefined): GoalView | undefined {
  const events = log?.events ?? []
  let result: GoalView | undefined
  let roundsAtLast = 0
  for (const event of events) {
    if (event.kind !== 'goal/change' || event.version !== 1) throw new GoalError('모르는 goal 이벤트입니다')
    if (event.operation === 'clear') {
      if (result && event.cleared.id !== result.id && event.cleared.revision !== result.revision) throw new GoalError('goal clear 가 현재 목표와 안 맞습니다')
      result = undefined
      roundsAtLast = 0
      continue
    }
    if (event.operation === 'create') {
      // 완료된 목표만 새 식별자로 교체 — 그 외 phase 가 있으면 안 된다 (dsh: completed 가 아니라면 clear·resume)
      if (result && result.phase !== 'complete') throw new GoalError('goal create 는 현재 목표가 없거나 완료된 때만 합니다')
      if (event.goal.revision !== 1) throw new GoalError('goal create 는 revision 1 로 시작합니다')
      roundsAtLast = 0
    } else {
      // edit·pause·resume·complete·block — 현재 목표의 revision+1 이어야 한다
      if (!result) throw new GoalError('goal 이 없어 변경할 것이 없습니다')
      if (event.goal.id !== result.id) throw new GoalError('goal 변경이 다른 목표를 가리킵니다')
      if (event.goal.revision !== result.revision + 1) throw new GoalError('goal revision 이 어긋납니다 (CAS)')
    }
    // roundsStarted 는 admitted 라운드로만 증가 — 이전 이벤트보다 줄거나 skip 하면 불량 (dsh: non-positive·gap 거부)
    if (event.roundsStarted < roundsAtLast || event.roundsStarted > roundsAtLast + event.goal.maxGoalRounds + GOAL_ROUNDS_MAX) {
      throw new GoalError('goal 라운드 수가 어긋납니다')
    }
    if (event.roundsStarted > event.goal.maxGoalRounds) throw new GoalError('goal 라운드가 상한을 넘습니다')
    // phase 가 blocked 면 reason 이 있고, 아니면 없다 (dsh: present exactly while blocked)
    if (event.goal.phase === 'blocked' && !event.goal.blockedReason) throw new GoalError('blocked goal 에 사유가 없습니다')
    if (event.goal.phase !== 'blocked' && event.goal.blockedReason) throw new GoalError('blocked 가 아닌 goal 에 사유가 있습니다')
    roundsAtLast = event.roundsStarted
    result = {
      ...event.goal,
      roundsStarted: event.roundsStarted,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
      armed: false, // activation 은 fold 에서 복구 안 됨 — 프로세스 로컬이다
    }
  }
  return result
}

/** 라운드 프롬프트 (dsh renderGoalRoundPrompt — 유지되는 단일 text 블록, 본문은 그대로) */
export function goalRoundPrompt(objective: string, round: number, max: number): string {
  return (
    '<goal_round>\n' +
    `Objective: ${JSON.stringify(objective)}\n` +
    `Round: ${round}/${max}\n\n` +
    'Continue working toward the objective in this same session. Treat the current workspace, ' +
    'tool results, and durable session state as authoritative; inspect them instead of assuming ' +
    'earlier narration is still current. Make concrete progress and verify the result. Before ' +
    'claiming completion, gather evidence that the whole objective is achieved, read the current ' +
    'goal, and mark it complete. If work remains, leave the goal active for the next round. Follow ' +
    'the configured goal-tool policy before reporting a blocker.\n' +
    '</goal_round>'
  )
}
