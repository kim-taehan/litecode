import { describe, expect, it } from 'vitest'
import { nextProjectInCycle, startProjectCycle } from '../../renderer/projectCycle.ts'

// #375 — 빠른 열기 패널에서 ⌘K 로 다음 프로젝트 순환. 순환은 "패널이 열렸을 때의 표시 순서" 스냅샷 기준 —
// 열면 목록 맨 앞으로 올라가는(open 이 re-order) live 목록 기준이면 처음 두 개 사이에서 그냥 오간다.

describe('startProjectCycle', () => {
  it('커서가 현재 프로젝트 자리에 시작한다', () => {
    expect(startProjectCycle(['a', 'b', 'c'], 'b').index).toBe(1)
  })

  it('현재 프로젝트가 목록에 없으면 -1 (다음 눌러서 첫 항목으로)', () => {
    expect(startProjectCycle(['a', 'b', 'c'], undefined).index).toBe(-1)
    expect(startProjectCycle(['a', 'b', 'c'], 'gone').index).toBe(-1)
  })
})

describe('nextProjectInCycle', () => {
  const cycle = () => startProjectCycle(['a', 'b', 'c'], 'a')

  it('cursor 에서 다음은 표시 순서의 다음 항목', () => {
    expect(nextProjectInCycle(cycle(), ['a', 'b', 'c'])!.path).toBe('b')
    expect(nextProjectInCycle(startProjectCycle(['a', 'b', 'c'], 'b'), ['a', 'b', 'c'])!.path).toBe('c')
  })

  it('끝에서 처음으로 감는다 (wrap)', () => {
    expect(nextProjectInCycle(startProjectCycle(['a', 'b', 'c'], 'c'), ['a', 'b', 'c'])!.path).toBe('a')
  })

  it('index -1 (현재가 목록에 없을 때) 는 첫 항목으로 간다', () => {
    expect(nextProjectInCycle(startProjectCycle(['a', 'b'], undefined), ['a', 'b'])!.path).toBe('a')
  })

  it('필터로 안 보이는 것은 건너뛴다 — 커서도 건너뛴 자리에 온다', () => {
    const step = nextProjectInCycle(cycle(), ['a', 'c'])! // b 는 필터로 안 보임
    expect(step.path).toBe('c')
    expect(step.cycle.index).toBe(2)
    expect(nextProjectInCycle(step.cycle, ['a', 'c'])!.path).toBe('a')
  })

  it('보이는 항목이 하나도 없으면 undefined (커서 이동 없음)', () => {
    expect(nextProjectInCycle(cycle(), [])).toBeUndefined()
  })

  it('프로젝트 두 개 이하면 순환할 것이 없어 undefined', () => {
    expect(nextProjectInCycle(startProjectCycle(['a'], 'a'), ['a'])).toBeUndefined()
    expect(nextProjectInCycle(startProjectCycle([], undefined), [])).toBeUndefined()
  })
})
