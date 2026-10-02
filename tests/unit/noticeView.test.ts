import { describe, expect, it } from 'vitest'
import { otherProjectsStatus, projectStatus } from '../../renderer/noticeView.ts'
import type { NoticeState } from '../../shared/ipc.ts'

// 프로젝트 단위 점 — 사이드바엔 현재 프로젝트 대화만 보여서, 다른 프로젝트의 사건은 전환 버튼·팝오버 행 점으로만 보인다 (01i 5절)

const state: NoticeState = {
  a1: { project: '/a', status: 'running' },
  a2: { project: '/a', status: 'done' },
  b1: { project: '/b', status: 'failed' },
  b2: { project: '/b', status: 'attention' },
  c1: { project: '/c', status: 'running' },
}

describe('projectStatus — 프로젝트 행 점', () => {
  it('그 프로젝트 대화 중 가장 급한 것: 답 필요 > 실행 중 > 실패 > 끝남 > 중단', () => {
    expect(projectStatus(state, '/a')).toBe('running')
    expect(projectStatus(state, '/b')).toBe('attention')
    expect(projectStatus(state, '/none')).toBeUndefined()
    expect(projectStatus({ x: { project: '/x', status: 'interrupted' }, y: { project: '/x', status: 'failed' } }, '/x')).toBe('failed')
  })
})

describe('otherProjectsStatus — 전환 버튼 점', () => {
  it('지금 안 보는 프로젝트의 답 필요·안 본 끝남만 — 실행 중은 확인할 것이 아니다', () => {
    expect(otherProjectsStatus(state, '/a')).toBe('attention')
    expect(otherProjectsStatus(state, '/b')).toBe('done')
    expect(otherProjectsStatus({ c1: { project: '/c', status: 'running' } }, '/a')).toBeUndefined()
    expect(otherProjectsStatus(state, undefined)).toBe('attention')
  })
})
