import { describe, expect, it } from 'vitest'
import { byScope, mcpCounts, mcpState } from '../../renderer/plusView.ts'

// 입력창 `+` 메뉴와 스킬·MCP 팝업(이슈 #43)의 화면용 순수 함수 — 묶음 가르기, 메뉴의 "연결 N · 실패 M", 서버 줄의 상태

describe('byScope — 두 묶음', () => {
  it('"이 프로젝트만" 과 "모든 프로젝트" 로 가르고 순서는 받은 그대로', () => {
    const items = [
      { name: 'billing-db', scope: 'project' as const },
      { name: 'wiki', scope: 'all' as const },
      { name: 'deploy-bot', scope: 'project' as const },
    ]
    expect(byScope(items)).toEqual({ project: [items[0], items[2]], all: [items[1]] })
    expect(byScope([])).toEqual({ project: [], all: [] })
  })
})

describe('mcpState — 서버 줄의 상태', () => {
  it('가려진 것 > 끈 것 > opencode 상태 순으로 본다', () => {
    expect(mcpState({ enabled: true, status: 'connected' })).toBe('connected')
    expect(mcpState({ enabled: true, status: 'failed' })).toBe('failed')
    expect(mcpState({ enabled: false, status: 'connected' })).toBe('disabled') // 방금 껐다 — 다음 턴에 끊긴다
    expect(mcpState({ enabled: true, status: 'connected', shadowed: true })).toBe('shadowed')
    expect(mcpState({ enabled: true })).toBeUndefined()
  })
})

describe('mcpCounts — 메뉴의 요약', () => {
  it('연결됨과 실패(인증 필요 포함)만 센다 — 끈 것·가려진 것은 빼고', () => {
    expect(
      mcpCounts([
        { enabled: true, status: 'connected' },
        { enabled: true, status: 'connected' },
        { enabled: true, status: 'failed' },
        { enabled: true, status: 'needs_auth' },
        { enabled: false, status: 'disabled' },
        { enabled: false, status: 'connected' },
        { enabled: true, status: 'connected', shadowed: true },
        { enabled: true },
      ]),
    ).toEqual({ connected: 2, failed: 2 })
  })
})
