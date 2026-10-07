import { describe, expect, it } from 'vitest'
import { generateNoiseKeyPair, NOISE_TAG, NoiseError, bluetoothPrologue } from '../../shared/noiseNK.ts'
import { NOISE_RECORD_PLAINTEXT_MAX, secureInitiator, secureResponder } from '../../shared/noiseRecord.ts'
import { FRAGMENT_BYTES, FRAME, FrameChannel, type ByteLink, type FrameMessage } from '../../shared/remoteFraming.ts'
import { zlibCodec } from '../../src/services/remote/framed.ts'
import { memoryPipe } from './support/memoryPipe.ts'

// L2 를 끼울 자리 (이슈 #171) — 날 링크(메모리 파이프) 위에 Noise 를 맺고 그 위에 FrameChannel 을 그대로 얹는다.
// FrameChannel·memoryPipe 는 바꾸지 않았다. 무선은 쓰지 않는다.

const bytes = (length: number, seed = 1): Uint8Array => Uint8Array.from({ length }, (_, index) => (index * 31 + seed * 7) & 0xff)
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
async function until(done: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 2000 && !done(); tries++) await settle()
  if (!done()) throw new Error(`기다렸지만 오지 않았다: ${what}`)
}

/** 날 링크 한쪽 끝을 감싸 지나가는 조각을 본다·바꾼다 (edit 이 돌려준 조각들을 대신 보낸다) */
function tap(link: ByteLink, edit: (chunk: Uint8Array, index: number) => Uint8Array[] = (chunk) => [chunk]) {
  const seen: Uint8Array[] = []
  const wrapped: ByteLink = {
    maxChunk: link.maxChunk,
    async send(chunk) {
      seen.push(chunk.slice())
      for (const out of edit(chunk.slice(), seen.length - 1)) await link.send(out)
    },
    onData: (listener) => link.onData(listener),
    onClose: (listener) => link.onClose(listener),
    close: () => link.close(),
  }
  return { link: wrapped, seen }
}

async function secured(options: { maxChunk?: number; phoneEdit?: Parameters<typeof tap>[1]; desktopEdit?: Parameters<typeof tap>[1] } = {}) {
  const pipe = memoryPipe({ maxChunk: options.maxChunk ?? 182 })
  const server = generateNoiseKeyPair()
  const phoneRaw = tap(pipe.a, options.phoneEdit)
  const desktopRaw = tap(pipe.b, options.desktopEdit)
  const prologue = bluetoothPrologue('desk-1')
  const [phone, desktop] = await Promise.all([secureInitiator(phoneRaw.link, server.publicKey, { prologue }), secureResponder(desktopRaw.link, server, { prologue })])
  return { pipe, server, phone, desktop, phoneRaw, desktopRaw }
}

function channels(phoneLink: ByteLink, desktopLink: ByteLink) {
  const got = { phone: [] as FrameMessage[], desktop: [] as FrameMessage[] }
  const closed = { phone: [] as unknown[], desktop: [] as unknown[] }
  const phone = new FrameChannel(phoneLink, { codec: zlibCodec, onMessage: (message) => void got.phone.push(message), onClose: (error) => void closed.phone.push(error) })
  const desktop = new FrameChannel(desktopLink, { codec: zlibCodec, onMessage: (message) => void got.desktop.push(message), onClose: (error) => void closed.desktop.push(error) })
  return { phone, desktop, got, closed }
}

