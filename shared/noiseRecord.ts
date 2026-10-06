// L2 를 끼울 자리 (이슈 #171) — 날 링크(ByteLink, 블루투스 rx/tx) 위에 Noise NK 채널을 맺고, 그 위에 다시 ByteLink 를 내놓는다.
// FrameChannel(L1+L3, shared/remoteFraming.ts)은 바꾸지 않는다: 날 링크 대신 이것이 돌려준 링크를 받을 뿐이다.
//
//   FrameChannel ── send(L1 레코드 하나) ──▶ 보안 링크 ── encrypt ──▶ | 길이 u16 | 암호문(평문 + 태그 16) | ──▶ 날 링크(≤ maxChunk 조각)
//
// - 보안 링크의 maxChunk 는 FrameChannel 레코드 하나의 최대 크기(길이 2 + 머리 4 + 조각 16KB)다. FrameChannel 은 레코드를 maxChunk 단위로
//   나눠 send 하므로 **L1 레코드 하나 = 암호 레코드 하나**가 된다 (설계 "레코드마다 AEAD, 평문 ≤ 16KB").
// - 바깥 틀도 L1 과 같은 `u16 길이 ‖ 본문` 이다 — 날 링크의 조각 경계와 무관하게 RecordDecoder 로 다시 붙인다. 핸드셰이크 메시지 둘도 같은 틀에 싣는다.
// - 복호 실패(변조·잘림·빠뜨림·되돌림·순서 바뀜)는 NoiseError 로 날 링크를 끊는다 — 위 FrameChannel 은 onClose(error) 를 받는다.
// - 핸드셰이크 시간 제한·동시 연결 상한은 운반(블루투스 플러그인, ③)이 링크를 끊어서 건다.

import { initiator, NOISE_TAG, NoiseError, responder, type NoiseHandshakeOptions, type NoiseKeyPair, type NoiseSession } from './noiseNK.ts'
import { FRAGMENT_BYTES, RecordDecoder, type ByteLink } from './remoteFraming.ts'

/** 암호 레코드 하나에 싣는 평문의 상한 = FrameChannel 레코드 하나(길이 2 + 머리 4 + 조각) */
export const NOISE_RECORD_PLAINTEXT_MAX = 2 + 4 + FRAGMENT_BYTES
const CIPHERTEXT_MAX = NOISE_RECORD_PLAINTEXT_MAX + NOISE_TAG

/** 폰 쪽 — 메시지 1 을 보내고 메시지 2 를 받으면 풀린다. 실패하면 날 링크를 끊고 거절 */
export function secureInitiator(link: ByteLink, serverPublicKey: Uint8Array, options: NoiseHandshakeOptions = {}): Promise<SecureLink> {
  return establish(link, async (secure) => {
    const handshake = initiator(serverPublicKey, options)
    await secure.sendRaw(handshake.writeMessage1())
    return handshake.readMessage2(await secure.nextRecord()).session
  })
}

/** 데스크탑 쪽 — 메시지 1 을 받고 메시지 2 를 보내면 풀린다. 실패하면 날 링크를 끊고 거절 */
export function secureResponder(link: ByteLink, staticKey: NoiseKeyPair, options: NoiseHandshakeOptions = {}): Promise<SecureLink> {
  return establish(link, async (secure) => {
    const handshake = responder(staticKey, options)
    handshake.readMessage1(await secure.nextRecord())
    const { message, session } = handshake.writeMessage2()
    await secure.sendRaw(message)
    return session
  })
}

async function establish(link: ByteLink, run: (secure: SecureLink) => Promise<NoiseSession>): Promise<SecureLink> {
  const secure = new SecureLink(link)
  try {
    secure.open(await run(secure))
  } catch (error) {
    secure.fail(error)
    throw error
  }
  return secure
}

