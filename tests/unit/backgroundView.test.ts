import { describe, expect, it } from 'vitest'
import { runningIn, runningOutside } from '../../renderer/backgroundView.ts'

// 백그라운드 진행 — 화면이 아는 대화별 pending 으로 센다. 알림 기능(NoticeState)과 무관하다: 꺼져 있어도(기본값) 도는 대화가 세어진다

const sessions = [
  { id: 'a1', project: '/a', pending: true },
  { id: 'a2', project: '/a', pending: false },
  { id: 'a3', project: '/a' },
  { id: 'b1', project: '/b', pending: true },
  { id: 'c1', project: '/c' },
]

describe('backgroundView', () => {
  it('그 프로젝트에서 도는 대화 id', () => {
    expect(runningIn(sessions, '/a')).toEqual(['a1'])
    expect(runningIn(sessions, '/c')).toEqual([])
    expect(runningIn(sessions, undefined)).toEqual([])
  })

  it('지금 프로젝트 밖에서 도는 수', () => {
    expect(runningOutside(sessions, '/a')).toBe(1)
    expect(runningOutside(sessions, '/b')).toBe(1)
    expect(runningOutside(sessions, undefined)).toBe(2)
  })
})
