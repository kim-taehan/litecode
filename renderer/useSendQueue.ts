import { useEffect, useReducer, useRef } from 'react'

// 답하는 중에 보낸 메시지 — 화면 큐에 쌓고, 그 대화의 턴이 끝나는 순간 줄바꿈으로 이어 **한 번에** 보낸다 (closed-code
// useSendQueue 방식, 사용자 2026-10-02). 엔진에는 늘 한 턴씩만 간다. opencode 의 delivery(queue) 는 쓰지 않는다 — ctx.llm 의
// admittedSeq 판정으로는 opencode 가 줄 세운 턴을 가르지 못한다 (01n).
//
// - **대화별**이다(closed-code 는 프로젝트별 — litecode 는 대화마다 엔진 세션이 따로라 대화별이 맞다)
// - 정본은 모듈 스토어 — 다른 대화·프로젝트로 옮겨도 그 대화의 턴 끝을 놓치지 않는다. 앱을 끄면 사라진다(메모리)
// - 실패·중단으로 끝나도 보낸다 (closed-code 와 같다 — "턴이 더는 안 돈다" 가 기준)
// - 보내기는 상태 업데이터 밖에서 한다 — StrictMode 는 업데이터를 두 번 불러 질문이 두 번 간다

/** 쌓이는 한 건 — 보낼 본문과(`/` 명령이면) 말풍선에 보일 글. 필드가 늘어도 mergeQueued 는 고치지 않아도 된다 */
export interface QueuedSend {
  text: string
  display?: string
}

/**
 * 쌓인 것을 하나로 — 본문(과 보일 글)만 줄바꿈으로 잇는다.
 * **필드를 골라 다시 쌓지 않는다**: 마지막 것을 바탕에 깔고 이을 수 있는 것만 덮는다. 고른 필드만 옮기면 나중에 더한 필드
 * (모드·모델 등)가 두 건 이상 쌓였을 때만 조용히 사라진다 (closed-code DC-1322)
 */
export function mergeQueued<T extends QueuedSend>(items: T[]): T {
  const last = items[items.length - 1]!
  if (items.length === 1) return last
  const merged: T = { ...last, text: items.map((item) => item.text).join('\n') }
  if (items.some((item) => item.display !== undefined)) merged.display = items.map((item) => item.display ?? item.text).join('\n')
  return merged
}

export class SendQueues {
  private queues = new Map<string, QueuedSend[]>()
  /** 대화 id → 직전에 본 "턴이 도는 중" */
  private running = new Map<string, boolean>()
  private listeners = new Set<() => void>()

  items(id: string): QueuedSend[] {
    return this.queues.get(id) ?? []
  }

  /** 쌓았으면 true. 턴이 안 돌고 앞에 쌓인 것도 없으면 false — 부른 쪽이 바로 보낸다 */
  submit(id: string, item: QueuedSend, busy: boolean): boolean {
    const current = this.items(id)
    if (!busy && current.length === 0) return false
    this.set(id, [...current, item])
    return true
  }

  /** 입력창으로 되돌리기 — 합친 것을 주고 비운다 */
  take(id: string): QueuedSend | undefined {
    const current = this.items(id)
    if (current.length === 0) return undefined
    this.set(id, [])
    return mergeQueued(current)
  }

  /** 대화의 지금 "턴이 도는 중" 을 알린다 — 돌다가 멈춘 그 순간에만 보낼 것(합친 것)을 주고 큐를 비운다 */
  observe(id: string, busy: boolean): QueuedSend | undefined {
    const was = this.running.get(id) ?? false
    this.running.set(id, busy)
    if (!was || busy) return undefined
    return this.take(id)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  private set(id: string, items: QueuedSend[]): void {
    if (items.length > 0) this.queues.set(id, items)
    else this.queues.delete(id)
    for (const listener of this.listeners) listener()
  }
}

const QUEUES = new SendQueues()

/**
 * 화면 훅 — 모든 대화의 "답 기다리는 중" 을 지켜보다 끝난 대화의 큐를 flush 로 보낸다.
 * flush 는 최신 것을 쓴다(렌더마다 바뀌는 보내기 함수). 반환값은 지금 대화의 미리보기·되돌리기·쌓기
 */
export function useSendQueue(sessions: { id: string; pending?: boolean }[], flush: (id: string, merged: QueuedSend) => void) {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const flushRef = useRef(flush)
  flushRef.current = flush
  useEffect(() => QUEUES.subscribe(bump), [])
  useEffect(() => {
    for (const session of sessions) {
      const merged = QUEUES.observe(session.id, !!session.pending)
      if (merged) flushRef.current(session.id, merged)
    }
  }, [sessions])
  return {
    items: (id: string) => QUEUES.items(id),
    submit: (id: string, item: QueuedSend, busy: boolean) => QUEUES.submit(id, item, busy),
    take: (id: string) => QUEUES.take(id),
  }
}
