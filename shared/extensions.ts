// zip 으로 받는 확장 (이슈 #478 — 설계 docs/superpowers/specs/2026-10-19-extension-install-design.md). 이 파일은 메인(검사·설치)과
// 화면(설치 확인·거절 카드)이 같이 쓰는 모양만 둔다. 거절 사유는 코드 + 변수다 — 문구는 화면 단계(4/4)에서 i18n 키로 입힌다

/** extension.json — 설계 3절의 필드 표. 이 밖의 필드는 거절한다 */
export interface ExtensionManifest {
  id: string
  name: string
  description: string
  /** 카드를 펼친 상세에 보이는 긴 설명 — 여러 줄 가능, 글로만 보인다(HTML 아님) (이슈 #519) */
  details?: string
  version: string
  /** 필요한 최소 앱 버전 (semver) */
  litecode?: string
  /** 진입 파일 — manifest 가 있는 폴더 기준 상대 경로 */
  entry: string
  /** A 층은 모양(문자열 배열)만 본다 — 의미는 B 층 */
  permissions?: string[]
}

/** 위험한 항목 경로의 종류 — parent: `..` 마디 · absolute: `/` 로 시작 · drive: `C:` · backslash: `\` (윈도에서 `..` 우회) · nul: 널 문자 · empty: 빈 이름 */
export type UnsafePathReason = 'empty' | 'nul' | 'absolute' | 'drive' | 'backslash' | 'parent'

/** 거절 사유 하나. params 의 값은 화면 문구의 변수로 그대로 들어간다 */
export type ExtensionProblem =
  // zip 자체
  | { code: 'zip-unreadable'; params: { message: string } }
  | { code: 'zip-too-large'; params: { bytes: number; limit: number } }
  | { code: 'too-many-entries'; params: { count: number; limit: number } }
  | { code: 'total-too-large'; params: { bytes: number; limit: number } }
  | { code: 'file-too-large'; params: { path: string; bytes: number; limit: number } }
  | { code: 'unsafe-path'; params: { path: string; reason: UnsafePathReason } }
  | { code: 'symlink'; params: { path: string } }
  | { code: 'duplicate-path'; params: { path: string } }
  // extension.json 의 자리
  | { code: 'manifest-missing'; params: Record<string, never> }
  | { code: 'manifest-ambiguous'; params: { paths: string } }
  | { code: 'manifest-misplaced'; params: { path: string } }
  | { code: 'manifest-too-large'; params: { bytes: number; limit: number } }
  // extension.json 의 내용
  | { code: 'manifest-invalid'; params: { message: string } }
  | { code: 'field-missing'; params: { field: string } }
  | { code: 'field-unknown'; params: { field: string; suggestion?: string } }
  | { code: 'id-invalid'; params: { value: string } }
  | { code: 'id-reserved'; params: { value: string } }
  | { code: 'text-invalid'; params: { field: 'name' | 'description' | 'details'; max: number } }
  | { code: 'version-invalid'; params: { field: 'version' | 'litecode'; value: string } }
  | { code: 'app-too-old'; params: { required: string; current: string } }
  | { code: 'entry-invalid'; params: { value: string } }
  | { code: 'permissions-invalid'; params: Record<string, never> }
  | { code: 'entry-missing'; params: { entry: string } }
  // 설치된 폴더 (이슈 #480) — 폴더 이름과 extension.json 의 id 가 다르다
  | { code: 'id-mismatch'; params: { folder: string; id: string } }

/** zip 검사 결과 — problems 가 비면 통과. manifest 는 extension.json 자체가 맞을 때만 (zip 에 다른 사유가 있어도 미리보기로 보인다) */
export interface ExtensionInspection {
  manifest?: ExtensionManifest
  /** 파일 항목 수(폴더 항목 제외)와 선언된 해제 크기 합 */
  files: { count: number; totalBytes: number }
  problems: ExtensionProblem[]
}

/** 보류 작업 (이슈 #480) — 다음 부팅 때 확장이 올라오기 전에 적용한다 */
export type ExtensionPendingOp = { op: 'install'; id: string; version: string } | { op: 'remove'; id: string }

