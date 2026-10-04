import { describe, expect, it } from 'vitest'
import {
  FLAG_DEFLATE,
  FLAG_MORE,
  FRAGMENT_BYTES,
  FRAME,
  FrameChannel,
  FramingError,
  RecordDecoder,
  decodeRecord,
  encodeRecord,
  utf8,
  type ByteLink,
  type FrameMessage,
} from '../../shared/remoteFraming.ts'
import { zlibCodec } from '../../src/services/remote/framed.ts'
import { memoryPipe } from './support/memoryPipe.ts'

// 프레이밍 (이슈 #68, 설계 01ab 5절 "계층·프레이밍") — 느린 바이트 링크 위에 /v1 을 싣는 L1(길이 접두 레코드)·L3(요청 id 다중화).
// 링크는 메모리 파이프다. 블루투스도 폰도 없다.

const bytes = (length: number, seed = 1): Uint8Array => Uint8Array.from({ length }, (_, index) => (index * 31 + seed * 7) & 0xff)
const text = (length: number): string => Array.from({ length: Math.ceil(length / 14) }, (_, index) => `line ${index} of text\n`).join('').slice(0, length)
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

async function until(done: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 2000 && !done(); tries++) await settle()
  if (!done()) throw new Error(`기다렸지만 오지 않았다: ${what}`)
}

/** 파이프 양 끝에 채널을 하나씩 */
function pair(options: { maxChunk?: number; codec?: boolean; maxMessageBytes?: number; bytesPerSecond?: number } = {}) {
  const pipe = memoryPipe({ maxChunk: options.maxChunk, bytesPerSecond: options.bytesPerSecond })
  const got = { a: [] as FrameMessage[], b: [] as FrameMessage[] }
  const closed = { a: [] as unknown[], b: [] as unknown[] }
  const codec = options.codec === false ? undefined : zlibCodec
  const a = new FrameChannel(pipe.a, { codec, maxMessageBytes: options.maxMessageBytes, onMessage: (message) => void got.a.push(message), onClose: (error) => void closed.a.push(error) })
  const b = new FrameChannel(pipe.b, { codec, maxMessageBytes: options.maxMessageBytes, onMessage: (message) => void got.b.push(message), onClose: (error) => void closed.b.push(error) })
  return { pipe, a, b, got, closed }
}

describe('L1 레코드 — u16 길이 ‖ 본문', () => {
  it('머리는 길이(u16 BE)·종류(u8)·id(u16 BE)·깃발(u8) — 길이는 그 뒤 전부', () => {
    const record = encodeRecord(FRAME.DATA, 0x1234, FLAG_MORE, Uint8Array.of(9, 8, 7))
    expect([...record]).toEqual([0x00, 0x07, FRAME.DATA, 0x12, 0x34, FLAG_MORE, 9, 8, 7])
    expect(decodeRecord(record.subarray(2))).toEqual({ type: FRAME.DATA, id: 0x1234, flags: FLAG_MORE, body: Uint8Array.of(9, 8, 7) })
  })

  it('조각 경계와 무관하게 재조립한다 — 1바이트씩, MTU 20·185·512, 한 조각에 여러 레코드', () => {
    const records = [encodeRecord(FRAME.REQ, 1, 0, bytes(300)), encodeRecord(FRAME.PING, 0, 0, new Uint8Array()), encodeRecord(FRAME.DATA, 2, 0, bytes(1000, 2))]
    const stream = Uint8Array.from(records.flatMap((record) => [...record]))
    for (const size of [1, 20, 185, 512, stream.length]) {
      const decoder = new RecordDecoder()
      const out: Uint8Array[] = []
      for (let at = 0; at < stream.length; at += size) out.push(...decoder.feed(stream.subarray(at, at + size)))
      expect(out.map((record) => decodeRecord(record))).toEqual(records.map((record) => decodeRecord(record.subarray(2))))
    }
  })

  it('잘린 레코드는 내놓지 않는다 — 나머지가 올 때까지 쥐고 있는다', () => {
    const decoder = new RecordDecoder()
    const record = encodeRecord(FRAME.RES, 7, 0, bytes(50))
    expect(decoder.feed(record.subarray(0, 1))).toEqual([])
    expect(decoder.feed(record.subarray(1, 40))).toEqual([])
    expect(decoder.feed(record.subarray(40))).toHaveLength(1)
  })

  it('머리보다 짧거나 상한보다 긴 레코드는 거절한다', () => {
    expect(() => new RecordDecoder().feed(Uint8Array.of(0, 3, 1, 0, 0))).toThrow(FramingError)
    expect(() => new RecordDecoder().feed(Uint8Array.of(0xff, 0xff))).toThrow(FramingError)
    expect(() => encodeRecord(FRAME.DATA, 1, 0, bytes(FRAGMENT_BYTES + 1))).toThrow(FramingError)
    expect(new RecordDecoder().feed(encodeRecord(FRAME.DATA, 1, 0, bytes(FRAGMENT_BYTES)))).toHaveLength(1)
  })
})

