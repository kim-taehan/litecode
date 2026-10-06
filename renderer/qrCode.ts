import qrcode from 'qrcode-generator'

// QR 그림 (설정 > 모바일의 [기기 연결], 01t 3절) — 순수 JS 인코더(qrcode-generator, MIT, 의존성 없음)로 칸을 얻어 SVG 경로 하나로 그린다.
// 오류 정정은 M(15%) — 모니터 반사·흐린 화면에서도 읽히게 하되 칸이 너무 촘촘하지 않게. 둘레 여백 4칸은 QR 규격의 조용한 영역이다.

const QUIET = 4

/** 글을 QR 로 — size 는 여백을 포함한 한 변의 칸 수, d 는 어두운 칸들의 SVG 경로 */
export function qrPath(text: string): { size: number; d: string } {
  const code = qrcode(0, 'M')
  code.addData(text, 'Byte')
  code.make()
  const count = code.getModuleCount()
  let d = ''
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) if (code.isDark(row, col)) d += `M${col + QUIET} ${row + QUIET}h1v1h-1z`
  }
  return { size: count + QUIET * 2, d }
}
