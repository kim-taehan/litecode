import { describe, expect, it } from 'vitest'
import { qrPath } from '../../renderer/qrCode.ts'
import { pairUri } from '../../shared/remote.ts'

// QR 그림 (renderer/qrCode.ts) — 설정 > 모바일의 [기기 연결] 모달이 짝짓기 글(litecode://pair?…)을 SVG 경로로 그린다.

describe('QR 경로', () => {
  const uri = pairUri({ version: 1, desktopId: '0123456789abcdef', name: 'DESKTOP-ABC123', addresses: ['192.168.0.10:47600', '10.20.30.40:47600'], fingerprint: 'x'.repeat(43), code: 'AB10110Z9XYZ', expiresAt: 1_800_000_000 })

  it('정사각형 칸 + 둘레 4칸 여백, 왼쪽 위 찾기 무늬(7×7 테두리)가 있다', () => {
    const { size, d } = qrPath(uri)
    expect((size - 8 - 17) % 4).toBe(0) // 버전 v 의 한 변은 17 + 4v
    expect(size).toBeLessThanOrEqual(8 + 17 + 4 * 10) // 짝짓기 글은 버전 10 안에 든다 — 화면 220px 에서 칸이 3px 넘게
    const dark = new Set(d.match(/M\d+ \d+/g))
    for (let index = 0; index < 7; index++) {
      expect(dark.has(`M${4 + index} 4`)).toBe(true) // 윗변
      expect(dark.has(`M4 ${4 + index}`)).toBe(true) // 왼변
    }
    expect(dark.has('M5 5')).toBe(false) // 테두리 안쪽 흰 줄
    expect(dark.has('M7 7')).toBe(true) // 가운데 3×3
  })

  it('같은 글은 같은 그림', () => {
    expect(qrPath(uri)).toEqual(qrPath(uri))
    expect(qrPath(uri).d).not.toBe(qrPath(`${uri}0`).d)
  })
})
