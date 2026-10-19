import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TurnItem } from '../../shared/contract.ts'
import { AssistantTurn } from '../../renderer/ChatTurn.tsx'
import { translate } from '../../shared/i18n/index.ts'

vi.mock('../../renderer/settingsStore.ts', () => ({ useT: () => (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('ko', key, vars) }))

// 이슈 #516 — 턴을 중단(stop)하면 작업 줄(마지막 Read 등 도구 호출)이 접히지 않고 펼쳐진 채 보였다.
// 원인: 중단 턴은 failed 의 한 갈래(ConversationView 가 failed={!!message.error}, interrupted 는 덧붙는 표시)인데
// AssistantTurn 이 failed 면 접기 버튼 없이 작업 줄을 늘 펼쳤다. 중단은 완료처럼 접혀 있고, 진짜 실패만 펼친다.

const read: TurnItem = { kind: 'tool', id: 'm:p1', name: 'read', status: 'error', input: '{"filePath":"/p/a.ts"}', summary: '/p/a.ts', error: 'Tool execution aborted' }
const render = (props: { failed?: boolean; interrupted?: boolean }) =>
  renderToStaticMarkup(createElement(AssistantTurn, { items: [read], text: '⚠️ 멈췄습니다', directory: '/p', ...props }))

describe('중단된 턴의 작업 줄 접힘 (#516)', () => {
  it('중단 턴은 작업 줄이 접혀 있고 머리가 접기 버튼이다', () => {
    const html = render({ failed: true, interrupted: true })
    expect(html).not.toContain('class="turn__work"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('/p/a.ts')
  })

  it('진짜 실패 턴은 예전처럼 작업 줄을 펼쳐 둔다', () => {
    const html = render({ failed: true })
    expect(html).toContain('class="turn__work"')
    expect(html).toContain('/p/a.ts')
  })
})
