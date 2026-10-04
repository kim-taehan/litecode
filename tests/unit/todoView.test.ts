import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { HistoryMessage, TodoItem, TurnItem } from '../../shared/contract.ts'
import { AssistantTurn } from '../../renderer/ChatTurn.tsx'
import { TodoDock } from '../../renderer/Todo.tsx'
import { currentTodos, latestTodos, todoCounts, todoDock } from '../../renderer/todoView.ts'
import { translate } from '../../shared/i18n/index.ts'

// 화면 설정 저장소는 메인에서 값을 받아야 해서 여기선 한국어 사전으로 바로 번역한다
vi.mock('../../renderer/settingsStore.ts', () => ({ useT: () => (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('ko', key, vars) }))

// 대화의 "지금 할 일 목록" (이슈 #83, 실측 _workspace/01ae_todo.md) — 그 대화에서 마지막으로 성공한 todowrite 줄의 목록.
// 엔진은 호출마다 목록을 통째로 갈아 끼우므로 앱도 합치지 않는다

const write = (id: string, todos?: TodoItem[], status: 'done' | 'error' | 'running' = 'done'): TurnItem => ({ kind: 'tool', id, name: 'todowrite', status, ...(todos && { todos }) })
const todo = (text: string, status: TodoItem['status'] = 'pending'): TodoItem => ({ text, status })
const answer = (...items: TurnItem[]): HistoryMessage => ({ role: 'assistant', text: '', items })
const user: HistoryMessage = { role: 'user', text: 'go' }

describe('latestTodos — 진행 줄에서 마지막 성공 목록', () => {
  it('목록 줄이 여럿이면 마지막 것', () => {
    expect(latestTodos([write('a', [todo('one')]), { kind: 'text', id: 't', text: 'x', done: true }, write('b', [todo('two')])])).toEqual([todo('two')])
  })

  it('실패·진행 중 줄(todos 없음)은 건너뛴다', () => {
    expect(latestTodos([write('a', [todo('one')]), write('b', undefined, 'error'), write('c', undefined, 'running')])).toEqual([todo('one')])
  })

  it('하위 작업 안은 보지 않는다. 없으면 undefined', () => {
    const subtask: TurnItem = { kind: 'subtask', id: 's', agent: 'general', description: '', status: 'done', items: [write('child', [todo('inner')])] }
    expect(latestTodos([subtask])).toBeUndefined()
    expect(latestTodos([])).toBeUndefined()
  })

  it('빈 목록도 목록이다 — 앞 목록으로 돌아가지 않는다', () => {
    expect(latestTodos([write('a', [todo('one')]), write('b', [])])).toEqual([])
  })
})

describe('currentTodos — 대화 전체에서', () => {
  it('도는 턴의 진행 줄이 먼저, 없으면 끝난 턴을 뒤에서부터', () => {
    const messages = [user, answer(write('a', [todo('old')])), user, answer(write('b', [todo('newer')])), user, answer({ kind: 'text', id: 't', text: 'x', done: true })]
    expect(currentTodos(messages, [])).toEqual([todo('newer')])
    expect(currentTodos(messages, [write('c', [todo('live')])])).toEqual([todo('live')])
    expect(currentTodos(messages, [write('c', undefined, 'running')])).toEqual([todo('newer')])
    expect(currentTodos([user], undefined)).toBeUndefined()
  })
})

describe('todoCounts — 완료 n/m', () => {
  it('취소한 항목은 전체에서 뺀다', () => {
    expect(todoCounts([todo('a', 'done'), todo('b', 'active'), todo('c'), todo('d', 'cancelled')])).toEqual({ done: 1, total: 3 })
    expect(todoCounts([])).toEqual({ done: 0, total: 0 })
  })
})

describe('todoDock — 입력 카드 위 줄', () => {
  const list = [todo('a', 'done'), todo('b', 'active'), todo('c'), todo('d', 'cancelled')]

  it('도는 턴이면 active 는 진행 중 — 지금 하는 일은 첫 active', () => {
    expect(todoDock(list, true)).toEqual({
      done: 1,
      total: 3,
      current: { text: 'b', stalled: false },
      rows: [{ text: 'a', mark: 'done' }, { text: 'b', mark: 'active' }, { text: 'c', mark: 'pending' }, { text: 'd', mark: 'cancelled' }],
    })
  })

  it('턴이 끝났으면(완료·실패·중단) active 로 남은 항목은 멈춤이다 — 엔진 값은 그대로 남는다', () => {
    const dock = todoDock(list, false)!
    expect(dock.current).toEqual({ text: 'b', stalled: true })
    expect(dock.rows[1]).toEqual({ text: 'b', mark: 'stalled' })
  })

  it('active 가 없으면 지금 하는 일이 없다', () => {
    const dock = todoDock([todo('a', 'done'), todo('c')], true)!
    expect(dock).toMatchObject({ done: 1, total: 2 })
    expect(dock.current).toBeUndefined()
  })

  it('목록이 없거나 비었거나 전부 완료·취소면 숨긴다', () => {
    expect(todoDock(undefined, true)).toBeUndefined()
    expect(todoDock([], true)).toBeUndefined()
    expect(todoDock([todo('a', 'done'), todo('b', 'cancelled')], false)).toBeUndefined()
    expect(todoDock([todo('b', 'cancelled')], false)).toBeUndefined()
  })
})

describe('화면', () => {
  const list = [todo('read a.txt', 'done'), todo('edit b.txt', 'active'), todo('run tests'), todo('write docs', 'cancelled')]
  const turn = (item: TurnItem) => renderToStaticMarkup(createElement(AssistantTurn, { items: [item], text: '', running: true, directory: '/p' }))

  it('대화 안: todowrite 줄은 "할 일 · 완료 1/3" — 일반 도구 줄(Todowrite)이 아니다', () => {
    const html = turn(write('m:p1', list))
    expect(html).toContain('data-kind="todo"')
    expect(html).toContain('할 일')
    expect(html).toContain('완료 1/3')
    expect(html).not.toContain('Todowrite')
  })

  it('대화 안: 빈 목록은 "목록 비움", 실패한 todowrite 는 도구 줄로 남되 제목은 "할 일"', () => {
    expect(turn(write('m:p1', []))).toContain('목록 비움')
    const failed = turn({ kind: 'tool', id: 'm:p1', name: 'todowrite', status: 'error', error: 'bad' })
    expect(failed).toContain('data-status="error"')
    expect(failed).toContain('할 일')
    expect(failed).not.toContain('Todowrite')
  })

  it('입력 카드 위: "할 일 1/3 · 지금: …", 끝난 턴이면 "멈춤: …"', () => {
    const stalled = renderToStaticMarkup(createElement(TodoDock, { messages: [user, answer(write('m:p1', list))], progress: undefined, running: false }))
    expect(stalled).toContain('todo-dock')
    expect(stalled).toContain('1/3')
    expect(stalled).toContain('멈춤: edit b.txt')
    const live = renderToStaticMarkup(createElement(TodoDock, { messages: [user], progress: [write('m:p1', list)], running: true }))
    expect(live).toContain('지금: edit b.txt')
  })

  it('입력 카드 위: 목록이 없거나 다 끝났으면 아무것도 그리지 않는다', () => {
    expect(renderToStaticMarkup(createElement(TodoDock, { messages: [user], progress: undefined, running: false }))).toBe('')
    expect(renderToStaticMarkup(createElement(TodoDock, { messages: [user, answer(write('a', [todo('x', 'done')]))], progress: undefined, running: false }))).toBe('')
  })
})
