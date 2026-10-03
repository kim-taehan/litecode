// 끌 수 있는 기능 (이슈 #8, 사용자 결정 2026-10-02 — _workspace/00_next_features.md). 메인(ctx.features — 묶음 올리고 내리기)과
// 화면(설정 > 기능, 꺼진 기능의 버튼·탭 숨기기)이 같이 쓴다. 기본은 켜짐 — settings.json 의 features 에 false 로 적힌 것만 꺼진다
// (새 기능이 생겨도 기본 켜짐). FEATURE_DEFAULT_OFF 에 든 기능만 기본 꺼짐이고 true 로 적어야 켜진다. 파일에는 기본값과 다른 값만 남긴다.
// 바탕(대화·엔진·설정·provider·프로젝트·대화 저장)은 여기에 없다 — 끌 수 없다.

// skills(이슈 #7)는 묶음(ctx.skills — 설정 > 스킬 목록·`/` 후보·본문 붙이기)과 엔진 설정(끄면 opencode skill 도구 deny — ctx.engine 이 재시작) 둘 다다
export const FEATURES = ['at', 'slash', 'bang', 'shell', 'terminal', 'trajectory', 'notifications', 'openIn', 'skills', 'mcp', 'web'] as const
export type FeatureId = (typeof FEATURES)[number]

/** 기본 꺼짐 — 웹 도구(opencode 내장 webfetch·websearch, 이슈 #14): 폐쇄망에서 멈추거나(외부 주소 대기) 검색어가 밖으로 나간다.
 *  묶음이 없다 — ctx.engine 이 features/changed 를 듣고 opencode 설정을 다시 써 재시작한다 */
export const FEATURE_DEFAULT_OFF: readonly FeatureId[] = ['web']

/** 저장된 값이 없을 때의 켜짐 */
export function featureDefault(feature: FeatureId): boolean {
  return !FEATURE_DEFAULT_OFF.includes(feature)
}

/** 그 기능이 쓰려면 같이 켜져 있어야 하는 기능 — `!` 입력은 `!명령` 실행(ctx.shell)이 돌린다 */
export const FEATURE_REQUIRES: Partial<Record<FeatureId, readonly FeatureId[]>> = { bang: ['shell'] }

/** 기능별 켜기 값 — 없는 키는 기본값(featureDefault) */
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
  return (switches?.[feature] ?? featureDefault(feature)) && (FEATURE_REQUIRES[feature] ?? []).every((needed) => featureOn(switches, needed))
}
