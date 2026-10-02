import { useT } from './settingsStore.ts'
import './background.css'

// 백그라운드 진행 드러내기 (01l §5 A, 사용자 결정 2026-10-02) — 대화 하나가 곧 백그라운드 작업이다. 정본은 알림 플러그인의 NoticeState
// (backgroundView.ts). 모양은 dsh 사이드바 섹션 머리·StateDot 치수를 따른다

/** 도는 대화 수 — 숨 쉬는 회색 점(알림의 실행 중 점과 같은 모양, 클래스는 따로 — `.notice-dot` 셀렉터에 안 걸리게) 옆에 숫자. 프로젝트 전환 카드·팝오버 행 */
export function RunningCount({ count, label, className }: { count: number; label: string; className?: string }) {
  if (count === 0) return null
  return (
    <span className={`running-count${className ? ` ${className}` : ''}`} role="img" aria-label={label} title={label}>
      <span className="running-dot" aria-hidden="true" />
      {count}
    </span>
  )
}

/** 대화 목록 머리 오른쪽 "진행 중 N" — 누르면 도는 대화만 보이고, 다시 누르면 전부. 도는 것이 없으면 없다 */
export function RunningFilter({ count, on, onToggle }: { count: number; on: boolean; onToggle(): void }) {
  const t = useT()
  if (count === 0) return null
  return (
    <button
      type="button"
      className="running-filter"
      aria-pressed={on}
      title={on ? t('sidebar.runningAll') : t('sidebar.runningOnly')}
      onClick={onToggle}
    >
      <span className="running-dot" aria-hidden="true" />
      {t('sidebar.running', { count })}
    </button>
  )
}
