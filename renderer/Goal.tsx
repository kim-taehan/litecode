import { memo, useEffect, useState } from 'react'
import { GOAL_MAX_ROUNDS, goalActions, goalHeadline, type Goal } from '../shared/goal.ts'
import { useT } from './settingsStore.ts'
import './goal.css'

// 목표 줄 (이슈 #285) — 입력 카드 위에 붙은 얇은 판 하나: "목표 · <첫 줄 말줄임> · 자동 이어가기 n/8회 · [일시 정지|계속] [지우기]".
// 새 시각 언어를 만들지 않는다 — 할 일 줄(TodoDock)·대기열 판(QueueDock)과 같은 판 치수·글자·버튼 모양(goal.css). 판이 여럿이면 목표가 맨 위다
// (목표 → 할 일 → 대기열 → 입력 카드: 오래 가는 것이 위, 곧 보낼 것이 카드 쪽). 상태·라운드는 메인(ctx.goal)이 쥐고 화면은 그린다.

/** 지금 대화의 목표 — 바뀌면(goal:changed) 다시 그린다. 기능이 꺼졌거나 대화가 없으면 undefined */
export function useGoal(on: boolean, conversationId: string | undefined): Goal | undefined {
  const [state, setState] = useState<{ id: string; goal: Goal | null }>()
  useEffect(() => {
    setState(undefined)
    if (!on || !conversationId) return
    // 읽기보다 알림이 늦게 왔을 수도, 먼저 왔을 수도 있다 — 알림을 한 번이라도 들었으면 읽은 값(더 옛것일 수 있다)은 버린다
    let heard = false
    const off = window.litecode.onGoalChanged((id, goal) => {
      if (id !== conversationId) return
      heard = true
      setState({ id, goal })
    })
    void window.litecode.goal(conversationId).then(
      (goal) => !heard && setState({ id: conversationId, goal }),
      () => {},
    )
    return () => {
      heard = true
      off()
    }
  }, [on, conversationId])
  return state && state.id === conversationId ? (state.goal ?? undefined) : undefined
}

function FlagIcon() {
  return (
    <svg className="goal-dock__icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 14V2.5M3.5 3H11.5L10 5.75L11.5 8.5H3.5" />
    </svg>
  )
}

interface GoalDockProps {
  goal: Goal
  onCommand(action: 'pause' | 'resume' | 'clear'): void
}

/** memo — 입력창에 글자를 칠 때마다 다시 그리지 않게 (onCommand 는 같은 대화면 매번 같은 일을 한다) */
export const GoalDock = memo(
  function GoalDock({ goal, onCommand }: GoalDockProps) {
    const t = useT()
    const status =
      goal.status === 'active'
        ? t('goal.rounds', { rounds: goal.rounds, max: GOAL_MAX_ROUNDS })
        : goal.status === 'paused' && goal.reason
          ? `${t('goal.status.paused')} · ${t(`goal.reason.${goal.reason}`)}`
          : goal.note
            ? `${t(`goal.status.${goal.status}`)} · ${goal.note}`
            : t(`goal.status.${goal.status}`)
    return (
      <section className="goal-dock" aria-label={t('goal.title')} data-status={goal.status}>
        <div className="goal-dock__head">
          <FlagIcon />
          <span className="goal-dock__title">{t('goal.title')}</span>
          <span className="goal-dock__text" title={goal.text}>
            {goalHeadline(goal.text)}
          </span>
          <span className="goal-dock__status" title={goal.status === 'active' ? t('goal.roundsHint', { max: GOAL_MAX_ROUNDS }) : status}>
            {status}
          </span>
          {goalActions(goal).map((action) => (
            <button key={action} type="button" className="goal-dock__action" onClick={() => onCommand(action)}>
              {t(`goal.${action}`)}
            </button>
          ))}
        </div>
      </section>
    )
  },
  (before, after) => before.goal === after.goal,
)
