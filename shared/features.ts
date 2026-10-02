// 끌 수 있는 기능 (이슈 #8, 사용자 결정 2026-10-02 — _workspace/00_next_features.md). 메인(ctx.features — 묶음 올리고 내리기)과
// 화면(설정 > 기능, 꺼진 기능의 버튼·탭 숨기기)이 같이 쓴다. 기본은 모두 켜짐 — settings.json 의 features 에 false 로 적힌 것만 꺼진다
// (새 기능이 생겨도 기본 켜짐). 바탕(대화·엔진·설정·provider·프로젝트·대화 저장)은 여기에 없다 — 끌 수 없다.

export const FEATURES = ['at', 'slash', 'bang', 'shell', 'terminal', 'trajectory', 'notifications', 'openIn'] as const
export type FeatureId = (typeof FEATURES)[number]

/** 그 기능이 쓰려면 같이 켜져 있어야 하는 기능 — `!` 입력은 `!명령` 실행(ctx.shell)이 돌린다 */
export const FEATURE_REQUIRES: Partial<Record<FeatureId, readonly FeatureId[]>> = { bang: ['shell'] }

/** 기능별 켜기 값 — 없는 키는 켜짐 */
export type FeatureSwitches = Partial<Record<FeatureId, boolean>>

export function isFeature(value: unknown): value is FeatureId {
  return (FEATURES as readonly unknown[]).includes(value)
}

export function isFeatureSwitches(value: unknown): value is FeatureSwitches {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.entries(value).every(([key, on]) => isFeature(key) && typeof on === 'boolean')
  )
}

/** 저장된 값으로 본 실제 켜짐 — 꺼졌거나, 필요한 기능이 꺼졌으면 false */
export function featureOn(switches: FeatureSwitches | undefined, feature: FeatureId): boolean {
  return switches?.[feature] !== false && (FEATURE_REQUIRES[feature] ?? []).every((needed) => featureOn(switches, needed))
}
