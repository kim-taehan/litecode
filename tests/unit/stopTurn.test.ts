import { describe, expect, it } from 'vitest'
import { EscapeTwice, STOP_SEQUENCE_MS } from '../../renderer/stopTurn.tsx'

// Esc 두 번으로 답변 멈추기 (dsh ui-conversation stop-sequence 의 동작: 같은 대화에 STOP_SEQUENCE_MS 안의 독립된 두 번)

describe('EscapeTwice', () => {
  it('같은 대화에 간격 안의 두 번째 Esc 만 멈춘다 — 첫 번은 아무것도 안 한다', () => {
    const escape = new EscapeTwice()
    expect(escape.press('c1', 1_000)).toBe(false)
    expect(escape.press('c1', 1_000 + STOP_SEQUENCE_MS)).toBe(true)
  })

  it('간격을 넘기면 다시 첫 번이다', () => {
    const escape = new EscapeTwice()
    escape.press('c1', 0)
    expect(escape.press('c1', STOP_SEQUENCE_MS + 1)).toBe(false)
    expect(escape.press('c1', STOP_SEQUENCE_MS + 2)).toBe(true)
  })

  it('멈춘 뒤 세 번째 Esc 는 새 첫 번이다', () => {
    const escape = new EscapeTwice()
    escape.press('c1', 0)
    expect(escape.press('c1', 10)).toBe(true)
    expect(escape.press('c1', 20)).toBe(false)
  })

  it('대화가 바뀌면 이어지지 않는다. reset 은 첫 번을 지운다', () => {
    const escape = new EscapeTwice()
    escape.press('c1', 0)
    expect(escape.press('c2', 10)).toBe(false)
    escape.reset()
    expect(escape.press('c2', 20)).toBe(false)
  })
})
