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

/** 진행 줄에서 하위 작업을 도는 것과 끝난 것으로 가른다 */
export function jobList(items: readonly TurnItem[]): JobList {
  const subtasks = items.filter((item): item is Subtask => item.kind === 'subtask')
  const live = (item: Subtask) => item.status === 'running' || item.status === 'preparing'
  return { running: subtasks.filter(live), finished: subtasks.filter((item) => !live(item)) }
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
