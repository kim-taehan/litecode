import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { confirmCode, groupCode, isPairCode, normalizePairCode, pairDeviceName, sha256 } from '../../shared/remotePairing.ts'
import * as desktop from '../../src/services/remote/pairing.ts'

// 짝짓기 글자 규칙 (shared/remotePairing.ts) — 데스크탑(ctx.remote)과 폰 앱이 같은 함수를 쓴다. 해시는 순수 TS 라 Node crypto 와 대조한다.

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

describe('sha256 (순수 TS)', () => {
  it('Node crypto 와 같은 값 — 빈 글, 한글, 블록 경계(55·56·63·64·65바이트), 긴 글', () => {
    const inputs = ['', 'abc', 'litecode-pair\nAB10110Z9XYZ\n김의 Pixel 8\nandroid', ...[55, 56, 63, 64, 65, 119, 120, 1000].map((length) => 'a'.repeat(length)), '가'.repeat(333)]
    for (const input of inputs) expect(hex(sha256(input)), JSON.stringify(input.slice(0, 20))).toBe(createHash('sha256').update(input).digest('hex'))
  })
})

describe('확인 코드', () => {
  /** #56 의 원래 식 (Node crypto + BigInt) — 옮긴 뒤에도 같은 글자가 나와야 이미 짝짓는 화면과 어긋나지 않는다 */
  function original(code: string, deviceName: string, platform: string): string {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
    const digest = createHash('sha256').update(`litecode-pair\n${code}\n${deviceName}\n${platform}`).digest()
    let bits = 0n
    for (const byte of digest.subarray(0, 5)) bits = (bits << 8n) | BigInt(byte)
    let text = ''
    for (let index = 7; index >= 0; index--) text += alphabet[Number((bits >> BigInt(index * 5)) & 31n)]
    return `${text.slice(0, 4)}-${text.slice(4)}`
  }

  it('옮기기 전 식과 같은 값이 나온다', () => {
    const cases: [string, string, string][] = [
      ['AB10110Z9XYZ', 'Pixel 8', 'android'],
      ['DEV0DEV0DEV0', 'sdk_gphone64_arm64', 'android'],
      ['000000000000', '김의 폰', 'ios'],
      ['ZZZZZZZZZZZZ', 'x'.repeat(64), 'android'],
    ]
    for (const [code, name, platform] of cases) expect(confirmCode(code, name, platform)).toBe(original(code, name, platform))
  })

  it('데스크탑 서비스가 쓰는 함수가 바로 이것이다 (한 정의)', () => {
    expect(desktop.confirmCode).toBe(confirmCode)
    expect(desktop.normalizePairCode).toBe(normalizePairCode)
    expect(desktop.groupCode).toBe(groupCode)
  })
})

describe('사람이 친 글자', () => {
  it('코드: 대문자, 칸 나눔 제거, O→0 · I/L→1. 보일 때는 네 글자씩', () => {
    expect(normalizePairCode('ab1o-il0z 9xyz')).toBe('AB10110Z9XYZ')
    expect(groupCode('AB10110Z9XYZ')).toBe('AB10-110Z-9XYZ')
    expect(groupCode('AB101')).toBe('AB10-1')
  })

  it('직접 입력 코드는 숫자 2자리 — 정규화가 2자리 숫자와 12자 코드를 둘 다 바르게 다룬다', () => {
    expect(normalizePairCode(' 4 7 ')).toBe('47')
    expect(normalizePairCode('o7')).toBe('07') // O→0 은 숫자 칸에서도 같다
    expect(normalizePairCode('ab1o-il0z 9xyz')).toBe('AB10110Z9XYZ')
    for (const good of ['47', '00', '99', 'AB10110Z9XYZ']) expect(isPairCode(good), good).toBe(true)
    for (const bad of ['4', '470', 'AB', '4A', '', 'AB10110Z9XY', 'AB10110Z9XYU']) expect(isPairCode(bad), bad).toBe(false)
  })

  it('기기 이름: 제어 문자를 빼고 다듬어 64자까지 — 데스크탑이 받는 모양 그대로여야 확인 코드가 맞는다', () => {
    expect(pairDeviceName('  Pixel\u0000 8\n ')).toBe('Pixel 8')
    expect(pairDeviceName('x'.repeat(100))).toHaveLength(64)
  })
})
