import type { RemoteStreamSink } from './carrier.ts'

// 이벤트 스트림 하나의 보내기 큐 (이슈 #68, 설계 01ab 4절 "최신 우선 합치기") — 운반 공통이다.
// 통로가 받아 주는 동안은 온 그대로 하나씩 쓴다 (HTTP 는 사실상 늘 그렇다 — 동작이 달라지지 않는다).
// 통로가 밀렸다고 하면(write 가 false) 풀릴 때까지 쥐고, 그동안 **같은 열쇠의 것은 최신 하나만** 남긴다: `turn.progress` 는
// 같은 진행 줄을 누적 전체로 다시 보내므로 밀린 옛 모습은 보낼 까닭이 없다 (20KB/s 링크에서 한 턴이 6MB → 수백 KB).
// 남긴 것은 **맨 뒤로** 간다 — seq 가 거꾸로 가면 폰 리듀서가 뒤에 온 작은 seq 를 버린다. 폰은 seq 건너뜀을 견딘다
// (mobile/src/core/state.ts: `seq <= state.seq` 만 본다). 풀리면 쥔 것을 한 번에 쓴다(SSE 글자는 이어 붙여도 된다).

export class StreamQueue {
  /** pushed: 받은 이벤트, coalesced: 그중 최신 것에 밀려 보내지 않은 것 */
  readonly stats = { pushed: 0, coalesced: 0 }
  private pending: { text: string; key?: string }[] = []
  private blocked = false
  private ended = false

  constructor(private sink: RemoteStreamSink) {
    sink.onDrain(() => this.flush())
  }

  /** 이벤트 하나. key 를 주면 밀려 있는 같은 key 의 것을 대신한다 */
  push(text: string, key?: string): void {
    if (this.ended) return
    this.stats.pushed += 1
    if (!this.blocked && this.pending.length === 0) {
      this.blocked = !this.sink.write(text)
      return
    }
    if (key !== undefined) {
      const before = this.pending.length
      this.pending = this.pending.filter((entry) => entry.key !== key)
      this.stats.coalesced += before - this.pending.length
    }
    this.pending.push({ text, key })
  }

  /** 살아 있다는 신호 — 밀려 있으면(글이 가고 있다) 보내지 않는다 */
  ping(text: string): void {
    if (this.ended || this.blocked || this.pending.length > 0) return
    this.blocked = !this.sink.write(text)
  }

  /** 곱게 닫는다 — 밀린 것은 버리고 마지막 글(있으면)만 보낸다 */
  end(text?: string): void {
    if (this.ended) return
    this.ended = true
    this.pending = []
    this.sink.end(text)
  }

  /** 그냥 끊는다 */
  destroy(): void {
    if (this.ended) return
    this.ended = true
    this.pending = []
    this.sink.destroy()
  }

  private flush(): void {
    this.blocked = false
    if (this.ended || this.pending.length === 0) return
    const text = this.pending.map((entry) => entry.text).join('')
    this.pending = []
    this.blocked = !this.sink.write(text)
  }
}
