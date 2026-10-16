import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TurnTab } from '../../renderer/TurnTab.tsx'
import { feedTurnSnapshot } from '../../renderer/turnDetailStore.ts'
import { translate } from '../../shared/i18n/index.ts'
import type { TurnItem } from '../../shared/contract.ts'

// 화면 설정 저장소와 진행 기록 훅(useSyncExternalStore)은 서버 렌더링에서 안 되어 한국어 사전·즉시 읽기로 대신한다 (todoView.test.ts 와 같은 길)
vi.mock('../../renderer/settingsStore.ts', () => ({ useT: () => (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('ko', key, vars) }))
vi.mock('../../renderer/turnDetailStore.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../renderer/turnDetailStore.ts')>()
  return { ...actual, useTurnDetail: (conversationId: string, startedAt: number) => actual.turnDetail(conversationId, startedAt) }
})

// “턴 작업” 탭의 대화 줄 (이슈 #462) — 이 턴이 속한 대화 제목 + 그 대화로 이동(다른 대화면), 지금 대화면 화살표 없음

const items: TurnItem[] = [{ id: 'm:1', kind: 'think', text: '생각 전문', done: true }]

function render(props: { conversationId: string; startedAt: number; title?: string; here?: boolean; onJump?: () => void }): string {
  return renderToStaticMarkup(createElement(TurnTab, { ...props, directory: '/p' }))
}

describe('대화 줄', () => {
  it('다른 대화의 턴 — 버튼 줄: 대화 제목 + 화살표(그 대화로 이동)', () => {
    feedTurnSnapshot('c-other', 1_000, items)
    const html = render({ conversationId: 'c-other', startedAt: 1_000, title: 'PR #459 본문 수리', onJump: () => {} })
    expect(html).toContain('turn-tab__conv--other')
    expect(html).toContain('<button')
    expect(html).toContain('PR #459 본문 수리')
    expect(html).toContain('turn-tab__conv-arrow')
  })

  it('지금 보는 대화의 턴 — 제목만(버튼도 화살표도 없음)', () => {
    feedTurnSnapshot('c-here', 2_000, items)
    const html = render({ conversationId: 'c-here', startedAt: 2_000, title: 'PR #459 본문 수리', here: true, onJump: () => {} })
    expect(html).toContain('turn-tab__conv')
    expect(html).not.toContain('turn-tab__conv--other')
    expect(html).not.toContain('turn-tab__conv-arrow')
    expect(html).toContain('PR #459 본문 수리')
  })

  it('제목이 없으면(대화 목록에 없는 id) — 줄을 안 그린다', () => {
    feedTurnSnapshot('c-gone', 3_000, items)
    const html = render({ conversationId: 'c-gone', startedAt: 3_000, title: '' })
    expect(html).not.toContain('turn-tab__conv')
  })
})
