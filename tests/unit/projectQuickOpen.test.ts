import { describe, expect, it } from 'vitest'
import { pinnedProjects } from '../../renderer/ProjectQuickOpen.tsx'
import type { Project } from '../../shared/ipc.ts'

// #377 — 빠른 열기가 열려 있는 동안 행 순서는 열렸을 때(initial) 그대로.
// open() 이 연 프로젝트를 최근 목록 맨 앞으로 올려 live(given projects) 순서가 바뀔 때마다
// 패널 행이 도약하는 것이 혼란스러웠다 — 고치는 것(강조 이동)은 화면 쪽, 순서 고정 규칙은 여기.

const project = (path: string, name: string, favorite = false): Project => ({ path, name, displayPath: `~/${name}`, favorite })

describe('pinnedProjects — 열렸을 때 순서 고정', () => {
  const initial = [project('/a', 'alpha', true), project('/b', 'beta'), project('/c', 'gamma')]

  it('live(최근) 순서가 바뀌어도 열렸을 때 순서대로 낸다', () => {
    const live = [project('/c', 'gamma'), project('/a', 'alpha', true), project('/b', 'beta')] // gamma 가 맨 앞으로
    expect(pinnedProjects(initial, live, '').map((p) => p.path)).toEqual(['/a', '/b', '/c'])
  })

  it('live 에서 사라진 프로젝트는 빠진다 (패널에서 × 로 뺀 경우)', () => {
    const live = [project('/b', 'beta'), project('/c', 'gamma')]
    expect(pinnedProjects(initial, live, '').map((p) => p.path)).toEqual(['/b', '/c'])
  })

  it('live 에만 있는 프로젝트는 안 들어온다 (열린 중인 목록에 없으므로)', () => {
    const live = [...[project('/c', 'gamma'), project('/a', 'alpha', true), project('/b', 'beta')], project('/d', 'delta')]
    expect(pinnedProjects(initial, live, '').map((p) => p.path)).toEqual(['/a', '/b', '/c'])
  })

  it('이름·즐겨찾기는 live 데이터로 본다 (패널 안에서 바꾼 ★·이름이 반영)', () => {
    const live = [project('/a', 'alpha-renamed', true), project('/b', 'beta', true)]
    const result = pinnedProjects(initial, live, '')
    expect(result[0]).toMatchObject({ name: 'alpha-renamed' })
    expect(result[1].favorite).toBe(true)
  })

  it('needle 로 거른다 (이름은 live 기준)', () => {
    const live = [project('/a', 'alpha', true), project('/b', 'beta'), project('/c', 'gamma')]
    expect(pinnedProjects(initial, live, 'be').map((p) => p.path)).toEqual(['/b'])
  })
})
