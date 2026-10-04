import type { HistoryMessage, TodoItem, TurnItem } from '../shared/contract.ts'

// AI 의 할 일 목록 (이슈 #83) 의 화면 규칙 — 새 데이터는 없다: 성공한 todowrite 도구 줄에 실린 todos(그 시점의 목록 전체)가 전부다.
// 엔진은 호출마다 목록을 통째로 갈아 끼우므로(실측 01ae) 앱도 합치지 않는다 — "지금 목록" = 그 대화의 마지막 성공 줄.
// 하위 작업(subtask.items) 안은 보지 않는다: 하위 에이전트에는 이 도구가 없다 (열어 주면 자식 세션에 따로 생긴다)

/** 그 진행 줄들에서 마지막으로 성공한 목록 (없으면 undefined). 빈 목록도 목록이다 — AI 가 비운 것 */
export function latestTodos(items: readonly TurnItem[]): TodoItem[] | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!
    if (item.kind === 'tool' && item.todos) return item.todos
  }
  return undefined
}

/** 대화의 지금 목록 — 도는 턴의 진행 줄이 먼저, 없으면 끝난 턴을 뒤에서부터 */
export function currentTodos(messages: readonly HistoryMessage[], progress: readonly TurnItem[] | undefined): TodoItem[] | undefined {
  const live = latestTodos(progress ?? [])
  if (live) return live
  for (let index = messages.length - 1; index >= 0; index--) {
    const found = latestTodos(messages[index]!.items ?? [])
    if (found) return found
  }
  return undefined
}

/** "완료 n/m" — 취소한 항목은 전체에서 뺀다 (할 일이 아니게 된 것이다) */
export function todoCounts(todos: readonly TodoItem[]): { done: number; total: number } {
  return {
    done: todos.filter((item) => item.status === 'done').length,
    total: todos.filter((item) => item.status !== 'cancelled').length,
  }
}

/** 지금 목록의 줄 표시 — stalled: 턴이 끝났는데 active 로 남은 항목 (엔진 값은 안 바뀐다 — 화면이 "멈춤" 으로 그린다) */
export type TodoMark = TodoItem['status'] | 'stalled'

export interface TodoDockView {
  done: number
  total: number
  /** 지금 하는 일 — 첫 active 항목 (없으면 없다) */
  current?: { text: string; stalled: boolean }
  rows: { text: string; mark: TodoMark }[]
}

/** 입력 카드 위 줄의 모양. 목록이 없거나 비었거나 남은 일이 없으면(전부 완료·취소) undefined — 그리지 않는다.
 *  running: 그 대화의 턴이 도는 중 — 아니면(완료·실패·중단) active 는 멈춤이다 */
export function todoDock(todos: readonly TodoItem[] | undefined, running: boolean): TodoDockView | undefined {
  if (!todos || !todos.some((item) => item.status === 'pending' || item.status === 'active')) return undefined
  const active = todos.find((item) => item.status === 'active')
  return {
    ...todoCounts(todos),
    ...(active && { current: { text: active.text, stalled: !running } }),
    rows: todos.map((item) => ({ text: item.text, mark: item.status === 'active' && !running ? 'stalled' : item.status })),
  }
}
