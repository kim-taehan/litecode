import { compactionThreshold } from './compaction.ts'
import { effectiveOutputLimit } from '../shared/outputLimit.ts'

// 설정 > 모델 시안 E (이슈 #542) 의 화면 계산 — provider 머리의 이니셜 타일, 모델 카드의 컨텍스트·출력 숫자와 막대·요약 지점.
// 요약 지점은 새로 정하지 않고 대화 화면의 문턱(compactionThreshold)과 같은 규칙을 쓴다

/** 이니셜 타일 글자 — 낱말이 둘 이상이면 앞 두 낱말의 첫 글자, 하나면 앞 두 글자. 대문자 */
export function providerInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean)
  const letters = words.length > 1 ? words.slice(0, 2).map((word) => Array.from(word)[0]!) : Array.from(words[0] ?? '').slice(0, 2)
  return letters.join('').toUpperCase()
}

/** 토큰 수 → 짧은 표기 (131072 → 128K, 100000 → 100K). 1024 로 나눠지면 1024 단위 — 모델 한도는 보통 2 의 거듭제곱이다 */
export function tokenLabel(tokens: number): string {
  const scaled = (unit: number, binary: number, suffix: string) => {
    const value = tokens % binary === 0 ? tokens / binary : tokens / unit
    return `${value < 10 ? Math.round(value * 10) / 10 : Math.round(value)}${suffix}`
  }
  if (tokens >= 1_000_000) return scaled(1_000_000, 1_048_576, 'M')
  if (tokens >= 1_000) return scaled(1_000, 1_024, 'K')
  return String(tokens)
}

export interface ModelBudget {
  /** 컨텍스트 길이 — 비면 없다 */
  context?: number
  /** 엔진이 실제로 쓰는 출력 한도 — 컨텍스트·최대 출력이 둘 다 비면 없다(엔진 기본) */
  output?: number
  /** 최대 출력을 비워 앱 기본을 쓰는가 */
  outputAuto: boolean
  /** 이 토큰을 넘으면 미리 요약한다 — 없으면 게이트웨이가 거절할 때만 요약 */
  summarizeAt?: number
  /** 요약 지점의 컨텍스트 대비 % (막대의 대화 몫) */
  percent?: number
}

export function modelBudget(model: { contextLength?: number; maxOutput?: number }): ModelBudget {
  const threshold = compactionThreshold(model.contextLength, model.maxOutput)
  return {
    context: model.contextLength || undefined,
    output: model.contextLength || model.maxOutput ? effectiveOutputLimit(model) : undefined,
    outputAuto: !model.maxOutput,
    summarizeAt: threshold?.tokens,
    percent: threshold?.percent,
  }
}