describe('L3 다중화', () => {
  for (const maxChunk of [20, 185, 512]) {
    it(`큰 본문을 16KB 조각으로 나누고 링크 조각(${maxChunk}바이트) 으로 실어 다시 붙인다`, async () => {
      const { a, got, pipe } = pair({ maxChunk, codec: false })
      const body = bytes(40_000)
      await a.send(FRAME.RES, 5, body)
      await until(() => got.b.length === 1, '메시지')
      expect(got.b[0]).toMatchObject({ type: FRAME.RES, id: 5, error: false })
      expect(got.b[0]!.body).toEqual(body)
      expect(pipe.bytes.aToB).toBe(40_000 + 3 * 6) // 조각 셋(16K·16K·8K) × 머리 6바이트
    })
  }

  it('빈 본문도 간다 (END·CANCEL·PING), error 깃발이 전해진다', async () => {
    const { a, got } = pair()
    await a.send(FRAME.END, 3, undefined, { error: true })
    await a.send(FRAME.CANCEL, 4)
    await until(() => got.b.length === 2, '둘')
    expect(got.b).toEqual([
      { type: FRAME.END, id: 3, body: new Uint8Array(), error: true },
      { type: FRAME.CANCEL, id: 4, body: new Uint8Array(), error: false },
    ])
  })

  it('큰 본문이 가는 중에도 작은 프레임이 사이에 끼어 먼저 닿는다 — 같은 id 안의 순서는 지킨다', async () => {
    const { a, got } = pair({ maxChunk: 512, codec: false })
    void a.send(FRAME.DATA, 1, bytes(100_000)) // 스트림의 큰 조각
    void a.send(FRAME.DATA, 1, utf8.encode('뒤따르는 작은 것')) // 같은 id — 앞지르면 안 된다
    void a.send(FRAME.RES, 2, utf8.encode('승인 답')) // 다른 id 의 작은 것 — 끼어든다
    void a.send(FRAME.RES, 3, bytes(50_000, 3)) // 다른 id 의 큰 것 — 번갈아 간다
    await until(() => got.b.length === 4, '넷')
    expect(got.b.map((message) => `${message.id}:${message.body.length}`)).toEqual(['2:10', '3:50000', '1:100000', '1:23'])
    expect(got.b[2]!.body).toEqual(bytes(100_000))
    expect(got.b[1]!.body).toEqual(bytes(50_000, 3))
  })

  it('작은 프레임은 큰 것 여럿이 번갈아 가는 줄을 기다리지 않는다', async () => {
    const { a, got, pipe } = pair({ maxChunk: 512, codec: false, bytesPerSecond: 500_000 })
    for (const id of [1, 3, 4]) void a.send(FRAME.DATA, id, bytes(60_000, id))
    void a.send(FRAME.RES, 2, utf8.encode('승인 답'))
    await until(() => got.b.length >= 1, '첫 메시지')
    expect(got.b[0]).toMatchObject({ type: FRAME.RES, id: 2 })
    expect(pipe.bytes.aToB).toBeLessThan(5000) // 큰 것의 조각(16KB)이 앞서 가지 않았다
    await until(() => got.b.length === 4, '전부')
  })

  it('양쪽이 동시에 보내도 섞이지 않는다 (요청 여럿 + 스트림)', async () => {
    const { a, b, got } = pair({ maxChunk: 185 })
    const sends: Promise<void>[] = []
    for (let id = 1; id <= 20; id++) sends.push(a.send(FRAME.REQ, id, utf8.encode(text(200 + id * 700))))
    for (let n = 0; n < 30; n++) sends.push(b.send(FRAME.DATA, 99, utf8.encode(`event ${n}\n\n`)))
    for (let id = 1; id <= 20; id++) sends.push(b.send(FRAME.RES, id, bytes(id * 3000, id)))
    await Promise.all(sends)
    await until(() => got.b.length === 20 && got.a.length === 50, '전부')
    for (const message of got.b) expect(utf8.decode(message.body)).toBe(text(200 + message.id * 700))
    expect(got.a.filter((message) => message.type === FRAME.DATA).map((message) => utf8.decode(message.body))).toEqual(Array.from({ length: 30 }, (_, n) => `event ${n}\n\n`))
    for (const message of got.a.filter((entry) => entry.type === FRAME.RES)) expect(message.body).toEqual(bytes(message.id * 3000, message.id))
  })

  it('아직 못 보낸 것을 거둘 수 있다 (drop) — 그 보내기는 실패로 끝나고, 보내던 조각 뒤로는 안 간다', async () => {
    const { a, got } = pair({ maxChunk: 512, codec: false })
    const first = a.send(FRAME.DATA, 1, bytes(60_000))
    const second = a.send(FRAME.DATA, 1, bytes(10))
    expect(a.busy(1)).toBe(true)
    a.drop(1)
    await expect(first).rejects.toThrow()
    await expect(second).rejects.toThrow()
    expect(a.busy(1)).toBe(false)
    await a.send(FRAME.RES, 2, bytes(5))
    await until(() => got.b.length === 1, '뒤의 것')
    expect(got.b[0]).toMatchObject({ type: FRAME.RES, id: 2 })
  })
})

