import { describe, expect, it } from 'vitest'
import { thinkingOffTwinId, toggleThinkingOff } from '../../shared/thinkingOffTwin.ts'
import type { ModelCatalogEntry } from '../../src/services/providers.ts'

// 이슈 #491 방법 B: 사고 끄기를 켜면 기존 항목은 그대로 두고 "사고 끔" 항목을 새로 만든다 — 기존 항목의 id 를 바꾸면
// 그 id 를 가리키던 대화·마지막 선택이 끊긴다. 가상 id 인지는 upstreamId 로만 본다(`-off` 접미사로 추측하지 않는다)
const SUFFIX = ' (사고 끔)'

describe('toggleThinkingOff', () => {
  it('(a) 사고 켬·별칭 없음 항목을 켜면 원래 항목은 그대로, 바로 뒤에 사고 끔 항목을 넣는다 (컨텍스트·출력·이미지 복사)', () => {
    const original: ModelCatalogEntry = { id: 'qwen', displayName: 'Qwen', contextLength: 32_768, maxOutput: 4_096, imageInput: true }
    const models = [original, { id: 'llama', displayName: 'L' }]
    const next = toggleThinkingOff(models, 0, true, SUFFIX)
    expect(next).toEqual([
      { id: 'qwen', displayName: 'Qwen', contextLength: 32_768, maxOutput: 4_096, imageInput: true },
      { id: 'qwen-off', displayName: 'Qwen (사고 끔)', upstreamId: 'qwen', thinkingOff: true, contextLength: 32_768, maxOutput: 4_096, imageInput: true },
      { id: 'llama', displayName: 'L' },
    ])
    // 원래 항목·배열은 바꾸지 않는다 (React 상태)
    expect(next[0]).toBe(original)
    expect(models).toHaveLength(2)
  })

  it('(a) 만든 id 가 이미 쓰이면 -off-2, -off-3 … 으로 유일하게', () => {
    const models = [
      { id: 'qwen', displayName: 'Q' },
      { id: 'qwen-off', displayName: '진짜 qwen-off' },
      { id: 'qwen-off-2', displayName: 'X' },
    ]
    expect(toggleThinkingOff(models, 0, true, SUFFIX)[1]).toEqual({ id: 'qwen-off-3', displayName: 'Q (사고 끔)', upstreamId: 'qwen', thinkingOff: true })
  })

  it('(a) 이름이 진짜 `x-off` 인 모델도 접미사로 추측하지 않고 사고 끔 항목을 새로 만든다', () => {
    const next = toggleThinkingOff([{ id: 'x-off', displayName: 'X' }], 0, true, SUFFIX)
    expect(next).toEqual([
      { id: 'x-off', displayName: 'X' },
      { id: 'x-off-off', displayName: 'X (사고 끔)', upstreamId: 'x-off', thinkingOff: true },
    ])
  })

  it('(a) 표시 이름이 비었으면 id 에 접미를 붙인다', () => {
    expect(toggleThinkingOff([{ id: 'qwen', displayName: '' }], 0, true, SUFFIX)[1]!.displayName).toBe('qwen (사고 끔)')
  })

  it('(b) 별칭(upstreamId)이 있는 항목을 켜면 그 항목의 thinkingOff 만 켠다 — 새 항목 없음', () => {
    const models = [{ id: 'qwen', displayName: 'Q' }, { id: 'qwen-fast', displayName: 'QF', upstreamId: 'qwen' }]
    expect(toggleThinkingOff(models, 1, true, SUFFIX)).toEqual([
      { id: 'qwen', displayName: 'Q' },
      { id: 'qwen-fast', displayName: 'QF', upstreamId: 'qwen', thinkingOff: true },
    ])
  })

  it('(c) 별칭이 있는 사고 끔 항목을 끄면 thinkingOff 만 지운다 — id·upstreamId 는 남아 별칭으로 사고 켬', () => {
    const models = [{ id: 'qwen', displayName: 'Q' }, { id: 'qwen-off', displayName: 'Q (사고 끔)', upstreamId: 'qwen', thinkingOff: true }]
    const next = toggleThinkingOff(models, 1, false, SUFFIX)
    expect(next).toEqual([{ id: 'qwen', displayName: 'Q' }, { id: 'qwen-off', displayName: 'Q (사고 끔)', upstreamId: 'qwen' }])
    expect(next[1]).not.toHaveProperty('thinkingOff')
  })

  it('(d) 별칭 없는 사고 끔 항목(구버전 단일 항목·진짜 x-off)을 끄면 thinkingOff 만 지운다, 다시 켜면 (a)', () => {
    for (const id of ['qwen', 'x-off']) {
      const off = toggleThinkingOff([{ id, displayName: 'M', thinkingOff: true }], 0, false, SUFFIX)
      expect(off).toEqual([{ id, displayName: 'M' }])
      expect(toggleThinkingOff(off, 0, true, SUFFIX)).toEqual([
        { id, displayName: 'M' },
        { id: `${id}-off`, displayName: 'M (사고 끔)', upstreamId: id, thinkingOff: true },
      ])
    }
  })

  it('이미 켜진 항목을 켜기는 그대로, id 가 빈 항목을 켜면 짝 없이 그 항목만 켠다', () => {
    const on = [{ id: 'qwen', displayName: 'Q', thinkingOff: true }]
    expect(toggleThinkingOff(on, 0, true, SUFFIX)).toEqual(on)
    expect(toggleThinkingOff([{ id: ' ', displayName: '' }], 0, true, SUFFIX)).toEqual([{ id: ' ', displayName: '', thinkingOff: true }])
  })
})

describe('thinkingOffTwinId', () => {
  it('`<id>-off`, 쓰이면 -off-2 …', () => {
    expect(thinkingOffTwinId('q', () => false)).toBe('q-off')
    expect(thinkingOffTwinId('q', (id) => id === 'q-off' || id === 'q-off-2')).toBe('q-off-3')
  })
})
