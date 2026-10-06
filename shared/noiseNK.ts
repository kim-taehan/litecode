// L2 보안 — Noise_NK_25519_ChaChaPoly_SHA256 (Noise Protocol Framework rev 34, 이슈 #171, 설계 _workspace/01ab_mobile_bluetooth.md 5절 "페어링·보안").
// 블루투스 GATT 는 OS 본딩 없이 평문 특성으로 둔다 — 믿음은 이 계층에서 만든다. 신뢰 모델은 사내망 HTTPS 와 같다: QR 의 `bk`(데스크탑 정적
// X25519 공개키)가 TLS 의 SPKI 지문 자리이고, 그 위에서 하는 일(POST /v1/pair → [허용] → Bearer 기기 토큰)은 글자 그대로 같다.
//
//   NK:   <- s            (폰은 QR 로 데스크탑 공개키를 미리 안다)
//         ...
//         -> e, es        (폰 → 데스크탑, 메시지 1 — 그 키의 주인만 읽는다)
//         <- e, ee        (데스크탑 → 폰, 메시지 2 — 이 뒤로 양방향 전송 키. 전방향 비밀성)
//
// 손으로 짠 암호 코드는 없다: X25519·ChaCha20-Poly1305·SHA-256·HKDF 는 감사된 순수 JS(@noble/*)이고, 여기는 Noise 명세 5절의
// CipherState·SymmetricState·HandshakeState 를 NK 한 패턴에 맞춰 옮긴 것뿐이다. 공개 검증 벡터(tests/fixtures/noise-nk-vectors.json —
// cacophony·snow)와 바이트 단위로 대조한다 (tests/unit/noiseNK.test.ts, mobile/tests/noise.test.ts).
// 데스크탑(Electron 메인)과 폰(Hermes)이 이 파일 하나를 쓴다 — node:crypto 도 RN API 도 쓰지 않는다.
// 난수(임시 키)는 @noble/hashes 의 randomBytes(= crypto.getRandomValues)다. Node·Electron 에는 있고, Hermes 에는 없어 폰 운반 라운드(④)에서 채운다.
//
// 전송 nonce 는 Noise 규칙대로 **보내지 않는 8바이트 카운터**다(레코드마다 1씩). 그래서 레코드를 빠뜨리거나·되돌리거나·순서를 바꾸면
// 받는 쪽 카운터와 어긋나 인증 태그가 틀린다. 명세는 복호 실패 뒤에도 세션을 계속 쓸 수 있게 두지만, 우리 링크는 순서를 지키므로
// 실패는 곧 공격·고장이다 — **한 번 실패하면 세션 전체를 버린다**(위층은 링크를 끊고 핸드셰이크부터 다시 한다).

import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { fingerprintCode } from './remotePairing.ts'

export const NOISE_PROTOCOL = 'Noise_NK_25519_ChaChaPoly_SHA256'
/** Noise 메시지 하나의 상한 (명세 3절) */
export const NOISE_MAX_MESSAGE = 65535
/** 인증 태그 */
export const NOISE_TAG = 16
const DH_LEN = 32
const HASH_LEN = 32
/**
 * 한 방향에서 쓸 수 있는 nonce 의 끝 — 여기 닿으면 그 세션으로 더 보내지 않는다(재협상 = 핸드셰이크를 다시).
 * 명세는 2^64−1 을 예약하고 그 전까지 허용하지만, JS 수가 정확한 2^53−1 에서 먼저 멈춘다 (16KB 레코드로 128 EB — 현실적으로 안 닿는다)
 */
export const NOISE_NONCE_LIMIT = Number.MAX_SAFE_INTEGER

/** 핸드셰이크·복호 실패, 순서 어긋난 호출, 버린 세션을 다시 쓴 것 */
export class NoiseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoiseError'
  }
}

const EMPTY = new Uint8Array()

export interface NoiseKeyPair {
  secretKey: Uint8Array
  publicKey: Uint8Array
}

/** 정적 키쌍 하나 (데스크탑이 한 번 만들어 봉해 둔다 — src/services/remote/noiseIdentity.ts) */
export function generateNoiseKeyPair(): NoiseKeyPair {
  const secretKey = x25519.utils.randomSecretKey()
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) }
}