describe('보내다 만 메시지', () => {
  it('조각을 보내다 거두면 상대가 받은 조각을 버린다 — 같은 id 의 다음 메시지에 섞이지 않는다', async () => {
    const { a, got, pipe } = pair({ maxChunk: 512, codec: false, bytesPerSecond: 2_000_000 })
    const big = a.send(FRAME.DATA, 1, bytes(60_000))
    await until(() => pipe.bytes.aToB > 0, '첫 조각이 가는 중')
    a.drop(1)
    await expect(big).rejects.toThrow()
    await a.send(FRAME.DATA, 1, utf8.encode('fresh'))
    await until(() => got.b.length === 1, '다음 메시지')
    expect(utf8.decode(got.b[0]!.body)).toBe('fresh')
  })
})

describe('프레임 deflate', () => {
  it('1KB 이상이고 줄어들 때만 압축한다 — 받는 쪽은 원문을 받는다', async () => {
    const { a, got, pipe } = pair()
    const big = utf8.encode(text(200_000))
    await a.send(FRAME.RES, 1, big)
    await until(() => got.b.length === 1, '큰 것')
    expect(got.b[0]!.body).toEqual(big)
    expect(pipe.bytes.aToB).toBeLessThan(big.length / 5)
    expect(a.stats).toMatchObject({ messages: 1, rawBytes: big.length, deflated: 1 })
    expect(a.stats.wireBytes).toBe(pipe.bytes.aToB)

    const before = pipe.bytes.aToB
    await a.send(FRAME.RES, 2, utf8.encode(text(1000))) // 1KB 미만 — 그대로
    expect(pipe.bytes.aToB - before).toBe(1000 + 6)

    const noise = Uint8Array.from({ length: 4000 }, () => Math.floor(Math.random() * 256)) // 줄지 않는 것 — 그대로
    const mark = pipe.bytes.aToB
    await a.send(FRAME.RES, 3, noise)
    expect(pipe.bytes.aToB - mark).toBe(4000 + 6)
    await until(() => got.b.length === 3, '셋')
    expect(got.b[2]!.body).toEqual(noise)
  })

  it('압축된 프레임인데 풀 수단이 없거나, 풀었더니 상한을 넘으면 링크를 끊는다', async () => {
    const pipe = memoryPipe({ maxChunk: 4096 })
    const closed: unknown[] = []
    new FrameChannel(pipe.b, { onMessage: () => {}, onClose: (error) => void closed.push(error) })
    await pipe.a.send(encodeRecord(FRAME.RES, 1, FLAG_DEFLATE, zlibCodec.deflate(utf8.encode(text(5000)))))
    await until(() => closed.length === 1, '끊김')
    expect(closed[0]).toBeInstanceOf(FramingError)

    // 상한을 지키지 않는 압축 수단이어도 채널이 다시 본다
    const sloppy = memoryPipe({ maxChunk: 4096 })
    const dropped: unknown[] = []
    const received: FrameMessage[] = []
    new FrameChannel(sloppy.b, { codec: { deflate: zlibCodec.deflate, inflate: (data) => zlibCodec.inflate(data, 1 << 24) }, maxMessageBytes: 10_000, onMessage: (message) => void received.push(message), onClose: (error) => void dropped.push(error) })
    await sloppy.a.send(encodeRecord(FRAME.RES, 1, FLAG_DEFLATE, zlibCodec.deflate(new Uint8Array(1_000_000))))
    await until(() => dropped.length === 1, '끊김')
    expect(received).toEqual([])

    const bomb = pair({ maxMessageBytes: 10_000 })
    void bomb.a.send(FRAME.RES, 2, new Uint8Array(1_000_000)).catch(() => {}) // 1MB 의 0 — 1KB 로 줄어 닿는다
    await until(() => bomb.closed.b.length === 1, '끊김')
    expect(bomb.got.b).toEqual([])
  })
})

