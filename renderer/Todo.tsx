import { memo, useMemo, useState } from 'react'
import type { HistoryMessage, TodoItem, TurnItem } from '../shared/contract.ts'
import { useFindFold } from './ChatFind.tsx'
import { useT } from './settingsStore.ts'
import { currentTodos, todoCounts, todoDock, type TodoMark } from './todoView.ts'
import './todo.css'

// AI 의 할 일 목록 (이슈 #83, dsh ui-conversation TodoPanel 참조 — 모양·동작만 가져와 새로 썼다):
// - TodoRow: 대화 안의 todowrite 줄. "할 일 · 완료 2/5", 펼치면 그때의 체크리스트 (그 시점의 기록이라 멈춤 표시는 없다)
// - TodoDock: 입력 카드 바로 위의 얇은 줄 — 그 대화의 지금 목록. "할 일 2/5 · 지금: ○○", 누르면 전체 목록. 남은 일이 없으면 없다
// 규칙(마지막 목록 고르기·개수·멈춤)은 todoView.ts

/** 체크리스트 — 항목에 id 가 없어 자리(index)가 키다.
 *  live: 그 대화의 지금 목록(입력 카드 위 판) — 진행 중 항목의 표시가 돈다 (#252). 턴이 안 돌면 active 는 이미 stalled 로 와서 돌 것이 없다.
 *  대화 안 줄은 그 시점의 기록이라 돌지 않는다 */
export function TodoList({ rows, live = false }: { rows: readonly { text: string; mark: TodoMark }[]; live?: boolean }) {
  const t = useT()
  return (
    <ul className="todo-list">
      {rows.map((row, index) => (
        <li key={index} className="todo-list__item" data-status={row.mark}>
          <span className="todo-list__mark" role="img" aria-label={t(`todo.status.${row.mark}`)}>
            <Mark mark={row.mark} spin={live && row.mark === 'active'} />
          </span>
          <span className="todo-list__text">{row.text}</span>
        </li>
      ))}
    </ul>
  )
}

/** 완료 ✓ · 진행 중 채운 점 · 멈춤 ❙❙ · 대기 빈 동그라미 · 취소 가로줄.
 *  spin: 진행 중 — 테두리가 흐려지고 그 위 호(arc)가 돈다. 움직임을 줄이면 호를 숨겨 정적인 원 + 점 (todo.css) */
function Mark({ mark, spin = false }: { mark: TodoMark; spin?: boolean }) {
  return (
    <svg className={spin ? 'todo-mark--spin' : undefined} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle className={spin ? 'todo-mark__track' : undefined} cx="8" cy="8" r="5.75" />
      {spin && <path className="todo-mark__arc" d="M8 2.25A5.75 5.75 0 0 1 13.75 8" />}
      {mark === 'done' && <path d="M5.5 8.25L7.25 10L10.5 6.25" />}
      {mark === 'active' && <circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none" />}
      {mark === 'stalled' && <path d="M6.75 6V10M9.25 6V10" />}
      {mark === 'cancelled' && <path d="M5.5 8H10.5" />}
    </svg>
  )
}

function ListIcon({ className }: { className: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 4.25L3.25 5.5L5.5 3M2 11L3.25 12.25L5.5 9.75M8 4.25H14M8 11H14" />
    </svg>
  )
}

/** 대화 안의 할 일 줄 — 일반 도구 줄("Todowrite") 대신. 빈 목록(AI 가 비움)은 펼칠 것이 없다 */
export function TodoRow({ todos }: { todos: readonly TodoItem[] }) {
  const [open, setOpen] = useState(false)
  const bodyFold = useFindFold(open, () => setOpen(true))
  const t = useT()
  const empty = todos.length === 0
  return (
    <div className="turn-row" data-kind="todo">
      <button type="button" className="turn-row__line" aria-expanded={empty ? undefined : open} disabled={empty} onClick={() => setOpen((now) => !now)}>
        <ListIcon className="turn-row__icon" />
        <span className="turn-row__title">{t('todo.title')}</span>
        <span className="turn-row__dot" aria-hidden="true" />
        <span className="turn-row__summary">{empty ? t('todo.empty') : t('todo.progress', todoCounts(todos))}</span>
      </button>
      {bodyFold.mounted && !empty && (
        <div className="turn-row__body" {...bodyFold.fold}>
          <TodoList rows={todos.map((item) => ({ text: item.text, mark: item.status }))} />
        </div>
      )}
    </div>
  )
}

interface TodoDockProps {
  messages: readonly HistoryMessage[]
  /** 도는 턴의 진행 줄 */
  progress: readonly TurnItem[] | undefined
  /** 그 대화의 턴이 도는 중 — 아니면 active 로 남은 항목은 멈춤이다 */
  running: boolean
}

/** 입력 카드 위 줄. memo — 입력창에 글자를 칠 때마다 App 이 다시 그려져도 목록이 그대로면 다시 그리지 않는다 */
export const TodoDock = memo(function TodoDock({ messages, progress, running }: TodoDockProps) {
  const [open, setOpen] = useState(false)
  const t = useT()
  const todos = useMemo(() => currentTodos(messages, progress), [messages, progress])
  const view = todoDock(todos, running)
  if (!view) return null
  return (
    <section className="todo-dock" aria-label={t('todo.title')}>
      <button type="button" className="todo-dock__head" aria-expanded={open} onClick={() => setOpen((now) => !now)}>
        <ListIcon className="todo-dock__icon" />
        <span className="todo-dock__title">{t('todo.title')}</span>
        <span className="todo-dock__count">
          {view.done}/{view.total}
        </span>
        {view.current && !view.current.stalled && <span className="todo-dock__pulse" aria-hidden="true" />}
        {view.current && (
          <span className="todo-dock__current" data-stalled={view.current.stalled || undefined}>
            {t(view.current.stalled ? 'todo.stalled' : 'todo.now', { text: view.current.text })}
          </span>
        )}
        <svg className="todo-dock__chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 10L8 6L12 10" />
        </svg>
      </button>
      {open && <TodoList rows={view.rows} live />}
    </section>
  )
})
