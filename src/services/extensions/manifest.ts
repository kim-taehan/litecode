import { FEATURES } from '../../../shared/features.ts'
import { EXTENSION_PERMISSIONS, type ExtensionManifest, type ExtensionProblem, type ExtensionType } from '../../../shared/extensions.ts'
import { isBuiltinLanguage, isLanguage } from '../../../shared/i18n/index.ts'
import { EXTENSION_LIMITS, type ExtensionLimits } from './limits.ts'
import { isEntryPath } from './paths.ts'
import { parseServerDeclaration } from './server.ts'

// extension.json 검증 (이슈 #478, 설계 3절 필드 표). 사유를 모두 모아 돌려준다 — 첫 사유에서 멈추지 않는다.
// 모르는 필드는 무시하지 않고 거절한다 (`permisions` 같은 오타가 조용히 넘어가면 권한 선언이 빠진 채 설치된다)
// 종류(type, 이슈 #525): 생략하면 panel(지금까지의 확장). locale 은 언어 팩 — locale: { language, label } 이 필수이고 entry 는 번들 .json

export const MANIFEST_FILE = 'extension.json'

const REQUIRED = ['id', 'name', 'description', 'version', 'entry'] as const
const KNOWN: readonly string[] = [...REQUIRED, 'details', 'litecode', 'permissions', 'type', 'locale', 'server']
const LOCALE_KNOWN: readonly string[] = ['language', 'label']
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
    const suggestion = similar(field, KNOWN)
    problems.push({ code: 'field-unknown', params: suggestion ? { field, suggestion } : { field } })
  }
  const missing = (field: string) => problems.push({ code: 'field-missing', params: { field } })

  if (raw.id === undefined) missing('id')
  else if (typeof raw.id !== 'string' || !ID.test(raw.id)) problems.push({ code: 'id-invalid', params: { value: shown(raw.id) } })
  else if ((FEATURES as readonly string[]).includes(raw.id)) problems.push({ code: 'id-reserved', params: { value: raw.id } })

  for (const [field, max] of [['name', limits.nameLength], ['description', limits.descriptionLength]] as const) {
    const text = raw[field]
    if (text === undefined) missing(field)
    else if (!isText(text, max)) problems.push({ code: 'text-invalid', params: { field, max } })
  }
  // details 는 선택 (이슈 #519) — 있으면 name·description 과 같은 규칙(비지 않은 문자열, 상한)
  if (raw.details !== undefined && !isText(raw.details, limits.detailsLength)) problems.push({ code: 'text-invalid', params: { field: 'details', max: limits.detailsLength } })

  if (raw.version === undefined) missing('version')
  else if (!isSemver(raw.version)) problems.push({ code: 'version-invalid', params: { field: 'version', value: shown(raw.version) } })

  if (raw.litecode !== undefined) {
    if (!isSemver(raw.litecode)) problems.push({ code: 'version-invalid', params: { field: 'litecode', value: shown(raw.litecode) } })
    else if (compareVersions(appVersion, raw.litecode) < 0) problems.push({ code: 'app-too-old', params: { required: raw.litecode, current: appVersion } })
  }

  let type: ExtensionType | undefined = 'panel'
  if (raw.type !== undefined && raw.type !== 'panel' && raw.type !== 'locale') {
    problems.push({ code: 'type-invalid', params: { value: shown(raw.type) } })
    type = undefined
  } else if (raw.type === 'locale') type = 'locale'

  if (raw.entry === undefined) missing('entry')
  else if (typeof raw.entry !== 'string' || !isEntryPath(raw.entry)) problems.push({ code: 'entry-invalid', params: { value: shown(raw.entry) } })
  else if (type === 'locale' && !/\.json$/i.test(raw.entry)) problems.push({ code: 'locale-invalid', params: { field: 'entry', value: raw.entry } })

  if (type === 'locale') problems.push(...checkLocale(raw.locale, limits))
  else if (type === 'panel' && raw.locale !== undefined) problems.push({ code: 'locale-unexpected', params: {} })

  if (raw.permissions !== undefined) {
    const list: unknown = raw.permissions
    const ok = Array.isArray(list) && list.every((permission) => typeof permission === 'string' && permission !== '')
    if (!ok) problems.push({ code: 'permissions-invalid', params: {} })
    // 권한의 의미 (이슈 #536) — 모르는 값은 거절(오타가 조용히 빠지면 확장이 쓰다가 permission-missing 으로 막힌다), 언어 팩은 코드를 실행하지 않으니 권한도 없다
    else if (type === 'locale' && list.length > 0) problems.push({ code: 'permissions-unexpected', params: {} })
    else {
      for (const value of list as string[]) {
        if ((EXTENSION_PERMISSIONS as readonly string[]).includes(value)) continue
        const suggestion = similar(value, EXTENSION_PERMISSIONS)
        problems.push({ code: 'permission-unknown', params: suggestion ? { value, suggestion } : { value } })
      }
    }
  }

  // 내장 서버 (이슈 #537) — 선언과 server 권한은 같이만. 선언은 앱이 그대로 띄우는 것이라 검사 결과(정규화된 값)를 manifest 에 싣는다
  let server: ExtensionManifest['server']
  if (raw.server !== undefined) {
    const parsed = parseServerDeclaration(raw.server)
    if (!parsed.ok) problems.push({ code: 'server-invalid', params: { field: parsed.field } })
    else server = parsed.server
  }
  const serverPermission = Array.isArray(raw.permissions) && raw.permissions.includes('server')
  if ((raw.server !== undefined) !== serverPermission) problems.push({ code: 'server-mismatch', params: {} })

  return problems.length > 0 ? { problems } : { manifest: { ...(raw as unknown as ExtensionManifest), ...(server && { server }) }, problems }
}

/** 언어 팩의 locale 선언 — { language, label }. 내장 언어(ko·en)는 대소문자와 상관없이 거절한다 */
function checkLocale(value: unknown, limits: ExtensionLimits): ExtensionProblem[] {
  if (value === undefined) return [{ code: 'field-missing', params: { field: 'locale' } }]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [{ code: 'locale-invalid', params: { field: 'locale', value: shown(value) } }]
  const locale = value as Record<string, unknown>
  const problems: ExtensionProblem[] = Object.keys(locale)
    .filter((field) => !LOCALE_KNOWN.includes(field))
    .map((field) => ({ code: 'field-unknown', params: { field: `locale.${field}` } }))
  const { language, label } = locale
  if (language === undefined) problems.push({ code: 'field-missing', params: { field: 'locale.language' } })
  else if (typeof language === 'string' && isBuiltinLanguage(language.toLowerCase())) problems.push({ code: 'locale-reserved', params: { value: language } })
  else if (!isLanguage(language)) problems.push({ code: 'locale-invalid', params: { field: 'locale.language', value: shown(language) } })
  if (label === undefined) problems.push({ code: 'field-missing', params: { field: 'locale.label' } })
  else if (!isText(label, limits.localeLabelLength)) problems.push({ code: 'text-invalid', params: { field: 'locale.label', max: limits.localeLabelLength } })
  return problems
}

function isText(value: unknown, max: number): boolean {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max
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

/** 오타로 보이는 알려진 이름(필드·권한) — 대소문자만 다르거나 편집 거리 2 이하 */
function similar(value: string, known: readonly string[]): string | undefined {
  const lower = value.toLowerCase()
  return known.find((name) => name === lower) ?? known.find((name) => editDistance(lower, name) <= 2)
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
