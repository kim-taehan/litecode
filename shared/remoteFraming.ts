// 프레이밍 — 느린 바이트 링크(블루투스 등) 위에 `/v1` 계약을 싣는 계층 (이슈 #68, 설계 _workspace/01ab_mobile_bluetooth.md 5절).
// 데스크탑(src/services/remote/framed.ts)과 폰(mobile/src/core/framed.ts)이 이 파일 하나를 쓴다. 순수 TS 다 — Node·React Native 의
// API 를 쓰지 않는다(Uint8Array·TextEncoder·Promise 뿐). 압축 수단은 밖에서 받는다(데스크탑 node:zlib, 폰 fflate — 둘 다 raw deflate).
//
// 계층 (설계의 번호):
//   L0 링크      ByteLink — 조각(≤ maxChunk 바이트)을 순서대로 실어 나른다. send 가 풀릴 때까지 다음 조각을 안 준다(되밀림)
//   L1 레코드    u16 길이 ‖ 본문. 조각 경계와 무관하게 다시 붙인다
//   (L2 보안)    다음 라운드 — Noise 가 레코드 본문을 감싼다. 그래서 레코드 본문은 16KB 를 넘지 않는다
//   L3 다중화    레코드 본문 = 종류 u8 ‖ id u16 ‖ 깃발 u8 ‖ 조각. 요청·응답·스트림이 한 링크에 섞여 간다
//   L4 의미      REQ·OPEN 본문 = JSON {method, path, headers, body}, RES = JSON {status, body}, DATA = SSE 글자 그대로
//
// 바이트 배치 (큰 끝 먼저):
//   | 길이 u16 | 종류 u8 | id u16 | 깃발 u8 | 조각 0..16384 |      길이 = 그 뒤 전부(4 + 조각)
// 큰 본문은 16KB 조각으로 나눠 MORE 깃발을 달고, 다른 id 의 프레임 사이에 끼워 보낸다 — 스트림 데이터가 승인 답 같은 작은 요청을 막지 않게.
// 같은 id 안에서는 보낸 순서를 지킨다.

export const FRAME = {
  /** 요청 하나 → RES */
  REQ: 1,
  /** REQ·OPEN 의 응답 (OPEN 에는 상태만 — 200 이면 DATA 가 따라온다) */
  RES: 2,
  /** 스트림 열기 → RES, DATA*, END */
  OPEN: 3,
  DATA: 4,
  /** 스트림 끝 (ERROR 깃발: 곱게 닫은 것이 아니다) */
  END: 5,
  /** 보낸 쪽이 그 id 를 거둔다 (응답을 더 기다리지 않는다·스트림을 닫는다) */
  CANCEL: 6,
  /** 살아 있다는 신호 — 받은 쪽은 아무것도 안 한다 */
  PING: 7,
} as const

/** 본문 전체가 raw deflate 로 압축됐다 (나누기 전에 압축한다 — 그 메시지의 모든 조각에 붙는다) */
export const FLAG_DEFLATE = 0x01
/** 이 메시지의 조각이 더 온다 */
export const FLAG_MORE = 0x02
export const FLAG_ERROR = 0x04
/** 보내다 만 메시지 — 지금까지 받은 조각을 버려라 */
export const FLAG_DISCARD = 0x08

/** 한 레코드에 싣는 조각의 최대 크기 */
export const FRAGMENT_BYTES = 16 * 1024
const FRAME_HEADER = 4
/** 이보다 작은 본문은 압축하지 않는다 */
export const DEFLATE_MIN_BYTES = 1024
/** 다시 붙인(압축을 푼) 본문의 기본 상한 */
export const DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024 * 1024

/** L0 — 순서 있는 바이트 링크의 한쪽 끝 */
export interface ByteLink {
  /** 한 번에 실을 수 있는 바이트 (BLE 면 MTU−3) */
  readonly maxChunk: number
  /** 조각 하나를 보낸다 — 링크가 받아 줄 때 풀린다. 끊겼으면 거절 */
  send(chunk: Uint8Array): Promise<void>
  onData(listener: (chunk: Uint8Array) => void): void
  onClose(listener: (error?: unknown) => void): void
  close(): void
}

/** raw deflate. inflate 는 푼 결과가 maxBytes 를 넘으면 던진다 */
export interface FrameCodec {
  deflate(data: Uint8Array): Uint8Array
  inflate(data: Uint8Array, maxBytes: number): Uint8Array
}

/** 상대가 규칙을 어겼다 — 링크를 끊는다 */
export class FramingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FramingError'
  }
}

const encoder = new TextEncoder()
export const utf8 = {
  encode: (text: string): Uint8Array => encoder.encode(text),
  decode: (bytes: Uint8Array): string => new TextDecoder().decode(bytes),
}

const EMPTY = new Uint8Array()

