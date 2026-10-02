import type { TurnItem } from '../shared/ipc.ts'

// 자동 요약(opencode compaction) 의 화면 쪽 계산 — 근거 _workspace/01o_compaction.md

export type CompactionItem = Extract<TurnItem, { kind: 'compaction' }>

/** opencode 의 compaction.reserved 기본값. 우리 limit.output 은 0 이라 문턱 = context − max(0, 20000) */
export const COMPACTION_RESERVED = 20_000
/** 이보다 작은 컨텍스트 길이에선 첫 요약 뒤 다시 요약하지 못한다(요약 요청이 context − 4096 을 넘음, 01o 2a) — 설정이 경고한다 */
export const COMPACTION_MIN_CONTEXT = 24_000

/** 압축 문턱 — 컨텍스트 몇 토큰·몇 % 를 넘으면 요약을 시도하는가. 한도를 모르거나 문턱이 0 이하면 없다.
 *  opencode 는 보고된 토큰이 아니라 자체 추정(요청 글자/4)으로 판단하고 "밀려난 앞 기록" 이 있어야 돈다 — 넘어도 바로 안 돌 수 있다 */
export function compactionThreshold(limit: number | undefined): { tokens: number; percent: number } | undefined {
  if (!limit || limit <= COMPACTION_RESERVED) return undefined
  const tokens = limit - COMPACTION_RESERVED
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
