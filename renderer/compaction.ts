import type { TurnItem } from '../shared/ipc.ts'

// 자동 요약(opencode compaction) 의 화면 쪽 계산 — 근거 _workspace/01o_compaction.md

export type CompactionItem = Extract<TurnItem, { kind: 'compaction' }>

/** opencode 가 문턱에서 빼는 출력 몫 — 레거시는 limit.input 이 없으면 문턱 = context − 출력 한도이고, 우리 limit.output 은 0(모름)이라
 *  opencode 기본 출력 한도 32000(OUTPUT_TOKEN_MAX)을 뺀다 (이슈 #20 L2 — 1.18.18 코드 `context − (min(output, 32000) || 32000)`).
 *  신규 세대의 compaction.reserved(20000)는 레거시 문턱에 안 쓰인다 */
export const COMPACTION_OUTPUT_RESERVE = 32_000
/** 이보다 작은 컨텍스트 길이에선 요약이 끝없이 돈다 — 문턱(context − 32000)이 시스템 프롬프트·도구 정의(~1만 2천 토큰: 가짜 LLM 이 받은 요청 글
 *  ~2만 6천 자 + 도구 정의)와 요약 글보다 작으면 요약한 뒤 바로 다시 넘친다(01w 요약 루프 — ctx.llm 이 한 턴 3번에서 끊는다). 설정이 경고한다 */
export const COMPACTION_MIN_CONTEXT = 48_000

/** 압축 문턱 — 보고된 토큰(마지막 스텝의 입력 + 출력)이 몇 토큰·몇 % 를 넘으면 그 스텝 뒤에 요약하는가. 한도를 모르거나 문턱이 0 이하면 없다.
 *  게이트웨이가 한도 초과로 거절해도 요약한다 — 그것은 문턱과 무관하다 */
export function compactionThreshold(limit: number | undefined): { tokens: number; percent: number } | undefined {
  if (!limit || limit <= COMPACTION_OUTPUT_RESERVE) return undefined
  const tokens = limit - COMPACTION_OUTPUT_RESERVE
  return { tokens, percent: Math.round((tokens * 100) / limit) }
}

/** 설정 > 모델 — 적었지만 너무 작은 컨텍스트 길이 */
export function isLowContext(contextLength: number | undefined): boolean {
  return contextLength !== undefined && contextLength > 0 && contextLength < COMPACTION_MIN_CONTEXT
}

/** 끝난 턴의 진행 줄에서 압축 줄을 뺀다 — 압축은 답 머리 위 구분선으로 따로 그린다(작업 접기에 안 섞이게). 실패한 압축은 버린다 */
export function takeCompactions(items: readonly TurnItem[]): { compactions: CompactionItem[]; rest: Exclude<TurnItem, CompactionItem>[] } {
  const compactions: CompactionItem[] = []
  const rest: Exclude<TurnItem, CompactionItem>[] = []
  for (const item of items) {
    if (item.kind !== 'compaction') rest.push(item)
    else if (item.status === 'done') compactions.push(item)
  }
  return { compactions, rest }
}
