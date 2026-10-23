import { Context, Service } from 'cordis'
import { randomUUID } from 'node:crypto'
import { readJsonFile, unreadableFileError, writeJsonFile } from './jsonFile.ts'
import {
  foldGoalLog,
  GoalError,
  GOAL_OBJECTIVE_MAX,
  GOAL_ROUNDS_DEFAULT,
  GOAL_ROUNDS_MAX,
  type GoalBlockReason,
  type GoalChangeOperation,
  type GoalEvent,
  type GoalLog,
  type GoalRef,
  type GoalSnapshot,
  type GoalView,
} from '../../shared/goal.ts'

// 대화 목표 (ctx.goals, 이슈 #626) — dsh packages/goal 의 충실 이식. dsh 는 세션 로그 이벤트로 fold 하는데 litecode 는
// 앱의 JSON 이벤트 로그(goals.json)로 한다 — 이벤트 모양·CAS·activation 분리·"현재 목표 하나" 는 그대로다.
//
// - 이벤트 = `goal/change` — 변경 후 **전체 스냅샷** 또는 clear 톰스톤. fold 가 정본 (읽기마다 fold, 캐시 없음)
// - 모든 mutation 은 GoalRef {id, revision} compare-and-set — 어긋나면 GoalError
// - phase(내구: active·paused·blocked·complete) 와 armed(프로세스 로컬 자동 이어가기 자격) 이 별도다 — armed 은 저장 안 함
// - 라운드는 드라이버(ctx.goalDriver) 가 예약(reserveRound)하고, 그 hook 턴이 실제로 시작됐을 때 admitRound 로만 증가한다
//   (dsh reservation→admission — stale 예약은 소모 안 함)

declare module 'cordis' {
  interface Context {
    goals: GoalService
  }
  interface Events {
    /** 목표가 바뀌었다 (변경·clear) — view 가 없으면 clear. 화면 스트립과 스냅샷이 쓴다 */
    'goal/changed'(cid: string, view: GoalView | undefined): void
  }
}

export interface GoalServiceOptions {
  /** goals.json 파일 경로 (app userData) */
  file: string
}

interface Stored {
  goals: Record<string, GoalLog>
}

type RoundReservation = { goalId: string; revision: number; round: number }
type Mutation =
  | { cleared: GoalRef }
  | { operation: GoalChangeOperation; snapshot: GoalSnapshot; roundsOverride?: number; arm?: boolean }
type MutationResult = { view: GoalView } | { cleared: GoalRef } | null

export class GoalService extends Service {
  static readonly inject: string[] = []
  /** 라운드 상한 기본값 — dsh 의 `defaultMaxGoalRounds`(배포 설정) 에 해당, 코드 상수 */
  static readonly DEFAULT_ROUNDS = GOAL_ROUNDS_DEFAULT

  /** 읽기-고치기-쓰기를 한 줄로 세운다 (sessions.ts 와 같은 이유) */
  private queue: Promise<unknown> = Promise.resolve()
  /** 프로세스 로컬 자동 이어가기 자격 — 저장 안 함 (dsh activation) */
  private armed = new Map<string, boolean>()
  /** 라운드 예약 — 대화 id → 예약한 것. admitRound 가 소모하거나 성공한 내구 변경이 stale 로 버린다 */
  private reserved = new Map<string, RoundReservation>()

  constructor(
    ctx: Context,
    private opts: GoalServiceOptions,
  ) {
    super(ctx, 'goals')
  }

  /** 현재 목표 (없으면 undefined) — armed 포함 */
  async view(cid: string): Promise<GoalView | undefined> {
    const folded = foldGoalLog((await this.read()).goals[cid])
    return folded ? { ...folded, armed: this.armed.get(cid) === true } : undefined
  }

  /** 생성 + arm. 현재 목표가 없고, 없거나 완료된 때만. 완료 목표는 새 식별자로 교체 (dsh create) */
  async create(cid: string, request: { objective: string; maxGoalRounds?: number }): Promise<GoalView> {
    const view = await this.viewed(cid, (current) => {
      if (current && current.phase !== 'complete') throw new GoalError('목표가 이미 있습니다 — 바꾸려면 edit, 없애려면 clear')
      const objective = this.objective(request.objective)
      const maxGoalRounds = request.maxGoalRounds === undefined ? GoalService.DEFAULT_ROUNDS : this.cap(request.maxGoalRounds)
      return {
        operation: 'create',
        snapshot: { id: randomUUID(), revision: 1, objective, phase: 'active', maxGoalRounds, roundsStarted: 0 },
        arm: true,
      }
    })
    if (!isView(view)) throw new GoalError('goal create 실패')
    return view.view
  }

