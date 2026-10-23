import { Context, Service } from 'cordis'
import { randomUUID } from 'node:crypto'
import { DEFAULT_MODE, isMode, type Mode } from '../../shared/modes.ts'
import './chat.ts'
import './sessions.ts'

// 계획 검토 (ctx.planReview, 이슈 #626) — dsh exit_plan_mode 의 사용자 검토 카드. litecode_exit_plan_mode 도구(appMcp)가
// 완성된 계획을 띄우면 'plan/review' 로 화면이 승인 카드를 그리고:
// - 승인 → 도구가 성공으로 돌아오고 모드는 planBack(계획 진입 직전, 없으면 기본 모드)으로 돌아온다
// - 계속 계획 → 반대로 feedback 이 도구 실패로 돌아가 모델이 다시 계획을 세운다 (dsh Keep planning)
// 도구는 응답이 올 때까지 기다린다 — 승인 카드가 도중 사라져도(대화 교체) 프로세스가 죽기 전엔 답이 온다

declare module 'cordis' {
  interface Context {
    planReview: PlanReviewService
  }
  interface Events {
    /** 계획 검토가 시작됐다 — 화면이 그 대화의 입력 자리를 검토 카드로 대체한다 */
    'plan/review'(data: { id: string; cid: string; plan: string }): void
    /** 검토가 끝났다 (승인·계속 계획·대화 삭제) — 화면이 카드를 닫는다 */
    'plan/review-answered'(id: string): void
  }
}

export class PlanReviewService extends Service {
  static readonly inject = ['sessions', 'chat']

  private pending = new Map<string, { cid: string; resolve: (result: { approved: boolean; feedback?: string }) => void }>()

  constructor(ctx: Context) {
    super(ctx, 'planReview')
  }

  /** 검토를 시작한다 — 화면의 답이 올 때까지 기다린다 */
  start(cid: string, plan: string): Promise<{ approved: boolean; feedback?: string }> {
    const id = `plan-${randomUUID().slice(0, 8)}`
    this.ctx.emit('plan/review', { id, cid, plan })
    return new Promise((resolve) => {
      this.pending.set(id, { cid, resolve })
    })
  }

  /** 화면의 답 — approve 는 모드를 planBack 으로 돌려 준다 */
  answer(id: string, decision: 'approve' | 'revise', feedback?: string): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    if (decision === 'approve') void this.exitPlan(entry.cid)
    entry.resolve({ approved: decision === 'approve', ...(feedback ? { feedback } : {}) })
    this.ctx.emit('plan/review-answered', id)
  }

  /** 지워진 대화의 대기 검토는 그냥 닫는다 (도구는 앱이 살아가는 동안만 돌고, 답이 없으면 그 턴이 엔진 실패로 끝난다) */
  drop(cid: string): void {
    for (const [id, entry] of [...this.pending]) {
      if (entry.cid === cid) {
        this.pending.delete(id)
        entry.resolve({ approved: false })
        this.ctx.emit('plan/review-answered', id)
      }
    }
  }

  /** 계획 모드에서 나가 planBack(없으면 기본 모드)으로 — 저장 시 pick 이 planBack 을 스스로 정리한다 */
  private async exitPlan(cid: string): Promise<void> {
    const conversation = (await this.ctx.sessions.list()).find((entry) => entry.id === cid)
    if (!conversation) return
    await this.ctx.sessions.patch(cid, (entry) => {
      const back = entry.planBack
      const mode: Mode = isMode(back) && back !== 'plan' ? back : DEFAULT_MODE
      return { mode }
    })
    this.ctx.emit('chat/conversations-changed', { project: conversation.project, removed: [] })
  }
}
