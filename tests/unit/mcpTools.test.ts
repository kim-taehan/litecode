import { describe, expect, it } from 'vitest'
import {
  ALL_TOOLS_OFF,
  estimateToolTokens,
  filterTools,
  hiddenTools,
  serverCost,
  shortTokens,
  toolBudget,
  toolOn,
  toolSelectionOf,
  withTool,
  type McpToolSelection,
} from '../../shared/mcpTools.ts'

// MCP 서버 안에서 도구 골라 끄기 (이슈 #164) — 선택 모양(off/only)·토큰 어림·머리 띠 합계·검색

describe('도구 선택 (off / only)', () => {
  const names = ['search', 'get', 'create']

  it('선택이 없으면 전부 켜짐', () => {
    expect(names.map((name) => toolOn(undefined, name))).toEqual([true, true, true])
    expect(hiddenTools(undefined, names)).toEqual([])
  })

  it('체크를 풀면 off 에 더해지고, 다시 켜서 off 가 비면 선택이 없어진다', () => {
    let selection = withTool(undefined, 'create', false)
    expect(selection).toEqual({ off: ['create'] })
    expect(hiddenTools(selection, names)).toEqual(['create'])
    selection = withTool(selection, 'get', false)
    expect(hiddenTools(selection, names)).toEqual(['get', 'create'])
    selection = withTool(withTool(selection, 'get', true), 'create', true)
    expect(selection).toBeUndefined()
  })

  it('[전부 끄기] 는 only: [] — 이후 체크는 only 에 더해지고, 서버가 새로 준 도구는 꺼진 채', () => {
    let selection: McpToolSelection | undefined = ALL_TOOLS_OFF
    expect(hiddenTools(selection, names)).toEqual(names)
    selection = withTool(selection, 'search', true)
    expect(selection).toEqual({ only: ['search'] })
    expect(hiddenTools(selection, [...names, 'brand_new'])).toEqual(['get', 'create', 'brand_new'])
    selection = withTool(selection, 'search', false)
    expect(selection).toEqual({ only: [] }) // only 모드는 비어도 남는다 (전부 꺼짐)
  })

  it('off 모드에서는 서버가 새로 준 도구가 켜진 채로 들어온다', () => {
    expect(hiddenTools({ off: ['get'] }, [...names, 'brand_new'])).toEqual(['get'])
  })

  it('[전부 켜기] 는 선택을 지운다(undefined) — 그러면 전부 켜짐', () => {
    expect(hiddenTools(undefined, names)).toEqual([])
  })

  it('파일 값 읽기 — 옛 모양·깨진 값은 전부 켜짐, only 가 off 를 이긴다', () => {
    expect(toolSelectionOf(undefined)).toBeUndefined()
    expect(toolSelectionOf('x')).toBeUndefined()
    expect(toolSelectionOf({ off: [] })).toBeUndefined()
    expect(toolSelectionOf({ off: ['a', 3] })).toEqual({ off: ['a'] })
    expect(toolSelectionOf({ only: [], off: ['a'] })).toEqual({ only: [] })
  })
})

describe('토큰 어림·머리 띠', () => {
  it('도구 정의 JSON 글자 수 ÷ 3.5 (올림)', () => {
    const tool = { name: 'first', description: 'one' } // {"name":"first","description":"one"} = 36자
    expect(estimateToolTokens(tool)).toBe(11)
    const schema = { name: 'x', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }
    expect(estimateToolTokens(schema)).toBe(Math.ceil(JSON.stringify(schema).length / 3.5))
  })

  it('서버 비용 — 켠 도구만, 도구 목록이 없으면 undefined', () => {
    const tools = [
      { name: 'a', tokens: 100 },
      { name: 'b', tokens: 200 },
    ]
    expect(serverCost({ tools })).toEqual({ count: 2, total: 2, tokens: 300 })
    expect(serverCost({ tools, toolSelection: { off: ['b'] } })).toEqual({ count: 1, total: 2, tokens: 100 })
    expect(serverCost({})).toBeUndefined()
  })

  it('합계는 연결된 서버의 켠 도구만 — 꺼진 서버·가려진 서버·연결 전 서버·꺼 둔 도구는 빼고, 내장 서버는 넣는다', () => {
    const tool = (name: string, tokens = 100) => ({ name, tokens })
    const servers = [
      { enabled: true, status: 'connected', tools: [tool('a'), tool('b')], toolSelection: { off: ['b'] } },
      { enabled: false, status: 'disabled', tools: [tool('c')] },
      { enabled: true, status: 'connected', shadowed: true, tools: [tool('d')] },
      { enabled: true, status: 'failed' },
      { enabled: true, status: 'connected', tools: [tool('litecode_x', 50)] }, // 내장
    ]
    expect(toolBudget(servers)).toEqual({ count: 2, tokens: 150, heavy: false })
  })

  it('도구가 64개를 넘거나 토큰이 5천을 넘으면 heavy (주황 띠)', () => {
    const many = Array.from({ length: 65 }, (_, i) => ({ name: `t${i}`, tokens: 1 }))
    expect(toolBudget([{ enabled: true, status: 'connected', tools: many }]).heavy).toBe(true)
    expect(toolBudget([{ enabled: true, status: 'connected', tools: many.slice(0, 64) }]).heavy).toBe(false)
    expect(toolBudget([{ enabled: true, status: 'connected', tools: [{ name: 'big', tokens: 5_001 }] }]).heavy).toBe(true)
    expect(toolBudget([{ enabled: true, status: 'connected', tools: [{ name: 'big', tokens: 5_000 }] }]).heavy).toBe(false)
  })

  it('짧게 쓰기 — ko 천·만, en k', () => {
    expect(shortTokens(187, 'ko')).toBe('190')
    expect(shortTokens(3, 'ko')).toBe('10')
    expect(shortTokens(2_400, 'ko')).toBe('2.4천')
    expect(shortTokens(9_000, 'ko')).toBe('9천')
    expect(shortTokens(31_000, 'ko')).toBe('3.1만')
    expect(shortTokens(2_400, 'en')).toBe('2.4k')
    expect(shortTokens(31_000, 'en')).toBe('31k')
  })
})

describe('도구 검색', () => {
  const tools = [{ name: 'jira_search', description: 'JQL 로 이슈를 찾는다' }, { name: 'confluence_get_page', description: 'Reads a page' }, { name: 'plain' }]
  it('이름·설명에서 대소문자 없이 찾고, 빈 글은 전부', () => {
    expect(filterTools(tools, 'JIRA').map((tool) => tool.name)).toEqual(['jira_search'])
    expect(filterTools(tools, 'page').map((tool) => tool.name)).toEqual(['confluence_get_page'])
    expect(filterTools(tools, '이슈').map((tool) => tool.name)).toEqual(['jira_search'])
    expect(filterTools(tools, '  ')).toHaveLength(3)
  })
})
