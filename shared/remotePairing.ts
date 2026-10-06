// 짝짓기의 글자 규칙 — 데스크탑(ctx.remote)과 폰 앱이 **같은 함수**를 쓴다 (이슈 #62). 두 화면에 같은 확인 코드가 떠야 사람이 맞춰 본다.
// Node·React Native 어느 쪽 API 도 쓰지 않는다: 해시는 순수 TS sha256 이다 (Node 의 crypto 는 폰에 없고, Hermes 에는 crypto.subtle 이 없다.
// 확인 코드는 한 번에 수십 바이트만 해시하므로 빠를 필요가 없다 — 네이티브 모듈을 더 들이지 않는다).

/** Crockford base32 — 사람이 읽고 치는 글자라 헷갈리는 I·L·O·U 가 없다 */
export const PAIR_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** 긴 코드 길이 (60bit) — QR 에 싣는다. 옛 데스크탑은 이것을 직접 입력용으로 보였다 */
export const PAIR_CODE_LENGTH = 12
/** 직접 입력용 짧은 코드 — 숫자 2자리(00~99). 같은 발급의 긴 코드와 한 세션이다: 2분·1회용·틀린 시도 3회 폐기를 같이 쓴다.
 *  추측으로 맞을 확률은 3/100 이고, 진짜 관문은 데스크탑의 [허용] 확인이다 (사용자 2026-10-06 "단순 숫자 2자리") */
export const PAIR_SHORT_CODE_LENGTH = 2
/** 기기 이름 길이 한도 — 데스크탑 확인 창·기기 목록에 그대로 보인다 */
export const PAIR_DEVICE_NAME_MAX = 64

/** 사람이 친 코드를 견줄 모양으로 — 대문자, 칸 나눔(공백·-) 제거, Crockford 규칙대로 O→0 · I/L→1 */
export function normalizePairCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
}

/** 정규화한 코드가 받을 수 있는 모양인가 — 숫자 2자리(직접 입력) 또는 12자 Crockford base32(QR·옛 데스크탑) */
export function isPairCode(code: string): boolean {
  if (code.length === PAIR_SHORT_CODE_LENGTH) return /^[0-9]+$/.test(code)
  return code.length === PAIR_CODE_LENGTH && [...code].every((letter) => PAIR_ALPHABET.includes(letter))
}

/** 화면에 보일 모양 — 네 글자씩 */
export function groupCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code
}

/** 기기 이름을 데스크탑이 받아들이는 모양으로 — 제어 문자를 빼고 앞뒤를 다듬어 자른다. 폰은 이 값을 보내고 이 값으로 확인 코드를 낸다 */
export function pairDeviceName(input: string): string {
  return input
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, PAIR_DEVICE_NAME_MAX)
}

/**
 * 확인 코드 8자 — 데스크탑 [허용] 확인과 폰 화면에 같은 글자가 보여야 한다. 루프백 평문 짝짓기(지문이 없다)에서는
 * 요청 자체에서 만든다: sha256("litecode-pair\n" + 코드 + "\n" + 기기 이름 + "\n" + 플랫폼) 의 앞 40bit 를 Crockford base32 8자로.
 * 코드는 normalizePairCode 한 것, 기기 이름은 pairDeviceName 한 것을 넣는다. TLS(사내망) 짝짓기에서는 fingerprintCode 를 쓴다 (01t 3절)
 */
export function confirmCode(code: string, deviceName: string, platform: string): string {
  return groupCode(crockford40(sha256(`litecode-pair\n${code}\n${deviceName}\n${platform}`)))
}

/**
 * 지문 앞 8자 (TLS 라운드, 01t 3절) — 사내망(TLS) 짝짓기에서 데스크탑 [허용] 확인과 폰 화면에 같은 글자가 보여야 한다.
 * fingerprint 는 인증서 공개키(SPKI DER)의 SHA-256 을 base64url(덧붙임 `=` 없음)로 쓴 43자다 (QR 의 `fp`, hello.fingerprint).
 * 그 해시의 앞 40bit 를 Crockford base32 8자로, 네 글자씩(`ABCD-EFGH`). 폰은 TLS 로 받은(고정한) 인증서에서 같은 값을 낸다.
 * 루프백 평문 짝짓기(에뮬레이터)에는 지문이 없어 confirmCode 가 그대로 쓰인다
 */
export function fingerprintCode(fingerprint: string): string {
  return groupCode(crockford40(base64UrlBytes(fingerprint)))
}

/** 앞 5바이트(40bit)를 5bit 씩 8번 */
function crockford40(bytes: Uint8Array): string {
  let text = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes.subarray(0, 5)) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      text += PAIR_ALPHABET[(buffer >> bits) & 31]
      buffer &= (1 << bits) - 1
    }
  }
  return text
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** base64url(덧붙임 없음) 글을 바이트로 (atob·Buffer 없이 — 어느 런타임에서도 같게). 모르는 글자는 건너뛴다 */
function base64UrlBytes(text: string): Uint8Array {
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const symbol of text) {
    const value = BASE64URL.indexOf(symbol)
    if (value < 0) continue
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 255)
      buffer &= (1 << bits) - 1
    }
  }
  return new Uint8Array(bytes)
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** 글자를 UTF-8 로 (TextEncoder 없이 — 어느 런타임에서도 같게) */
function utf8(text: string): number[] {
  const bytes: number[] = []
  for (const symbol of text) {
    const point = symbol.codePointAt(0)!
    if (point < 0x80) bytes.push(point)
    else if (point < 0x800) bytes.push(0xc0 | (point >> 6), 0x80 | (point & 63))
    else if (point < 0x10000) bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 63), 0x80 | (point & 63))
    else bytes.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 63), 0x80 | ((point >> 6) & 63), 0x80 | (point & 63))
  }
  return bytes
}

/** SHA-256 (FIPS 180-4) — 글의 UTF-8 바이트를 해시한 32바이트. tests/unit/remotePairing.test.ts 가 Node crypto 와 대조한다 */
export function sha256(text: string): Uint8Array {
  const message = utf8(text)
  const bitLength = message.length * 8
  message.push(0x80)
  while (message.length % 64 !== 56) message.push(0)
  // 길이(64bit big-endian) — 글이 2^32 비트를 넘을 일은 없지만 위쪽 32bit 도 채운다
  const high = Math.floor(bitLength / 0x100000000)
  for (const word of [high, bitLength >>> 0]) message.push((word >>> 24) & 255, (word >>> 16) & 255, (word >>> 8) & 255, word & 255)

  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const w = new Uint32Array(64)
  const rotr = (value: number, by: number): number => (value >>> by) | (value << (32 - by))
  for (let offset = 0; offset < message.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = (message[offset + i * 4]! << 24) | (message[offset + i * 4 + 1]! << 16) | (message[offset + i * 4 + 2]! << 8) | message[offset + i * 4 + 3]!
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w[i] = w[i - 16]! + s0 + w[i - 7]! + s1
    }
    let [a, b, c, d, e, f, g, h] = hash as unknown as [number, number, number, number, number, number, number, number]
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      h = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    hash[0] += a
    hash[1] += b
    hash[2] += c
    hash[3] += d
    hash[4] += e
    hash[5] += f
    hash[6] += g
    hash[7] += h
  }
  const out = new Uint8Array(32)
  hash.forEach((word, index) => out.set([(word >>> 24) & 255, (word >>> 16) & 255, (word >>> 8) & 255, word & 255], index * 4))
  return out
}
