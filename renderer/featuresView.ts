import { FEATURE_GROUPS, type ChoosableFeatureId } from '../shared/features.ts'

// 설정 > 기능의 순수 규칙 (이슈 #277, 보고서 _workspace/report-plugins/builtin-plugins.html 4절 — dsh PluginInventorySettingsTab 의 거르기 참조).
// 찾기 거르기와 평평한 줄 목록. 화면(FeaturesSettings.tsx)은 이것만 부른다.

/** 찾는 말로 거르기 — 대소문자 무시 부분일치, 앞뒤 공백 무시. 빈 말이면 전부 */
export function filterByQuery<T>(items: readonly T[], query: string, textsOf: (item: T) => readonly string[]): T[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...items]
  return items.filter((item) => textsOf(item).some((text) => text.toLowerCase().includes(needle)))
}

/** 설정 > 기능의 줄 — 묶음(FEATURE_GROUPS) 순서대로 이어 붙인 한 목록, 줄마다 묶음 id(뱃지) (#302) */
export const FEATURE_ROWS: readonly { feature: ChoosableFeatureId; group: (typeof FEATURE_GROUPS)[number]['id'] }[] = FEATURE_GROUPS.flatMap((group) =>
  group.features.map((feature) => ({ feature, group: group.id })),
)
