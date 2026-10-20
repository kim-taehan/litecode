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
  /** manifest 의 details(선택, 이슈 #519) — 카드를 펼친 상세에 여러 줄로 보이는 긴 설명. 근거: 게임 규칙·조작법 같은 몇 문단이면 충분하고,
   *  목록(ExtensionSummary)에 실려 확장마다 IPC 로 오가므로 manifestBytes(64KB) 보다 훨씬 작게 둔다 */
  detailsLength: 2000,
  /** 진입 HTML 을 읽어 화면에 보내는 크기 (이슈 #511, readEntry). 근거: 한 파일짜리 HTML(인라인 스크립트·스타일)은 보통 수백 KB 다 — 이 글은 IPC 로 한 번,
   *  iframe srcdoc 에 base64(약 1.33배)로 한 번 더 실리므로 파일 미리보기의 HTML 상한(1MB)의 두 배에서 멈춘다 */
  entryBytes: 2 * MB,
  // 언어 팩 (이슈 #525) — 번들(JSON)은 부팅·설치 검사·언어 전환 때 메모리로 읽고, 화면에 IPC 로 한 번 보낸다.
  // 근거(2026-10-20 실측): 내장 사전은 1309키, JSON 으로 ko 85KB·en 77KB, 가장 긴 값 745자(en). 한자는 UTF-8 3바이트라 같은 키 수의 중국어도 수백 KB 안이다
  /** 번들 파일 크기 — 내장 사전 JSON 의 약 12배 */
  localeBytes: 1 * MB,
  /** 번들 맨 위 키 수 — 지금 키 수의 약 4배(키가 늘어날 여지). 넘으면 번들을 통째로 거절한다 */
  localeKeys: 5000,
  /** 값 하나의 글자 수 — 가장 긴 문구의 약 2.7배. 넘는 값은 버린다(그 키는 en 으로 보인다) */
  localeValueLength: 2000,
  /** manifest 의 locale.label — 설정 > 일반 언어 드롭다운의 한 줄 */
  localeLabelLength: 40,
}

export type ExtensionLimits = typeof EXTENSION_LIMITS
