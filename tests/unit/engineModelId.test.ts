import { describe, expect, it } from 'vitest'
import { engineModelId } from '../../shared/engineModelId.ts'

// 이슈 #497 (시안 E): 같은 게이트웨이 id 를 사고 켬·끔 두 항목으로 둔다. 엔진·대화 쪽은 이 함수가 만든 내부 키로 모델을 가리키고,
// 사용자는 키를 보지 않는다. 규칙은 이 함수 한 곳에만 있다
describe('engineModelId', () => {
  it('사고 끄기가 아니면 id 그대로', () => {
    expect(engineModelId({ id: 'qwen3.8-27b' })).toBe('qwen3.8-27b')
    expect(engineModelId({ id: 'qwen3.8-27b', thinkingOff: false })).toBe('qwen3.8-27b')
  })

  it('사고 끄기면 id 뒤에 고정 접미사 — 같은 id 의 사고 켬과 다르고, `/`·공백이 없다', () => {
    const off = engineModelId({ id: 'Qwen/Qwen3-32B', thinkingOff: true })
    expect(off).not.toBe('Qwen/Qwen3-32B')
    expect(off.startsWith('Qwen/Qwen3-32B')).toBe(true)
    const suffix = off.slice('Qwen/Qwen3-32B'.length)
    expect(suffix).toMatch(/^[a-z0-9-]+$/)
  })

  it('접미 키는 그 모양의 진짜 id 와 겹칠 수 있다 — 저장 검증이 키 기준으로 거절한다 (providers.test)', () => {
    const key = engineModelId({ id: 'x', thinkingOff: true })
    expect(engineModelId({ id: key })).toBe(key)
  })
})
