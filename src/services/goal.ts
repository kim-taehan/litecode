import { Context, Service } from 'cordis'
import './chat.ts'
import './sessions.ts'
import { tr } from '../i18n.ts'
import { fromPerson, type ChatEventMap, type ChatOrigin } from '../../shared/chat.ts'
import {
  GOAL_MAX_ROUNDS,
  createGoal,
  finishGoal,
  goalHeadline,
  goalRoundPrompt,
  goalStartPrompt,
  nextRound,
  parseGoalCommand,
  pauseGoal,
  resumeGoal,
  type Goal,
  type GoalPauseReason,
} from '../../shared/goal.ts'

// 목표 (ctx.goal, 이슈 #285 — dsh goal·command-goal·goal-round-driver 의 아이디어, 규칙·전이는 shared/goal.ts).
// "이 목표가 끝날 때까지 계속": 대화마다 목표 하나를 sessions.json 의 그 대화(Conversation.goal)에 둔다. 아직 저장 안 된 새 대화(`/goal` 이 첫 입력)는
// 그 대화의 첫 턴이 시작될 때까지 메모리에 들고 있다가 그때 적는다.
//
// 자동 이어가기 (driver): 'chat/turn-ended' 에 목표가 진행 중이고 그 대화가 쉬면(도는 턴·대기열 없음) 다음 라운드를 출처 'goal' 로 보낸다.
// 폭주 막기 — 아래면 보내지 않고 paused(사유):
// - ■ 중지로 끝난 턴(stopped) · 오류로 끝난 턴(failed) · 승인·질문을 거절해 끝난 턴(declined) · 승인·질문 카드가 뜸(attention)
// - 연속 자동 라운드 GOAL_MAX_ROUNDS 번(limit) — `/goal resume` 이 다시 센다. 사람이 직접 보낸 턴이 시작되면 연속이 끊겨 0 부터
// - 앱(또는 이 기능)을 다시 켜면 진행 중이던 목표는 restart — 저절로 다시 이어 가지 않는다
// 사람 글이 대기열에 있으면 그것이 먼저 간다(그 턴이 끝난 뒤 다시 본다). 백그라운드 하위 작업(#319)이 도는 동안은 라운드를 보내지 않는다 — 결과 턴
// (출처 'task')은 라운드로 세지 않고 연속도 끊지 않으며, 남은 작업이 없을 때 그 턴이 끝나면 이어 간다. 목표를 멈추거나 지워도 도는 작업은 그대로다. 모델이 done·blocked 를 알리면(appMcp/tools/goal.ts) 다음 라운드는 없다.
// 읽고-고치고-쓰기는 한 줄로 선다(serial) — 도구의 done 과 턴 끝 판정이 엇갈려 끝난 목표에 라운드를 하나 더 보내지 않게.
// 엔진을 모른다 — 턴은 ctx.chat.send 로만 보낸다.

declare module 'cordis' {
  interface Context {
    goal: GoalService
  }
  interface Events {
    /** 그 대화의 목표가 바뀌었다 (undefined = 지웠다) — 화면이 입력 카드 위 줄을 다시 그린다 */
    'goal/changed'(cid: string, goal: Goal | undefined): void
  }
}

/** `/goal …` 의 답 — message: 입력창 아래 한 줄로 알릴 글(입력은 그대로). send: 화면이 평소 보내기로 보낼 첫 프롬프트(말풍선엔 display) */
export interface GoalReply {
  message?: string
  send?: { text: string; display: string }
}

export class GoalService extends Service {
  static readonly inject = ['chat', 'sessions']

  /** 아직 저장 안 된 대화의 목표 — 첫 턴이 시작되면 sessions 에 옮긴다 */
  private pending = new Map<string, Goal>()
  /** 목표 읽고-고치고-쓰기 한 줄. 맨 앞은 복원(restart) */
  private chain: Promise<unknown>

  constructor(ctx: Context) {
    super(ctx, 'goal')
    this.chain = this.restore().catch((error: unknown) => console.error('[goal] 복원 실패', (error as Error).message))
    ctx.on('chat/turn-started', (data) => void this.started(data).catch(logged))
    ctx.on('chat/turn-attention', ({ cid, requests }) => void (requests.length > 0 && this.pause(cid, 'attention').catch(logged)))
    ctx.on('chat/turn-ended', (data) => void this.ended(data).catch(logged))
    ctx.on('sessions/removed', (ids) => ids.forEach((id) => this.pending.delete(id)))
  }

  /** 그 대화의 목표 (없으면 undefined) */
  async get(cid: string): Promise<Goal | undefined> {
    return this.serial(() => this.load(cid))
  }

  /** `/goal` 과 입력 카드 위 줄의 버튼 — args 는 `/goal` 뒤의 글 (shared/goal.ts parseGoalCommand) */
  async command(cid: string, args: string): Promise<GoalReply> {
    const command = parseGoalCommand(args)
    switch (command.kind) {
      case 'show': {
        const goal = await this.get(cid)
        return { message: goal ? describe(goal) : tr('goal.none') }
      }
      case 'set': {
        const goal = createGoal(command.text)
        await this.mutate(cid, () => goal)
        return { send: { text: goalStartPrompt(goal.text), display: `/goal ${command.text}` } }
      }
      case 'pause':
        return (await this.mutate(cid, (goal) => pauseGoal(goal, 'user'))) ? {} : { message: tr('goal.notActive') }
      case 'resume': {
        if (!(await this.mutate(cid, resumeGoal))) return { message: tr('goal.notResumable') }
        void this.serial(() => this.advance(cid)).catch(logged) // 쉬고 있으면 바로 다음 라운드, 도는 중이면 그 턴이 끝난 뒤
        return {}
      }
      case 'clear':
        return (await this.mutate(cid, (goal) => (goal ? null : undefined))) ? {} : { message: tr('goal.none') }
    }
  }

