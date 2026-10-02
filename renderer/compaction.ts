import type { TurnItem } from '../shared/ipc.ts'
import { effectiveOutputLimit } from '../shared/outputLimit.ts'

// 자동 요약(opencode compaction) 의 화면 쪽 계산 — 근거 _workspace/01o_compaction.md

export type CompactionItem = Extract<TurnItem, { kind: 'compaction' }>

/** 문턱(컨텍스트 길이 − 출력 한도)이 이보다 작으면 요약이 끝없이 돈다 — 시스템 프롬프트·도구 정의(~1만 2천 토큰: 가짜 LLM 이 받은 요청 글
 *  ~2만 6천~3만 2천 자 + 도구 정의)와 요약 글보다 작으면 요약한 뒤 바로 다시 넘친다(01w 요약 루프 — ctx.llm 이 한 턴 3번에서 끊는다).
 *  레거시 문턱 = context − (limit.output 이 0 이면 32000) 이라 출력 한도를 주기 전(#20)의 경고 기준 48000 과 같은 값이다. 설정이 경고한다 */
export const COMPACTION_MIN_THRESHOLD = 16_000

/** 압축 문턱 — 보고된 토큰(마지막 스텝의 입력 + 출력)이 몇 토큰·몇 % 를 넘으면 그 스텝 뒤에 요약하는가. 한도를 모르거나 문턱이 0 이하면 없다.
 *  문턱 = context − 출력 한도(최대 출력, 비면 앱 기본 — shared/outputLimit.ts, 이슈 #27). 신규 세대의 compaction.reserved 는 레거시 문턱에 안 쓰인다.
 *  게이트웨이가 한도 초과로 거절해도 요약한다 — 그것은 문턱과 무관하다 */
export function compactionThreshold(limit: number | undefined, maxOutput?: number): { tokens: number; percent: number } | undefined {
  if (!limit) return undefined
  const tokens = limit - effectiveOutputLimit({ contextLength: limit, maxOutput })
  if (tokens <= 0) return undefined
  return { tokens, percent: Math.round((tokens * 100) / limit) }
}

/** 설정 > 모델 — 적었지만 문턱이 너무 작은 컨텍스트 길이·최대 출력 */
export function isLowContext(model: { contextLength?: number; maxOutput?: number }): boolean {
  if (!model.contextLength || model.contextLength <= 0) return false
  return model.contextLength - effectiveOutputLimit(model) < COMPACTION_MIN_THRESHOLD
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