export function noisePublicKey(secretKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(secretKey)
}

/** 프롤로그 — 양쪽이 같은 값을 해시에 섞는다. 다른 데스크탑(desktopId)·다른 프로토콜 판으로 잘못 붙으면 메시지 1 에서 실패한다 */
export function bluetoothPrologue(desktopId: string): Uint8Array {
  return new TextEncoder().encode(`litecode-bt/1${desktopId}`)
}

// ── 키 글자 (QR 의 bk) ───────────────────────────────────────────────────────────────────────────────

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** 32바이트 → base64url(덧붙임 없음) 43자 */
export function encodeNoiseKey(key: Uint8Array): string {
  if (key.length !== DH_LEN) throw new NoiseError(`key must be ${DH_LEN} bytes`)
  let text = ''
  let buffer = 0
  let bits = 0
  for (const byte of key) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 6) {
      bits -= 6
      text += BASE64URL[(buffer >> bits) & 63]
    }
    buffer &= (1 << bits) - 1
  }
  if (bits > 0) text += BASE64URL[(buffer << (6 - bits)) & 63]
  return text
}

/** encodeNoiseKey 의 반대 — 43자 base64url 이 아니거나 남는 비트가 0 이 아니면 undefined */
export function decodeNoiseKey(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) return undefined
  const bytes = new Uint8Array(DH_LEN)
  let buffer = 0
  let bits = 0
  let at = 0
  for (const symbol of text) {
    buffer = (buffer << 6) | BASE64URL.indexOf(symbol)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes[at++] = (buffer >> bits) & 255
    }
    buffer &= (1 << bits) - 1
  }
  return buffer === 0 ? bytes : undefined
}

/** 사람이 맞춰 보는 8자 (`ABCD-EFGH`) — 공개키 SHA-256 의 앞 40bit, TLS 지문의 fingerprintCode 와 같은 규칙 */
export function noiseKeyCode(publicKey: Uint8Array): string {
  return fingerprintCode(encodeNoiseKey(sha256(publicKey)))
}

// ── 명세 5.1 CipherState ─────────────────────────────────────────────────────────────────────────────

/** 키 하나와 그 방향의 nonce 카운터 */
export class CipherState {
  private n: number

  constructor(
    private readonly key: Uint8Array,
    /** 테스트가 카운터 끝을 볼 때만 */
    nonce = 0,
  ) {
    this.n = nonce
  }

  /** 다음에 쓸 nonce */
  get nonce(): number {
    return this.n
  }

  /** 이 방향으로 더 보낼 수 없다 — 핸드셰이크를 다시 해야 한다 */
  get needsRekey(): boolean {
    return this.n >= NOISE_NONCE_LIMIT
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    const out = chacha20poly1305(this.key, this.take(), ad).encrypt(plaintext)
    this.n += 1
    return out
  }

  /** 실패하면 던지고 카운터는 그대로 (명세대로 — 세션을 버리는 것은 NoiseSession 이 한다) */
  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (ciphertext.length < NOISE_TAG) throw new NoiseError('ciphertext shorter than its tag')
    let out: Uint8Array
    try {
      out = chacha20poly1305(this.key, this.take(), ad).decrypt(ciphertext)
    } catch {
      throw new NoiseError('decrypt failed')
    }
    this.n += 1
    return out
  }

  /** 12바이트 nonce = 0 4바이트 ‖ 카운터 8바이트 리틀 엔디언 */
  private take(): Uint8Array {
    if (this.needsRekey) throw new NoiseError('nonce exhausted — rekey required')
    const nonce = new Uint8Array(12)
    let low = this.n % 0x100000000
    let high = Math.floor(this.n / 0x100000000)
    for (let i = 4; i < 8; i++, low = Math.floor(low / 256)) nonce[i] = low & 255
    for (let i = 8; i < 12; i++, high = Math.floor(high / 256)) nonce[i] = high & 255
    return nonce
  }
}

// ── 명세 5.2 SymmetricState ──────────────────────────────────────────────────────────────────────────

class SymmetricState {
  ck: Uint8Array
  h: Uint8Array
  private cipher?: CipherState

