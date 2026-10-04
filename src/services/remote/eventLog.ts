import { randomBytes } from 'node:crypto'

// 이벤트 링 (01t 4절) — 내보낸 이벤트에 seq 를 붙여 메모리에 쥔다: 최근 2000개 또는 15분. 끊긴 폰이 `?run=&after=` 로 이어 받는다.
// runId 는 링마다(= 서버를 띄울 때마다) 새로 — 바뀌었으면 폰이 쥔 seq 는 무효다.

export const EVENT_RING_SIZE = 2000
export const EVENT_RING_AGE_MS = 15 * 60_000

export interface LoggedEvent {
  seq: number
  event: string
  data: unknown
  at: number
}

export class EventLog {
  readonly runId = `run_${randomBytes(6).toString('hex')}`
  private last = 0
  private entries: LoggedEvent[] = []

  constructor(
    private now: () => number = Date.now,
    private size = EVENT_RING_SIZE,
    private ageMs = EVENT_RING_AGE_MS,
  ) {}

  /** 지금까지 낸 마지막 seq */
  get seq(): number {
    return this.last
  }

  append(event: string, data: unknown): LoggedEvent {
    const entry = { seq: ++this.last, event, data, at: this.now() }
    this.entries.push(entry)
    this.prune()
    return entry
  }

  /** seq > after 인 이벤트 (오래된 것부터) */
  after(after: number): LoggedEvent[] {
    return this.entries.filter((entry) => entry.seq > after)
  }

  /** 그 뒤를 빠짐없이 이어 줄 수 있나 — 실행이 같고, after 가 링 안(또는 바로 앞)이어야 한다 */
  canResume(run: string, after: number): boolean {
    this.prune()
    const oldest = this.entries[0]?.seq ?? this.last + 1
    return run === this.runId && Number.isInteger(after) && after <= this.last && after >= oldest - 1
  }

  private prune(): void {
    const cutoff = this.now() - this.ageMs
    let drop = Math.max(0, this.entries.length - this.size)
    while (drop < this.entries.length && this.entries[drop]!.at < cutoff) drop++
    if (drop > 0) this.entries = this.entries.slice(drop)
  }
}