  /** objective·라운드 상한 중 하나 이상 — phase·armed 는 그대로 (dsh edit) */
  async edit(cid: string, ref: GoalRef, request: { objective?: string; maxGoalRounds?: number }): Promise<GoalView> {
    if (request.objective === undefined && request.maxGoalRounds === undefined) throw new GoalError('edit 는 바꿀 것이 있어야 합니다')
    const view = await this.viewed(cid, (current) => {
      const checked = this.checkRef(current, ref, 'edit')
      const objective = request.objective !== undefined ? this.objective(request.objective) : checked.objective
      const maxGoalRounds = request.maxGoalRounds !== undefined ? this.cap(request.maxGoalRounds) : checked.maxGoalRounds
      return {
        operation: 'edit',
        snapshot: { ...checked, revision: checked.revision + 1, objective, maxGoalRounds },
      }
    })
    if (!isView(view)) throw new GoalError('goal edit 실패')
    return view.view
  }

  /** 일시중지 + disarm (dsh pause) */
  async pause(cid: string, ref: GoalRef): Promise<GoalView> {
    const view = await this.viewed(cid, (current) => {
      const checked = this.checkRef(current, ref, 'pause')
      if (checked.phase !== 'active') throw new GoalError('pause 는 활성 목표에만 합니다')
      return {
        operation: 'pause',
        snapshot: { ...checked, revision: checked.revision + 1, phase: 'paused' },
        arm: false,
      }
    })
    if (!isView(view)) throw new GoalError('goal pause 실패')
    return view.view
  }

  /** 재개 + arm — 라운드 잔량이 있을 때만 (dsh resume). 완료 목표는 다시 못 연다 */
  async resume(cid: string, ref: GoalRef): Promise<GoalView> {
    const view = await this.viewed(cid, (current) => {
      const checked = this.checkRef(current, ref, 'resume')
      if (checked.phase === 'complete') throw new GoalError('완료된 목표는 다시 못 엽니다 — 새 목표를 만들어 주세요')
      if (checked.phase === 'active' && this.armed.get(cid) === true) return undefined // 이미 그 상태 (dsh: noop)
      if (checked.roundsStarted >= checked.maxGoalRounds) throw new GoalError('라운드 잔량이 없어 재개할 수 없습니다')
      return {
        operation: 'resume',
        snapshot: { ...checked, revision: checked.revision + 1, phase: 'active', blockedReason: undefined },
        arm: true,
      }
    })
    if (view === null) return (await this.view(cid))!
    if (!isView(view)) throw new GoalError('goal resume 실패')
    return view.view
  }

  /** 완료 + disarm — 모델 판단 (dsh complete) */
  async complete(cid: string, ref: GoalRef): Promise<GoalView> {
    const view = await this.viewed(cid, (current) => {
      const checked = this.checkRef(current, ref, 'complete')
      if (checked.phase === 'complete') throw new GoalError('이미 완료된 목표입니다')
      const { blockedReason: _dropped, ...rest } = checked
      return {
        operation: 'complete',
        snapshot: { ...rest, revision: checked.revision + 1, phase: 'complete' },
        arm: false,
      }
    })
    if (!isView(view)) throw new GoalError('goal complete 실패')
    return view.view
  }

  /** 차단 + disarm — policy 의 code·message (dsh block) */
  async block(cid: string, ref: GoalRef, reason: GoalBlockReason): Promise<GoalView> {
    const view = await this.viewed(cid, (current) => {
      const checked = this.checkRef(current, ref, 'block')
      if (checked.phase !== 'active') throw new GoalError('block 은 활성 목표에만 합니다')
      const { blockedReason: _dropped, ...rest } = checked
      return {
        operation: 'block',
        snapshot: { ...rest, revision: checked.revision + 1, phase: 'blocked', blockedReason: { code: reason.code, message: reason.message } },
        arm: false,
      }
    })
    if (!isView(view)) throw new GoalError('goal block 실패')
    return view.view
  }

  /** 삭제 — 톰스톤으로 내구 히스토리 보존 (dsh clear) */
  async clear(cid: string, ref: GoalRef): Promise<GoalRef> {
    const view = await this.viewed(cid, (current) => {
      const checked = this.checkRef(current, ref, 'clear')
      return { cleared: { id: checked.id, revision: checked.revision } }
    })
    if (!view || !('cleared' in view) || !view.cleared) throw new GoalError('goal clear 실패')
    return view.cleared
  }

  /** 프로세스 로컬 자격 해제 — 내구 상태는 안 건다 (dsh disarm). 드라이버가 내리거나 라운드가 stale 가 됐을 때 */
  disarm(cid: string): void {
    this.armed.delete(cid)
    this.reserved.delete(cid)
  }

  /** 라운드 예약 (dsh reservation) — active+armed+잔량이 있으면 다음 라운드 번호를 잡아 둔다. 없으면 undefined */
  async reserveRound(cid: string): Promise<RoundReservation | undefined> {
    const current = await this.view(cid)
    if (!current || current.phase !== 'active' || !current.armed) return undefined
    if (current.roundsStarted >= current.maxGoalRounds) return undefined
    const reservation = { goalId: current.id, revision: current.revision, round: current.roundsStarted + 1 }
    this.reserved.set(cid, reservation)
    return reservation
  }

