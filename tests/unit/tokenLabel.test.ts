import { describe, expect, it } from 'vitest'
import { tokenLabel } from '../../renderer/tokenLabel.ts'

// 설정 > 모델 표 (이슈 #542 시안 A) — 컨텍스트·최대 출력 칸의 짧은 표기

describe('tokenLabel', () => {
  it('1024 로 나눠지면 K 는 1024 단위 (131072 → 128K, 32768 → 32K)', () => {
    expect(tokenLabel(131_072)).toBe('128K')
    expect(tokenLabel(32_768)).toBe('32K')
    expect(tokenLabel(262_144)).toBe('256K')
  })

  it('아니면 1000 단위 반올림 (100000 → 100K, 25000 → 25K, 99072 → 99K)', () => {
    expect(tokenLabel(100_000)).toBe('100K')
    expect(tokenLabel(25_000)).toBe('25K')
    expect(tokenLabel(99_072)).toBe('99K')
  })

  it('10K 아래는 소수 한 자리까지, 1000 아래는 그대로', () => {
    expect(tokenLabel(6_000)).toBe('6K')
    expect(tokenLabel(1_500)).toBe('1.5K')
    expect(tokenLabel(999)).toBe('999')
  })

  it('백만 이상은 M', () => {
    expect(tokenLabel(1_048_576)).toBe('1M')
    expect(tokenLabel(1_000_000)).toBe('1M')
    expect(tokenLabel(1_500_000)).toBe('1.5M')
  })
})