  constructor(protocolName: string) {
    const name = new TextEncoder().encode(protocolName)
    // 이름이 HASHLEN 이하면 0 으로 채우고, 길면 해시한다 (우리 이름은 정확히 32바이트)
    this.h = name.length <= HASH_LEN ? padded(name, HASH_LEN) : sha256(name)
    this.ck = this.h
  }

  mixKey(input: Uint8Array): void {
    const [ck, key] = hkdf2(this.ck, input)
    this.ck = ck
    this.cipher = new CipherState(key)
  }

  mixHash(data: Uint8Array): void {
    this.h = sha256(concat(this.h, data))
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const out = this.cipher ? this.cipher.encryptWithAd(this.h, plaintext) : plaintext
    this.mixHash(out)
    return out
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const out = this.cipher ? this.cipher.decryptWithAd(this.h, ciphertext) : ciphertext
    this.mixHash(ciphertext)
    return out
  }

  split(): [CipherState, CipherState] {
    const [first, second] = hkdf2(this.ck, EMPTY)
    return [new CipherState(first), new CipherState(second)]
  }
}

/** 명세 4.3 HKDF(ck, ikm, 2) — RFC 5869 HKDF(salt=ck, info 빈 값) 64바이트를 반으로 자른 것과 같다 */
function hkdf2(chainingKey: Uint8Array, input: Uint8Array): [Uint8Array, Uint8Array] {
  const out = hkdf(sha256, input, chainingKey, EMPTY, 2 * HASH_LEN)
  return [out.slice(0, HASH_LEN), out.slice(HASH_LEN)]
}

function dh(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  try {
    return x25519.getSharedSecret(secretKey, publicKey)
  } catch {
    throw new NoiseError('bad public key') // 길이가 틀렸거나 작은 차수의 점(공유 비밀이 0)
  }
}

// ── 전송 세션 ────────────────────────────────────────────────────────────────────────────────────────

/** 핸드셰이크가 끝난 뒤의 양방향 채널. 레코드 하나 = encrypt 한 번 (평문 + 16바이트 태그) */
export class NoiseSession {
  private dead = false

  constructor(
    private readonly sending: CipherState,
    private readonly receiving: CipherState,
    /** 핸드셰이크 해시 — 채널 바인딩에 쓸 수 있다(양쪽이 같다) */
    readonly handshakeHash: Uint8Array,
  ) {}

  /** 실패를 한 번 겪어 더 쓸 수 없다 */
  get broken(): boolean {
    return this.dead
  }

  /** 보내는 쪽 nonce 가 끝에 닿았다 — 새 핸드셰이크가 필요하다 */
  get needsRekey(): boolean {
    return this.sending.needsRekey
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    return this.guard(() => {
      if (plaintext.length + NOISE_TAG > NOISE_MAX_MESSAGE) throw new NoiseError(`record too large: ${plaintext.length}`)
      return this.sending.encryptWithAd(EMPTY, plaintext)
    })
  }

  /** 변조·잘림·빠뜨림·되돌림·순서 바뀜은 전부 여기서 던지고 세션을 버린다 */
  decrypt(ciphertext: Uint8Array): Uint8Array {
    return this.guard(() => {
      if (ciphertext.length > NOISE_MAX_MESSAGE) throw new NoiseError(`record too large: ${ciphertext.length}`)
      return this.receiving.decryptWithAd(EMPTY, ciphertext)
    })
  }

  private guard<T>(work: () => T): T {
    if (this.dead) throw new NoiseError('session is broken')
    try {
      return work()
    } catch (error) {
      this.dead = true
      throw error
    }
  }
}

// ── 명세 5.3 HandshakeState — NK 한 패턴 ────────────────────────────────────────────────────────────

export interface NoiseHandshakeOptions {
  /** 양쪽이 같아야 한다 (bluetoothPrologue). 기본 빈 값 */
  prologue?: Uint8Array
  /** 임시 비밀키 — 검증 벡터용. 평소에는 비워 두면 새로 만든다 */
  ephemeralSecret?: Uint8Array
}