  /** 라운드 수용 (dsh admission) — 그 hook 턴이 실제로 시작됐을 때 true. stale(목표 변경·clear·phase) 면 소모 없이 false */
  async admitRound(cid: string): Promise<boolean> {
    const reservation = this.reserved.get(cid)
    if (!reservation) return false
    this.reserved.delete(cid)
    const view = await this.viewed(cid, (current) => {
      if (!current) return undefined
      if (current.id !== reservation.goalId || current.revision !== reservation.revision) return undefined
      if (current.phase !== 'active') return undefined
      if (current.roundsStarted + 1 !== reservation.round || current.roundsStarted + 1 > current.maxGoalRounds) return undefined
      return {
        operation: 'round',
        snapshot: { ...current, revision: current.revision + 1 },
        roundsOverride: current.roundsStarted + 1,
      }
    })
    return isView(view)
  }

  private checkRef(current: GoalView | undefined, ref: GoalRef, action: string): GoalView {
    if (!current) throw new GoalError(`${action} 할 목표가 없습니다`)
    if (current.id !== ref.id || current.revision !== ref.revision) throw new GoalError(`${action} 할 때 목표가 바뀐 것 같습니다 — /goal 로 다시 보세요`)
    return current
  }

  private objective(value: unknown): string {
    const text = typeof value === 'string' ? value.trim() : ''
    if (!text) throw new GoalError('목표(objective)가 비어 있습니다')
    if (text.length > GOAL_OBJECTIVE_MAX) throw new GoalError(`목표가 너무 깁니다 (최대 ${GOAL_OBJECTIVE_MAX}자)`)
    return text
  }

  private cap(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value)) throw new GoalError('라운드 상한은 정수여야 합니다')
    if (value < 1 || value > GOAL_ROUNDS_MAX) throw new GoalError(`라운드 상한은 1~${GOAL_ROUNDS_MAX} 사이여야 합니다`)
    return value
  }

  /** 캡슐화된 읽기-고치기-쓰기 — fold 정본 위에 한 이벤트만 붙인다. undefined 반환이면 바꾸지 않는다.
   *  성공한 내구 변경은 전부 stale 라운드 예약을 버린다 (revision·식별자·phase 가 바뀔 수 있다) */
  private async viewed(cid: string, decide: (current: GoalView | undefined) => Mutation | undefined): Promise<MutationResult> {
    const next = this.queue.then(async (): Promise<MutationResult> => {
      const stored = await this.read()
      const log = stored.goals[cid]
      const current = foldGoalLog(log)
      const view = current ? { ...current, armed: this.armed.get(cid) === true } : undefined
      const decision = decide(view)
      if (decision === undefined) return null
      if ('cleared' in decision) {
        const now = Date.now()
        const log2: GoalLog = { events: [...(log?.events ?? []), { kind: 'goal/change', version: 1, operation: 'clear', cleared: decision.cleared, clearedAt: now }] }
        stored.goals[cid] = log2
        this.armed.delete(cid)
        this.reserved.delete(cid)
        await writeJsonFile(this.opts.file, stored)
        this.ctx.emit('goal/changed', cid, undefined)
        return { cleared: decision.cleared }
      }
      const now = Date.now()
      const event: GoalEvent = {
        kind: 'goal/change',
        version: 1,
        operation: decision.operation,
        goal: decision.snapshot,
        roundsStarted: decision.roundsOverride ?? view?.roundsStarted ?? 0,
        createdAt: view?.createdAt ?? now,
        updatedAt: now,
      }
      const log2: GoalLog = { events: [...(log?.events ?? []), event] }
      stored.goals[cid] = log2
      if (decision.arm !== undefined) this.armed.set(cid, decision.arm)
      this.reserved.delete(cid)
      await writeJsonFile(this.opts.file, stored)
      const after = foldGoalLog(log2)
      const afterView = after ? { ...after, armed: this.armed.get(cid) === true } : undefined
      this.ctx.emit('goal/changed', cid, afterView)
      return { view: afterView! }
    })
    this.queue = next.catch(() => {})
    return next
  }

  /** 쓰는 길 — 못 읽으면 던진다 (sessions.ts 와 같은 이유: 손상된 파일 위에서 빈 값으로 덮어 쓰지 않는다) */
  private async read(): Promise<Stored> {
    let parsed: Partial<Record<keyof Stored, unknown>> | undefined
    try {
      parsed = (await readJsonFile(this.opts.file, 'object')) as Partial<Record<keyof Stored, unknown>> | undefined
    } catch (error) {
      throw unreadableFileError(this.opts.file, error)
    }
    const goals: Record<string, GoalLog> = {}
    if (parsed?.goals && typeof parsed.goals === 'object') {
      for (const [cid, value] of Object.entries(parsed.goals)) {
        const entry = value as Partial<GoalLog> | null
        if (entry && Array.isArray(entry.events) && entry.events.length > 0) goals[cid] = { events: entry.events as GoalLog['events'] }
      }
    }
    return { goals }
  }
}

function isView(result: MutationResult): result is { view: GoalView } {
  return result !== null && 'view' in result
}
