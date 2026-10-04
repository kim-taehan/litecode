// 오른쪽 패널의 줄 이동 (이슈 #51 — AI 의 open_file 이 줄 번호를 준다). 코드 보기는 줄 높이가 같은 pre 두 개라(FilePreview CodeLines)
// n번째 줄의 자리는 곱셈으로 나온다. 화면(DOM)을 모르는 순수 계산 — 재는 것(줄 높이·보이는 높이)은 부르는 쪽이 한다.

export interface LineJump {
  /** 실제로 간 줄 (1부터) — 파일보다 큰 번호는 마지막 줄, 1보다 작으면 첫 줄 */
  line: number
  /** 그 줄의 위쪽 자리 (코드 첫 줄 위쪽 기준, px) — 강조 띠의 top */
  top: number
  /** 스크롤 자리 — 그 줄이 보이는 높이의 위에서 1/3 쯤에 오게 (앞뒤 문맥이 같이 보인다). 음수 없음 */
  scrollTop: number
}

/** offset 은 스크롤 영역 맨 위에서 코드 첫 줄까지의 거리(패딩) */
export function lineJump(line: number, lineCount: number, lineHeight: number, viewport: number, offset = 0): LineJump {
  const target = Math.min(Math.max(1, Math.floor(line) || 1), Math.max(1, lineCount))
  const top = (target - 1) * lineHeight
  return { line: target, top, scrollTop: Math.max(0, Math.round(offset + top - viewport / 3)) }
}
