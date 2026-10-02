import { describe, expect, it } from 'vitest'
import { messageTokens, TurnMeter } from '../../src/services/turnUsage.ts'

// 턴 하나의 사용량·시간 — opencode 레거시 이벤트(이 턴 것만, TurnScope 가 거른 것)에서 모은다. 모양·시각은 01w 실측 기록
// (`hello [think]` 턴: user created 809202 → reasoning start 810721 → text 813728~813731 → step-finish 813835) 을 따른다
const tokens = (reasoning: number, read: number) => ({ total: 1_050, input: 700, output: 50, reasoning, cache: { read, write: 0 } })
const user = (created: number) => ['message.updated', { info: { id: 'u', role: 'user', time: { created } } }] as const
const part = (time: number, p: Record<string, unknown>) => ['message.part.updated', { part: { messageID: 'a', ...p }, time }] as const

describe('TurnMeter', () => {
  it('글 턴: 스텝 1, 토큰, LLM 시간은 첫 출력→스텝 끝, 첫 토큰은 user 메시지 생성(보낸 때)부터', () => {
    const meter = new TurnMeter()
    meter.observe(...user(809_202))
    meter.observe(...part(810_720, { type: 'step-start', id: 's' }))
    meter.observe(...part(810_721, { type: 'reasoning', id: 'r', text: '', time: { start: 810_721 } }))
    meter.observe(...part(813_724, { type: 'reasoning', id: 'r', text: 'x', time: { start: 810_721, end: 813_723 } }))
    meter.observe(...part(813_728, { type: 'text', id: 't', text: '', time: { start: 813_728 } }))
    meter.observe(...part(813_835, { type: 'step-finish', id: 'f', reason: 'stop', tokens: tokens(1, 301) }))
    expect(meter.usage()).toEqual({
      steps: 1,
      tokens: { input: 700, output: 50, reasoning: 1, cacheRead: 301, cacheWrite: 0 },
      llmMs: 813_835 - 810_721,
      toolMs: 0,
      ttftMs: 810_721 - 809_202,
      ttftSteps: 1,
      lastContextTokens: 700 + 301 + 50 + 1,
    })
  })

  it('도구 턴: 스텝 2, 도구 시간은 state.time, 도구 스텝의 첫 출력은 도구 파트가 나타난 때, 둘째 스텝의 첫 토큰은 직전 스텝 끝부터', () => {
    const meter = new TurnMeter()
    meter.observe(...user(1_000))
    meter.observe(...part(1_100, { type: 'tool', id: 'b', state: { status: 'pending', input: {} } }))
    meter.observe(...part(1_103, { type: 'tool', id: 'b', state: { status: 'running', input: {}, time: { start: 1_103 } } }))
    meter.observe(...part(1_130, { type: 'tool', id: 'b', state: { status: 'completed', input: {}, output: 'x', time: { start: 1_103, end: 1_130 } } }))
    meter.observe(...part(1_133, { type: 'step-finish', id: 'f1', reason: 'tool-calls', tokens: tokens(2, 302) }))
    meter.observe(...part(1_500, { type: 'step-start', id: 's2', messageID: 'a2' }))
    meter.observe(...part(1_508, { type: 'text', id: 't', messageID: 'a2', text: '', time: { start: 1_508 } }))
    meter.observe(...part(1_900, { type: 'step-finish', id: 'f2', messageID: 'a2', reason: 'stop', tokens: tokens(3, 303) }))
    expect(meter.usage()).toEqual({
      steps: 2,
      tokens: { input: 1_400, output: 100, reasoning: 5, cacheRead: 605, cacheWrite: 0 },
      llmMs: 33 + 392,
      toolMs: 27,
      ttftMs: 100 + 375,
      ttftSteps: 2,
      lastContextTokens: 700 + 303 + 50 + 3,
    })
  })

  it('실패한 스텝(step-finish 없이 assistant error)도 한 번 센다. 아무 스텝도 없으면 사용량이 없다', () => {
    expect(new TurnMeter().usage()).toBeUndefined()
    const meter = new TurnMeter()
    meter.observe(...user(1))
    const failed = ['message.updated', { info: { id: 'a', role: 'assistant', error: { name: 'APIError', data: { message: 'x' } } } }] as const
    meter.observe(...failed)
    meter.observe(...failed)
    expect(meter.usage()).toMatchObject({ steps: 1, tokens: { input: 0, output: 0 }, ttftSteps: 0 })
  })
})

describe('messageTokens', () => {
  // 레거시 GET /session/{id}/message 의 [{info, parts}] (01w)
  it('대화 글자 수(사용자 글·답·생각·도구 입력과 결과)를 4 로 나눠 어림한다 — 합성 글은 빼고', () => {
    const input = { command: 'echo hi', description: 'fake' }
    const messages = [
      { parts: [{ type: 'text', text: '[bash:echo hi]' }, { type: 'text', text: 'ignored', synthetic: true }] },
      { parts: [{ type: 'step-start' }, { type: 'tool', tool: 'bash', state: { input, output: 'hi\n' } }, { type: 'step-finish' }] },
      { parts: [{ type: 'text', text: 'tool: hi' }] },
    ]
    const chars = '[bash:echo hi]'.length + JSON.stringify(input).length + 'hi\n'.length + 'tool: hi'.length
    expect(messageTokens(messages)).toBe(Math.round(chars / 4))
  })
})
