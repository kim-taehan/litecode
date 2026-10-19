import { describe, expect, it } from 'vitest'
import { findModel, initialModel, parseModelRef, withThinking } from '../../renderer/modelChoice.ts'
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

  // 이슈 #500: Thinking 모델(thinking:true)은 대화마다 디폴트·켬·끔 — 그 값은 선택의 키(modelId)에 실린다. 선택기는 키를 (항목, 값)으로 푼다
  describe('Thinking 키', () => {
    const on = engineModelId({ id: 'q' }, 'on')
    const off = engineModelId({ id: 'q' }, 'off')
    const gw = [{ id: 'gw', displayName: 'Gateway', models: [{ id: 'llama', displayName: 'L' }, { id: 'q', displayName: 'Q', thinking: true }] }]

    it('findModel 은 키를 항목과 Thinking 값으로 푼다 — 세 키 모두 같은 항목', () => {
      expect(findModel(gw, { providerId: 'gw', modelId: 'q' })).toMatchObject({ model: { id: 'q' }, thinking: 'default' })
      expect(findModel(gw, { providerId: 'gw', modelId: on })).toMatchObject({ model: { id: 'q' }, thinking: 'on' })
      expect(findModel(gw, { providerId: 'gw', modelId: off })).toMatchObject({ model: { id: 'q' }, thinking: 'off' })
      expect(findModel(gw, { providerId: 'gw', modelId: on })?.model).toBe(gw[0]!.models[1])
    })

    it('Thinking 모델로 선언되지 않은 항목의 접미 키는 못 찾는다', () => {
      expect(findModel(gw, { providerId: 'gw', modelId: engineModelId({ id: 'llama' }, 'off') })).toBeUndefined()
    })

    it('마지막 선택이 켬·끔 키여도 새 대화가 그대로 이어받는다', () => {
      expect(initialModel(gw, { providerId: 'gw', modelId: off })).toEqual({ providerId: 'gw', modelId: off })
    })

    it('withThinking 은 그 선택의 항목은 그대로 두고 키만 바꾼다', () => {
      const current = { providerId: 'gw', modelId: on }
      expect(withThinking(gw, current, 'off')).toEqual({ providerId: 'gw', modelId: off })
      expect(withThinking(gw, current, 'default')).toEqual({ providerId: 'gw', modelId: 'q' })
      expect(withThinking(gw, { providerId: 'gw', modelId: 'q' }, 'on')).toEqual({ providerId: 'gw', modelId: on })
      // 못 찾는 선택·미선언 항목은 바꾸지 않는다
      expect(withThinking(gw, { providerId: 'gw', modelId: 'gone' }, 'on')).toBeUndefined()
      expect(withThinking(gw, { providerId: 'gw', modelId: 'llama' }, 'on')).toBeUndefined()
    })

    it('이전 저장값 {modelId, thinkingOff} 는 끔 키로 읽는다 — 이주로 Thinking 모델이 된 항목의 끔', () => {
      const offRef = parseModelRef('{"providerId":"gw","modelId":"q","thinkingOff":true}')
      expect(offRef).toEqual({ providerId: 'gw', modelId: off })
      expect(findModel(gw, offRef)).toMatchObject({ model: { id: 'q' }, thinking: 'off' })
      expect(parseModelRef('{"providerId":"gw","modelId":"q","thinkingOff":false}')).toEqual({ providerId: 'gw', modelId: 'q' })
    })
  })
})
