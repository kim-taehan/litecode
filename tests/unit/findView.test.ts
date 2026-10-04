import { describe, expect, it } from 'vitest'
import { findCount, findInChunks, stepIndex } from '../../renderer/findView.ts'
import { matchesTitle, pinnedFirst } from '../../renderer/sessionListView.ts'

// 대화 안 찾기 (이슈 #79) 의 순수 부분 — 글 조각(한 문단의 글자 노드들)에서 일치 자리를 찾고, 순번을 옮긴다.
// 화면(ChatFind.tsx)은 이 자리를 DOM Range 로 바꿔 CSS Custom Highlight 로 칠한다

describe('findInChunks — 한 문단의 글 조각들에서 일치 자리', () => {
  it('대소문자를 가리지 않고, 겹치지 않게 앞에서부터 찾는다', () => {
    expect(findInChunks(['Find the find in FINDER'], 'find')).toEqual([
      { start: { chunk: 0, offset: 0 }, end: { chunk: 0, offset: 4 } },
      { start: { chunk: 0, offset: 9 }, end: { chunk: 0, offset: 13 } },
      { start: { chunk: 0, offset: 17 }, end: { chunk: 0, offset: 21 } },
    ])
    expect(findInChunks(['aaaa'], 'aa')).toHaveLength(2)
  })

  it('조각 경계에 걸친 글도 찾는다 — 굵게·코드로 글자 노드가 갈라진 문단', () => {
    // "결제 **API** 문서" → ['결제 ', 'API', ' 문서']
    expect(findInChunks(['결제 ', 'API', ' 문서'], '제 api 문')).toEqual([{ start: { chunk: 0, offset: 1 }, end: { chunk: 2, offset: 2 } }])
  })

  it('일치가 조각 끝에서 끝나면 끝 자리는 그 조각 안이다 (다음 조각의 0 이 아니다), 빈 조각은 건너뛴다', () => {
    expect(findInChunks(['ab', '', 'cd'], 'ab')).toEqual([{ start: { chunk: 0, offset: 0 }, end: { chunk: 0, offset: 2 } }])
    expect(findInChunks(['ab', '', 'cd'], 'cd')).toEqual([{ start: { chunk: 2, offset: 0 }, end: { chunk: 2, offset: 2 } }])
    expect(findInChunks(['ab', '', 'cd'], 'bc')).toEqual([{ start: { chunk: 0, offset: 1 }, end: { chunk: 2, offset: 1 } }])
  })

  it('빈 찾는 말·공백뿐인 찾는 말·없는 글은 빈 목록', () => {
    expect(findInChunks(['hello'], '')).toEqual([])
    expect(findInChunks(['hello world'], '   ')).toEqual([])
    expect(findInChunks(['hello'], 'xyz')).toEqual([])
    expect(findInChunks([], 'a')).toEqual([])
  })

  it('찾는 말 안의 공백은 그대로 본다', () => {
    expect(findInChunks(['npm test', 'npmtest'], 'npm test')).toHaveLength(1)
  })

  it('소문자로 바꾸면 길이가 달라지는 글자가 있어도 자리가 어긋나지 않는다 (그 문단은 대소문자를 가려 찾는다)', () => {
    // 'İ'.toLowerCase() 는 두 글자다
    expect(findInChunks(['İİ abc'], 'abc')).toEqual([{ start: { chunk: 0, offset: 3 }, end: { chunk: 0, offset: 6 } }])
  })
})

describe('stepIndex · findCount — 순번', () => {
  it('다음·이전은 끝에서 처음으로 돈다', () => {
    expect(stepIndex(0, 3, 1)).toBe(1)
    expect(stepIndex(2, 3, 1)).toBe(0)
    expect(stepIndex(0, 3, -1)).toBe(2)
  })

  it('일치가 없으면 0', () => {
    expect(stepIndex(0, 0, 1)).toBe(0)
    expect(stepIndex(0, 0, -1)).toBe(0)
  })

  it('개수 글 — "3/12", 없으면 "0/0", 찾는 말이 없으면 빈 글, 상한에 닿으면 "+"', () => {
    expect(findCount(2, 12, false)).toBe('3/12')
    expect(findCount(0, 0, false)).toBe('0/0')
    expect(findCount(0, 2000, true)).toBe('1/2000+')
  })
})

// 대화 목록 (이슈 #79) — 제목 찾기와 고정
describe('matchesTitle — 제목으로 거르기', () => {
  it('대소문자를 가리지 않고 낱말이 전부 들어 있어야 한다 (순서 무관)', () => {
    expect(matchesTitle('결제 API 문서 정리', 'api')).toBe(true)
    expect(matchesTitle('결제 API 문서 정리', '정리 결제')).toBe(true)
    expect(matchesTitle('결제 API 문서 정리', '결제 로그인')).toBe(false)
  })

  it('빈 찾는 말은 전부 통과', () => {
    expect(matchesTitle('아무 제목', '')).toBe(true)
    expect(matchesTitle('아무 제목', '   ')).toBe(true)
  })
})

describe('pinnedFirst — 고정한 대화가 위', () => {
  it('고정한 것을 위로 올리고, 묶음 안의 순서는 그대로 둔다', () => {
    const list = [{ id: 'a' }, { id: 'b', pinned: true }, { id: 'c' }, { id: 'd', pinned: true }]
    expect(pinnedFirst(list).map((entry) => entry.id)).toEqual(['b', 'd', 'a', 'c'])
  })

  it('고정한 것이 없으면 그대로', () => {
    expect(pinnedFirst<{ id: string; pinned?: boolean }>([{ id: 'a' }, { id: 'b' }]).map((entry) => entry.id)).toEqual(['a', 'b'])
  })
})
