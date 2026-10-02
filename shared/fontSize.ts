// 대화 본문 글자 크기 — dsh ui-theme 와 같은 범위(12~17px 정수, 기본 14). 메인(검증)과 화면(조절기·CSS 변수)이 같이 쓴다.

export const FONT_SIZE_MIN = 12
export const FONT_SIZE_MAX = 17

/** 기준 크기에서 나오는 CSS 변수 셋 (dsh: 제목은 기준값 + delta, 한 단계 작은 글자는 14 이하면 −1, 넘으면 −2) */
export function chatFontVars(size: number): Record<'--chat-font-size' | '--chat-font-delta' | '--chat-font-size-secondary', string> {
  return {
    '--chat-font-size': `${size}px`,
    '--chat-font-delta': `${size - 14}px`,
    '--chat-font-size-secondary': `${size <= 14 ? size - 1 : size - 2}px`,
  }
}
