import { describe, expect, it } from 'vitest'
import { findModel, initialModel, parseModelRef } from '../../renderer/modelChoice.ts'

// 입력창 아래 모델 드롭다운의 선택 규칙 (00_request 모델 선택, 2026-10-01)
describe('modelChoice', () => {
  const providers = [
    { id: 'gw', displayName: 'Gateway', models: [{ id: 'echo', displayName: 'Echo' }, { id: 'echo-b', displayName: 'Echo B' }] },
    { id: 'relay', displayName: 'Relay', models: [{ id: 'r1', displayName: 'R1' }] },
  ]

  it('findModel 은 provider·모델 id 로 찾고, 설정에서 지워졌으면 undefined', () => {
    expect(findModel(providers, { providerId: 'relay', modelId: 'r1' })?.model.displayName).toBe('R1')
    expect(findModel(providers, { providerId: 'relay', modelId: 'echo' })).toBeUndefined() // 다른 provider 의 모델
    expect(findModel(providers, { providerId: 'gone', modelId: 'echo' })).toBeUndefined()
    expect(findModel(providers, undefined)).toBeUndefined()
  })

  it('새 대화는 마지막으로 고른 모델로, 그것이 설정에서 지워졌거나 없으면 첫 provider 의 첫 모델로 시작한다', () => {
    expect(initialModel(providers, { providerId: 'gw', modelId: 'echo-b' })).toEqual({ providerId: 'gw', modelId: 'echo-b' })
    expect(initialModel(providers, { providerId: 'gw', modelId: 'removed' })).toEqual({ providerId: 'gw', modelId: 'echo' })
    expect(initialModel(providers, undefined)).toEqual({ providerId: 'gw', modelId: 'echo' })
  })

  it('모델이 하나도 없으면 고를 것이 없다', () => {
    expect(initialModel([], undefined)).toBeUndefined()
    expect(initialModel([{ id: 'empty', displayName: 'Empty', models: [] }, ...providers.slice(1)], undefined)).toEqual({ providerId: 'relay', modelId: 'r1' })
  })

  it('저장된 값은 모양이 맞을 때만 읽는다 — 깨진 값이면 없는 것으로', () => {
    expect(parseModelRef('{"providerId":"gw","modelId":"echo-b"}')).toEqual({ providerId: 'gw', modelId: 'echo-b' })
    expect(parseModelRef(null)).toBeUndefined()
    expect(parseModelRef('not json')).toBeUndefined()
    expect(parseModelRef('{"providerId":"gw"}')).toBeUndefined()
    expect(parseModelRef('null')).toBeUndefined()
    expect(parseModelRef('{"providerId":"gw","modelId":"echo","thinkingOff":true}')).toEqual({ providerId: 'gw', modelId: 'echo', thinkingOff: true })
  })

  it('같은 id 의 사고 켬·끔 두 항목을 thinkingOff 로 가려 고르고, 사고 끄기만 지워도 사고 켬은 남는다', () => {
    const both = [
      {
        id: 'gw',
        displayName: 'Gateway',
        models: [
          { id: 'echo', displayName: 'Echo' },
          { id: 'echo', displayName: 'Echo', thinkingOff: true },
        ],
      },
    ]
    expect(findModel(both, { providerId: 'gw', modelId: 'echo', thinkingOff: true })?.model.thinkingOff).toBe(true)
    expect(findModel(both, { providerId: 'gw', modelId: 'echo', thinkingOff: false })?.model.thinkingOff).toBeUndefined()
    // thinkingOff 를 안 준(이전 저장값) 것은 id 로만 맞춰 사고 켜진 항목이 된다
    expect(findModel(both, { providerId: 'gw', modelId: 'echo' })?.model.thinkingOff).toBeUndefined()
    const onlyOff = [{ id: 'gw', displayName: 'Gateway', models: [{ id: 'echo', displayName: 'Echo', thinkingOff: true }] }]
    expect(findModel(onlyOff, { providerId: 'gw', modelId: 'echo', thinkingOff: true })?.model.thinkingOff).toBe(true)
    expect(findModel(onlyOff, { providerId: 'gw', modelId: 'echo', thinkingOff: false })).toBeUndefined()
    // 지워진 사고 끄기 선택은 첫 모델로, 사고 켜진 선택은 그대로
    expect(initialModel(onlyOff, { providerId: 'gw', modelId: 'echo', thinkingOff: true })).toEqual({ providerId: 'gw', modelId: 'echo', thinkingOff: true })
  })
})
