import type { ChatOrigin, QueuedSend } from '../../shared/chat.ts'

// 답하는 중에 보낸 메시지 — 대화별 대기열에 쌓고, 그 대화의 턴이 끝나는 순간 줄바꿈으로 이어 **한 번에** 보낸다 (closed-code
// useSendQueue 방식, 사용자 2026-10-02). 엔진에는 늘 한 턴씩만 간다. opencode 의 delivery(queue) 는 쓰지 않는다.
// 원래 화면(renderer/useSendQueue.ts)이 쥐던 것을 메인의 ctx.chat 이 쥔다 (이슈 #52) — 화면이 둘이어도(모바일) 대기열은 하나다.
//
// - **대화별**이다(closed-code 는 프로젝트별 — litecode 는 대화마다 엔진 세션이 따로라 대화별이 맞다)
// - 앱을 끄면 사라진다(메모리)
// - 실패·중단으로 끝나도 보낸다 (closed-code 와 같다 — "턴이 더는 안 돈다" 가 기준). 단 사용자가 멈춘 턴(■·Esc 두 번)은 보내지 않고
//   입력창으로 되돌린다 (hold — 이슈 #3, 사용자가 멈췄으니)
// - **출처(origin)가 같은 것끼리만 합친다** — 다른 대화가 보낸 지시(이슈 #55)와 사람이 친 글을 한 메시지로 이으면 출처가 사라진다.
//   출처가 다르면 쌓인 순서대로 한 턴씩 간다
// - 붙잡기(hold)는 **사람이 친 글이 쌓여 있을 때만** 건다 — 되돌릴 입력창이 있는 것은 사람 글뿐이다. 다른 대화의 지시만 쌓여 있으면
//   멈춘 턴 뒤에 차례대로 간다 (그 지시는 대기열 줄의 "빼기" 로 뺀다 — drop)

export type { QueuedSend } from '../../shared/chat.ts'

const originOf = (item: QueuedSend): ChatOrigin => item.origin ?? 'user'
/** 사람이 친 글인가 — 데스크탑 화면('user')과 짝지은 폰(`device:…`)은 사람, 다른 대화가 보낸 지시(`session:…`)만 아니다 */
const fromPerson = (item: QueuedSend): boolean => !originOf(item).startsWith('session:')

/**
 * 쌓인 것을 하나로 — 본문(과 보일 글)을 줄바꿈으로 잇고(첨부만 보낸 빈 본문은 건너뛴다) 첨부를 순서대로 모은다.
 * **필드를 골라 다시 쌓지 않는다**: 마지막 것을 바탕에 깔고 이을 수 있는 것만 덮는다. 고른 필드만 옮기면 나중에 더한 필드
 * (모드·모델 등)가 두 건 이상 쌓였을 때만 조용히 사라진다 (closed-code DC-1322)
 */
export function mergeQueued<T extends QueuedSend>(items: T[]): T {
  const last = items[items.length - 1]!
  if (items.length === 1) return last
  const merged: T = { ...last, text: items.map((item) => item.text).filter(Boolean).join('\n') }
  if (items.some((item) => item.display !== undefined)) merged.display = items.map((item) => item.display ?? item.text).filter(Boolean).join('\n')
  if (items.some((item) => item.attachments?.length)) merged.attachments = items.flatMap((item) => item.attachments ?? [])
  return merged
}

export class SendQueues {
  private queues = new Map<string, QueuedSend[]>()
  /** 사용자가 턴을 멈춘 대화 — 턴이 끝나도 보내지 않고 쌓인 것을 남긴다. 입력창으로 되돌리면(take) 풀린다 (이슈 #3) */
  private holds = new Set<string>()
  private listeners = new Set<(id: string) => void>()

  items(id: string): QueuedSend[] {
    return this.queues.get(id) ?? []
  }

  /** 쌓인 것이 있는 대화 */
  ids(): string[] {
    return [...this.queues.keys()]
  }

  /** 쌓았으면 true. 턴이 안 돌고 앞에 쌓인 것도 없으면 false — 부른 쪽이 바로 보낸다 */
  submit(id: string, item: QueuedSend, busy: boolean): boolean {
    const current = this.items(id)
    if (!busy && current.length === 0) return false
    this.set(id, [...current, item])
    return true
  }

  /** 입력창으로 되돌리기 — 그 출처가 쌓은 것을 합쳐 주고 대기열에서 뺀다. 붙잡힌 것도 풀린다 */
  take(id: string, origin: ChatOrigin = 'user'): QueuedSend | undefined {
    const current = this.items(id)
    const mine = current.filter((item) => originOf(item) === origin)
    if (mine.length === 0) return undefined
    const rest = current.filter((item) => originOf(item) !== origin)
    // 다른 사람(데스크탑 화면·짝지은 폰)의 글이 남아 있으면 계속 붙잡는다 — 그 사람이 자기 입력창으로 되돌릴 것이다
    if (!rest.some(fromPerson)) this.holds.delete(id)
    this.set(id, rest)
    return mergeQueued(mine)
  }

  /** 다른 대화가 보낸 줄 하나를 뺀다 (index 는 items 의 자리). 사람이 친 줄은 여기서 못 뺀다(되돌리기 = take) — 뺐으면 true */
  drop(id: string, index: number): boolean {
    const current = this.items(id)
    const item = current[index]
    if (!item || fromPerson(item)) return false
    this.set(id, current.filter((_, at) => at !== index))
    return true
  }

  /** 그 대화가 지워졌다 — 쌓인 것을 다 버린다 */
  clear(id: string): void {
    this.holds.delete(id)
    if (this.queues.has(id)) this.set(id, [])
  }

  /** 사용자가 멈췄다 — 사람이 친 글이 쌓여 있으면 턴 끝에 보내지 않고 붙잡아 둔다 (화면이 입력창으로 되돌린다) */
  hold(id: string): void {
    if (!this.items(id).some(fromPerson)) return
    this.holds.add(id)
    for (const listener of this.listeners) listener(id)
  }

  held(id: string): boolean {
    return this.holds.has(id)
  }

  /** 그 대화의 턴이 끝났다 — 다음에 보낼 것(맨 앞부터 출처가 같은 것까지 합친 것)을 주고 대기열에서 뺀다. 붙잡힌 대화는 주지 않는다 */
  next(id: string): QueuedSend | undefined {
    const current = this.items(id)
    if (current.length === 0 || this.holds.has(id)) return undefined
    const origin = originOf(current[0]!)
    const until = current.findIndex((item) => originOf(item) !== origin)
    const run = until === -1 ? current : current.slice(0, until)
    this.set(id, current.slice(run.length))
    return mergeQueued(run)
  }

  /** 대기열이 바뀔 때마다 그 대화 id 로 */
  subscribe(listener: (id: string) => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  private set(id: string, items: QueuedSend[]): void {
    if (items.length > 0) this.queues.set(id, items)
    else this.queues.delete(id)
    for (const listener of this.listeners) listener(id)
  }
}
