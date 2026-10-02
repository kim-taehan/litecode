// 모델 출력 한도 (opencode limit.output) — 메인(엔진 설정)과 화면(문턱 눈금·경고)이 같은 규칙을 쓴다 (이슈 #27).
// 실측 2026-10-02 (opencode 1.18.18 레거시, 가짜 LLM 요청 본문):
// - limit.output = N 이면 모든 LLM 요청(요약 요청 포함)에 max_tokens N 이 실린다. 0/없으면 max_tokens 32000
// - N 이 32000 을 넘으면 max_tokens·문턱 모두 32000 으로 잘린다
// - 자동 요약 문턱 = context − (min(N, 32000) || 32000). context 24000·output 0 은 한 턴에 요약 19번(끝없음), output 4000 은 한 번
// - context 0·output N 이면 max_tokens N 만 실리고 미리 요약하지 않는다

/** opencode 의 출력 한도 상한(OUTPUT_TOKEN_MAX) — 출력 한도가 0 이면 이 값을 쓴다 */
export const ENGINE_OUTPUT_MAX = 32_000

/** 최대 출력을 비웠을 때 앱이 정하는 값 — 컨텍스트 길이의 1/4, 최대 32000. 문턱(context − 출력)이 컨텍스트의 3/4 가 되어
 *  작은 모델(24000 → 6000, 문턱 18000)도 시스템 프롬프트·도구 정의(~1만 토큰)와 요약 뒤에 여유가 남는다. 컨텍스트가 128000 이상이면
 *  지금까지(32000)와 같다. 대가: 그보다 작은 모델은 한 번의 답이 이 값에서 잘린다 — 길게 받아야 하면 최대 출력을 적는다 */
export function defaultOutputLimit(contextLength: number): number {
  return Math.min(ENGINE_OUTPUT_MAX, Math.floor(contextLength / 4))
}

/** opencode.json 모델의 limit — 컨텍스트 길이·최대 출력 둘 다 비면 없다(opencode 기본: max_tokens 32000, 미리 요약 안 함).
 *  output 은 빼면 안 된다(빠지면 설정 파일 전체가 무시된다, 01o) */
export function engineLimit(model: { contextLength?: number; maxOutput?: number }): { context: number; output: number } | undefined {
  if (!model.contextLength && !model.maxOutput) return undefined
  const context = model.contextLength ?? 0
  return { context, output: model.maxOutput ?? defaultOutputLimit(context) }
}

/** opencode 가 실제로 쓰는 출력 한도 — 요청의 max_tokens 이자 문턱에서 빼는 몫 */
export function effectiveOutputLimit(model: { contextLength?: number; maxOutput?: number }): number {
  const output = engineLimit(model)?.output ?? 0
  return Math.min(output, ENGINE_OUTPUT_MAX) || ENGINE_OUTPUT_MAX
}
