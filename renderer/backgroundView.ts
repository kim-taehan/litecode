import type { NoticeState } from '../shared/ipc.ts'

// 백그라운드로 도는 대화 — 정본은 알림 플러그인(ctx.notifications)의 NoticeState. 답 필요(attention)는 세지 않는다 — 그건 이미
// 주황 점으로 따로 보이고(전환 카드·팝오버 행), 겹쳐 세면 같은 대화가 두 번 보인다

function isRunning(status: NoticeState[string]['status']): boolean {
  return status === 'running'
}

/** 그 프로젝트에서 도는 대화 id — 사이드바 "진행 중 N" 과 그 거르기 */
export function runningIn(state: NoticeState, project: string | undefined): string[] {
  if (!project) return []
  return Object.entries(state)
    .filter(([, entry]) => entry.project === project && isRunning(entry.status))
    .map(([id]) => id)
}

/** 지금 프로젝트 밖에서 도는 대화 수 — 프로젝트 전환 카드의 숫자 */
export function runningOutside(state: NoticeState, current: string | undefined): number {
  return Object.values(state).filter((entry) => entry.project !== current && isRunning(entry.status)).length
}
