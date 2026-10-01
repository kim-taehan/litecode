import { describe, expect, it } from 'vitest'
import { addTurn, cacheHitPercent, chatStats, compactTokens, duration, statsReadings } from '../../renderer/stats.ts'

// 입력창 아래 통계 줄 — dsh StatsPills·ContextMeter 표기. 엔진이 안 준 값은 "—" (2026-10-01 00_request)
describe('통계 줄 읽기 값', () => {
  it('토큰은 dsh 처럼 K·M 으로 줄인다 (100 이상은 정수, 아래는 소수 한 자리)', () => {
    expect(compactTokens(517)).toBe('517')
    expect(compactTokens(12_240)).toBe('12.2K')
    expect(compactTokens(45_700)).toBe('45.7K')
    expect(compactTokens(666_400)).toBe('666K')
    expect(compactTokens(262_144)).toBe('262K')
    expect(compactTokens(1_234_000)).toBe('1.2M')
  })

  it('시간은 1분 안이면 45.2s, 넘으면 2m42s', () => {
    expect(duration(45_210)).toBe('45.2s')
    expect(duration(162_000)).toBe('2m42s')
  })

  it('캐시 적중률은 일부만 맞았으면 100% 로 반올림하지 않고, 입력이 없으면 없음', () => {
    expect(cacheHitPercent({ input: 100, cacheRead: 0, cacheWrite: 0, output: 5 })).toBe('0')
    expect(cacheHitPercent({ input: 1, cacheRead: 999, cacheWrite: 0, output: 0 })).toBe('99.9')
    expect(cacheHitPercent({ input: 0, cacheRead: 50, cacheWrite: 0, output: 0 })).toBe('100')
    expect(cacheHitPercent({ input: 0, cacheRead: 0, cacheWrite: 0, output: 9 })).toBeUndefined()
  })

  it('값이 하나도 없으면 세 칸과 팝업 항목이 전부 "—"', () => {
    const r = statsReadings()
    expect(r.pace).toEqual(['—'])
    expect(r.usage).toEqual(['—'])
    expect(r.percent).toBeUndefined()
    expect(Object.values(r.session)).toEqual(['—', '—', '—', '—'])
    expect(Object.values(r.tokens)).toEqual(['—', '—', '—', '—', '—'])
    expect(Object.values(r.context)).toEqual(['—', '—', '—'])
  })

  it('다 있으면 dsh 캡처와 같은 모양으로 읽힌다', () => {
    const r = statsReadings({
      turns: 3,
      steps: 7,
      llmMs: 45_210,
      toolMs: 1_500,
      ttftMs: 820,
      tokensPerSecond: 34.4,
      tokens: { input: 600_000, cacheRead: 0, cacheWrite: 0, output: 66_400 },
      context: { used: 45_700, limit: 262_144, systemAndTools: 21_000, messages: 24_700 },
    })
    expect(r.pace).toEqual(['3 turns 7 steps', '34 tok/s'])
    expect(r.session).toEqual({ llm: '45.2s', tool: '1.5s', ttft: '0.8s', tps: '34 tok/s' })
    expect(r.usage).toEqual(['666K tok', 'Cache hit 0%'])
    expect(r.tokens).toEqual({ total: '666,400 tok', cacheHit: '0%', uncached: '600,000 tok', cached: '0 tok', output: '66,400 tok' })
    expect(r.percent).toBe(17)
    expect(r.context).toEqual({ figures: '~45.7K / 262K', systemAndTools: '~21K', messages: '~24.7K' })
  })

  it('컨텍스트 한도를 모르면 백분율은 없고 크기만 보인다', () => {
    const r = statsReadings({ context: { used: 1_200 } })
    expect(r.percent).toBeUndefined()
    expect(r.context.figures).toBe('~1.2K / —')
  })

  // 리더 결정 (2026-10-01): 대화별 합산 — tok/s = Σ출력 / ΣLLM 초, TTFT 평균 = Σ / 표본 수, 컨텍스트는 마지막 턴
  it('턴 사용량을 대화 단위로 더하고 화면 값으로 바꾼다', () => {
    const turn = (steps: number, messageTokens: number) => ({
      steps,
      tokens: { input: 700 * steps, output: 50 * steps, reasoning: 0, cacheRead: 300 * steps, cacheWrite: 0 },
      llmMs: 500 * steps,
      toolMs: steps > 1 ? 30 : 0,
      ttftMs: 200 * steps,
      ttftSteps: steps,
      lastContextTokens: 1_050,
      messageTokens,
    })
    const chat = addTurn(addTurn(undefined, turn(1, 10)), turn(2, 40))
    expect(chat).toMatchObject({ turns: 2, steps: 3, llmMs: 1_500, toolMs: 30, ttftMs: 600, ttftSteps: 3, messageTokens: 40 })
    const stats = chatStats(chat, 4_200)
    expect(stats).toEqual({
      turns: 2,
      steps: 3,
      llmMs: 1_500,
      toolMs: 30,
      ttftMs: 200,
      tokensPerSecond: 100,
      tokens: { input: 2_100, cacheRead: 900, cacheWrite: 0, output: 150 },
      context: { used: 1_050, limit: 4_200, messages: 40, systemAndTools: 1_010 },
    })
    const r = statsReadings(stats)
    expect(r.pace).toEqual(['2 turns 3 steps', '100 tok/s'])
    expect(r.usage).toEqual(['3.2K tok', 'Cache hit 30%'])
    expect(r.percent).toBe(25)
    expect(chatStats(chat).context?.limit).toBeUndefined() // 한도 미설정 → % 는 "—"
    expect(statsReadings(chatStats(chat)).percent).toBeUndefined()
  })

  it('출력은 reasoning 을 포함한다', () => {
    const chat = addTurn(undefined, {
      steps: 1,
      tokens: { input: 10, output: 5, reasoning: 7, cacheRead: 0, cacheWrite: 0 },
      llmMs: 1_000,
      toolMs: 0,
      ttftMs: 0,
      ttftSteps: 0,
      lastContextTokens: 22,
    })
    expect(chatStats(chat)).toMatchObject({ tokens: { output: 12 }, tokensPerSecond: 12, ttftMs: undefined })
  })
})
