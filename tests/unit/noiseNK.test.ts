import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { describe, expect, it } from 'vitest'
import {
  bluetoothPrologue,
  CipherState,
  decodeNoiseKey,
  encodeNoiseKey,
  generateNoiseKeyPair,
  initiator,
  NOISE_MAX_MESSAGE,
  NOISE_NONCE_LIMIT,
  NOISE_TAG,
  NoiseError,
  noiseKeyCode,
  noisePublicKey,
  responder,
  type NoiseSession,
} from '../../shared/noiseNK.ts'
import { fingerprintCode } from '../../shared/remotePairing.ts'

// L2 보안 채널 — Noise_NK_25519_ChaChaPoly_SHA256 (이슈 #171). 가장 큰 증거는 공개 검증 벡터와 바이트 단위로 같다는 것이다:
// tests/fixtures/noise-nk-vectors.json (cacophony·snow 의 NK 25519/ChaChaPoly/SHA256 항목을 그대로 옮긴 것, 출처·커밋은 파일 안에).
// 무선은 쓰지 않는다.

interface Vector {
  protocol_name: string
  init_prologue: string
  init_ephemeral: string
  init_remote_static: string
  resp_prologue: string
  resp_static: string
  resp_ephemeral: string
  handshake_hash?: string
  messages: { payload: string; ciphertext: string }[]
}
const fixture = JSON.parse(readFileSync(new URL('../fixtures/noise-nk-vectors.json', import.meta.url), 'utf8')) as { sources: { name: string; vectors: Vector[] }[] }
const vectors = fixture.sources.flatMap((source) => source.vectors.map((vector) => ({ source: source.name, vector })))

const hex = (text: string): Uint8Array => Uint8Array.from(text.match(/../g) ?? [], (byte) => parseInt(byte, 16))
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')
const bytes = (length: number, seed = 1): Uint8Array => Uint8Array.from({ length }, (_, index) => (index * 31 + seed * 7) & 0xff)

/** 두 끝의 세션 — 핸드셰이크를 끝까지 돌린다 */
function connect(options: { prologue?: Uint8Array } = {}) {
  const server = generateNoiseKeyPair()
  const phone = initiator(server.publicKey, options)
  const desktop = responder(server, options)
  desktop.readMessage1(phone.writeMessage1())
  const { message, session: desktopSession } = desktop.writeMessage2()
  const { session: phoneSession } = phone.readMessage2(message)
  return { server, phone: phoneSession, desktop: desktopSession }
}

describe('공개 검증 벡터 — 같은 키·페이로드로 같은 바이트', () => {
  it(`벡터가 있다 (${vectors.map((entry) => entry.source).join('·')})`, () => {
    expect(vectors.length).toBeGreaterThanOrEqual(2)
    for (const { vector } of vectors) expect(vector.protocol_name).toBe('Noise_NK_25519_ChaChaPoly_SHA256')
  })

  for (const { source, vector } of vectors) {
    it(`${source}: 핸드셰이크 두 메시지와 전송 ${vector.messages.length - 2}개가 바이트 단위로 같다`, () => {
      const staticSecret = hex(vector.resp_static)
      expect(toHex(noisePublicKey(staticSecret))).toBe(vector.init_remote_static) // 벡터 자체의 짝이 맞다
      const phone = initiator(hex(vector.init_remote_static), { prologue: hex(vector.init_prologue), ephemeralSecret: hex(vector.init_ephemeral) })
      const desktop = responder({ secretKey: staticSecret, publicKey: noisePublicKey(staticSecret) }, { prologue: hex(vector.resp_prologue), ephemeralSecret: hex(vector.resp_ephemeral) })
      const [m1, m2, ...transport] = vector.messages

      const message1 = phone.writeMessage1(hex(m1!.payload))
      expect(toHex(message1)).toBe(m1!.ciphertext)
      expect(toHex(desktop.readMessage1(message1))).toBe(m1!.payload)

      const { message: message2, session: desktopSession } = desktop.writeMessage2(hex(m2!.payload))
      expect(toHex(message2)).toBe(m2!.ciphertext)
      const { session: phoneSession, payload } = phone.readMessage2(message2)
      expect(toHex(payload)).toBe(m2!.payload)

      if (vector.handshake_hash) {
        expect(toHex(phoneSession.handshakeHash)).toBe(vector.handshake_hash)
        expect(toHex(desktopSession.handshakeHash)).toBe(vector.handshake_hash)
      }
      // 전송 메시지는 개시자부터 번갈아
      transport.forEach((message, index) => {
        const [from, to] = index % 2 === 0 ? [phoneSession, desktopSession] : [desktopSession, phoneSession]
        const cipher = from.encrypt(hex(message.payload))
        expect(toHex(cipher)).toBe(message.ciphertext)
        expect(toHex(to.decrypt(cipher))).toBe(message.payload)
      })
    })
  }
})

