import type { ConversationStatus, NoticeState } from '../shared/ipc.ts'

// 알림 점을 프로젝트 단위로 모은다 — 대화 행 점은 상태 그대로, 프로젝트 행·전환 버튼은 그 프로젝트에서 가장 급한 것 하나

/** 급한 순서 — dsh ui-session: 대기 > 실행 중 > 안 본 완료 (실패는 완료보다 앞, 중단은 맨 뒤) */
const RANK: ConversationStatus[] = ['attention', 'running', 'failed', 'done', 'interrupted']

function top(statuses: ConversationStatus[]): ConversationStatus | undefined {
  return RANK.find((status) => statuses.includes(status))
}

/** 팝오버 행 점 — 그 프로젝트 대화 중 가장 급한 상태 */
export function projectStatus(state: NoticeState, project: string): ConversationStatus | undefined {
  return top(Object.values(state).filter((entry) => entry.project === project).map((entry) => entry.status))
}

/** 전환 버튼 점 — 지금 안 보는 프로젝트에 확인할 것(답 필요·안 본 끝남)이 있나. 실행 중은 넣지 않는다 */
export function otherProjectsStatus(state: NoticeState, current: string | undefined): ConversationStatus | undefined {
  return top(Object.values(state).filter((entry) => entry.project !== current && entry.status !== 'running').map((entry) => entry.status))
}
