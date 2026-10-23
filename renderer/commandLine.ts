/** 앱 명령 줄 (이슈 #626) — 엔진에 안 간 내 말(명령 에코)과 그 결과 줄. 임시: 이번 실행 동안만, 리로드면 없다 */
export interface CommandLine {
  id: string
  /** `/goal pause` 처럼 — 친 입력 그대로 */
  echo: string
  /** 메인(ctx.appCommands)의 결과 줄 */
  result: string
}