/** 레코드 하나 (길이 접두 포함) */
export function encodeRecord(type: number, id: number, flags: number, body: Uint8Array): Uint8Array {
  if (body.length > FRAGMENT_BYTES) throw new FramingError(`fragment too large: ${body.length}`)
  const length = FRAME_HEADER + body.length
  const record = new Uint8Array(2 + length)
  record[0] = length >> 8
  record[1] = length & 0xff
  record[2] = type
  record[3] = (id >> 8) & 0xff
  record[4] = id & 0xff
  record[5] = flags
  record.set(body, 6)
  return record
}

/** 길이 접두를 뗀 레코드 본문을 푼다 */
export function decodeRecord(record: Uint8Array): { type: number; id: number; flags: number; body: Uint8Array } {
  if (record.length < FRAME_HEADER) throw new FramingError('record shorter than its header')
  return { type: record[0]!, id: (record[1]! << 8) | record[2]!, flags: record[3]!, body: record.subarray(FRAME_HEADER) }
}

/** L1 — 조각을 넣으면 완성된 레코드 본문들(길이 접두 없이)을 준다 */
export class RecordDecoder {
  private rest: Uint8Array = EMPTY
  private maxRecordBytes: number

  constructor(maxRecordBytes = FRAME_HEADER + FRAGMENT_BYTES) {
    this.maxRecordBytes = maxRecordBytes
  }

  feed(chunk: Uint8Array): Uint8Array[] {
    const data = this.rest.length === 0 ? chunk : concat([this.rest, chunk])
    const records: Uint8Array[] = []
    let at = 0
    while (data.length - at >= 2) {
      const length = (data[at]! << 8) | data[at + 1]!
      if (length < FRAME_HEADER || length > this.maxRecordBytes) throw new FramingError(`bad record length: ${length}`)
      if (data.length - at - 2 < length) break
      records.push(data.slice(at + 2, at + 2 + length))
      at += 2 + length
    }
    this.rest = data.slice(at)
    return records
  }
}

/** 다 붙인 메시지 하나 */
export interface FrameMessage {
  type: number
  id: number
  body: Uint8Array
  /** ERROR 깃발 */
  error: boolean
}

export interface FrameChannelOptions {
  /** 없으면 압축하지 않고, 압축된 프레임이 오면 끊는다 */
  codec?: FrameCodec
  /** 다시 붙인(압축을 푼) 본문의 상한 — 넘으면 끊는다 */
  maxMessageBytes?: number
  onMessage(message: FrameMessage): void
  /** 링크가 끊겼다 (상대가 규칙을 어겨 우리가 끊은 것이면 FramingError) */
  onClose?(error?: unknown): void
}

interface Outgoing {
  type: number
  id: number
  flags: number
  body: Uint8Array
  /** 보낸 바이트 */
  offset: number
  /** 한 레코드로 끝나는 것 — 큰 것들 사이에 끼어 먼저 간다 */
  small: boolean
  resolve(): void
  reject(error: unknown): void
}

/** L1 + L3 — 링크 한쪽 끝에서 메시지(종류·id·본문)를 주고받는다. 양 끝이 같은 클래스를 쓴다 */
export class FrameChannel {
  /** 보낸 것의 통계 — rawBytes: 압축 전 본문, wireBytes: 링크에 실린 바이트(머리 포함) */
  readonly stats = { messages: 0, rawBytes: 0, wireBytes: 0, deflated: 0 }
  private decoder = new RecordDecoder()
  /** id → 그 id 로 보낼 것들 (순서대로) */
  private lanes = new Map<number, Outgoing[]>()
  /** 다음에 볼 차례 (id) */
  private order: number[] = []
  /** `종류:id` → 붙이는 중인 조각 */
  private partial = new Map<string, { chunks: Uint8Array[]; size: number }>()
  private pumping = false
  private done = false
  private maxMessageBytes: number
  private link: ByteLink
  private options: FrameChannelOptions

  constructor(link: ByteLink, options: FrameChannelOptions) {
    this.link = link
    this.options = options
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
    link.onData((chunk) => this.receive(chunk))
    link.onClose((error) => this.finish(error))
  }

  get closed(): boolean {
    return this.done
  }

  /** 메시지 하나를 보낸다 — 마지막 조각까지 링크가 받아 주면 풀린다. 끊겼거나 거뒀으면(drop) 거절 */
  send(type: number, id: number, body: Uint8Array = EMPTY, options: { error?: boolean } = {}): Promise<void> {
    if (this.done) return Promise.reject(new Error('link closed'))
    let flags = options.error ? FLAG_ERROR : 0
    let payload = body
    this.stats.messages += 1
    this.stats.rawBytes += body.length
    if (this.options.codec && body.length >= DEFLATE_MIN_BYTES) {
      const packed = this.options.codec.deflate(body)
      if (packed.length < body.length) {
        payload = packed
        flags |= FLAG_DEFLATE
        this.stats.deflated += 1
      }
    }
    return new Promise<void>((resolve, reject) => {
      this.enqueue({ type, id, flags, body: payload, offset: 0, small: payload.length <= FRAGMENT_BYTES, resolve, reject })
    })
  }

