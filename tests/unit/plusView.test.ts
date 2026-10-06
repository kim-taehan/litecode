import { describe, expect, it } from 'vitest'
import { byScope, mcpCounts, mcpState, toolPicking, toolRows } from '../../renderer/plusView.ts'

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

describe('MCP 도구 고르기 화면 모델 (#164)', () => {
  const tools = [
    { name: 'jira_search', description: 'JQL 로 이슈를 찾는다', tokens: 190 },
    { name: 'jira_delete', description: 'Deletes an issue', tokens: 120 },
  ]

  it('고를 수 있나 — 연결돼 도구 목록이 있으면 pick, 없으면 waiting(연결되면), 내장·가려진 서버는 none', () => {
    expect(toolPicking({ source: 'project', enabled: true, status: 'connected', tools })).toBe('pick')
    expect(toolPicking({ source: 'app', enabled: true, status: 'failed' })).toBe('waiting')
    expect(toolPicking({ source: 'app', enabled: false, status: 'disabled' })).toBe('waiting')
    expect(toolPicking({ source: 'builtin', enabled: true, status: 'connected', tools })).toBe('none')
    expect(toolPicking({ source: 'project', enabled: true, status: 'connected', shadowed: true, tools })).toBe('none')
  })

  it('줄 — 검색으로 거르고 선택으로 켜짐을 붙인다', () => {
    expect(toolRows(tools, { off: ['jira_delete'] }, '').map((row) => [row.name, row.on])).toEqual([
      ['jira_search', true],
      ['jira_delete', false],
    ])
    expect(toolRows(tools, { only: [] }, '이슈').map((row) => [row.name, row.on])).toEqual([['jira_search', false]])
  })
})
