import { LANGUAGES, type MessageKey } from '../shared/i18n/index.ts'
import type { ExtensionFailedReason, ExtensionPreview, ExtensionProblem, ExtensionStoreFailure, ExtensionSummary, UnsafePathReason } from '../shared/extensions.ts'
import { filterByQuery } from './featuresView.ts'
import type { Translate } from './settingsStore.ts'

// 설정 > 기능의 확장 (이슈 #489, 시안 _workspace/mock-extension Main·Confirm·Reject) — 순수 규칙. 화면(ExtensionsSettings.tsx)은 이것만 부른다.
// 메인은 거절·실패 사유를 코드 + 변수로 보낸다(shared/extensions.ts) — 문구는 여기서 i18n 키로 입힌다. 모르는 코드가 와도 던지지 않고 일반 문구.

/** 번역할 문구 하나 — 키 + 변수 */
export interface Message {
  key: MessageKey
  vars?: Record<string, string | number>
}

/** 거절 사유 한 줄 — 굵은 제목 · 고정폭(경로·필드·값) · 번역한 보조 글 · 번역하지 않는 원문(오류 메시지) */
export interface ProblemLine {
  title: Message
  mono?: string
  detail?: Message
  plain?: string
}

/** 1024 진법, 10 미만은 소수 한 자리 (`1.5 KB`·`84 KB`) */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const shown = unit === 0 || value >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10)
  return `${shown} ${units[unit]}`
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** semver 2.0.0 순서 — a 가 크면 양수. src/services/extensions/manifest.ts 의 compareVersions 와 같은 규칙(화면은 서비스 코드를 부르지 않아 따로 둔다).
 *  통과한 zip·설치된 확장의 버전만 오므로 모양이 틀린 값은 0.0.0 으로 본다 */
