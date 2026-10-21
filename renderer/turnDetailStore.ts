import { useSyncExternalStore } from 'react'
import type { TurnItem } from '../shared/ipc.ts'
import { upsertItem } from '../shared/chatReducer.ts'

// 오른쪽 패널 "턴 작업" 탭 (이슈 #416) 의 데이터 — 도는 턴의 진행 줄을 채팅 이벤트(useChatEvents)에서 실시간으로 받아 넣고,
// 턴이 끝나면 끝난 답의 items(turn.ended 의 message.items)로 통째 바꾼다. 새 데이터는 없다 — 채팅의 진행 줄과 같은 출처다.
// 열쇠는 (대화 id, 보낸 시각) — 턴마다 하나. 화면이 (재)뜰 때 메인이 쥔 도는 턴은 App 이 스냅샷으로 한 번에 넣어 준다(feedTurnSnapshot).
// 오래된 기록은 상한만 거른다(메모리 저장소 — 탭은 남을 수 있지만 데이터는 상한까지)

export interface TurnDetail {
  items: TurnItem[]
  /** 보낸 시각(ms) — 채팅 도는 턴의 sentAt 과 같은 값 */
  startedAt: number
  /** 턴이 끝나면 있다 */
  endedAt?: number
  /** 끝난 턴의 걸린 시간(ms) */
  duration?: number
  failed?: boolean
  interrupted?: boolean
  declined?: boolean
}

/** 기억할 턴 기록 개수 — 넘으면 가장 오래된 것부터 걷는다 */
const MAX_ENTRIES = 50

const entries = new Map<string, TurnDetail>()
/** 도는 턴 — 대화 id → 보낸 시각 (진행 줄은 대화 id 로만 와서 지금 도는 턴을 알아야 넣을 자리가 있다) */
const active = new Map<string, number>()
let order: string[] = []
const listeners = new Set<() => void>()

function keyOf(conversationId: string, startedAt: number): string {
  return `${conversationId}:${startedAt}`
}

function emit(): void {
  for (const listener of listeners) listener()
}

function put(detail: TurnDetail, key: string): void {
  const had = entries.has(key)
  entries.set(key, detail)
  if (!had) {
    order = [...order.filter((entry) => entry !== key), key]
    while (order.length > MAX_ENTRIES) {
      const dropped = order.shift()
      if (dropped !== undefined) entries.delete(dropped)
    }
  }
  emit()
}

/** 턴 시작 — 보낸 시각(message.at)이 열쇠의 시간. 이미 있으면 그대로 둔다(같은 시각이면 같은 턴) */
export function feedTurnStarted(conversationId: string, startedAt: number): void {
  active.set(conversationId, startedAt)
  if (!entries.has(keyOf(conversationId, startedAt))) put({ items: [], startedAt }, keyOf(conversationId, startedAt))
}

/** 진행 줄 하나 — 같은 id 면 통째로 바꾼다. 도는 턴을 모르면(시작 이벤트 전·끝난 뒤) 버린다 */
export function feedTurnItem(conversationId: string, item: TurnItem): void {
  const startedAt = active.get(conversationId)
  const existing = startedAt === undefined ? undefined : entries.get(keyOf(conversationId, startedAt))
  if (existing === undefined) return
  put({ ...existing, items: upsertItem(existing.items, item) }, keyOf(conversationId, startedAt!))
}

/** 턴 끝 — 끝난 답의 items 로 바꿈(없으면 지금 것 남김) + 소요·실패 표식 */
export function feedTurnEnded(
  conversationId: string,
  message: { items?: TurnItem[]; duration?: number; error?: string; interrupted?: boolean; declined?: boolean },
): void {
  const startedAt = active.get(conversationId)
  if (startedAt === undefined) return
  active.delete(conversationId)
  const existing = entries.get(keyOf(conversationId, startedAt))
  if (existing === undefined) return
  put(
    {
      ...existing,
      items: message.items && message.items.length > 0 ? [...message.items] : existing.items,
      endedAt: Date.now(),
      ...(message.duration !== undefined && { duration: message.duration }),
      ...(message.error !== undefined && { failed: true }),
      ...(message.interrupted === true && { interrupted: true }),
      ...(message.declined === true && { declined: true }),
    },
    keyOf(conversationId, startedAt),
  )
}

/** 메인이 쥔 지금 모습 — 화면이 (재)뜰 때 도는 턴을 이어 넣는다 (App 의 chatSnapshot) */
export function feedTurnSnapshot(conversationId: string, startedAt: number, items: readonly TurnItem[]): void {
  active.set(conversationId, startedAt)
  put({ items: [...items], startedAt }, keyOf(conversationId, startedAt))
}

/** 끝난 턴의 기록을 보충한다 — 상한 밖으로 걷힌 오래된 턴을 사용자가 열 때 채팅의 items 로 넣는다. 이미 있으면 그대로 둔다 */
export function feedCompletedTurn(
  conversationId: string,
  startedAt: number,
  items: readonly TurnItem[],
  meta?: { duration?: number; failed?: boolean; interrupted?: boolean; declined?: boolean },
): void {
  const key = keyOf(conversationId, startedAt)
  if (entries.has(key)) return
  put(
    {
      items: [...items],
      startedAt,
      endedAt: Date.now(),
      ...(meta?.duration !== undefined && { duration: meta.duration }),
      ...(meta?.failed === true && { failed: true }),
      ...(meta?.interrupted === true && { interrupted: true }),
      ...(meta?.declined === true && { declined: true }),
    },
    key,
  )
}

export function turnDetail(conversationId: string, startedAt: number): TurnDetail | undefined {
  return entries.get(keyOf(conversationId, startedAt))
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** (대화, 보낸 시각) 턴의 기록 — 턴 탭이 실시간으로 본다 */
export function useTurnDetail(conversationId: string, startedAt: number): TurnDetail | undefined {
  return useSyncExternalStore(subscribe, () => turnDetail(conversationId, startedAt))
}
