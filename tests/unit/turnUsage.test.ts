import { describe, expect, it } from 'vitest'
import { messageTokens, TurnMeter } from '../../src/services/turnUsage.ts'

// 턴 하나의 사용량·시간 — opencode 세션 SSE 이벤트에서 모은다. 이벤트 순서·시각은 01_probe 의 실측 기록 그대로 (2026-10-01)
const tokens = (reasoning: number, read: number) => ({ input: 700, output: 50, reasoning, cache: { read, write: 0 } })

describe('TurnMeter', () => {
  it('글자 턴: 스텝 1, 토큰, LLM 시간은 첫 출력→끝, 첫 토큰은 prompted 부터', () => {
    const meter = new TurnMeter()
    meter.observe('session.next.prompted', { timestamp: 807_280 })
    meter.observe('session.next.step.started', { timestamp: 807_762 })
    meter.observe('session.next.text.started', { timestamp: 807_765 })
    meter.observe('session.next.text.ended', { timestamp: 808_158 })
    meter.observe('session.next.step.ended', { timestamp: 808_161, finish: 'stop', tokens: tokens(1, 301) })
    expect(meter.usage()).toEqual({
      steps: 1,
      tokens: { input: 700, output: 50, reasoning: 1, cacheRead: 301, cacheWrite: 0 },
      llmMs: 396,
      toolMs: 0,
      ttftMs: 485,
      ttftSteps: 1,
      lastContextTokens: 700 + 301 + 50 + 1,
    })
  })

  it('도구 턴: 스텝 2, 도구 시간은 callID 로 짝, 둘째 스텝의 첫 토큰은 직전 스텝 끝부터', () => {
    const meter = new TurnMeter()
    meter.observe('session.next.prompted', { timestamp: 833_048 })
    meter.observe('session.next.step.started', { timestamp: 833_190 })
    meter.observe('session.next.tool.input.started', { timestamp: 833_192, callID: 'call_1' })
    meter.observe('session.next.tool.called', { timestamp: 833_195, callID: 'call_1' })
    meter.observe('session.next.tool.success', { timestamp: 833_222, callID: 'call_1' })
    meter.observe('session.next.step.ended', { timestamp: 833_225, finish: 'tool-calls', tokens: tokens(2, 302) })
    meter.observe('session.next.step.started', { timestamp: 833_598 })
    meter.observe('session.next.text.started', { timestamp: 833_600 })
    meter.observe('session.next.step.ended', { timestamp: 834_003, finish: 'stop', tokens: tokens(3, 303) })
    expect(meter.usage()).toEqual({
      steps: 2,
      tokens: { input: 1_400, output: 100, reasoning: 5, cacheRead: 605, cacheWrite: 0 },
      llmMs: 33 + 403, // 도구 스텝은 tool.input.started 가 첫 출력
      toolMs: 27,
      ttftMs: 144 + 375,
      ttftSteps: 2,
      lastContextTokens: 700 + 303 + 50 + 3,
    })
  })

  it('실패한 스텝도 센다. 아무 스텝도 없으면 사용량이 없다', () => {
    expect(new TurnMeter().usage()).toBeUndefined()
    const meter = new TurnMeter()
    meter.observe('session.next.prompted', { timestamp: 1 })
    meter.observe('session.next.step.failed', { timestamp: 9, error: { message: 'x' } })
    expect(meter.usage()).toMatchObject({ steps: 1, tokens: { input: 0, output: 0 }, ttftSteps: 0 })
  })
})

describe('messageTokens', () => {
  // GET /api/session/{id}/context 의 실측 모양 (2026-10-01): user 는 text, assistant 는 content[] (text·tool)
  it('대화 글자 수(사용자 글·답·도구 입력과 결과)를 4 로 나눠 어림한다', () => {
    const input = { command: 'echo hi', description: 'fake' }
    const context = [
      { type: 'user', text: '[bash:echo hi]' },
      {
        type: 'assistant',
        content: [{ type: 'tool', name: 'bash', state: { input, content: [{ type: 'text', text: 'hi\n' }, { type: 'text', text: 'Command exited with code 0.' }] } }],
      },
      { type: 'assistant', content: [{ type: 'text', text: 'tool: hi' }] },
    ]
    const chars = '[bash:echo hi]'.length + JSON.stringify(input).length + 'hi\n'.length + 'Command exited with code 0.'.length + 'tool: hi'.length
    expect(messageTokens(context)).toBe(Math.round(chars / 4))
  })
})
