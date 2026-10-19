import { describe, expect, it } from 'vitest'
import { engineModelId, engineModelKeys, resolveModelKey } from '../../shared/engineModelId.ts'

// 이슈 #500 (#497 을 대체): 설정의 모델 id 는 게이트웨이의 실제 이름이고, "Thinking 모델" 로 선언한 항목은 대화마다 Thinking 을
// 디폴트·켬·끔으로 고른다. 엔진·대화 쪽은 그 선택을 키 하나(디폴트=id, 켬=id--think, 끔=id--nothink)로 들고 다닌다.
// 키를 만드는 것도 되찾는 것도 이 파일 한 곳이다
describe('engineModelId', () => {
  it('디폴트는 id 그대로 — 두 번째 인자를 안 주면 디폴트', () => {
    expect(engineModelId({ id: 'qwen3.8-27b' })).toBe('qwen3.8-27b')
    expect(engineModelId({ id: 'qwen3.8-27b' }, 'default')).toBe('qwen3.8-27b')
  })

  it('켬·끔은 id 뒤에 서로 다른 고정 접미사 — `/`·공백이 없다. 끔 접미사는 #497 과 같은 --nothink', () => {
    const on = engineModelId({ id: 'Qwen/Qwen3-32B' }, 'on')
    const off = engineModelId({ id: 'Qwen/Qwen3-32B' }, 'off')
    expect(off).toBe('Qwen/Qwen3-32B--nothink')
    expect(on).toBe('Qwen/Qwen3-32B--think')
    for (const key of [on, off]) expect(key.slice('Qwen/Qwen3-32B'.length)).toMatch(/^[a-z-]+$/)
  })
})

describe('engineModelKeys', () => {
  it('Thinking 모델이 아니면 키는 id 하나, 선언하면 셋', () => {
    expect(engineModelKeys({ id: 'llama' })).toEqual(['llama'])
    expect(engineModelKeys({ id: 'qwen', thinking: true })).toEqual(['qwen', 'qwen--think', 'qwen--nothink'])
  })
})

describe('resolveModelKey', () => {
  const models = [
    { id: 'llama', displayName: 'L' },
    { id: 'qwen', displayName: 'Q', thinking: true },
  ]

  it('키로 항목과 Thinking 값을 되찾는다', () => {
    expect(resolveModelKey(models, 'qwen')).toEqual({ model: models[1], thinking: 'default' })
    expect(resolveModelKey(models, 'qwen--think')).toEqual({ model: models[1], thinking: 'on' })
    expect(resolveModelKey(models, 'qwen--nothink')).toEqual({ model: models[1], thinking: 'off' })
    expect(resolveModelKey(models, 'llama')).toEqual({ model: models[0], thinking: 'default' })
  })

  it('Thinking 모델로 선언되지 않은 항목의 접미 키는 해석하지 않는다', () => {
    expect(resolveModelKey(models, 'llama--think')).toBeUndefined()
    expect(resolveModelKey(models, 'llama--nothink')).toBeUndefined()
  })

  it('없는 키·빈 키는 undefined', () => {
    expect(resolveModelKey(models, 'gone')).toBeUndefined()
    expect(resolveModelKey(models, undefined)).toBeUndefined()
    expect(resolveModelKey(models, '--think')).toBeUndefined()
  })

  it('진짜 id 가 접미사로 끝나면 그 항목이 이긴다 (같은 목록에 x 의 Thinking 모델이 있어도 — 그런 목록은 저장이 거절한다)', () => {
    const real = [{ id: 'x--think', displayName: 'Real' }, { id: 'x', displayName: 'X', thinking: true }]
    expect(resolveModelKey(real, 'x--think')).toEqual({ model: real[0], thinking: 'default' })
    expect(resolveModelKey(real, 'x--nothink')).toEqual({ model: real[1], thinking: 'off' })
    // 선언 안 된 x 에 진짜 id `x--nothink` 만 있으면 그 항목 그대로
    expect(resolveModelKey([{ id: 'x' }, { id: 'x--nothink' }], 'x--nothink')).toEqual({ model: { id: 'x--nothink' }, thinking: 'default' })
  })

  it('id 가 겹치는 목록(읽기에서 남은 것)은 첫 항목', () => {
    const dup = [{ id: 'd', n: 1 }, { id: 'd', n: 2 }]
    expect(resolveModelKey(dup, 'd')?.model).toBe(dup[0])
  })
})
