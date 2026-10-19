import { FEATURES } from '../../../shared/features.ts'
import type { ExtensionManifest, ExtensionProblem } from '../../../shared/extensions.ts'
import { EXTENSION_LIMITS, type ExtensionLimits } from './limits.ts'
import { isEntryPath } from './paths.ts'

// extension.json 검증 (이슈 #478, 설계 3절 필드 표). 사유를 모두 모아 돌려준다 — 첫 사유에서 멈추지 않는다.
// 모르는 필드는 무시하지 않고 거절한다 (`permisions` 같은 오타가 조용히 넘어가면 권한 선언이 빠진 채 설치된다)

export const MANIFEST_FILE = 'extension.json'

const REQUIRED = ['id', 'name', 'description', 'version', 'entry'] as const
const KNOWN: readonly string[] = [...REQUIRED, 'litecode', 'permissions']
/** 폴더 이름과 설정 키로 쓰이므로 엄격하게 */
const ID = /^[a-z0-9-]{3,40}$/
/** semver 2.0.0 (semver.org 의 권장 정규식) */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

/** manifest 가 맞으면 manifest 와 빈 problems, 아니면 manifest 없이 사유들. value 는 JSON.parse 결과 */
export function checkManifest(
  value: unknown,
  appVersion: string,
  limits: ExtensionLimits = EXTENSION_LIMITS,
): { manifest?: ExtensionManifest; problems: ExtensionProblem[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { problems: [{ code: 'manifest-invalid', params: { message: 'not a JSON object' } }] }
  }
  const raw = value as Record<string, unknown>
  const problems: ExtensionProblem[] = []

  for (const field of Object.keys(raw)) {
    if (KNOWN.includes(field)) continue
    const suggestion = similarField(field)
    problems.push({ code: 'field-unknown', params: suggestion ? { field, suggestion } : { field } })
  }
  const missing = (field: string) => problems.push({ code: 'field-missing', params: { field } })

  if (raw.id === undefined) missing('id')
  else if (typeof raw.id !== 'string' || !ID.test(raw.id)) problems.push({ code: 'id-invalid', params: { value: shown(raw.id) } })
  else if ((FEATURES as readonly string[]).includes(raw.id)) problems.push({ code: 'id-reserved', params: { value: raw.id } })

  for (const [field, max] of [['name', limits.nameLength], ['description', limits.descriptionLength]] as const) {
    const text = raw[field]
    if (text === undefined) missing(field)
    else if (typeof text !== 'string' || text.trim() === '' || text.length > max) problems.push({ code: 'text-invalid', params: { field, max } })
  }

  if (raw.version === undefined) missing('version')
  else if (!isSemver(raw.version)) problems.push({ code: 'version-invalid', params: { field: 'version', value: shown(raw.version) } })

  if (raw.litecode !== undefined) {
    if (!isSemver(raw.litecode)) problems.push({ code: 'version-invalid', params: { field: 'litecode', value: shown(raw.litecode) } })
    else if (compareVersions(appVersion, raw.litecode) < 0) problems.push({ code: 'app-too-old', params: { required: raw.litecode, current: appVersion } })
  }

  if (raw.entry === undefined) missing('entry')
  else if (typeof raw.entry !== 'string' || !isEntryPath(raw.entry)) problems.push({ code: 'entry-invalid', params: { value: shown(raw.entry) } })

  if (raw.permissions !== undefined) {
    const ok = Array.isArray(raw.permissions) && raw.permissions.every((permission) => typeof permission === 'string' && permission !== '')
    if (!ok) problems.push({ code: 'permissions-invalid', params: {} })
  }

  return problems.length > 0 ? { problems } : { manifest: raw as unknown as ExtensionManifest, problems }
}

/** 확장 id 형식 — 폴더 이름·설정 키로 써도 안전하다 (예약어 검사는 하지 않는다) */
export function isExtensionId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value)
}

export function isSemver(value: unknown): value is string {
  return typeof value === 'string' && SEMVER.test(value)
}

/** semver 순서 (semver.org 11절) — 음수: a 가 낮다, 0: 같다(빌드 메타데이터 무시), 양수: a 가 높다. 둘 다 isSemver 여야 한다 */
export function compareVersions(a: string, b: string): number {
  const [, aMajor, aMinor, aPatch, aPre] = SEMVER.exec(a) ?? []
  const [, bMajor, bMinor, bPatch, bPre] = SEMVER.exec(b) ?? []
  const core = Number(aMajor) - Number(bMajor) || Number(aMinor) - Number(bMinor) || Number(aPatch) - Number(bPatch)
  if (core !== 0) return core
  if (aPre === undefined || bPre === undefined) return (aPre === undefined ? 1 : 0) - (bPre === undefined ? 1 : 0)
  const aParts = aPre.split('.')
  const bParts = bPre.split('.')
  for (let i = 0; i < Math.min(aParts.length, bParts.length); i++) {
    const x = aParts[i]!
    const y = bParts[i]!
    if (x === y) continue
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) return Number(x) - Number(y)
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    return x < y ? -1 : 1
  }
  return aParts.length - bParts.length
}

/** 오타로 보이는 알려진 필드 — 대소문자만 다르거나 편집 거리 2 이하 */
function similarField(field: string): string | undefined {
  const lower = field.toLowerCase()
  return KNOWN.find((known) => known === lower) ?? KNOWN.find((known) => editDistance(lower, known) <= 2)
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    previous = current
  }
  return previous[b.length]!
}

/** 사유에 싣는 값 — 문자열은 그대로, 그 밖은 JSON 으로 */
function shown(value: unknown): string {
  return typeof value === 'string' ? value : String(JSON.stringify(value))
}
