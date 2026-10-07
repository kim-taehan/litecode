import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { translate } from '../../shared/i18n/index.ts'
import { ConversationMenu, ReportBundle } from '../../renderer/Report.tsx'

// 대화 머리 ⋯ 메뉴와 설정 > 일반 "문제 신고 묶음" 카드의 첫 모양 (이슈 #177, 시안 _workspace/mock-report). 누른 뒤의 동작(IPC)은 메인 쪽 report.test.ts
vi.mock('../../renderer/settingsStore.ts', () => ({ useT: () => (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('ko', key, vars) }))

describe('ConversationMenu — 대화 머리 더 보기', () => {
  it('닫힌 ⋯ 버튼만 그린다 (메뉴를 여는 버튼이라고 알린다)', () => {
    const html = renderToStaticMarkup(createElement(ConversationMenu, { conversationId: 'c1' }))
    expect(html).toContain('aria-label="더 보기"')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('role="menu"')
  })
})

describe('ReportBundle — 문제 신고 묶음 카드', () => {
  it('이름·설명·[묶음 만들기] 와 들어가는 것/들어가지 않는 것 두 칸을 그린다', () => {
    const html = renderToStaticMarkup(createElement(ReportBundle))
    expect(html).toContain('문제 신고 묶음')
    expect(html).toContain('앱이 어디로 보내지는 않습니다')
    expect(html).toContain('>묶음 만들기<')
    expect(html).toContain('>들어가는 것<')
    expect(html).toContain('<li>앱 로그(main.log, 비밀 가림)</li>')
    expect(html).toContain('>들어가지 않는 것<')
    expect(html).toContain('<li>API 키 · 비밀번호 · 토큰</li>')
    expect(html).toContain('<li>MCP 서버의 헤더·환경 값</li>')
    expect(html).not.toContain('묶음을 저장했습니다') // 만들기 전엔 안내가 없다
  })
})
