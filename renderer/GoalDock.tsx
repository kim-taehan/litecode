import { useState } from 'react'
import type { GoalView } from '../shared/goal.ts'
import { Markdown } from './Markdown.tsx'
import type { Translate } from './settingsStore.ts'

// 목표 스트립 (이슈 #626) — 지금 대화가 목표가 있을 때 입력 카드 위에 한 줄. 상태와 다음에 쓸 명령 버튼(중지·재개·지우기)을
// 둔다. 버튼은 화면 명령으로 `/goal pause`·`/goal resume`·`/goal clear` 를 돌린다 (메인 ctx.appCommands)

export function GoalDock({ t, goal, onCommand }: { t: Translate; goal: GoalView; onCommand(action: 'pause' | 'resume' | 'clear'): void }) {
  const resumable = goal.phase === 'paused' || goal.phase === 'blocked' || (goal.phase === 'active' && !goal.armed)
  return (
    <div className="goal-dock" role="status">
      <span className="goal-dock__dot" data-phase={goal.phase} aria-hidden />
      <span className="goal-dock__objective" title={goal.objective}>
        {goal.objective}
      </span>
      <span className="goal-dock__meta">
        {t('goal.rounds', { started: goal.roundsStarted, max: goal.maxGoalRounds })} · {t(`goal.phase.${goal.phase}`)}
        {goal.phase === 'blocked' && goal.blockedReason ? ` · ${goal.blockedReason.message}` : ''}
      </span>
      {goal.phase === 'active' && goal.armed && (
        <button type="button" className="goal-dock__button" onClick={() => onCommand('pause')}>
          {t('goal.pause')}
        </button>
      )}
      {resumable && (
        <button type="button" className="goal-dock__button" onClick={() => onCommand('resume')}>
          {t('goal.resume')}
        </button>
      )}
      <button type="button" className="goal-dock__button goal-dock__button--muted" onClick={() => onCommand('clear')} title={t('goal.clearConfirm')}>
        {t('goal.clear')}
      </button>
    </div>
  )
}

// 계획 검토 카드 (이슈 #626) — litecode_exit_plan_mode 도구가 완성된 계획을 띄우면 대화 끝에 그려진다.
// 승인 → 모드가 planBack 으로 돌아오고 도구가 성공, 계속 계획 → 피드백과 함께 도구가 실패해 모델이 다시 세운다 (dsh)

export function PlanReviewCard({ t, plan, onAnswer }: { t: Translate; plan: string; onAnswer(decision: 'approve' | 'revise', feedback?: string): void }) {
  const [feedback, setFeedback] = useState('')
  function revise(): void {
    const text = feedback.trim()
    onAnswer('revise', text || undefined)
    setFeedback('')
  }
  return (
    <div className="plan-review">
      <div className="plan-review__title">{t('plan.review.title')}</div>
      <div className="plan-review__plan markdown">
        <Markdown text={plan} />
      </div>
      <div className="plan-review__actions">
        <button type="button" className="settings-button settings-button--primary plan-review__approve" onClick={() => onAnswer('approve')}>
          {t('plan.review.approve')}
        </button>
        <div className="plan-review__revise">
          <input
            type="text"
            className="plan-review__feedback"
            value={feedback}
            placeholder={t('plan.review.feedbackPlaceholder')}
            onChange={(event) => setFeedback(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                revise()
              }
            }}
          />
          <button type="button" className="settings-button plan-review__revise-button" onClick={revise}>
            {t('plan.review.revise')}
          </button>
        </div>
      </div>
    </div>
  )
}