describe('보안 링크 — FrameChannel 을 그대로 얹는다', () => {
  it('평문 상한은 FrameChannel 레코드 하나 (길이 2 + 머리 4 + 조각 16KB)', () => {
    expect(NOISE_RECORD_PLAINTEXT_MAX).toBe(2 + 4 + FRAGMENT_BYTES)
  })

  it('양방향 여러 메시지(큰 것 포함)가 BLE 크기 조각(182)으로 오가고, L1 레코드 하나 = 암호 레코드 하나', async () => {
    const { phone, desktop, phoneRaw } = await secured()
    const handshakeChunks = phoneRaw.seen.length
    const { phone: p, desktop: d, got } = channels(phone, desktop)
    const big = crypto.getRandomValues(new Uint8Array(40_000)) // 압축 안 되는 것 — 16KB 조각 셋
    let records = 0
    const plain = phone.send.bind(phone)
    phone.send = (chunk) => {
      records += 1
      return plain(chunk)
    }
    await Promise.all([p.send(FRAME.REQ, 1, bytes(100)), p.send(FRAME.REQ, 2, big), d.send(FRAME.RES, 1, bytes(200, 2)), d.send(FRAME.DATA, 9, new Uint8Array())])
    await until(() => got.desktop.length === 2 && got.phone.length === 2, '메시지 넷')
    expect(got.desktop.map((message) => [message.id, message.body.length])).toEqual(expect.arrayContaining([[1, 100], [2, 40_000]]))
    expect(got.desktop.find((message) => message.id === 2)!.body).toEqual(big)
    expect(got.phone.map((message) => [message.id, message.body.length])).toEqual([[1, 200], [9, 0]])
    // 폰이 보낸 L1 레코드 = 1(100B) + 3(40KB → 16KB 조각 셋) = 4 → 암호 레코드도 4
    expect(records).toBe(4)
    // 날 링크에 실린 조각은 모두 182 이하, 평문은 보이지 않는다
    const wire = phoneRaw.seen.slice(handshakeChunks)
    expect(wire.every((chunk) => chunk.length <= 182)).toBe(true)
    const all = Buffer.concat(wire)
    expect(all.includes(Buffer.from(bytes(100)))).toBe(false)
    // 바깥 틀: u16 길이 ‖ 암호문(평문 + 16) — 첫 레코드는 L1 레코드(2 + 4 + 100) + 태그
    expect((all[0]! << 8) | all[1]!).toBe(2 + 4 + 100 + NOISE_TAG)
  })

  it('핸드셰이크 두 메시지도 같은 틀(u16 길이 ‖ 48바이트)로 간다', async () => {
    const { phoneRaw, desktopRaw } = await secured({ maxChunk: 512 })
    expect([...phoneRaw.seen[0]!.subarray(0, 2)]).toEqual([0, 48])
    expect(phoneRaw.seen[0]!.length).toBe(50)
    expect([...desktopRaw.seen[0]!.subarray(0, 2)]).toEqual([0, 48])
  })

  it('틀린 서버 공개키 → 데스크탑이 메시지 1 을 못 풀어 끊고, 폰 쪽도 거절된다', async () => {
    const pipe = memoryPipe()
    const server = generateNoiseKeyPair()
    const other = generateNoiseKeyPair()
    const results = await Promise.allSettled([secureInitiator(pipe.a, other.publicKey), secureResponder(pipe.b, server)])
    expect(results[0].status).toBe('rejected')
    expect(results[1]).toMatchObject({ status: 'rejected', reason: expect.any(NoiseError) })
  })

  it('다른 데스크탑의 프롤로그(desktopId)면 실패한다', async () => {
    const pipe = memoryPipe()
    const server = generateNoiseKeyPair()
    const results = await Promise.allSettled([
      secureInitiator(pipe.a, server.publicKey, { prologue: bluetoothPrologue('desk-1') }),
      secureResponder(pipe.b, server, { prologue: bluetoothPrologue('desk-2') }),
    ])
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
  })

  // 큰 maxChunk 로 암호 레코드 하나 = 날 조각 하나가 되게 해 레코드 단위로 건드린다. 폰의 0 번 조각은 메시지 1, 1 번이 첫 데이터(id 1)
  const truncate = (chunk: Uint8Array): Uint8Array => {
    const length = ((chunk[0]! << 8) | chunk[1]!) - 5
    return Uint8Array.of(length >> 8, length & 0xff, ...chunk.subarray(2, 2 + length))
  }
  const attacks: [string, (chunk: Uint8Array, index: number) => Uint8Array[], number[]][] = [
    ['변조', (chunk, index) => (index === 1 ? [Uint8Array.from(chunk, (byte, at) => (at === 10 ? byte ^ 1 : byte))] : [chunk]), []],
    ['잘림(끝 5바이트를 떼고 길이도 맞춤)', (chunk, index) => (index === 1 ? [truncate(chunk)] : [chunk]), []],
    ['되돌림(같은 레코드 두 번)', (chunk, index) => (index === 1 ? [chunk, chunk] : [chunk]), [1]],
    ['빠뜨림(nonce 건너뜀)', (chunk, index) => (index === 1 ? [] : [chunk]), []],
  ]
  for (const [name, edit, accepted] of attacks) {
    it(`${name} → 받는 쪽이 NoiseError 로 링크를 끊고 FrameChannel 은 onClose(error) 를 받는다`, async () => {
      const { phone, desktop } = await secured({ maxChunk: 20_000, phoneEdit: edit })
      const { phone: p, desktop: d, got, closed } = channels(phone, desktop)
      for (const id of [1, 2, 3]) void p.send(FRAME.REQ, id, bytes(40 + id)).catch(() => {})
      await until(() => closed.desktop.length === 1, '끊김')
      expect(closed.desktop[0]).toBeInstanceOf(NoiseError)
      expect(d.closed).toBe(true)
      expect(desktop.closed).toBe(true)
      expect(got.desktop.map((message) => message.id)).toEqual(accepted)
    })
  }

  it('순서를 바꾼 레코드 → 끊는다', async () => {
    let held: Uint8Array | undefined
    const { phone, desktop } = await secured({
      maxChunk: 20_000,
      phoneEdit: (chunk, index) => {
        if (index === 1) {
          held = chunk
          return []
        }
        if (index === 2) return [chunk, held!]
        return [chunk]
      },
    })
    const { phone: p, got, closed } = channels(phone, desktop)
    void p.send(FRAME.REQ, 1, bytes(50)).catch(() => {})
    void p.send(FRAME.REQ, 2, bytes(60)).catch(() => {})
    await until(() => closed.desktop.length === 1, '끊김')
    expect(closed.desktop[0]).toBeInstanceOf(NoiseError)
    expect(got.desktop).toEqual([])
  })

  it('핸드셰이크 직후 상대가 바로 보낸 레코드도 놓치지 않는다 (위층이 듣기 전에 온 것은 쥐고 있다가 준다)', async () => {
    const pipe = memoryPipe({ maxChunk: 64 })
    const server = generateNoiseKeyPair()
    const desktopReady = secureResponder(pipe.b, server)
    const phone = await secureInitiator(pipe.a, server.publicKey)
    await phone.send(bytes(30, 5)) // 데스크탑이 아직 위층을 안 붙였을 수 있다
    const desktop = await desktopReady
    await settle()
    const got: Uint8Array[] = []
    desktop.onData((chunk) => void got.push(chunk))
    await until(() => got.length === 1, '이른 레코드')
    expect(got[0]).toEqual(bytes(30, 5))
  })

  it('한 레코드보다 큰 조각은 받지 않는다, 핸드셰이크 전에 끊기면 거절된다', async () => {
    const { phone } = await secured()
    await expect(phone.send(new Uint8Array(NOISE_RECORD_PLAINTEXT_MAX + 1))).rejects.toThrow(/too large/)
    const pipe = memoryPipe()
    const waiting = secureResponder(pipe.b, generateNoiseKeyPair())
    pipe.cut()
    await expect(waiting).rejects.toThrow()
  })

  it('보안 링크를 닫으면 날 링크도 닫힌다', async () => {
    const { pipe, phone, desktop } = await secured()
    const closed: unknown[] = []
    desktop.onClose((error) => void closed.push(error ?? 'clean'))
    phone.close()
    await until(() => closed.length === 1, '닫힘')
    expect(phone.closed).toBe(true)
    await expect(pipe.a.send(new Uint8Array(1))).rejects.toThrow(/closed/)
  })
})
