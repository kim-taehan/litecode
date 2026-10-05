// 백그라운드로 도는 대화 — 화면이 아는 대화별 pending(chatState.ts — ctx.chat 이벤트·스냅샷)으로 센다. 알림 기능(ctx.notifications)이
// 꺼져 있어도(기본값) 보인다. 안 본 완료·실패·답 필요 점은 알림 기능의 것이다 (noticeView.ts)

interface Running {
  id: string
  project: string
  pending?: boolean
}

/** 그 프로젝트에서 도는 대화 id — 사이드바 "진행 중 N" 과 그 거르기 */
export function runningIn(sessions: readonly Running[], project: string | undefined): string[] {
  if (!project) return []
  return sessions.filter((session) => session.project === project && session.pending).map((session) => session.id)
}

/** 지금 프로젝트 밖에서 도는 대화 수 — 프로젝트 전환 카드의 숫자 */
export function runningOutside(sessions: readonly Running[], current: string | undefined): number {
  return sessions.filter((session) => session.project !== current && session.pending).length
}
