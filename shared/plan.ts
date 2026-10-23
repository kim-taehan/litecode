// 계획 모드 (ctx.planReview, 이슈 #626 — dsh packages/plan/plan-mode 의 충실 이식) — 모델 도구나 화면이 쓰는 상수·형상.
// dsh 에서 plan 은 세션 로그의 `plan/mode` 이벤트 fold + 에이전트마다 안내 문단(prompt section)인데, litecode 는
// Conversation.mode (plan 칩) 에 실리고 안내는 engineConfig 의 PLAN_PROMPT 가 한다 — 도구(검토 카드)와 명령(커맨드) 이식이다.

/** 앱 모델 도구 이름 (서버 litecode) — 엔진 권한 규칙(engineConfig)과 화면이 같이 쓴다 */
export const PLAN_EXIT_TOOL = 'litecode_exit_plan_mode'
/** exit_plan_mode 의 plan 본문 상한 (글자) */
export const PLAN_MAX = 20000

/** 'plan/review' 이벤트·IPC 에 실리는 검토 카드 */
export interface PlanReviewCard {
  id: string
  /** 검토를 요청한 대화 */
  cid: string
  /** markdown — `#` 헤딩으로 시작한다 */
  plan: string
}