export function compareVersions(a: string, b: string): number {
  const [, aMajor = '0', aMinor = '0', aPatch = '0', aPre] = SEMVER.exec(a) ?? []
  const [, bMajor = '0', bMinor = '0', bPatch = '0', bPre] = SEMVER.exec(b) ?? []
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

export type InstallKind = 'new' | 'upgrade' | 'same' | 'downgrade'

/** 이미 있는 같은 id 와 견줘 — 설치 확인의 "이미 설치됨" 줄과 버튼 글이 이것으로 갈린다 */
export function installKind(preview: ExtensionPreview): InstallKind {
  if (!preview.existing || !preview.manifest) return 'new'
  const order = compareVersions(preview.manifest.version, preview.existing.version)
  return order > 0 ? 'upgrade' : order === 0 ? 'same' : 'downgrade'
}

/** 설치 직후 오른쪽 패널에 탭을 여나 — 패널 확장만. 언어 팩(이슈 #525)은 열 것이 없고 언어도 바꾸지 않는다(설정 > 일반에서 고른다. 안내는 팩의 details) */
export function opensAfterInstall(preview: ExtensionPreview): boolean {
  return preview.manifest?.type !== 'locale'
}

export type CardKind = 'on' | 'off' | 'mounting' | 'failed'

/** 카드 모양 — 실패 · 올리는 중 · 켜짐/꺼짐 (설치·삭제는 곧바로 적용돼 보류 상태가 없다, 이슈 #511) */
export function cardKind(extension: ExtensionSummary): CardKind {
  if (extension.state === 'failed') return 'failed'
  if (extension.state === 'mounting') return 'mounting'
  return extension.state === 'on' ? 'on' : 'off'
}

/** id 순 + 찾기 (이름·설명·id — 깨진 확장은 id 만 있다). 기능 줄과 같은 거르기(featuresView.filterByQuery) */
export function filterExtensions(extensions: readonly ExtensionSummary[], query: string): ExtensionSummary[] {
  const sorted = [...extensions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return filterByQuery(sorted, query, (extension) => [extension.id, extension.name ?? '', extension.description ?? ''])
}

/** 설정 > 일반 언어 선택지 (이슈 #525) — 내장(ko·en) 뒤에 켜 둔 정상(on) 언어 팩의 자기 이름. 같은 언어의 팩이 여럿이면 id 순 첫 팩(메인 readLocale 과 같은 규칙) */
export function languageOptions(extensions: readonly ExtensionSummary[]): { id: string; label: string }[] {
  const options: { id: string; label: string }[] = [...LANGUAGES]
  const packs = [...extensions].filter((extension) => extension.type === 'locale' && extension.state === 'on' && extension.locale).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const { locale } of packs) {
    if (!options.some((option) => option.id === locale!.language)) options.push({ id: locale!.language, label: locale!.label })
  }
  return options
}

const UNSAFE_PATH: Record<UnsafePathReason, MessageKey> = {
  empty: 'extensions.unsafePath.empty',
  nul: 'extensions.unsafePath.nul',
  absolute: 'extensions.unsafePath.absolute',
  drive: 'extensions.unsafePath.drive',
  backslash: 'extensions.unsafePath.backslash',
  parent: 'extensions.unsafePath.parent',
}

const sizeDetail = (bytes: number, limit: number): Message => ({ key: 'extensions.detail.size', vars: { size: formatBytes(bytes), limit: formatBytes(limit) } })

/** 거절 사유 하나 → 한 줄. 모르는 코드는 일반 문구 + 코드 원문 */
export function problemLine(problem: ExtensionProblem): ProblemLine {
  switch (problem.code) {
    case 'zip-unreadable':
      return { title: { key: 'extensions.problem.zip-unreadable' }, plain: problem.params.message }
    case 'zip-too-large':
      return { title: { key: 'extensions.problem.zip-too-large' }, detail: sizeDetail(problem.params.bytes, problem.params.limit) }
    case 'too-many-entries':
      return { title: { key: 'extensions.problem.too-many-entries' }, detail: { key: 'extensions.detail.count', vars: { count: problem.params.count, limit: problem.params.limit } } }
    case 'total-too-large':
      return { title: { key: 'extensions.problem.total-too-large' }, detail: sizeDetail(problem.params.bytes, problem.params.limit) }
    case 'file-too-large':
      return { title: { key: 'extensions.problem.file-too-large' }, mono: problem.params.path, detail: sizeDetail(problem.params.bytes, problem.params.limit) }
    case 'unsafe-path': {
      const detail = UNSAFE_PATH[problem.params.reason] as MessageKey | undefined
      return { title: { key: 'extensions.problem.unsafe-path' }, mono: problem.params.path, ...(detail ? { detail: { key: detail } } : {}) }
    }
    case 'symlink':
      return { title: { key: 'extensions.problem.symlink' }, mono: problem.params.path }
    case 'duplicate-path':
      return { title: { key: 'extensions.problem.duplicate-path' }, mono: problem.params.path }
    case 'manifest-missing':
      return { title: { key: 'extensions.problem.manifest-missing' }, detail: { key: 'extensions.detail.manifestPlace' } }
    case 'manifest-ambiguous':
      return { title: { key: 'extensions.problem.manifest-ambiguous' }, mono: problem.params.paths }
    case 'manifest-misplaced':
      return { title: { key: 'extensions.problem.manifest-misplaced' }, mono: problem.params.path, detail: { key: 'extensions.detail.manifestPlace' } }
    case 'manifest-too-large':
      return { title: { key: 'extensions.problem.manifest-too-large' }, detail: sizeDetail(problem.params.bytes, problem.params.limit) }
    case 'manifest-invalid':
      return { title: { key: 'extensions.problem.manifest-invalid' }, plain: problem.params.message }
    case 'field-missing':
      return { title: { key: 'extensions.problem.field-missing' }, mono: problem.params.field }
    case 'field-unknown': {
      const { field, suggestion } = problem.params
      return { title: { key: 'extensions.problem.field-unknown' }, mono: field, ...(suggestion ? { detail: { key: 'extensions.detail.suggestion', vars: { suggestion } } } : {}) }
    }
    case 'id-invalid':
      return { title: { key: 'extensions.problem.id-invalid' }, mono: problem.params.value, detail: { key: 'extensions.detail.idRule' } }
    case 'id-reserved':
      return { title: { key: 'extensions.problem.id-reserved' }, mono: problem.params.value }
    case 'text-invalid':
      return { title: { key: 'extensions.problem.text-invalid' }, mono: problem.params.field, detail: { key: 'extensions.detail.textRule', vars: { max: problem.params.max } } }
    case 'version-invalid':
      return { title: { key: 'extensions.problem.version-invalid' }, mono: problem.params.field, detail: { key: 'extensions.detail.versionRule', vars: { value: problem.params.value } } }
    case 'app-too-old':
      return { title: { key: 'extensions.problem.app-too-old' }, detail: { key: 'extensions.detail.appTooOld', vars: { required: problem.params.required, current: problem.params.current } } }
    case 'entry-invalid':
      return { title: { key: 'extensions.problem.entry-invalid' }, mono: problem.params.value }
    case 'permissions-invalid':
      return { title: { key: 'extensions.problem.permissions-invalid' }, mono: 'permissions' }
    case 'entry-missing':
      return { title: { key: 'extensions.problem.entry-missing' }, mono: problem.params.entry }
    case 'id-mismatch':
      return { title: { key: 'extensions.problem.id-mismatch' }, detail: { key: 'extensions.detail.idMismatch', vars: { folder: problem.params.folder, id: problem.params.id } } }
    case 'type-invalid':
      return { title: { key: 'extensions.problem.type-invalid' }, mono: problem.params.value, detail: { key: 'extensions.detail.typeRule' } }
    case 'locale-invalid':
      return { title: { key: 'extensions.problem.locale-invalid' }, mono: `${problem.params.field}: ${problem.params.value}`, detail: { key: 'extensions.detail.localeRule' } }
    case 'locale-reserved':
      return { title: { key: 'extensions.problem.locale-reserved' }, mono: problem.params.value }
    case 'locale-unexpected':
      return { title: { key: 'extensions.problem.locale-unexpected' }, mono: 'locale' }
    case 'locale-too-large':
      return { title: { key: 'extensions.problem.locale-too-large' }, detail: sizeDetail(problem.params.bytes, problem.params.limit) }
    case 'locale-unreadable':
      return { title: { key: 'extensions.problem.locale-unreadable' }, plain: problem.params.message }
    default:
      return { title: { key: 'extensions.problem.unknown' }, mono: String((problem as { code?: unknown }).code) }
  }
}

/** 설치·삭제·켜고 끄기 실패 → 줄들. rejected 는 다시 검사한 사유를 펼친다 */
export function failureLines(failure: ExtensionStoreFailure): ProblemLine[] {
  switch (failure.code) {
    case 'token-unknown':
      return [{ title: { key: 'extensions.failure.token-unknown' }, detail: { key: 'extensions.detail.retry' } }]
    case 'rejected':
      return failure.params.problems.length > 0 ? failure.params.problems.map(problemLine) : [{ title: { key: 'extensions.failure.rejected' } }]
    case 'staged-mismatch':
      return [{ title: { key: 'extensions.failure.staged-mismatch' }, detail: { key: 'extensions.detail.stagedMismatch', vars: { expected: failure.params.expected, actual: failure.params.actual } } }]
    case 'unpack-failed':
      return [{ title: { key: 'extensions.failure.unpack-failed' }, plain: failure.params.message }]
    case 'verify-failed':
      return [{ title: { key: 'extensions.failure.verify-failed' }, plain: failure.params.message }]
    case 'id-invalid':
      return [{ title: { key: 'extensions.failure.id-invalid' }, mono: failure.params.value }]
    case 'not-installed':
      return [{ title: { key: 'extensions.failure.not-installed' }, mono: failure.params.id }]
    case 'io-failed':
      return [{ title: { key: 'extensions.failure.io-failed' }, plain: failure.params.message }]
    case 'apply-failed':
      return [{ title: { key: 'extensions.failure.apply-failed' }, plain: failure.params.message }]
    case 'not-on':
      return [{ title: { key: 'extensions.failure.not-on' }, mono: failure.params.id }]
    case 'entry-not-html':
      return [{ title: { key: 'extensions.failure.entry-not-html' }, mono: failure.params.entry }]
    case 'entry-unsafe':
      return [{ title: { key: 'extensions.failure.entry-unsafe' }, mono: failure.params.entry }]
    case 'entry-too-large':
      return [{ title: { key: 'extensions.failure.entry-too-large' }, detail: sizeDetail(failure.params.bytes, failure.params.limit) }]
    case 'entry-unreadable':
      return [{ title: { key: 'extensions.failure.entry-unreadable' }, plain: failure.params.message }]
    case 'locale-unavailable':
      return [{ title: { key: 'extensions.failure.locale-unavailable' }, mono: failure.params.language }]
    case 'locale-unreadable':
      return [{ title: { key: 'extensions.failure.locale-unreadable' }, plain: failure.params.message }]
    default:
      return [{ title: { key: 'extensions.failure.unknown' } }]
  }
}

/** 한 줄 요약 — 제목 (고정폭 값) */
export function lineSummary(line: ProblemLine, t: Translate): string {
  const title = t(line.title.key, line.title.vars)
  return line.mono ? `${title} (${line.mono})` : title
}

/** 실패한 확장 카드의 빨간 사유 한 줄 */
export function failedReasonText(reason: ExtensionFailedReason, t: Translate): string {
  switch (reason.code) {
    case 'invalid': {
      const first = reason.params.problems[0]
      return first ? t('extensions.failed.invalid', { problem: lineSummary(problemLine(first), t) }) : t('extensions.failed.invalidBare')
    }
    case 'mount-failed':
      return t('extensions.failed.mount', { message: reason.params.message })
    default:
      return t('extensions.failed.unknown')
  }
}
