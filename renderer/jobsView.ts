import type { Subtask, TurnItem } from '../shared/ipc.ts'
import { thinkSummary } from './turnView.ts'

// 도는 작업 목록(이슈 #32)의 모양 — 도는 턴의 진행 줄(chat:progress 로 받은 TurnItem)에서 "메인 + 하위 작업" 줄을 만든다.
// 새 데이터는 없다: 하위 작업 줄(#31 Subtask)과 그 안의 생각·도구 줄이 전부다.

/** 펼친 하위 작업 아래 회색 상자에 보일 최근 줄 수 */
export const RECENT_LINES = 4

export interface JobList {
  /** 도는 하위 작업 (나타난 순서) */
  running: Subtask[]
  /** 끝난 하위 작업 — 완료·실패·중단 */
  finished: Subtask[]
}

/** 진행 줄에서 하위 작업을 도는 것과 끝난 것으로 가른다.
 *  ended: 턴이 이미 끝났다(입력 카드 위 줄이 새 턴 전까지 끝난 작업을 보인다, 이슈 #295) — 남은 준비·진행 중은 "중단됨" 으로 끝난 것에 */
export function jobList(items: readonly TurnItem[], ended = false): JobList {
  const subtasks = items.filter((item): item is Subtask => item.kind === 'subtask')
  // queued: 차례를 기다리는 백그라운드 작업 (#321) — 도는 것에 든다
  const live = (item: Subtask) => item.status === 'running' || item.status === 'preparing' || item.status === 'queued'
  if (ended) return { running: [], finished: subtasks.map((item) => (live(item) ? { ...item, status: 'stopped' as const } : item)) }
  return { running: subtasks.filter(live), finished: subtasks.filter((item) => !live(item)) }
}

/** 입력 카드 위 접힌 줄이 가리키는 대표 작업 (이슈 #295) — 도는 것 중 가장 먼저 시작한 것.
 *  시작 시각이 없는(준비 중) 것은 뒤로, 같으면 나타난 순서 */
export function leadJob(running: readonly Subtask[]): Subtask | undefined {
  let lead: Subtask | undefined
  for (const item of running) {
    if (!lead || (item.startedAt ?? Infinity) < (lead.startedAt ?? Infinity)) lead = item
  }
  return lead
}

/** 조용한 백그라운드 작업(quietSince)이 몇 분째 조용한가 — 실행 중이 아니거나 표시가 없으면 undefined. 표시는 TASK_QUIET_MS 뒤에 붙으므로 1분 이상 */
export function quietMinutes(item: Subtask, now: number): number | undefined {
  if (item.status !== 'running' || item.quietSince === undefined) return undefined
  return Math.max(1, Math.floor((now - item.quietSince) / 60_000))
}

/** 펼친 목록에 한 번에 보일 하위 작업 줄 수 — 나머지는 "+N개 더 보기" (이슈 #295 시안 G) */
export const VISIBLE_ROWS = 3

/** 앞의 limit 줄과 남은 개수. all 이면 전부 */
export function capRows<T>(rows: readonly T[], all: boolean, limit = VISIBLE_ROWS): { shown: T[]; more: number } {
  const shown = all ? rows.slice() : rows.slice(0, limit)
  return { shown, more: rows.length - shown.length }
}

/** 생각·도구 줄 하나의 글. mono 면 고정폭(도구), state 는 도구의 끝 표시 */
export interface JobLine {
  id: string
  text: string
  mono: boolean
  state?: 'running' | 'done' | 'error'
}

function jobLine(item: TurnItem): JobLine | undefined {
  if (item.kind === 'think') {
    const text = thinkSummary(item.text, item.done)
    return text ? { id: item.id, text, mono: false } : undefined
  }
  if (item.kind !== 'tool') return undefined
  const name = item.mcp ? `${item.mcp.server}/${item.mcp.tool}` : item.name
  return {
    id: item.id,
    text: [name, item.summary].filter(Boolean).join(' '),
    mono: true,
    state: item.status === 'done' ? 'done' : item.status === 'error' ? 'error' : 'running',
  }
}

/** 그 줄들의 최근 생각·도구 줄 (오래된 것부터, 최대 limit) */
export function recentLines(items: readonly TurnItem[], limit = RECENT_LINES): JobLine[] {
  return items.flatMap((item) => jobLine(item) ?? []).slice(-limit)
}

/** 지금 하는 일 — 마지막 생각·도구 줄 (없으면 undefined) */
export function lastLine(items: readonly TurnItem[]): JobLine | undefined {
  return recentLines(items, 1)[0]
}

/** 스트리밍 중인 잠정답 — 마지막 도구·생각 줄 이후 누적된 text 줄 (deepagents harness: final_ai_text).
 *  도구·생각 줄이면 그 뒤의 글만. 없으면 전체. 글이 없으면 undefined */
export function interimText(items: readonly TurnItem[]): string | undefined {
  let base = 0
  for (let at = items.length - 1; at >= 0; at--) {
    const item = items[at]!
    if (item.kind === 'tool' || item.kind === 'think') {
      base = at + 1
      break
    }
  }
  const parts: string[] = []
  for (let at = base; at < items.length; at++) {
    const item = items[at]!
    if (item.kind === 'text' && item.text.trim()) parts.push(item.text.trim())
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

/** 스트리밍 한 줄(이슈 #416) 에 보일 지금 하는 일 — lastLine 과 비슷하되 하위 작업 줄도 본다
 *  (하위 작업만 도는 턴은 생각·도구 줄이 없어도 그 설명으로). 없으면 undefined */
export function runningLine(items: readonly TurnItem[]): JobLine | undefined {
  for (let at = items.length - 1; at >= 0; at--) {
    const item = items[at]!
    if (item.kind === 'subtask') {
      const text = [item.agent, item.description].filter(Boolean).join(' · ')
      if (text) return { id: item.id, text, mono: false }
      continue
    }
    const line = jobLine(item)
    if (line) return line
  }
  return undefined
}

/** 백그라운드 작업 줄의 훑어보기 한 줄 (#325) — 실패·중단 사유가 있으면 그것, 아니면 마지막 활동(생각·도구·응답 글의 첫 줄). 없으면 undefined */
export function peekLine(item: Subtask): JobLine | undefined {
  if (item.error) return { id: 'error', text: item.error, mono: false, state: 'error' }
  for (let at = item.items.length - 1; at >= 0; at--) {
    const entry = item.items[at]!
    if (entry.kind === 'text') {
      const text = entry.text.trim().split('\n')[0]?.trim()
      if (text) return { id: entry.id, text, mono: false }
      continue
    }
    const line = jobLine(entry)
    if (line) return line
  }
  return undefined
}

/** 경과 시간 — 좁은 칸(44px 고정폭)에 들어가게 12s · 1m05s · 1h02m */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const pad = (value: number) => String(value).padStart(2, '0')
  if (total < 60) return `${total}s`
  if (total < 3600) return `${Math.floor(total / 60)}m${pad(total % 60)}s`
  return `${Math.floor(total / 3600)}h${pad(Math.floor((total % 3600) / 60))}m`
}

/** 토큰 수 — 999 까지 그대로, 그 위는 3.1k · 12k · 1.2M */
export function compactTokens(count: number): string {
  const short = (value: number, unit: string) => `${value < 10 ? (Math.floor(value * 10) / 10).toFixed(1).replace(/\.0$/, '') : Math.floor(value)}${unit}`
  if (count < 1000) return String(count)
  if (count < 1_000_000) return short(count / 1000, 'k')
  return short(count / 1_000_000, 'M')
}