describe('핸드셰이크', () => {
  it('정상 왕복 — 양방향 여러 레코드, 양쪽 핸드셰이크 해시가 같다, 메시지 둘은 48바이트(빈 페이로드)', () => {
    const server = generateNoiseKeyPair()
    const phone = initiator(server.publicKey)
    const desktop = responder(server)
    const m1 = phone.writeMessage1()
    expect(m1.length).toBe(32 + NOISE_TAG)
    expect(desktop.readMessage1(m1).length).toBe(0)
    const { message: m2, session: d } = desktop.writeMessage2()
    expect(m2.length).toBe(32 + NOISE_TAG)
    const { session: p } = phone.readMessage2(m2)
    expect(toHex(p.handshakeHash)).toBe(toHex(d.handshakeHash))
    for (let round = 0; round < 5; round++) {
      expect(toHex(d.decrypt(p.encrypt(bytes(100 + round, round))))).toBe(toHex(bytes(100 + round, round)))
      expect(toHex(d.decrypt(p.encrypt(bytes(7, round))))).toBe(toHex(bytes(7, round)))
      expect(toHex(p.decrypt(d.encrypt(bytes(300, round))))).toBe(toHex(bytes(300, round)))
    }
  })

  it('같은 평문도 레코드마다 암호문이 다르다 (nonce 카운터)', () => {
    const { phone } = connect()
    expect(toHex(phone.encrypt(bytes(10)))).not.toBe(toHex(phone.encrypt(bytes(10))))
  })

  it('틀린 서버 공개키(다른 데스크탑의 bk) — 데스크탑이 메시지 1 을 못 푼다', () => {
    const server = generateNoiseKeyPair()
    const other = generateNoiseKeyPair()
    const phone = initiator(other.publicKey)
    expect(() => responder(server).readMessage1(phone.writeMessage1())).toThrow(NoiseError)
  })

  it('틀린 서버 공개키를 쥔 폰은 진짜 데스크탑의 메시지 2 도 못 푼다 (중간자가 답을 지어낼 수 없다)', () => {
    const server = generateNoiseKeyPair()
    const impostor = generateNoiseKeyPair()
    // 폰은 진짜 키를 쥐었고, 사칭자는 자기 키로 응답한다 → 사칭자는 메시지 1 부터 못 푼다
    const phone = initiator(server.publicKey)
    expect(() => responder(impostor).readMessage1(phone.writeMessage1())).toThrow(NoiseError)
  })

  it('프롤로그가 다르면(다른 desktopId) 메시지 1 에서 실패한다', () => {
    const server = generateNoiseKeyPair()
    const phone = initiator(server.publicKey, { prologue: bluetoothPrologue('desk-a') })
    expect(() => responder(server, { prologue: bluetoothPrologue('desk-b') }).readMessage1(phone.writeMessage1())).toThrow(NoiseError)
    expect(new TextDecoder().decode(bluetoothPrologue('desk-a'))).toBe('litecode-bt/1desk-a')
  })

  it('변조한 메시지 1·메시지 2 는 실패한다', () => {
    const server = generateNoiseKeyPair()
    const m1 = initiator(server.publicKey).writeMessage1()
    for (const at of [0, 31, 32, m1.length - 1]) {
      const bad = m1.slice()
      bad[at]! ^= 1
      expect(() => responder(server).readMessage1(bad)).toThrow(NoiseError)
    }
    const phone = initiator(server.publicKey)
    const desktop = responder(server)
    desktop.readMessage1(phone.writeMessage1())
    const m2 = desktop.writeMessage2().message.slice()
    m2[m2.length - 1]! ^= 1
    expect(() => phone.readMessage2(m2)).toThrow(NoiseError)
  })

  it('잘린 핸드셰이크 메시지·작은 차수의 점(공유 비밀 0)은 실패한다', () => {
    const server = generateNoiseKeyPair()
    const m1 = initiator(server.publicKey).writeMessage1()
    expect(() => responder(server).readMessage1(m1.subarray(0, 40))).toThrow(NoiseError)
    const lowOrder = new Uint8Array(48) // e = 0 (작은 차수) + 아무 태그
    expect(() => responder(server).readMessage1(lowOrder)).toThrow(NoiseError)
    expect(() => initiator(new Uint8Array(31))).toThrow(NoiseError)
  })

  it('순서대로 한 번씩만 — 다시 부르거나 건너뛰면 던진다', () => {
    const server = generateNoiseKeyPair()
    const phone = initiator(server.publicKey)
    expect(() => phone.readMessage2(new Uint8Array(48))).toThrow(/out of order/)
    const desktop = responder(server)
    expect(() => desktop.writeMessage2()).toThrow(/out of order/)
  })
})

