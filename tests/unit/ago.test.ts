import { describe, expect, it } from 'vitest'
import { ago } from '../../renderer/ago.ts'

// 대화 목록 줄 오른쪽의 마지막 활동 시각 — dsh 세션 행처럼 짧게 (2026-10-01 사용자 요청)
describe('ago', () => {
  const now = Date.UTC(2026, 9, 1, 12, 0, 0)
  const min = 60_000

  it('1분 안이면 now', () => {
    expect(ago(now - 59_000, now)).toBe('now')
    expect(ago(now + 5_000, now)).toBe('now') // 시계가 살짝 어긋나도
  })

  it('분·시간·일 단위로 내림한다', () => {
    expect(ago(now - min, now)).toBe('1min')
    expect(ago(now - 38 * min, now)).toBe('38min')
    expect(ago(now - 60 * min, now)).toBe('1h')
    expect(ago(now - (23 * 60 + 59) * min, now)).toBe('23h')
    expect(ago(now - 24 * 60 * min, now)).toBe('1d')
    expect(ago(now - 9 * 24 * 60 * min, now)).toBe('9d')
  })

  // dsh ui-primitives relative-time — 30일부터 달(30일 단위), 365일부터 해 (01j)
  it('30일부터 mo, 365일부터 y', () => {
    const day = 24 * 60 * min
    expect(ago(now - 29 * day, now)).toBe('29d')
    expect(ago(now - 30 * day, now)).toBe('1mo')
    expect(ago(now - 364 * day, now)).toBe('12mo')
    expect(ago(now - 365 * day, now)).toBe('1y')
    expect(ago(now - 800 * day, now)).toBe('2y')
  })
})
