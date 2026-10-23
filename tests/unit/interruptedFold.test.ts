import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TurnItem } from '../../shared/contract.ts'
import { AssistantTurn } from '../../renderer/ChatTurn.tsx'
import { translate } from '../../shared/i18n/index.ts'

vi.mock('../../renderer/settingsStore.ts', () => ({ useT: () => (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('ko', key, vars) }))

// 이슈 #516 — 턴을 중단(stop)하면 작업 줄(마지막 Read 등 도구 호출)이 접히지 않고 펼쳐진 채 보였다.
// 원인: 중단 턴은 failed 의 한 갈래(ConversationView 가 failed={!!message.error}, interrupted 는 덧붙는 표시)인데
// AssistantTurn 이 failed 면 접기 버튼 없이 작업 줄을 늘 펼쳤다.
// 이슈 #614 — 진짜 실패 턴도 접히지 않다는 같은 보고. 이제 끝난 턴(완료·실패·중단·거절)은 전부 완료처럼 기본 접혀
// 머리(버튼)로 펼친다 — 최종 답(실패면 ⚠️ 사유)만 남고, 접힌 작업 줄은 DOM 에 숨긴 채 (대화 안 찾기, 이슈 #79).

const read: TurnItem = { kind: 'tool', id: 'm:p1', name: 'read', status: 'error', input: '{"filePath":"/p/a.ts"}', summary: '/p/a.ts', error: 'Tool execution aborted' }
const render = (props: { failed?: boolean; interrupted?: boolean }) =>
  renderToStaticMarkup(createElement(AssistantTurn, { items: [read], text: '⚠️ 멈췄습니다', directory: '/p', ...props }))

describe('끝난 턴의 작업 줄 접힘 (중단 #516 · 실패 #614)', () => {
  it('중단 턴은 작업 줄이 접혀 있고 머리가 접기 버튼이다 (숨겨진 채 DOM 에 남는다 — 대화 안 찾기, 이슈 #79)', () => {
    const html = render({ failed: true, interrupted: true })
    expect(html).toContain('class="turn__work" hidden="" data-find-fold=""')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('>Read<span')
  })

  it('진짜 실패 턴도 완료·중단처럼 작업 줄이 접혀 있고 머리가 접기 버튼이다 (최종 답 ⚠️ 사유만 남는다)', () => {
    const html = render({ failed: true })
    expect(html).toContain('class="turn__work" hidden="" data-find-fold=""')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('class="turn__head" aria-expanded') // 머리가 접기 버튼
  })
})