describe('어긋난 것·끊긴 것', () => {
  it('다 붙인 본문이 상한을 넘으면 링크를 끊는다 (너무 큰 프레임)', async () => {
    const { a, got, closed } = pair({ codec: false, maxMessageBytes: 30_000 })
    await a.send(FRAME.REQ, 1, bytes(30_000))
    await until(() => got.b.length === 1, '상한까지는 받는다')
    void a.send(FRAME.REQ, 2, bytes(30_001)).catch(() => {})
    await until(() => closed.b.length === 1, '끊김')
    expect(closed.b[0]).toBeInstanceOf(FramingError)
    expect(got.b).toHaveLength(1)
    expect(closed.a).toHaveLength(1) // 링크가 끊기면 양쪽이 안다
  })

  it('잘못된 레코드(머리보다 짧다)가 오면 끊는다', async () => {
    const { pipe, closed } = pair()
    await pipe.a.send(Uint8Array.of(0, 2, 1, 1))
    await until(() => closed.b.length === 1, '끊김')
    expect(closed.b[0]).toBeInstanceOf(FramingError)
  })

  it('링크가 끊기면 붙이던 조각은 버리고, 보내려던 것은 실패로 끝난다. 끊긴 뒤 보내기도 실패다', async () => {
    const { a, pipe, got, closed } = pair({ maxChunk: 20, codec: false, bytesPerSecond: 20_000 })
    const sending = a.send(FRAME.RES, 1, bytes(50_000))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(pipe.bytes.aToB).toBeGreaterThan(0)
    pipe.cut(new Error('멀어졌다'))
    await expect(sending).rejects.toThrow()
    expect(got.b).toEqual([])
    expect(closed.a).toHaveLength(1)
    expect(a.closed).toBe(true)
    await expect(a.send(FRAME.REQ, 2, bytes(3))).rejects.toThrow()
  })

  it('링크가 받아 줄 때까지 다음 조각을 꺼내지 않는다 (되밀림)', async () => {
    const sent: Uint8Array[] = []
    const release: (() => void)[] = []
    const link: ByteLink = { maxChunk: 100, send: (chunk) => new Promise((resolve) => (sent.push(chunk), release.push(resolve))), onData: () => {}, onClose: () => {}, close: () => {} }
    const channel = new FrameChannel(link, { onMessage: () => {} })
    void channel.send(FRAME.DATA, 1, bytes(250))
    await settle()
    expect(sent).toHaveLength(1) // 첫 조각만 — 풀릴 때까지 기다린다
    release.shift()!()
    await settle()
    expect(sent.map((chunk) => chunk.length)).toEqual([100, 100])
    release.shift()!()
    await settle()
    expect(sent.map((chunk) => chunk.length)).toEqual([100, 100, 56])
  })
})