  /** 그 id 로 아직 다 못 보낸 것이 있나 */
  busy(id: number): boolean {
    return this.lanes.has(id)
  }

  /** 그 id 로 아직 못 보낸 것을 거둔다 (그 보내기들은 거절된다). 조각을 보내다 만 메시지가 있으면 상대에게 버리라고 알린다 */
  drop(id: number): void {
    const lane = this.lanes.get(id)
    if (!lane) return
    this.lanes.delete(id)
    this.order = this.order.filter((entry) => entry !== id)
    const head = lane[0]!
    for (const message of lane) message.reject(new Error('dropped'))
    if (head.offset > 0 && !this.done) {
      this.enqueue({ type: head.type, id, flags: FLAG_DISCARD, body: EMPTY, offset: 0, small: true, resolve: () => {}, reject: () => {} })
    }
  }

  close(error?: unknown): void {
    if (this.done) return
    this.finish(error)
    this.link.close()
  }

  private enqueue(message: Outgoing): void {
    const lane = this.lanes.get(message.id)
    if (lane) lane.push(message)
    else {
      this.lanes.set(message.id, [message])
      this.order.push(message.id)
    }
    if (this.pumping) return
    this.pumping = true
    void Promise.resolve().then(() => this.pump())
  }

  /** 보낼 것이 남은 동안 레코드를 하나씩 링크에 싣는다. 작은 것이 맨 앞인 id 가 먼저, 없으면 id 들이 조각 하나씩 번갈아 */
  private async pump(): Promise<void> {
    try {
      while (!this.done && this.order.length > 0) {
        const id = this.order.find((entry) => this.lanes.get(entry)![0]!.small && this.lanes.get(entry)![0]!.offset === 0) ?? this.order[0]!
        const lane = this.lanes.get(id)!
        const message = lane[0]!
        const fragment = message.body.subarray(message.offset, message.offset + FRAGMENT_BYTES)
        message.offset += fragment.length
        const last = message.offset >= message.body.length
        const record = encodeRecord(message.type, id, message.flags | (last ? 0 : FLAG_MORE), fragment)
        // 한 레코드는 끊지 않고 보낸다 — 조각(≤ maxChunk)마다 링크가 받아 줄 때까지 기다린다
        for (let at = 0; at < record.length; at += this.link.maxChunk) {
          const chunk = record.subarray(at, at + this.link.maxChunk)
          await this.link.send(chunk)
          this.stats.wireBytes += chunk.length
        }
        // 보내는 사이 거둬졌을 수 있다 (drop) — 그때는 줄이 이미 바뀌어 있다
        if (this.lanes.get(id) !== lane || lane[0] !== message) continue
        if (last) {
          lane.shift()
          message.resolve()
        }
        this.order = this.order.filter((entry) => entry !== id)
        if (lane.length > 0) this.order.push(id)
        else this.lanes.delete(id)
      }
    } catch (error) {
      this.close(error)
    } finally {
      this.pumping = false
    }
  }

  private receive(chunk: Uint8Array): void {
    if (this.done) return
    try {
      for (const record of this.decoder.feed(chunk)) {
        const { type, id, flags, body } = decodeRecord(record)
        const key = `${type}:${id}`
        if (flags & FLAG_DISCARD) {
          this.partial.delete(key)
          continue
        }
        const held = this.partial.get(key) ?? { chunks: [], size: 0 }
        held.chunks.push(body)
        held.size += body.length
        if (held.size > this.maxMessageBytes) throw new FramingError(`message too large: ${held.size}`)
        if (flags & FLAG_MORE) {
          this.partial.set(key, held)
          continue
        }
        this.partial.delete(key)
        let whole = held.chunks.length === 1 ? held.chunks[0]! : concat(held.chunks)
        if (flags & FLAG_DEFLATE) {
          if (!this.options.codec) throw new FramingError('compressed frame without a codec')
          try {
            whole = this.options.codec.inflate(whole, this.maxMessageBytes)
          } catch (error) {
            throw new FramingError(`cannot inflate: ${(error as Error).message}`)
          }
          if (whole.length > this.maxMessageBytes) throw new FramingError(`message too large: ${whole.length}`)
        }
        this.options.onMessage({ type, id, body: whole, error: (flags & FLAG_ERROR) !== 0 })
        if (this.done) return
      }
    } catch (error) {
      this.close(error)
    }
  }

  private finish(error?: unknown): void {
    if (this.done) return
    this.done = true
    const waiting = [...this.lanes.values()].flat()
    this.lanes.clear()
    this.order = []
    this.partial.clear()
    for (const message of waiting) message.reject(error ?? new Error('link closed'))
    this.options.onClose?.(error)
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const whole = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    whole.set(chunk, at)
    at += chunk.length
  }
  return whole
}
