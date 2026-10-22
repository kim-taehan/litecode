import { describe, expect, it } from 'vitest'
import { recentRows } from '../../renderer/RecentConversations.tsx'
import { newSession } from '../../renderer/session.ts'

// 최근 대화 팝오버 (이슈 #580) 의 순수 부분 — 행 정렬(고정 우선 → 최신)·필터(제목·프로젝트명)·한도(10).
// 행 클릭·좌표·키보드는 화면 쪽(RecentConversations.tsx)

const session = (project: string, title: string, updatedAt: number, pinned = false) => ({ ...newSession(project), title, updatedAt, pinned })
const P = [{ path: '/w/shop-web', name: 'shop-web' }, { path: '/w/order-backend', name: 'order-backend' }]

describe('recentRows — 고정한 대화 우선, 그 뒤 최신순', () => {
  it('고정한 것을 먼저(끼어서도 최신순), 남은 것은 updatedAt 내림차순', () => {
    const rows = recentRows([
      session('/w/shop-web', '결제 수정', 1_000),
      session('/w/order-backend', '배포', 5_000, true),
      session('/w/shop-web', '로그인', 3_000),
      session('/w/order-backend', '주문 API', 2_000, true),
    ], P)
    expect(rows.map((r) => r.title)).toEqual(['배포', '주문 API', '로그인', '결제 수정'])
  })

  it('최대 10개 — 그보다 오래된 것은 잘린다', () => {
    const many = Array.from({ length: 15 }, (_, i) => session('/w/shop-web', `c-${i}`, i * 1_000))
    const rows = recentRows(many, P, '')
    expect(rows).toHaveLength(10)
    expect(rows[0]?.title).toBe('c-14')
    expect(rows[9]?.title).toBe('c-5')
  })
})

describe('recentRows — 제목·프로젝트명으로 거르기', () => {
  const all = [session('/w/shop-web', '결제 API 문서', 1_000), session('/w/order-backend', '배포 스크립트', 2_000)]

  it('제목 부분일치 (대소문자 무시)', () => {
    expect(recentRows(all, P, 'aPi').map((r) => r.title)).toEqual(['결제 API 문서'])
  })

  it('제목에 없어도 프로젝트명 부분일치면 나온다', () => {
    expect(recentRows(all, P, 'backend').map((r) => r.title)).toEqual(['배포 스크립트'])
  })

  it('빈·공백 찾는 말은 전부 통과, 없으면 빈 목록', () => {
    expect(recentRows(all, P, '   ').map((r) => r.title)).toEqual(['배포 스크립트', '결제 API 문서'])
    expect(recentRows(all, P, '없는 글')).toEqual([])
  })
})

describe('recentRows — 프로젝트명 표시', () => {
  it('등록된 프로젝트는 등록 이름, 없으면 경로 마지막 조각', () => {
    const rows = recentRows([
      session('/w/shop-web', 'a', 1),
      session('/nowhere/deep/inner', 'b', 2),
    ], P)
    expect(rows.find((r) => r.title === 'a')?.projectName).toBe('shop-web')
    expect(rows.find((r) => r.title === 'b')?.projectName).toBe('inner')
  })
})
