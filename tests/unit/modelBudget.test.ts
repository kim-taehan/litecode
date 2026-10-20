import { describe, expect, it } from 'vitest'
import { modelBudget, providerInitials, tokenLabel } from '../../renderer/modelBudget.ts'

// 설정 > 모델 시안 E (이슈 #542) — 머리의 이니셜 타일, 모델 카드의 숫자·막대·요약 지점. 요약 지점은 앱이 쓰는 규칙(compactionThreshold:
// 컨텍스트 − 출력 한도, 출력이 비면 앱 기본 1/4·최대 32000, 32000 상한)을 그대로 쓴다

describe('providerInitials', () => {
  it('낱말이 둘 이상이면 앞 두 낱말의 첫 글자, 대문자', () => {
    expect(providerInitials('Internal LiteLLM Gateway')).toBe('IL')
    expect(providerInitials('사내 게이트웨이')).toBe('사게')
    expect(providerInitials('  open   router ')).toBe('OR')
  })

  it('한 낱말이면 앞 두 글자, 대문자', () => {
    expect(providerInitials('vllm')).toBe('VL')
    expect(providerInitials('x')).toBe('X')
  })

  it('비면 빈 글자', () => {
    expect(providerInitials('   ')).toBe('')
  })

  it('서로게이트 쌍을 반으로 자르지 않는다', () => {
    expect(providerInitials('😀😃 gw')).toBe('😀G')
  })
})

describe('tokenLabel', () => {
  it('1024 로 나눠지면 K 는 1024 단위 (131072 → 128K, 32768 → 32K)', () => {
    expect(tokenLabel(131_072)).toBe('128K')
    expect(tokenLabel(32_768)).toBe('32K')
    expect(tokenLabel(262_144)).toBe('256K')
  })

  it('아니면 1000 단위 반올림 (100000 → 100K, 99072 → 99K, 25000 → 25K)', () => {
    expect(tokenLabel(100_000)).toBe('100K')
    expect(tokenLabel(99_072)).toBe('99K')
    expect(tokenLabel(25_000)).toBe('25K')
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

describe('modelBudget', () => {
  it('출력이 비면 앱 기본(컨텍스트의 1/4) — 자동으로 표시, 요약 지점은 컨텍스트 − 출력', () => {
    expect(modelBudget({ contextLength: 100_000 })).toEqual({ context: 100_000, output: 25_000, outputAuto: true, summarizeAt: 75_000, percent: 75 })
  })

  it('큰 모델의 자동 출력은 32000 에서 멈춘다 (131072 → 99072 에서 요약)', () => {
    expect(modelBudget({ contextLength: 131_072 })).toMatchObject({ output: 32_000, outputAuto: true, summarizeAt: 99_072 })
  })

  it('최대 출력을 적으면 그 값, 32000 을 넘으면 엔진처럼 32000 으로 자른다', () => {
    expect(modelBudget({ contextLength: 100_000, maxOutput: 8_000 })).toMatchObject({ output: 8_000, outputAuto: false, summarizeAt: 92_000, percent: 92 })
    expect(modelBudget({ contextLength: 200_000, maxOutput: 64_000 })).toMatchObject({ output: 32_000, outputAuto: false, summarizeAt: 168_000 })
  })

  it('컨텍스트가 비면 요약 지점이 없다 — 출력은 적은 값 또는 자동', () => {
    expect(modelBudget({})).toEqual({ context: undefined, output: undefined, outputAuto: true, summarizeAt: undefined, percent: undefined })
    expect(modelBudget({ maxOutput: 4_000 })).toEqual({ context: undefined, output: 4_000, outputAuto: false, summarizeAt: undefined, percent: undefined })
  })

  it('출력이 컨텍스트 이상이면 요약 지점이 없다', () => {
    expect(modelBudget({ contextLength: 8_000, maxOutput: 8_000 })).toMatchObject({ context: 8_000, summarizeAt: undefined })
  })
})
