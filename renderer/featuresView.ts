import { FEATURE_FIXED, FEATURES, type FeatureId } from '../shared/features.ts'
import { modePermission, type Mode, type ModeRule } from '../shared/modes.ts'

// 설정 > 기능의 순수 규칙 (이슈 #277, 보고서 _workspace/report-plugins/builtin-plugins.html 4절 — dsh PluginInventorySettingsTab 의 거르기 참조).
// 찾기 거르기와 모드 권한 요약 표. 화면(FeaturesSettings.tsx)은 이것만 부른다.

/** 찾는 말로 거르기 — 대소문자 무시 부분일치, 앞뒤 공백 무시. 빈 말이면 전부 */
export function filterByQuery<T>(items: readonly T[], query: string, textsOf: (item: T) => readonly string[]): T[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...items]
  return items.filter((item) => textsOf(item).some((text) => text.toLowerCase().includes(needle)))
}

/** 늘 켜진 기능 (shared/features.ts FEATURE_FIXED) — "항상 켜짐" 소묶음의 읽기 전용 줄, FEATURES 순서 */
export const ALWAYS_ON_FEATURES: readonly FeatureId[] = FEATURES.filter((feature) => FEATURE_FIXED[feature] === true)

/** 모드 권한 요약 표의 행 — 행마다 modePermission 에 물어볼 권한(이름 + 대상). 여럿이면 가장 엄한 값 */
export const MODE_PERMISSION_ROWS = [
  { id: 'editRun', probes: [{ permission: 'edit' }, { permission: 'bash' }] },
  { id: 'web', probes: [{ permission: 'webfetch' }] },
  // 이름에 `_` 가 든 아무 MCP 도구 — 앱 도구(litecode_*)·브라우저(chrome_*)의 예외는 이 행에 넣지 않는다
  { id: 'mcp', probes: [{ permission: 'server_tool' }] },
  { id: 'crossProject', probes: [{ permission: 'litecode_send_to_project' }, { permission: 'litecode_create' }] },
  { id: 'outside', probes: [{ permission: 'external_directory' }, { permission: 'read', resources: ['.env'] }] },
] as const satisfies readonly { id: string; probes: readonly { permission: string; resources?: readonly string[] }[] }[]

export type ModePermissionRowId = (typeof MODE_PERMISSION_ROWS)[number]['id']

const STRICTNESS: Record<ModeRule, number> = { allow: 0, ask: 1, deny: 2 }

/** 그 모드에서 표의 한 행 값 — 메인 대화 기준(하위 작업 아님) */
export function modePermissionRow(mode: Mode, row: ModePermissionRowId): ModeRule {
  const { probes } = MODE_PERMISSION_ROWS.find((candidate) => candidate.id === row)!
  return probes
    .map((probe): ModeRule => modePermission(mode, probe.permission, { resources: 'resources' in probe ? probe.resources : undefined }))
    .reduce((strictest, rule) => (STRICTNESS[rule] > STRICTNESS[strictest] ? rule : strictest))
}