describe('전송 세션 — 변조·잘림·순서·되돌림·nonce', () => {
  const broken = (session: NoiseSession) => {
    expect(session.broken).toBe(true)
    expect(() => session.decrypt(new Uint8Array(32))).toThrow(/broken/)
    expect(() => session.encrypt(new Uint8Array(1))).toThrow(/broken/)
  }

  it('변조한 레코드 → 던지고 세션을 버린다 (그 뒤 정상 레코드도 받지 않는다)', () => {
    const { phone, desktop } = connect()
    const record = phone.encrypt(bytes(64))
    record[5]! ^= 0x80
    expect(() => desktop.decrypt(record)).toThrow(NoiseError)
    broken(desktop)
  })

  it('잘린 레코드 → 던지고 버린다 (태그보다 짧은 것 포함)', () => {
    for (const cut of [1, NOISE_TAG, 70]) {
      const { phone, desktop } = connect()
      const record = phone.encrypt(bytes(64))
      expect(() => desktop.decrypt(record.subarray(0, record.length - cut))).toThrow(NoiseError)
      broken(desktop)
    }
  })

  it('순서를 바꾼 레코드 → 던지고 버린다', () => {
    const { phone, desktop } = connect()
    phone.encrypt(bytes(10, 1))
    const second = phone.encrypt(bytes(10, 2))
    expect(() => desktop.decrypt(second)).toThrow(NoiseError)
    broken(desktop)
  })

  it('같은 레코드 되돌림(재사용 nonce) → 던지고 버린다', () => {
    const { phone, desktop } = connect()
    const record = phone.encrypt(bytes(10))
    desktop.decrypt(record)
    expect(() => desktop.decrypt(record)).toThrow(NoiseError)
    broken(desktop)
  })

  it('레코드를 빠뜨리면(nonce 건너뜀) 다음 레코드가 실패한다', () => {
    const { phone, desktop } = connect()
    desktop.decrypt(phone.encrypt(bytes(10, 1)))
    phone.encrypt(bytes(10, 2)) // 링크에서 사라졌다
    expect(() => desktop.decrypt(phone.encrypt(bytes(10, 3)))).toThrow(NoiseError)
  })

  it('반대 방향 레코드를 되돌려 보내도(반사) 실패한다 — 방향마다 키가 다르다', () => {
    const { phone } = connect()
    const record = phone.encrypt(bytes(10))
    expect(() => phone.decrypt(record)).toThrow(NoiseError)
  })

  it('빈 페이로드 — 태그 16바이트만 오가고 빈 평문으로 풀린다', () => {
    const { phone, desktop } = connect()
    const record = phone.encrypt(new Uint8Array())
    expect(record.length).toBe(NOISE_TAG)
    expect(desktop.decrypt(record).length).toBe(0)
  })

  it('최대 크기 — 평문 65519 바이트(메시지 65535)까지, 넘으면 던진다', () => {
    const { phone, desktop } = connect()
    const max = NOISE_MAX_MESSAGE - NOISE_TAG
    const record = phone.encrypt(bytes(max))
    expect(record.length).toBe(NOISE_MAX_MESSAGE)
    expect(toHex(desktop.decrypt(record))).toBe(toHex(bytes(max)))
    expect(() => phone.encrypt(bytes(max + 1))).toThrow(/too large/)
  })

  it('nonce 는 0 4바이트 ‖ 카운터 8바이트 리틀 엔디언 — 2^32 를 넘어도', () => {
    const key = bytes(32, 9)
    for (const n of [0, 1, 255, 256, 0x100000000 + 5, 2 ** 52 + 3]) {
      const nonce = new Uint8Array(12)
      new DataView(nonce.buffer).setBigUint64(4, BigInt(n), true)
      const expected = chacha20poly1305(key, nonce, new Uint8Array()).encrypt(bytes(20))
      const state = new CipherState(key, n)
      expect(toHex(state.encryptWithAd(new Uint8Array(), bytes(20)))).toBe(toHex(expected))
      expect(state.nonce).toBe(n + 1)
    }
  })

  it('한 방향 nonce 가 끝(2^64 전, 2^53−1)에 닿으면 재협상이 필요하다고 표시하고 더 보내지 않는다', () => {
    const key = bytes(32, 3)
    const state = new CipherState(key, NOISE_NONCE_LIMIT - 1)
    expect(state.needsRekey).toBe(false)
    state.encryptWithAd(new Uint8Array(), bytes(1))
    expect(state.needsRekey).toBe(true)
    expect(() => state.encryptWithAd(new Uint8Array(), bytes(1))).toThrow(/rekey/)
    expect(NOISE_NONCE_LIMIT).toBeLessThan(2 ** 64 - 1)
  })
})