export interface NoiseInitiator {
  /** 메시지 1 (e, es) — 32 + 페이로드 + 16 바이트 */
  writeMessage1(payload?: Uint8Array): Uint8Array
  /** 메시지 2 (e, ee) 를 읽고 세션을 연다 — 서버 키가 틀렸거나 변조됐으면 던진다 */
  readMessage2(message: Uint8Array): { session: NoiseSession; payload: Uint8Array }
}

export interface NoiseResponder {
  /** 메시지 1 을 읽는다 — 우리 공개키로 만든 것이 아니면(틀린 bk·다른 프롤로그·변조) 던진다. 돌려주는 것은 페이로드 */
  readMessage1(message: Uint8Array): Uint8Array
  /** 메시지 2 를 쓰고 세션을 연다 */
  writeMessage2(payload?: Uint8Array): { message: Uint8Array; session: NoiseSession }
}

/** 폰 쪽 — QR 로 받은 데스크탑 공개키(bk)로 */
export function initiator(serverPublicKey: Uint8Array, options: NoiseHandshakeOptions = {}): NoiseInitiator {
  if (serverPublicKey.length !== DH_LEN) throw new NoiseError('server key must be 32 bytes')
  const state = start(options.prologue)
  state.mixHash(serverPublicKey) // 미리 아는 메시지: <- s
  const e = keyPair(options.ephemeralSecret)
  let step = 0
  return {
    writeMessage1(payload = EMPTY) {
      expectStep(step, 0)
      step = 1
      state.mixHash(e.publicKey)
      state.mixKey(dh(e.secretKey, serverPublicKey))
      return checkSize(concat(e.publicKey, state.encryptAndHash(payload)))
    },
    readMessage2(message) {
      expectStep(step, 1)
      step = 2
      if (message.length < DH_LEN + NOISE_TAG || message.length > NOISE_MAX_MESSAGE) throw new NoiseError('bad handshake message')
      const re = message.subarray(0, DH_LEN)
      state.mixHash(re)
      state.mixKey(dh(e.secretKey, re))
      const payload = state.decryptAndHash(message.subarray(DH_LEN))
      const [sending, receiving] = state.split()
      return { session: new NoiseSession(sending, receiving, state.h), payload }
    },
  }
}

/** 데스크탑 쪽 — 봉해 둔 정적 키쌍으로 */
export function responder(staticKey: NoiseKeyPair, options: NoiseHandshakeOptions = {}): NoiseResponder {
  const state = start(options.prologue)
  state.mixHash(staticKey.publicKey)
  const e = keyPair(options.ephemeralSecret)
  let re: Uint8Array | undefined
  let step = 0
  return {
    readMessage1(message) {
      expectStep(step, 0)
      step = 1
      if (message.length < DH_LEN + NOISE_TAG || message.length > NOISE_MAX_MESSAGE) throw new NoiseError('bad handshake message')
      re = message.slice(0, DH_LEN)
      state.mixHash(re)
      state.mixKey(dh(staticKey.secretKey, re))
      return state.decryptAndHash(message.subarray(DH_LEN))
    },
    writeMessage2(payload = EMPTY) {
      expectStep(step, 1)
      step = 2
      state.mixHash(e.publicKey)
      state.mixKey(dh(e.secretKey, re!))
      const message = checkSize(concat(e.publicKey, state.encryptAndHash(payload)))
      const [receiving, sending] = state.split()
      return { message, session: new NoiseSession(sending, receiving, state.h) }
    },
  }
}

function start(prologue: Uint8Array = EMPTY): SymmetricState {
  const state = new SymmetricState(NOISE_PROTOCOL)
  state.mixHash(prologue)
  return state
}

function keyPair(secret?: Uint8Array): NoiseKeyPair {
  if (!secret) return generateNoiseKeyPair()
  return { secretKey: secret, publicKey: x25519.getPublicKey(secret) }
}

/** 한 핸드셰이크 객체는 정해진 순서로 한 번씩만 — 실패한 뒤에도 다시 못 쓴다 */
function expectStep(step: number, expected: number): void {
  if (step !== expected) throw new NoiseError('handshake step out of order')
}

function checkSize(message: Uint8Array): Uint8Array {
  if (message.length > NOISE_MAX_MESSAGE) throw new NoiseError('handshake message too large')
  return message
}

function padded(bytes: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length)
  out.set(bytes)
  return out
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}
