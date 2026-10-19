// zip 으로 받는 확장 (이슈 #478 — 설계 docs/superpowers/specs/2026-10-19-extension-install-design.md). 이 파일은 메인(검사·설치)과
// 화면(설치 확인·거절 카드)이 같이 쓰는 모양만 둔다. 거절 사유는 코드 + 변수다 — 문구는 화면 단계(4/4)에서 i18n 키로 입힌다

/** extension.json — 설계 3절의 필드 표. 이 밖의 필드는 거절한다 */
export interface ExtensionManifest {
  id: string
  name: string
  description: string
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
  | { code: 'text-invalid'; params: { field: 'name' | 'description'; max: number } }
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
  | { code: 'unpack-failed'; params: { message: string } }
  | { code: 'verify-failed'; params: { message: string } }
  | { code: 'id-invalid'; params: { value: string } }
  | { code: 'not-installed'; params: { id: string } }
  | { code: 'io-failed'; params: { message: string } }
