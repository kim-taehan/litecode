// 터미널 제어 코드(ANSI) 떼기 — `!명령` 출력은 파이프로 받지만 색을 강제하는 도구(`--color=always`·FORCE_COLOR·CLICOLOR_FORCE)는
// 코드를 그대로 낸다. 카드의 <pre> 와 "AI 에게 보내기" 본문에 `[31m` 같은 글자로 찍히지 않게 뗀다. 색을 그리지는 않는다 — 제거만.
// 줄바꿈·탭·CR 은 건드리지 않는다

const ESC = '\\x1b'
const ANSI = new RegExp(
  [
    `${ESC}\\[[0-?]*[ -/]*[@-~]`, // CSI — 색(SGR)·커서 이동·지우기·?25l
    `${ESC}\\][^\\x07\\x1b]*(?:\\x07|${ESC}\\\\)?`, // OSC — 창 제목·링크 (BEL 또는 ST 로 끝난다)
    `${ESC}[()*+][0-9A-Za-z]`, // 문자 집합 고르기
    `${ESC}[0-9=>@-Z\\\\^_cdn-o|}~]`, // 두 글자 이스케이프
    `${ESC}(?:\\[[0-?]*[ -/]*)?$`, // 조각 끝에서 잘린 코드 (도는 카드 — 다음 조각이 오면 통째로 떼인다)
  ].join('|'),
  'g',
)

export function stripAnsi(text: string): string {
  return text.includes('\x1b') ? text.replace(ANSI, '') : text
}
