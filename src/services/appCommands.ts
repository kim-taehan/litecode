import { Context, Service } from 'cordis'
import { GoalError, type GoalView } from '../../shared/goal.ts'
import { DEFAULT_MODE, type Mode } from '../../shared/modes.ts'
import { tr } from '../i18n.ts'
import './goals.ts'
import './sessions.ts'
import './chat.ts'
import './planReview.ts'

// 앱 명령 (ctx.appCommands, 이슈 #626) — `/goal`·`/plan` 의 본문. 화면(슬래시 메뉴·GoalDock 버튼)은 입력 방식일 뿐이며
// 파싱·실행·결과 텍스트는 여기다 (dsh packages/goal/command-goal + packages/plan/command 의 파싱·상태 흐름 그대로).
// 결과 텍스트는 사람 글이라 i18n(한국어 기본)이다.

declare module 'cordis' {
  interface Context {
    appCommands: AppCommandsService
  }
}

export class AppCommandsService extends Service {
  static readonly inject = ['goals', 'sessions', 'chat', 'planReview']

  constructor(ctx: Context) {
    super(ctx, 'appCommands')
  }

  /** 앱 명령 하나를 돌려 결과 줄(사람 글)을 준다. sent 는 그 명령이 메시지를 보냈는지 (말풍선이 화면에 가서 결과 줄은 안 그림) */
  async run(cid: string, command: 'goal' | 'plan', args?: string): Promise<{ text: string; sent?: boolean }> {
    const input = (args ?? '').trim()
    if (command === 'goal') return { text: await this.goal(cid, input) }
    return this.plan(cid, input)
  }

  // ---------- /goal (dsh command-goal 의 파싱·흐름은 그대로) ----------

  private async goal(cid: string, input: string): Promise<string> {
    const control = input.toLowerCase()
    const current = await this.ctx.goals.view(cid)
    try {
      if (input === '') return current ? this.renderGoal('goal.created', current) : tr('goal.none')
      if (control === 'clear') {
        if (!current) return tr('goal.noClear')
        await this.ctx.goals.clear(cid, refOf(current))
        return tr('goal.cleared')
      }
      if (control === 'pause') {
        if (!current) return missingGoal('pause')
        return this.renderGoal('goal.paused', await this.ctx.goals.pause(cid, refOf(current)))
      }
      if (control === 'resume') {
        if (!current) return missingGoal('resume')
        return this.renderGoal('goal.resumed', await this.ctx.goals.resume(cid, refOf(current)))
      }
      if (control === 'edit') return tr('goal.editNeeds')
      if (/^edit\s/.test(control)) {
        const objective = input.slice(4).trim()
        if (!current) return missingGoal('edit')
        if (current.phase === 'complete') return this.renderGoal('goal.created', await this.ctx.goals.create(cid, { objective }))
        return this.renderGoal('goal.updated', await this.ctx.goals.edit(cid, refOf(current), { objective }))
      }
      // 그 외 인자 전체 = 새 목표 (dsh: arbitrary other input is an objective)
      if (current && current.phase !== 'complete') return tr('goal.already', { phase: phaseLabel(current.phase) })
      return this.renderGoal('goal.created', await this.ctx.goals.create(cid, { objective: input }))
    } catch (error) {
      if (error instanceof GoalError) return tr('goal.invalid')
      throw error
    }
  }

  /** dsh renderGoal — compare-and-set 은 안 보인다 */
  private renderGoal(titleKey: 'goal.created' | 'goal.updated' | 'goal.paused' | 'goal.resumed', goal: GoalView): string {
    const blocker = goal.phase === 'blocked' && goal.blockedReason ? [tr('goal.blocker', { message: goal.blockedReason.message })] : []
    return [
      tr(titleKey),
      tr('goal.status', { phase: phaseLabel(goal.phase) }),
      ...blocker,
      tr('goal.objective', { objective: goal.objective }),
      tr('goal.rounds', { started: goal.roundsStarted, max: goal.maxGoalRounds }),
      tr(goal.armed ? 'goal.armed' : 'goal.disarmed'),
      '',
      tr('goal.commands', { hints: commandHint(goal) }),
    ].join('\n')
  }

  // ---------- /plan (dsh plan-mode 명령의 흐름은 그대로) ----------

  private async plan(cid: string, input: string): Promise<{ text: string; sent?: boolean }> {
    const conversation = (await this.ctx.sessions.list()).find((entry) => entry.id === cid)
    if (!conversation) throw new Error('There is no such conversation')
    const control = input.toLowerCase()
    const setPlan = (back: Mode | undefined) =>
      this.ctx.sessions.patch(cid, () => ({ mode: 'plan' as Mode, ...(isPlanBack(back) && { planBack: back }) }))
    if (conversation.mode === 'plan') {
      if (input === '') return { text: tr('plan.already') }
      if (control === 'off') {
        await this.exitPlan(conversation)
        this.ctx.emit('chat/conversations-changed', { project: conversation.project, removed: [] })
        return { text: tr('plan.ended') }
      }
      await this.ctx.chat.send(cid, { text: input, mode: 'plan' })
      return { text: tr('plan.sent'), sent: true }
    }
    if (control === 'off') return { text: tr('plan.notIn') }
    const back = isPlanBack(conversation.mode) ? conversation.mode : undefined
    await setPlan(back)
    this.ctx.emit('chat/conversations-changed', { project: conversation.project, removed: [] })
    if (input === '') return { text: tr('plan.entered') }
    await this.ctx.chat.send(cid, { text: input, mode: 'plan' })
    return { text: tr('plan.enteredSent'), sent: true }
  }

  /** planBack(계획 진입 직전 모드, 없으면 기본 모드)로 돌아온다 */
  private async exitPlan(conversation: { id: string; planBack?: Mode }): Promise<void> {
    const back: Mode = isPlanBack(conversation.planBack) ? conversation.planBack : DEFAULT_MODE
    await this.ctx.sessions.patch(conversation.id, () => ({ mode: back }))
  }
}

function isPlanBack(value: Mode | undefined): value is Mode {
  return value !== undefined && value !== 'plan'
}

function refOf(goal: GoalView): { id: string; revision: number } {
  return { id: goal.id, revision: goal.revision }
}

function missingGoal(action: 'pause' | 'resume' | 'edit'): string {
  return tr('goal.missing', { action })
}

function phaseLabel(phase: GoalView['phase']): string {
  return tr(phase === 'active' ? 'goal.phase.active' : phase === 'paused' ? 'goal.phase.paused' : phase === 'blocked' ? 'goal.phase.blocked' : 'goal.phase.complete')
}

/** dsh commandHint — 그 상태의 다음에 쓸 만한 명령 (명령 텍스트라 번역 안 함) */
function commandHint(goal: GoalView): string {
  if (goal.phase === 'active') {
    return goal.armed ? '/goal edit <objective>, /goal pause, /goal clear' : '/goal edit <objective>, /goal resume, /goal clear'
  }
  switch (goal.phase) {
    case 'paused':
    case 'blocked':
      return '/goal edit <objective>, /goal resume, /goal clear'
    case 'complete':
      return '/goal <objective>, /goal clear'
  }
}