  /** 모델이 알린 끝 (litecode_goal_update) — 진행 중이거나 멈춘 목표만. 바꾼 목표, 못 바꿨으면 undefined */
  async finish(cid: string, status: 'done' | 'blocked', note?: string): Promise<Goal | undefined> {
    let finished: Goal | undefined
    await this.mutate(cid, (goal) => (finished = finishGoal(goal, status, note)))
    return finished
  }

  private pause(cid: string, reason: GoalPauseReason): Promise<boolean> {
    return this.mutate(cid, (goal) => pauseGoal(goal, reason))
  }

  /** 앱을 다시 켰다(이 기능이 다시 올라왔다) — 진행 중이던 목표는 저절로 이어 가지 않는다 */
  private async restore(): Promise<void> {
    for (const entry of await this.ctx.sessions.list()) {
      const paused = pauseGoal(entry.goal, 'restart')
      if (paused) await this.ctx.sessions.setGoal(entry.id, paused)
    }
  }

  private async started({ cid, origin }: ChatEventMap['turn.started']): Promise<void> {
    // 새 대화의 첫 턴 — 대화가 저장됐다. 메모리의 목표를 옮긴다
    if (this.pending.has(cid)) await this.mutate(cid, (goal) => goal)
    // 사람이 직접 보낸 턴 — 연속 자동 라운드가 끊긴다
    if (fromPerson(origin as ChatOrigin)) await this.mutate(cid, (goal) => (goal?.status === 'active' && goal.rounds > 0 ? { ...goal, rounds: 0 } : undefined))
  }

  private ended({ cid, outcome, message }: ChatEventMap['turn.ended']): Promise<void> {
    return this.serial(async () => {
      const goal = await this.load(cid)
      if (goal?.status !== 'active') return
      if (outcome !== 'done' || message.declined) {
        await this.store(cid, pauseGoal(goal, outcome === 'interrupted' ? 'stopped' : outcome === 'failed' ? 'failed' : 'declined'))
        return
      }
      await this.advance(cid)
    })
  }

  /** (serial 안에서) 진행 중인 목표의 다음 라운드를 보낸다 — 대화가 쉴 때만. 한도에 닿았으면 paused(limit) */
  private async advance(cid: string): Promise<void> {
    const goal = await this.load(cid)
    if (goal?.status !== 'active' || this.busy(cid)) return
    const next = nextRound(goal)
    if (!next) return void (await this.store(cid, pauseGoal(goal, 'limit')))
    // send 는 턴을 곧바로(첫 await 전에) 연다 — 그 사이 온 사람 글은 그 턴에 끼거나 대기열로 간다
    const sending = this.ctx.chat.send(cid, { text: goalRoundPrompt(goal, next.rounds), display: tr('goal.continue', { text: goalHeadline(goal.text) }), origin: 'goal' })
    await this.store(cid, next)
    try {
      await sending
    } catch (error) {
      console.error('[goal] 라운드 보내기 실패', (error as Error).message)
      await this.store(cid, pauseGoal(next, 'failed'))
    }
  }

  /** 도는 턴·대기열이 있거나 백그라운드 작업이 돌면 쉬지 않는 것이다 (#319 — 작업을 기다리며 "계속해" 라운드를 헛쓰지 않게. 작업이 끝나면 그 결과
   *  턴(출처 'task')이 끝날 때 다시 본다) */
  private busy(cid: string): boolean {
    return !!this.ctx.chat.turnOf(cid) || this.ctx.chat.queued(cid) > 0 || this.ctx.chat.tasksRunning(cid) > 0
  }

  /** 한 줄로 세운다 — 한 번 실패해도 다음 것은 돈다 */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work)
    this.chain = next.catch(() => {})
    return next
  }

  /** 읽고 고쳐 쓴다 — change 가 undefined 면 그대로(false), null 이면 지운다. 바꿨으면 true */
  private mutate(cid: string, change: (goal: Goal | undefined) => Goal | null | undefined): Promise<boolean> {
    return this.serial(async () => {
      const next = change(await this.load(cid))
      if (next === undefined) return false
      await this.store(cid, next ?? undefined)
      return true
    })
  }

  private async load(cid: string): Promise<Goal | undefined> {
    return this.pending.get(cid) ?? (await this.ctx.sessions.list()).find((entry) => entry.id === cid)?.goal
  }

  /** 저장된 대화면 sessions 에, 아니면 메모리에 — 그리고 화면에 알린다 */
  private async store(cid: string, goal: Goal | undefined): Promise<void> {
    if (await this.ctx.sessions.setGoal(cid, goal)) this.pending.delete(cid)
    else if (goal) this.pending.set(cid, goal)
    else this.pending.delete(cid)
    this.ctx.emit('goal/changed', cid, goal)
  }
}

/** `/goal` 만 쳤을 때 보이는 한 줄 */
function describe(goal: Goal): string {
  const status = tr(`goal.status.${goal.status}`)
  const why = goal.status === 'paused' && goal.reason ? ` (${tr(`goal.reason.${goal.reason}`)})` : goal.note ? ` (${goal.note})` : ''
  return tr('goal.show', { status: status + why, rounds: goal.rounds, max: GOAL_MAX_ROUNDS, text: goalHeadline(goal.text) })
}

function logged(error: unknown): void {
  console.error('[goal]', (error as Error).message)
}