/** 핸드셰이크가 끝난 링크 — FrameChannel 에 그대로 넘긴다 */
export class SecureLink implements ByteLink {
  readonly maxChunk = NOISE_RECORD_PLAINTEXT_MAX
  private session?: NoiseSession
  private decoder = new RecordDecoder(CIPHERTEXT_MAX)
  /** 세션이 열리기 전에 온 레코드 (핸드셰이크 메시지, 그 뒤로 이미 도착한 암호 레코드) */
  private inbox: Uint8Array[] = []
  private waiter?: { resolve(record: Uint8Array): void; reject(error: unknown): void }
  private dataListeners: ((chunk: Uint8Array) => void)[] = []
  private closeListeners: ((error?: unknown) => void)[] = []
  /** 위층이 듣기 전에 온 평문 */
  private early: Uint8Array[] = []
  /** 보내기를 한 줄로 — 암호화 순서(nonce)와 날 링크에 실리는 순서가 같아야 한다 */
  private sending: Promise<void> = Promise.resolve()
  private done = false
  private closeError?: unknown

  constructor(private readonly raw: ByteLink) {
    raw.onData((chunk) => this.receive(chunk))
    raw.onClose((error) => this.finish(error))
  }

  get closed(): boolean {
    return this.done
  }

  send(chunk: Uint8Array): Promise<void> {
    if (this.done || !this.session) return Promise.reject(new Error('link closed'))
    if (chunk.length > this.maxChunk) return Promise.reject(new NoiseError(`chunk too large: ${chunk.length}`))
    let record: Uint8Array
    try {
      record = this.session.encrypt(chunk)
    } catch (error) {
      this.fail(error)
      return Promise.reject(error)
    }
    return this.sendRaw(record)
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.dataListeners.push(listener)
    const early = this.early
    this.early = []
    for (const chunk of early) listener(chunk)
  }

  onClose(listener: (error?: unknown) => void): void {
    if (this.done) listener(this.closeError)
    else this.closeListeners.push(listener)
  }

  close(): void {
    if (this.done) return
    this.finish()
    this.raw.close()
  }

  /** 핸드셰이크용 — 바깥 틀(u16 길이)을 씌워 날 링크에 조각으로 싣는다 */
  sendRaw(body: Uint8Array): Promise<void> {
    const framed = new Uint8Array(2 + body.length)
    framed[0] = body.length >> 8
    framed[1] = body.length & 0xff
    framed.set(body, 2)
    const next = this.sending.then(async () => {
      if (this.done) throw new Error('link closed')
      for (let at = 0; at < framed.length; at += this.raw.maxChunk) await this.raw.send(framed.subarray(at, at + this.raw.maxChunk))
    })
    this.sending = next.catch(() => {})
    return next
  }

  /** 핸드셰이크용 — 다음 레코드 하나 */
  nextRecord(): Promise<Uint8Array> {
    if (this.inbox.length > 0) return Promise.resolve(this.inbox.shift()!)
    if (this.done) return Promise.reject(this.closeError ?? new Error('link closed'))
    return new Promise((resolve, reject) => (this.waiter = { resolve, reject }))
  }

  /** 핸드셰이크가 끝났다 — 그사이 쌓인 레코드부터 복호한다 */
  open(session: NoiseSession): void {
    this.session = session
    const waiting = this.inbox
    this.inbox = []
    for (const record of waiting) if (!this.deliver(record)) return
  }

  /** 규칙 위반 — 날 링크를 끊는다 */
  fail(error: unknown): void {
    if (this.done) return
    this.finish(error)
    this.raw.close()
  }

  private receive(chunk: Uint8Array): void {
    if (this.done) return
    let records: Uint8Array[]
    try {
      records = this.decoder.feed(chunk)
    } catch (error) {
      return this.fail(error)
    }
    for (const record of records) {
      if (this.session) {
        if (!this.deliver(record)) return
      } else if (this.waiter) {
        const waiter = this.waiter
        this.waiter = undefined
        waiter.resolve(record)
      } else this.inbox.push(record)
    }
  }

  /** 복호해 위로 올린다 — 실패하면 끊고 false */
  private deliver(record: Uint8Array): boolean {
    let plain: Uint8Array
    try {
      plain = this.session!.decrypt(record)
    } catch (error) {
      this.fail(error)
      return false
    }
    if (this.dataListeners.length === 0) this.early.push(plain)
    else for (const listener of this.dataListeners) listener(plain)
    return !this.done
  }

  private finish(error?: unknown): void {
    if (this.done) return
    this.done = true
    this.closeError = error
    this.waiter?.reject(error ?? new Error('link closed'))
    this.waiter = undefined
    for (const listener of this.closeListeners) listener(error)
  }
}
