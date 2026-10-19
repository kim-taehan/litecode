// 확장 zip 검사의 상한 (이슈 #478) — 값은 여기 한 곳에만 둔다. 검사 함수는 시험용으로 다른 값을 받을 수 있다.

const MB = 1024 * 1024

/** 근거: 확장은 JS·스킬 마크다운·작은 자산이라 보통 수 MB — 넉넉히 두되, 풀었을 때 디스크를 수 GB 채우는 zip bomb·수만 개 항목은 막는다 */
export const EXTENSION_LIMITS = {
  /** zip 파일 자체 크기 — 이보다 크면 목록도 읽지 않는다 */
  zipBytes: 100 * MB,
  /** 항목 수 (폴더 항목 포함) — 목록을 읽기 전에 zip 끝 레코드의 수로 본다 */
  entries: 2000,
  /** 선언된 해제 크기의 합 */
  totalBytes: 200 * MB,
  /** 항목 하나의 선언된 해제 크기 */
  fileBytes: 50 * MB,
  /** extension.json — 메모리로 읽는 유일한 항목이라 따로 작게 */
  manifestBytes: 64 * 1024,
  /** manifest 의 name·description 글자 수 — 카드 제목·설명 한 줄 */
  nameLength: 80,
  descriptionLength: 300,
}

export type ExtensionLimits = typeof EXTENSION_LIMITS
