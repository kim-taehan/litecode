import { describe, expect, it } from 'vitest'
import { PAIR_ALPHABET } from '../../shared/remotePairing.ts'
import { fingerprintCode, isLoopbackHost, PAIR_CLOCK_SKEW_MS, pairUri, parseHostPort, parsePairUri, readPairQr, type PairLink } from '../src/core/pairQr.ts'

// QR 내용(litecode://pair?…)과 지문 앞 8자 — 폰이 데스크탑에 기대는 계약의 글자 규칙 (src/core/pairQr.ts)

const FP = 'q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA' // 43자 base64url
const NOW = 1_800_000_000_000
const link: PairLink = {
  version: 1,
  desktopId: 'desk_1',
  name: '김의 MacBook',
  addresses: ['192.168.0.12:47600', '10.8.0.3:47600'],
  fingerprint: FP,
  code: 'ABCD2345WXYZ',
  expiresAt: NOW / 1000 + 120,
}
const uri = pairUri(link)
/** uri 의 한 필드를 바꾸거나(값) 지운다(undefined) */
function edit(field: string, value: string | undefined): string {
  const [head, query] = uri.split('?') as [string, string]
  const parts = query.split('&').filter((part) => !part.startsWith(`${field}=`))
  if (value !== undefined) parts.push(`${field}=${value}`)
  return `${head}?${parts.join('&')}`
}

describe('QR 글 (데스크탑과 같은 pairUri·parsePairUri)', () => {
  it('필드 순서 v·d·n·a·fp·c·x, 값은 encodeURIComponent — 만든 것을 그대로 읽는다', () => {
    expect(uri).toBe(`litecode://pair?v=1&d=desk_1&n=${encodeURIComponent('김의 MacBook')}&a=192.168.0.12%3A47600%2C10.8.0.3%3A47600&fp=${FP}&c=ABCD2345WXYZ&x=${NOW / 1000 + 120}`)
    expect(parsePairUri(uri)).toEqual(link)
    expect(parsePairUri(uri.replace('%20', '+'))).toEqual(link) // + 는 공백
  })
})

describe('QR 읽기 (readPairQr — 폰이 더 보는 것)', () => {
  it('쓸 수 있으면 그대로 — 겹친 주소는 하나로, 호스트는 소문자로, IPv6 는 [ip]:port, 앞뒤 공백 허용', () => {
    expect(readPairQr(uri, NOW)).toEqual({ ok: true, link })
    const text = ` ${pairUri({ ...link, addresses: ['192.168.0.12:47600', 'PC.local:47600', '192.168.0.12:47600', '[FE80::1]:47600'] })} `
    expect(readPairQr(text, NOW)).toMatchObject({ ok: true, link: { addresses: ['192.168.0.12:47600', 'pc.local:47600', '[fe80::1]:47600'] } })
  })

  it('우리 QR 이 아니면 not-litecode', () => {
    for (const text of ['https://example.com', 'litecode://open?x=1', 'hello', '']) expect(readPairQr(text, NOW), text).toEqual({ ok: false, problem: 'not-litecode' })
  })

  it('모르는 버전이면 version (앱이 오래됐다) — 버전이 없으면 invalid', () => {
    expect(readPairQr(edit('v', '2'), NOW)).toEqual({ ok: false, problem: 'version' })
    expect(readPairQr(edit('v', undefined), NOW)).toEqual({ ok: false, problem: 'invalid' })
  })

  it('만료 — 시계 차이만큼은 봐준다', () => {
    const expiry = link.expiresAt * 1000
    expect(readPairQr(uri, expiry + PAIR_CLOCK_SKEW_MS)).toMatchObject({ ok: true })
    expect(readPairQr(uri, expiry + PAIR_CLOCK_SKEW_MS + 1)).toEqual({ ok: false, problem: 'expired' })
    expect(readPairQr(edit('x', '-5'), NOW)).toEqual({ ok: false, problem: 'expired' })
  })

  it('필드가 빠지면 invalid (이름 n 만 없어도 된다)', () => {
    for (const field of ['d', 'a', 'fp', 'c', 'x']) expect(readPairQr(edit(field, undefined), NOW), field).toEqual({ ok: false, problem: 'invalid' })
    expect(readPairQr(edit('n', undefined), NOW)).toMatchObject({ ok: true, link: { name: '' } })
  })

  it('변조·깨짐은 invalid — 지문 길이·글자, 주소 모양·포트, 코드(12자 Crockford), 만료 숫자, 퍼센트 인코딩', () => {
    const bad = [
      edit('fp', FP.slice(0, 42)),
      edit('fp', `${FP.slice(0, 42)}=`),
      edit('fp', `${FP.slice(0, 42)}+`),
      edit('a', '192.168.0.12'),
      edit('a', '192.168.0.12:0'),
      edit('a', '192.168.0.12:70000'),
      edit('a', 'user@192.168.0.12:47600'),
      edit('c', 'ABCD2345WXY'),
      edit('c', 'ABCD2345WXYU'),
      edit('c', 'AbCdEfGhIjKlMnOpQrStUv'),
      edit('x', 'soon'),
      edit('d', '%E0%A4%A'),
    ]
    for (const text of bad) expect(readPairQr(text, NOW), text).toEqual({ ok: false, problem: 'invalid' })
  })

  it('host:port 하나', () => {
    expect(parseHostPort(' 10.0.0.5:47600 ')).toBe('10.0.0.5:47600')
    expect(parseHostPort('Desk.Local:1')).toBe('desk.local:1')
    expect(parseHostPort('[::1]:47600')).toBe('[::1]:47600')
    for (const bad of ['10.0.0.5', ':47600', '10.0.0.5:65536', '::1:47600', 'a b:1']) expect(parseHostPort(bad), bad).toBeUndefined()
  })

  it('데스크탑의 루프백(평문 리스너)은 127.x 와 ::1 뿐', () => {
    expect(['127.0.0.1', '127.1.2.3', '::1', '[::1]'].map(isLoopbackHost)).toEqual([true, true, true, true])
    expect(['10.0.2.2', 'localhost', '192.168.0.12', '127.0.0.1.evil'].map(isLoopbackHost)).toEqual([false, false, false, false])
  })
})

describe('지문 앞 8자 (fingerprintCode)', () => {
  /** 다른 길로 셈한다: 앞 5바이트를 40bit 정수로 → 5bit 씩 */
  function expected(fingerprint: string): string {
    let value = 0n
    for (const byte of Buffer.from(fingerprint, 'base64url').subarray(0, 5)) value = (value << 8n) | BigInt(byte)
    let text = ''
    for (let shift = 35n; shift >= 0n; shift -= 5n) text += PAIR_ALPHABET[Number((value >> shift) & 31n)]
    return `${text.slice(0, 4)}-${text.slice(4)}`
  }

  it('지문 앞 40bit 를 Crockford base32 로, 네 글자씩', () => {
    expect(fingerprintCode(FP)).toBe(expected(FP))
    expect(fingerprintCode(FP)).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    for (const fingerprint of ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '__________________________________________8', '-_-_-_-_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'])
      expect(fingerprintCode(fingerprint), fingerprint).toBe(expected(fingerprint))
  })

  it('지문이 다르면 (앞 40bit 가 다르면) 8자도 다르다', () => {
    expect(fingerprintCode(FP)).not.toBe(fingerprintCode(`B${FP.slice(1)}`))
  })
})