describe('키 글자 (QR 의 bk)·사람이 보는 8자', () => {
  it('공개키 ↔ base64url 43자 왕복, 모양이 틀리면 undefined', () => {
    const { publicKey } = generateNoiseKeyPair()
    const text = encodeNoiseKey(publicKey)
    expect(text).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(text).toBe(Buffer.from(publicKey).toString('base64url'))
    expect(toHex(decodeNoiseKey(text)!)).toBe(toHex(publicKey))
    expect(decodeNoiseKey(text.slice(1))).toBeUndefined()
    expect(decodeNoiseKey(`${text.slice(0, 42)}+`)).toBeUndefined()
    // 마지막 글자의 남는 2비트가 0 이 아니면 정규형이 아니다
    const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    expect(decodeNoiseKey(text.slice(0, 42) + last[last.indexOf(text[42]!) | 1])).toBeUndefined()
  })

  it('지문 8자는 공개키 SHA-256 에서 fingerprintCode 규칙으로 — 같은 키는 늘 같다', () => {
    const { publicKey } = generateNoiseKeyPair()
    const code = noiseKeyCode(publicKey)
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    expect(noiseKeyCode(publicKey.slice())).toBe(code)
    expect(code).toBe(fingerprintCode(createHash('sha256').update(publicKey).digest('base64url')))
    expect(noiseKeyCode(generateNoiseKeyPair().publicKey)).not.toBe(code)
  })
})
