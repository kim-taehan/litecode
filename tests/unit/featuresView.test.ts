import { describe, expect, it } from 'vitest'
import { FEATURE_FIXED, FEATURE_GROUPS } from '../../shared/features.ts'
import { FEATURE_ROWS, filterByQuery } from '../../renderer/featuresView.ts'

// 설정 > 기능 찾기 거르기 (이슈 #277) — 대소문자 무시 부분일치, trim, 빈 말은 전부
const items = [
  { id: 'terminal', texts: ['터미널 탭', '오른쪽 패널 탭으로 프로젝트 폴더의 터미널을 여는 칸 — ⌘↓ 로 엽니다'] },
  { id: 'mcp', texts: ['MCP', '추가한 MCP 서버의 도구를 AI 가 씁니다'] },
  { id: 'web', texts: ['웹 가져오기', 'AI 가 주소의 웹 페이지를 읽습니다'] },
]
const ids = (query: string): string[] => filterByQuery(items, query, (item) => item.texts).map((item) => item.id)

describe('filterByQuery', () => {
  it('빈 말·공백만이면 전부, 순서 그대로', () => {
    expect(ids('')).toEqual(['terminal', 'mcp', 'web'])
    expect(ids('   ')).toEqual(['terminal', 'mcp', 'web'])
  })

  it('대소문자를 가리지 않는다', () => {
    expect(ids('mcp')).toEqual(['mcp'])
    expect(ids('ai')).toEqual(['mcp', 'web'])
  })

  it('부분일치 — 이름이든 요약이든 하나만 맞으면 된다', () => {
    expect(ids('터미')).toEqual(['terminal'])
    expect(ids('페이지')).toEqual(['web'])
  })

  it('앞뒤 공백은 떼고 찾는다 (가운데 공백은 그대로)', () => {
    expect(ids('  웹 가져 ')).toEqual(['web'])
    expect(ids('웹가져')).toEqual([])
  })

  it('일치가 없으면 빈 목록', () => {
    expect(ids('zzzz')).toEqual([])
  })
})

// 이슈 #302 — 설정 > 기능은 묶음 구역 없이 한 목록, 묶음은 줄마다 뱃지
describe('FEATURE_ROWS', () => {
  it('묶음 순서대로 이어 붙이고 줄마다 묶음 id 를 단다', () => {
    expect(FEATURE_ROWS).toEqual(FEATURE_GROUPS.flatMap((group) => group.features.map((feature) => ({ feature, group: group.id }))))
  })

  it('고정된 필수 기능(훅 포함)은 없다', () => {
    for (const { feature } of FEATURE_ROWS) expect(FEATURE_FIXED[feature]).toBeUndefined()
    expect(FEATURE_ROWS.map((row) => row.feature)).not.toContain('hooks')
  })
})
