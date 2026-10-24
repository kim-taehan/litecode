import { createElement, Fragment, isValidElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TurnItem } from '../../shared/contract.ts'
import { AssistantTurn } from '../../renderer/ChatTurn.tsx'
import { translate } from '../../shared/i18n/index.ts'

vi.mock('../../renderer/settingsStore.ts', () => ({ useT: () => (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('ko', key, vars) }))

// 이슈 #635: 답한 질문(reply 줄)에서 턴을 갈라 그린다. 턴 끝 사실(토큰·완료 시각)·고친 파일 카드는 턴 전체의 것이라 마지막 조각에만,
// 거절로 끝난 턴(말풍선 뒤가 빈 조각)도 그 줄이 남는다. reply 가 생겨도 마지막 조각(승인·질문 카드가 붙는 곳)은 다시 마운트되지 않는다

const ask: TurnItem = { kind: 'text', id: 'm:a', text: '어느 쪽으로 할까요?', done: true }
const edit: TurnItem = {
  kind: 'tool',
  id: 'm:e',
  name: 'edit',
  status: 'done',
  diffs: [{ path: 'src/a.ts', status: 'modified', added: 2, removed: 1, patch: '@@ -1 +1,2 @@\n-a\n+b\n+c\n' }],
}
const answered: TurnItem = { kind: 'reply', id: 'm:q', questions: [{ question: 'Which DB?', answer: 'SQLite' }], askedAt: 1_004, at: 1_010 }
const dismissed: TurnItem = { kind: 'reply', id: 'm:q', questions: [{ question: 'Which DB?' }], askedAt: 1_004, at: 1_010 }
const done: TurnItem = { kind: 'text', id: 'n:d', text: '만들었어요', done: true }
const facts = { directory: '/p', tokens: 1234, finishedAt: Date.UTC(2026, 9, 24, 3, 4), startedAt: 1_000, duration: 20 }
const usage = translate('ko', 'chat.usage', { count: '1.2K' })

const render = (items: TurnItem[], props: Record<string, unknown>) => renderToStaticMarkup(createElement(AssistantTurn, { items, text: '', ...facts, ...props }))
const count = (html: string, needle: string) => html.split(needle).length - 1

describe('답한 질문으로 가른 턴 (이슈 #635)', () => {
  it('토큰·완료 시각 줄과 고친 파일 카드는 말풍선 뒤 마지막 조각에 한 번만', () => {
    const html = render([edit, ask, answered, done], { text: '어느 쪽으로 할까요?만들었어요' })
    expect(count(html, 'class="turn__usage"')).toBe(1)
    expect(count(html, 'class="changed-files"')).toBe(1)
    const bubble = html.indexOf('data-kind="reply"')
    expect(bubble).toBeGreaterThan(0)
    expect(html.indexOf('class="turn__usage"')).toBeGreaterThan(bubble)
    expect(html.indexOf('class="changed-files"')).toBeGreaterThan(bubble)
    expect(html).toContain(usage)
  })

  it('거절로 끝난 턴: 말풍선 뒤 빈 조각은 머리·빈 답 칸 없이 토큰·완료 시각 줄만', () => {
    const html = render([edit, ask, dismissed], { text: '어느 쪽으로 할까요?', declined: true })
    const bubble = html.indexOf('data-kind="reply"')
    const tail = html.slice(bubble)
    expect(count(html, 'class="turn__usage"')).toBe(1)
    expect(tail).toContain('class="turn__usage"')
    expect(tail).toContain('class="turn__time"')
    expect(tail).not.toContain('turn__head')
    expect(tail).not.toContain('bubble--assistant')
    // 질문 앞 글은 앞 조각에 한 번만
    expect(count(html, '어느 쪽으로 할까요?')).toBe(1)
  })

  it('reply 가 와도 마지막 조각은 같은 종류·같은 key 자리 — 다시 마운트되지 않는다 (병렬 질문 카드의 고르던 상태 유지)', () => {
    const tree = (items: TurnItem[]) => {
      const element = (AssistantTurn as unknown as { type: (props: object) => ReactElement<{ children: ReactElement[] }> }).type({ items, text: '', directory: '/p', running: true, startedAt: 1_000 })
      expect(element.type).toBe(Fragment)
      const children = element.props.children
      expect(Array.isArray(children)).toBe(true)
      const last = children.at(-1)!
      expect(isValidElement(last)).toBe(true)
      return { type: last.type, key: last.key }
    }
    const before = tree([ask, { kind: 'tool', id: 'm:q', name: 'question', status: 'running' }])
    const after = tree([ask, answered, done])
    expect(after).toEqual(before)
  })
})
