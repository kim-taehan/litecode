import type { TrajectoryRecord } from '../shared/ipc.ts'

// Trajectory 화면의 계산 (화면 없이 단위 테스트한다). 모양은 dsh ui-trajectory 참조 — 턴 묶음, 단어 AND 검색,
// 시간축 3레인(Input·Model·Tools)과 두 보기: sequence(레코드마다 같은 너비) / duration(실제 시간, 아무것도 안 돈 구간 압축).

export interface TurnItem {
  /** 전체 레코드 안의 순서 — 접기 상태·화면 키에 쓴다 */
  id: number
  record: TrajectoryRecord
}

export interface Turn {
  /** 1부터 */
  number: number
  items: TurnItem[]
}

/** user 레코드마다 새 턴. 첫 user 앞의 레코드(없어야 정상)는 첫 턴에 붙인다 */
export function groupTurns(records: readonly TrajectoryRecord[]): Turn[] {
  const turns: Turn[] = []
  records.forEach((record, id) => {
    if (record.kind === 'user' || turns.length === 0) turns.push({ number: turns.length + 1, items: [] })
    turns.at(-1)!.items.push({ id, record })
  })
  return turns
}

function searchText(record: TrajectoryRecord): string {
  switch (record.kind) {
    case 'tool':
      return [record.name, record.input, record.result, record.error ?? '', record.subtask ?? ''].join('\n')
    case 'assistant':
      return [record.text, record.error ?? '', record.subtask ?? ''].join('\n')
    default:
      return record.text
  }
}

/** 공백으로 나눈 단어를 모두 포함하면 참 (대소문자 무시). 빈 검색은 모두 참 */
export function matchesSearch(record: TrajectoryRecord, query: string): boolean {
  const text = searchText(record).toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word))
}

export type TimelineMode = 'sequence' | 'duration'

export interface TimelineSpan {
  id: number
  /** 0 Input · 1 Model · 2 Tools */
  lane: 0 | 1 | 2
  start: number
  end: number
  /** Model 막대에서 응답이 오기 시작한 자리 — start 와의 사이가 대기. duration 에서만 */
  firstAt?: number
  error: boolean
  /** 끝나지 않았다 — 길이를 지어내지 않고 시작 표시만 한다 */
  open: boolean
}

function laneOf(record: TrajectoryRecord): 0 | 1 | 2 {
  return record.kind === 'tool' ? 2 : record.kind === 'assistant' ? 1 : 0
}

/** 실제 [시작, 끝] — 점 레코드(user·context)와 끝나지 않은 레코드는 길이 0 */
function realRange(record: TrajectoryRecord): [number, number] {
  if (record.kind === 'user' || record.kind === 'context') return [record.at, record.at]
  return [record.start, record.end ?? record.start]
}

/** 같은 축에 놓은 막대들. total 은 축 길이(sequence 는 칸 수, duration 은 압축한 ms) */
export function timeline(records: readonly TrajectoryRecord[], mode: TimelineMode): { spans: TimelineSpan[]; total: number } {
  const base = (record: TrajectoryRecord, id: number) => ({
    id,
    lane: laneOf(record),
    error: 'error' in record && record.error !== undefined,
    open: record.kind !== 'user' && record.kind !== 'context' && record.end === undefined,
  })
  if (mode === 'sequence') {
    return { spans: records.map((record, id) => ({ ...base(record, id), start: id, end: id + 1 })), total: records.length }
  }

  // 아무것도 안 돈 구간(턴 사이 사람이 쉰 시간)을 작은 틈으로 줄인다 — 안 그러면 1분 쉰 뒤의 턴이 한쪽 끝에 몰린다 (dsh)
  const groups: [number, number][] = []
  for (const [start, end] of records.map(realRange).sort((a, b) => a[0] - b[0])) {
    const last = groups.at(-1)
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else groups.push([start, end])
  }
  const covered = groups.reduce((sum, [start, end]) => sum + (end - start), 0)
  const gap = Math.max(covered * 0.02, 1)
  const offsets: number[] = []
  let offset = 0
  for (const [index, [start, end]] of groups.entries()) {
    if (index > 0) offset += gap
    offsets.push(offset - start)
    offset += end - start
  }
  const place = (time: number) => {
    let index = groups.length - 1
    while (index > 0 && groups[index]![0] > time) index--
    return time + (offsets[index] ?? 0)
  }

  const spans = records.map((record, id): TimelineSpan => {
    const [start, end] = realRange(record)
    const span: TimelineSpan = { ...base(record, id), start: place(start), end: place(end) }
    if (record.kind === 'assistant' && record.end !== undefined) span.firstAt = place(record.firstAt)
    return span
  })
  return { spans, total: Math.max(offset, 1) }
}

/** 걸린 시간 표시 — 1초 미만은 ms, 그 위는 초 한 자리 */
export function formatDuration(ms: number): string {
  return ms < 1_000 ? `${Math.round(ms)}ms` : `${(ms / 1_000).toFixed(1)}s`
}
