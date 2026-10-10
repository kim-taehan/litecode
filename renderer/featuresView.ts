import { FEATURE_FIXED, FEATURES, type FeatureId } from '../shared/features.ts'

// 설정 > 기능의 순수 규칙 (이슈 #277, 보고서 _workspace/report-plugins/builtin-plugins.html 4절 — dsh PluginInventorySettingsTab 의 거르기 참조).
// 찾기 거르기와 늘 켜진 기능 목록. 화면(FeaturesSettings.tsx)은 이것만 부른다.

/** 찾는 말로 거르기 — 대소문자 무시 부분일치, 앞뒤 공백 무시. 빈 말이면 전부 */
export function filterByQuery<T>(items: readonly T[], query: string, textsOf: (item: T) => readonly string[]): T[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...items]
  return items.filter((item) => textsOf(item).some((text) => text.toLowerCase().includes(needle)))
}

/** 늘 켜진 기능 (shared/features.ts FEATURE_FIXED) — "항상 켜짐" 소묶음의 읽기 전용 줄, FEATURES 순서 */
export const ALWAYS_ON_FEATURES: readonly FeatureId[] = FEATURES.filter((feature) => FEATURE_FIXED[feature] === true)
