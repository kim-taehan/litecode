import { describe, expect, it } from 'vitest'
import { findModel, initialModel, parseModelRef } from '../../renderer/modelChoice.ts'
import { engineModelId } from '../../shared/engineModelId.ts'

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
  })

  // 이슈 #497 (시안 E): 같은 id 의 사고 켬·끔 두 항목은 내부 키(engineModelId)가 다르다 — 선택은 키 하나로 쥔다
  describe('내부 키', () => {
    const off = engineModelId({ id: 'q', thinkingOff: true })
    // providers.json 의 실제 형태 — 사고 끄기 항목이 먼저, 같은 id 의 사고 켬 항목이 뒤에
    const both = [{ id: 'gw', displayName: 'Gateway', models: [{ id: 'q', displayName: 'Q', thinkingOff: true }, { id: 'q2', displayName: 'Other' }, { id: 'q', displayName: 'thinking Q' }] }]

    it('findModel 은 키로 찾는다 — 사고 켬 키(=id)는 사고 켬 항목, 접미 키는 사고 끔 항목', () => {
      expect(findModel(both, { providerId: 'gw', modelId: 'q' })?.model.displayName).toBe('thinking Q')
      expect(findModel(both, { providerId: 'gw', modelId: off })?.model.displayName).toBe('Q')
    })

    it('사고 끔 항목만 있으면 id 로는 못 찾는다 (키가 다르다)', () => {
      const onlyOff = [{ id: 'gw', displayName: 'Gateway', models: [{ id: 'q', displayName: 'Q', thinkingOff: true }] }]
      expect(findModel(onlyOff, { providerId: 'gw', modelId: 'q' })).toBeUndefined()
      expect(initialModel(onlyOff, { providerId: 'gw', modelId: off })).toEqual({ providerId: 'gw', modelId: off })
    })

    it('새 대화의 첫 모델도 키 — 첫 항목이 사고 끔이면 접미 키', () => {
      expect(initialModel(both, undefined)).toEqual({ providerId: 'gw', modelId: off })
    })

    it('이전 저장값 {modelId, thinkingOff} 는 키로 읽는다 — 첫 모델로 돌아가지 않는다', () => {
      const offRef = parseModelRef('{"providerId":"gw","modelId":"q","thinkingOff":true}')
      expect(offRef).toEqual({ providerId: 'gw', modelId: off })
      expect(initialModel(both, offRef)).toEqual({ providerId: 'gw', modelId: off })
      const onRef = parseModelRef('{"providerId":"gw","modelId":"q","thinkingOff":false}')
      expect(onRef).toEqual({ providerId: 'gw', modelId: 'q' })
      expect(findModel(both, onRef)?.model.displayName).toBe('thinking Q')
    })
  })
})
