import { describe, expect, it } from 'vitest'
import { runningIn, runningOutside } from '../../renderer/backgroundView.ts'
import type { NoticeState } from '../../shared/ipc.ts'

// 백그라운드 진행 — 알림 플러그인의 NoticeState 가 정본. 답 필요(attention)는 주황 점이 따로 있어 세지 않는다

const state: NoticeState = {
  a1: { project: '/a', status: 'running' },
  a2: { project: '/a', status: 'attention' },
  a3: { project: '/a', status: 'done' },
  b1: { project: '/b', status: 'running' },
  c1: { project: '/c', status: 'failed' },
}

describe('backgroundView', () => {
  it('그 프로젝트에서 도는 대화 id', () => {
    expect(runningIn(state, '/a')).toEqual(['a1'])
    expect(runningIn(state, '/c')).toEqual([])
    expect(runningIn(state, undefined)).toEqual([])
  })

  it('지금 프로젝트 밖에서 도는 수', () => {
    expect(runningOutside(state, '/a')).toBe(1)
    expect(runningOutside(state, '/b')).toBe(1)
    expect(runningOutside(state, undefined)).toBe(2)
  })
})
