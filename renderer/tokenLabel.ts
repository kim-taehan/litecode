// 설정 > 모델 표의 토큰 수 표기 (이슈 #542 시안 A) — 컨텍스트 `128K`, 최대 출력 `자동 25K`.
// 대화 통계 줄의 compactTokens(stats.ts)는 1000 단위라 모델 한도(보통 2 의 거듭제곱)가 131K·32.8K 로 보인다 — 여기선 1024 로 나눠지면 1024 단위

/** 토큰 수 → 짧은 표기 (131072 → 128K, 100000 → 100K) */
export function tokenLabel(tokens: number): string {
  const scaled = (unit: number, binary: number, suffix: string) => {
    const value = tokens % binary === 0 ? tokens / binary : tokens / unit
    return `${value < 10 ? Math.round(value * 10) / 10 : Math.round(value)}${suffix}`
  }
  if (tokens >= 1_000_000) return scaled(1_000_000, 1_048_576, 'M')
  if (tokens >= 1_000) return scaled(1_000, 1_024, 'K')
  return String(tokens)
}