/** 설치·삭제 요청이 실패한 사유. rejected 는 staging 복사본을 다시 검사해 걸린 것 */
export type ExtensionStoreFailure =
  | { code: 'token-unknown'; params: Record<string, never> }
  | { code: 'rejected'; params: { problems: ExtensionProblem[] } }
  /** staging 복사본의 id·version 이 stage 때 본 것과 다르다 (`<id>@<version>`) */
  | { code: 'staged-mismatch'; params: { expected: string; actual: string } }
  | { code: 'unpack-failed'; params: { message: string } }
  | { code: 'verify-failed'; params: { message: string } }
  | { code: 'id-invalid'; params: { value: string } }
  | { code: 'not-installed'; params: { id: string } }
  | { code: 'io-failed'; params: { message: string } }
  /** 설치·삭제를 곧바로 적용하지 못했다 (이슈 #511) — 이전 상태(버전)가 그대로 남는다. message 는 저장소가 남긴 사유 */
  | { code: 'apply-failed'; params: { message: string } }
  // 진입 HTML 읽기 (readEntry, 이슈 #511)
  /** 켜져 있지 않거나 상태가 정상(on)이 아니다 */
  | { code: 'not-on'; params: { id: string } }
  /** 진입 파일이 .html·.htm 이 아니다 — 패널 확장은 한 파일짜리 HTML */
  | { code: 'entry-not-html'; params: { entry: string } }
  /** 진입 경로가 설치 폴더 밖을 가리키거나(심볼릭 링크) 일반 파일이 아니다 */
  | { code: 'entry-unsafe'; params: { entry: string } }
  | { code: 'entry-too-large'; params: { bytes: number; limit: number } }
  | { code: 'entry-unreadable'; params: { message: string } }

// --- ctx.extensions 와 화면 사이 (이슈 #482) ---

/** settings.extensions — 확장 id → 켜짐. 기본(켜짐)과 다른 값(false)만 남긴다 (features 와 같은 규칙) */
export type ExtensionSwitches = Record<string, boolean>

/** off: 꺼짐 · mounting: 올리는 중 · on: 켜짐 · failed: 설치 폴더가 깨졌거나 올리지 못함 (reason) */
export type ExtensionState = 'on' | 'off' | 'mounting' | 'failed'

/** failed 의 사유 — 코드 + 변수 (문구는 화면이 i18n 키로 입힌다) */
export type ExtensionFailedReason =
  /** 설치 폴더의 extension.json·진입 파일이 맞지 않다 (부팅 때 다시 검증) */
  | { code: 'invalid'; params: { problems: ExtensionProblem[] } }
  /** mount 가 던졌다 — message 는 한 줄로 정리한 오류 (홈 경로 ~, 비밀 가림) */
  | { code: 'mount-failed'; params: { message: string } }

/** 확장 목록의 한 줄. name·description·version 은 extension.json 을 읽었을 때만 (깨진 폴더면 id 만) */
export interface ExtensionSummary {
  id: string
  name?: string
  description?: string
  /** manifest 의 details (이슈 #519) — 있을 때만 */
  details?: string
  version?: string
  /** settings.extensions 의 값 (없으면 켜짐) */
  enabled: boolean
  state: ExtensionState
  reason?: ExtensionFailedReason
}

/** 설치 확인 카드의 미리보기 — problems 가 비면 통과(token 이 있다), 아니면 거절 카드 */
export interface ExtensionPreview extends ExtensionInspection {
  token?: string
  /** 같은 id 가 이미 있으면 그 버전 (보류 설치가 있으면 그쪽) */
  existing?: { version: string }
}

/** ctx.extensions 의 요청 결과 — 던지지 않는다. 실패 코드는 저장소의 것과 같다 (io-failed: 예상 못 한 파일·설정·대화상자 오류) */
export type ExtensionResult<T extends object = object> = ({ ok: true } & T) | { ok: false; failure: ExtensionStoreFailure }
/** pick — preview 가 없으면 대화상자를 취소했다 */
export type ExtensionPickResult = ExtensionResult<{ preview?: ExtensionPreview }>
export type ExtensionInstallResult = ExtensionResult<{ id: string; version: string }>
/** readEntry (이슈 #511) — 켜진 정상 확장의 진입 HTML(UTF-8)과 그 버전 */
export type ExtensionEntryResult = ExtensionResult<{ html: string; version: string }>
