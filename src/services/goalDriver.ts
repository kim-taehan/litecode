import { Context, Service } from 'cordis'
import { goalRoundPrompt } from '../../shared/goal.ts'
import type { AfterTurn } from './chat.ts'
import type { ChatEventMap } from '../../shared/chat.ts'

// 목표 라운드 드라이버 (ctx.goalDriver, 이슈 #626) — dsh packages/goal/goal-round-driver 의 충실 이식.
//
// - 턴이 **완전히 끝났을 때만**('chat/after-turn', 실패·중단·거절은 아니다) 지금의 목표가 active+armed+라운드 잔량 있고,
//   대기열·백그라운드 작업이 없으면 다음 라운드를 **예약**하고 목표 프롬프트를 'hook' 다음 턴으로 보낸다 (followUp)
// - 그 hook 턴이 실제로 시작했을 때만 라운드가 '수용'(admitRound) 된다 — dsh 의 reservation→admission
// - 라운드 턴의 운명: 실패(failed)면 자동 이어가기 자격만 내려(dsh disarm), 중단(interrupted, ■)되면 일시중지(pause)
// - 라운드 잔량이 다 쓰이면 다음 턴 끝에서 round-limit 으로 차단(block)

declare module 'cordis' {
  interface Context {
    goalDriver: GoalRoundDriver
  }
}

export class GoalRoundDriver extends Service {
  static readonly inject = ['goals', 'chat']

  /** 라운드를 제안한 대화 → undefined(아직 시작 안 함) | null(시작했으나 메시지 id 가 없음) | 기대 메시지 id. 'hook' 턴의 시작·끝으로 소모한다 */
  private waiting = new Map<string, string | null | undefined>()

  constructor(ctx: Context) {
    super(ctx, 'goalDriver')
    ctx.on('chat/after-turn', (turn) => {
      void this.afterTurn(turn).catch((error: unknown) => console.error('[goalDriver] after-turn 실패', (error as Error).message))
    })
    ctx.on('chat/turn-started', (data) => {
      void this.turnStarted(data).catch((error: unknown) => console.error('[goalDriver] turn-started 실패', (error as Error).message))
    })
    ctx.on('chat/turn-ended', (data) => {
      void this.turnEnded(data).catch((error: unknown) => console.error('[goalDriver] turn-ended 실패', (error as Error).message))
    })
    ctx.on('sessions/removed', (ids) => {
      for (const cid of ids) {
        this.waiting.delete(cid)
        this.ctx.goals.disarm(cid)
        // 지운 대화의 목표는 파일에서도 정리 (goals.json 의 고아 항목 방지)
        void this.clearGoalOf(cid)
      }
    })
  }

  /** 이 대화의 자동 라운드 턴이 도는 중인가 (dsh requireDirectHuman·completionAuthority 의 litecode 판정) —
   *  create·edit·pause·resume 은goal 라운드 안에서 안 된다, complete·blocked 만 된다 */
  inRound(cid: string): boolean {
    const waiting = this.waiting.get(cid)
    return waiting === null || typeof waiting === 'string'
  }

  private async clearGoalOf(cid: string): Promise<void> {
    const view = await this.ctx.goals.view(cid)
    if (view) await this.ctx.goals.clear(cid, { id: view.id, revision: view.revision })
  }

  private async afterTurn(turn: AfterTurn): Promise<void> {
    if (turn.outcome !== 'done' || turn.declined) return
    if (this.ctx.chat.queued(turn.cid) > 0) return // 사람이 보낼 것이 남아 있으면
    if (this.ctx.chat.tasksRunning(turn.cid) > 0) return // 백그라운드 작업이 도는 동안은
    const view = await this.ctx.goals.view(turn.cid)
    if (!view || view.phase !== 'active' || !view.armed) return
    if (view.roundsStarted >= view.maxGoalRounds) {
      await this.ctx.goals.block(turn.cid, { id: view.id, revision: view.revision }, { code: 'round-limit', message: 'Achieved the round limit' })
      return
    }
    const reservation = await this.ctx.goals.reserveRound(turn.cid)
    if (!reservation) return
    this.waiting.set(turn.cid, undefined)
    turn.followUp = goalRoundPrompt(view.objective, reservation.round, view.maxGoalRounds)
  }

  private async turnStarted(data: ChatEventMap['turn.started']): Promise<void> {
    if (data.origin !== 'hook') return
    if (!this.waiting.has(data.cid)) return // 이 hook 턴은 우리 라운드가 아니다 (다른 확장점의 followUp)
    const admitted = await this.ctx.goals.admitRound(data.cid)
    if (admitted) this.waiting.set(data.cid, data.message.id ?? null)
    else this.waiting.delete(data.cid) // 예약이 stale — 이 턴은 우리 라운드 아님, 다음 hook 턴도 안 기대한다
  }

  private async turnEnded(data: ChatEventMap['turn.ended']): Promise<void> {
      const expected = this.waiting.get(data.cid)
    if (expected === undefined) return // 라운드 턴이 아직 시작 안 됨 (대기열) — 시작·끝에서 처리된다
    if (expected === null || expected === data.message.id) {
      this.waiting.delete(data.cid)
      const view = await this.ctx.goals.view(data.cid)
      if (!view) return
      const ref = { id: view.id, revision: view.revision }
      if (data.outcome === 'failed') {
        // dsh: 실패한 라운드는 자동 이어가기 자격만 내리고 phase 는 둔다 — 사용자가 resume 또는 새 목표로
        this.ctx.goals.disarm(data.cid)
      } else if (data.outcome === 'interrupted') {
        await this.ctx.goals.pause(data.cid, ref).catch(() => undefined) // 목표가 그새 바뀐 것 같으면 무시
      }
    }
    // expected === null — 라운드 턴이 아직 시작 안 됨 (대기열). 다음 시작·끝에서 처리된다
  }
}
