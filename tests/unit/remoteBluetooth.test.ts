import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BLUETOOTH_RX_UUID, BLUETOOTH_TX_UUID, bluetoothServiceUuid } from '../../shared/bluetooth.ts'
import { bluetoothPrologue, decodeNoiseKey, generateNoiseKeyPair } from '../../shared/noiseNK.ts'
import { secureInitiator } from '../../shared/noiseRecord.ts'
import { parsePairUri } from '../../shared/remote.ts'
import { FRAME, FrameChannel, utf8, type ByteLink, type FrameMessage } from '../../shared/remoteFraming.ts'
import { BLUETOOTH_PACE_BYTES_PER_SECOND, RemoteBluetooth, type BlenoCharacteristicOptions, type BlenoLike, type RemoteBluetoothOptions } from '../../src/services/remote/bluetooth.ts'
import { zlibCodec } from '../../src/services/remote/framed.ts'
import { loadNoiseIdentity } from '../../src/services/remote/noiseIdentity.ts'
import type { KeyCipher } from '../../src/services/providers.ts'
import { box, parseFrames, setUp, start, tearDown, until } from './support/remoteHarness.ts'

// 블루투스 운반 (이슈 #210) — 가짜 bleno 로만. 라디오·광고·스캔은 쓰지 않는다.
// 가짜는 @stoprocent/bleno 0.13.1 의 겉모양을 따른다: stateChange 를 처음 걸면 초기화되어 상태를 알리고, 특성의 onSubscribe(handle, MTU−3, 알림 보내기)·
// onWriteRequest·onUnsubscribe·onNotify 를 부른다. 폰 쪽은 그 위에 ByteLink 를 만들어 진짜 Noise(secureInitiator) + FrameChannel 을 얹는다.

beforeEach(setUp)
afterEach(tearDown)

class FakeCharacteristic {
  constructor(readonly options: BlenoCharacteristicOptions) {}
}
class FakeService {
  constructor(readonly options: { uuid: string; characteristics: object[] }) {}
}

interface Central {
  handle: string
  link: ByteLink
  subscribe(): void
  unsubscribe(): void
  /** 날 바이트 쓰기 — 결과 코드 */
  write(data: Uint8Array): number
  /** 받은 알림 크기 */
  notifications: number[]
  closed(): boolean
}

class FakeBleno extends EventEmitter implements BlenoLike {
  state = 'unknown'
  readonly Characteristic = FakeCharacteristic
  readonly PrimaryService = FakeService
  calls: string[] = []
  services: FakeService[] = []
  advertising?: { name: string; uuids: string[] }
  advertiseError?: Error
  /** 끊기가 실제로 끊나 (Windows 처럼) — false 면 macOS 처럼 아무 일도 없다 */
  canDisconnect = true
  /** 알림을 보낸 뒤 notify 신호를 주나 (Linux 처럼) */
  autoNotify = true
  private initialized = false
  private centrals = new Map<string, { close(): void }>()

  constructor(private initialState = 'poweredOn') {
    super()
    this.on('newListener', (event) => {
      if (event !== 'stateChange' || this.initialized) return
      this.initialized = true
      this.calls.push('init')
      queueMicrotask(() => this.power(this.initialState))
    })
  }

  power(state: string): void {
    this.state = state
    this.emit('stateChange', state)
  }
  setServices(services: object[], callback: (error?: Error | null) => void): void {
    this.calls.push('setServices')
    this.services = services as FakeService[]
    queueMicrotask(() => callback(null))
  }
  startAdvertising(name: string, uuids: string[], callback: (error?: Error | null) => void): void {
    this.calls.push('startAdvertising')
    if (!this.advertiseError) this.advertising = { name, uuids }
    queueMicrotask(() => callback(this.advertiseError ?? null))
  }
  stopAdvertising(): void {
    this.calls.push('stopAdvertising')
    this.advertising = undefined
  }
  disconnect(handle?: string | number | null): void {
    this.calls.push(`disconnect:${handle ?? 'all'}`)
    if (!this.canDisconnect) return
    for (const [key, central] of [...this.centrals]) {
      if (handle !== undefined && handle !== null && key !== String(handle)) continue
      central.close()
      this.emit('disconnect', key, key)
    }
  }
  stop(): void {
    this.calls.push('stop')
    this.initialized = false
    this.state = 'unknown'
  }
  /** 걸린 리스너 수 (bleno 의 것) */
  listening(): number {
    return ['stateChange', 'accept', 'disconnect'].reduce((sum, event) => sum + this.listenerCount(event), 0)
  }

  characteristic(uuid: string): FakeCharacteristic {
    const found = this.services.flatMap((service) => service.options.characteristics as FakeCharacteristic[]).find((entry) => entry.options.uuid === uuid)
    if (!found) throw new Error(`no characteristic ${uuid}`)
    return found
  }

  /** 붙는 폰 하나 — MTU 를 협상해 tx 를 구독하고 rx 에 쓴다 */
  central(handle: string, mtu = 185): Central {
    const data: ((chunk: Uint8Array) => void)[] = []
    const closes: ((error?: unknown) => void)[] = []
    const notifications: number[] = []
    let closed = false
    const close = (): void => {
      if (closed) return
      closed = true
      this.centrals.delete(handle)
      for (const listener of closes) listener()
    }
    const write = (chunk: Uint8Array): number => {
      let result = -1
      this.characteristic(BLUETOOTH_RX_UUID).options.onWriteRequest!(handle, Buffer.from(chunk), 0, true, (code) => (result = code))
      return result
    }
    const link: ByteLink = {
      maxChunk: mtu - 3,
      async send(chunk) {
        if (closed) throw new Error('link closed')
        write(chunk)
      },
      onData: (listener) => void data.push(listener),
      onClose: (listener) => void closes.push(listener),
      close: () => {
        this.characteristic(BLUETOOTH_TX_UUID).options.onUnsubscribe!(handle)
        close()
      },
    }
    const central: Central = {
      handle,
      link,
      notifications,
      closed: () => closed,
      write,
      subscribe: () => {
        closed = false
        this.centrals.set(handle, { close })
        const tx = this.characteristic(BLUETOOTH_TX_UUID)
        tx.options.onSubscribe!(handle, mtu - 3, (chunk) => {
          notifications.push(chunk.length)
          const copy = new Uint8Array(chunk)
          for (const listener of data) listener(copy)
          if (this.autoNotify) setImmediate(() => tx.options.onNotify!(handle))
        })
      },
      unsubscribe: () => link.close(),
    }
    return central
  }
}

/** 블루투스 운반을 올린다 — 가짜 bleno 를 넘기고 ctx.remote 가 띄울 때까지 */
async function bluetooth(desktop: Awaited<ReturnType<typeof start>>, bleno: FakeBleno | (() => Promise<BlenoLike>), options: Partial<RemoteBluetoothOptions> = {}) {
  let loads = 0
  const load = typeof bleno === 'function' ? bleno : async () => bleno
  const fiber = desktop.ctx.plugin(RemoteBluetooth, {
    load: () => {
      loads += 1
      return load()
    },
    ...options,
  })
  box.cleanups.push(() => fiber.dispose())
  await until(() => desktop.remote.status().bluetooth !== undefined, '블루투스 운반 올라옴') // inject 를 기다려 비동기로 붙는다
  await desktop.remote.ready()
  return { fiber, loads: () => loads }
}

/** 손으로 쓰는 폰 — 보안 링크 위에 FrameChannel */
function rawPhone(link: ByteLink) {
  const got: FrameMessage[] = []
  let closed = false
  const channel = new FrameChannel(link, { codec: zlibCodec, onMessage: (message) => void got.push(message), onClose: () => (closed = true) })
  const json = (message: FrameMessage | undefined) => (message ? JSON.parse(utf8.decode(message.body)) : undefined)
  return {
    channel,
    closed: () => closed,
    send: (type: number, id: number, body: unknown) => channel.send(type, id, utf8.encode(JSON.stringify(body))),
    async response(id: number): Promise<{ status: number; body: any }> {
      await until(() => got.some((message) => message.type === FRAME.RES && message.id === id), `RES ${id}`)
      return json(got.find((message) => message.type === FRAME.RES && message.id === id))
    },
    stream: (id: number) => got.filter((message) => message.type === FRAME.DATA && message.id === id).map((message) => utf8.decode(message.body)).join(''),
  }
}

const noiseKeyFile = () => path.join(box.root, 'remote-noise-key.json')

/** 폰 하나를 붙여 핸드셰이크까지 — QR 의 bk(데스크탑 공개키)와 desktopId 로 */
async function connect(desktop: Awaited<ReturnType<typeof start>>, bleno: FakeBleno, handle: string, mtu = 185) {
  const central = bleno.central(handle, mtu)
  central.subscribe()
  const identity = await desktop.remote.noiseIdentity()
  const secure = await secureInitiator(central.link, decodeNoiseKey(identity.publicKeyText)!, { prologue: bluetoothPrologue(desktop.remote.desktopId) })
  return { central, phone: rawPhone(secure) }
}

describe('블루투스 운반 — 광고 수명', () => {
  it('켤 때 모듈을 처음 읽는다(키는 아직 — 이슈 #268). 서비스 UUID 하나만 광고(이름 없음), 특성은 rx(write without response)·tx(notify). 내리면 광고를 멈추고 리스너를 다 걷는다', async () => {
    const desktop = await start({ http: false, noiseKeyFile: noiseKeyFile() })
    await expect(fs.stat(noiseKeyFile())).rejects.toThrow() // 켜기 전에는 키 파일이 없다
    const bleno = new FakeBleno()
    const { fiber, loads } = await bluetooth(desktop, bleno)
    expect(loads()).toBe(1)
    await until(() => desktop.remote.status().bluetooth?.state === 'advertising', '광고')
    await expect(fs.stat(noiseKeyFile())).rejects.toThrow() // 광고에는 desktopId 만 — 키는 폰이 붙거나 짝짓기를 시작할 때 읽는다 (#268)
    expect(bleno.calls).toEqual(['init', 'setServices', 'startAdvertising'])
    expect(bleno.advertising).toEqual({ name: '', uuids: [bluetoothServiceUuid(desktop.remote.desktopId)] })
    expect(bleno.services.map((service) => service.options.uuid)).toEqual([bluetoothServiceUuid(desktop.remote.desktopId)])
    expect(bleno.characteristic(BLUETOOTH_RX_UUID).options.properties).toEqual(['writeWithoutResponse'])
    expect(bleno.characteristic(BLUETOOTH_TX_UUID).options.properties).toEqual(['notify'])
    expect(desktop.remote.status()).toMatchObject({ addresses: [], bluetooth: { state: 'advertising', links: 0, devices: [] } })
    expect(desktop.remote.status().error).toBeUndefined()
    // 주소 없는 운반만 떠 있어도 짝짓기를 시작할 수 있다
    expect(desktop.remote.startPairing().pairing?.code).toBeTruthy()

    await fiber.dispose()
    await desktop.remote.ready()
    expect(bleno.calls.slice(3)).toEqual(['stopAdvertising', 'disconnect:all', 'stop'])
    expect(bleno.listening()).toBe(0)
    expect(desktop.remote.status().bluetooth).toBeUndefined()

    // 다시 켜면 다시 초기화해 광고한다 (모듈은 한 번 읽은 것을 다시 쓴다 — 여기선 load 가 다시 불린다)
    await bluetooth(desktop, bleno)
    await until(() => desktop.remote.status().bluetooth?.state === 'advertising', '다시 광고')
    expect(bleno.listening()).toBe(3)
  })

  it('상태 전이 — 기다림 → 블루투스 꺼짐 → 권한 없음 → 지원 안 함 → 켜짐(광고). 광고가 실패하면 사유와 함께 지원 안 함', async () => {
    const desktop = await start({ http: false, noiseKeyFile: noiseKeyFile() })
    const bleno = new FakeBleno('unknown')
    await bluetooth(desktop, bleno)
    const state = () => desktop.remote.status().bluetooth
    await until(() => bleno.calls.includes('init'), '초기화')
    expect(state()).toMatchObject({ state: 'starting' })
    for (const radio of ['poweredOff', 'unauthorized', 'unsupported'] as const) {
      bleno.power(radio)
      expect(state()).toMatchObject({ state: radio })
      expect(desktop.remote.status().error).toBeUndefined() // 라디오 사정은 리스너 오류 줄에 섞이지 않는다
    }
    bleno.power('poweredOn')
    await until(() => state()?.state === 'advertising', '광고')
    // 꺼졌다 켜지면 서비스를 다시 올리고 다시 광고한다
    bleno.power('poweredOff')
    expect(state()).toMatchObject({ state: 'poweredOff' })
    bleno.advertiseError = new Error('Peripheral role is not supported')
    bleno.power('poweredOn')
    await until(() => state()?.state === 'unsupported', '광고 실패')
    expect(state()).toMatchObject({ state: 'unsupported', reason: 'Peripheral role is not supported' })
    expect(bleno.calls.filter((call) => call === 'setServices')).toHaveLength(2)
  })

  it('모듈을 못 읽으면 상태 줄에 사유만 남는다 — ctx.remote·HTTP 는 그대로 돈다', async () => {
    const desktop = await start({ noiseKeyFile: noiseKeyFile() })
    await bluetooth(desktop, async () => {
      throw new Error('No native build was found for platform=win32 arch=arm64')
    })
    expect(desktop.remote.status().bluetooth).toEqual({ state: 'unsupported', reason: 'No native build was found for platform=win32 arch=arm64', links: 0, devices: [] })
    expect(desktop.remote.status().error).toBeUndefined()
    expect((await desktop.api('GET', '/v1/hello')).status).toBe(401) // HTTP 운반은 산다
    await expect(fs.stat(noiseKeyFile())).rejects.toThrow() // 모듈을 못 읽었으면 키도 만들지 않는다
  })

  // 이슈 #268: 앱을 켤 때마다 macOS 키체인 허용 창이 뜨지 않게 — 광고 시작은 키 저장소를 부르지 않고, 폰이 핸드셰이크를 시작할 때 처음 읽는다
  it('광고를 시작할 때는 키 저장소를 부르지 않는다. 폰이 붙을 때 읽고, 못 풀면 그 연결을 끊고 failed + keyStore (이슈 #231) — 다음 연결에서 다시 읽어 붙는다', async () => {
    let available = true
    let cipherCalls = 0
    const cipher: KeyCipher = {
      available: () => (cipherCalls++, available),
      encrypt: (plain) => (cipherCalls++, Buffer.from(plain).reverse()),
      decrypt: (sealed) => (cipherCalls++, Buffer.from(sealed).reverse().toString()),
    }
    await loadNoiseIdentity(noiseKeyFile(), cipher)
    available = false
    cipherCalls = 0
    const desktop = await start({ http: false, noiseKeyFile: noiseKeyFile(), cipher })
    const bleno = new FakeBleno()
    await bluetooth(desktop, bleno)
    await until(() => desktop.remote.status().bluetooth?.state === 'advertising', '광고')
    expect(cipherCalls).toBe(0)

    bleno.central('first').subscribe()
    await until(() => desktop.remote.status().bluetooth?.state === 'failed', '실패')
    expect(cipherCalls).toBeGreaterThan(0)
    expect(desktop.remote.status().bluetooth).toMatchObject({ state: 'failed', keyStore: true, links: 0 })
    expect(bleno.calls).toContain('disconnect:first')

    available = true // 사용자가 키체인 접근을 허용했다
    await connect(desktop, bleno, 'second')
    await until(() => desktop.remote.status().bluetooth?.links === 1, '핸드셰이크')
    expect(desktop.remote.status().bluetooth).toMatchObject({ state: 'advertising', links: 1 })
  })
})

describe('블루투스 운반 — 연결', () => {
  it('구독 → Noise 핸드셰이크 → /v1/hello 왕복. 알림은 그 연결의 MTU−3 조각이고, notify 신호가 되밀림을 푼다. 스트림을 열면 기기 줄이 블루투스로 보인다', async () => {
    const desktop = await start({ noiseKeyFile: noiseKeyFile() })
    const bleno = new FakeBleno()
    // 속도 상한은 아주 느리게 — notify 신호(Linux)로만 다음 조각이 나간다
    await bluetooth(desktop, bleno, { paceBytesPerSecond: 1 })
    await until(() => desktop.remote.status().bluetooth?.state === 'advertising', '광고')
    const { token } = await desktop.pair()
    const { central, phone } = await connect(desktop, bleno, 'central-1', 64)
    await until(() => desktop.remote.status().bluetooth?.links === 1, '핸드셰이크')

    await phone.send(FRAME.REQ, 1, { method: 'GET', path: '/v1/hello', headers: {} })
    expect(await phone.response(1)).toEqual({ status: 401, body: { error: 'not a paired device' } })
    await phone.send(FRAME.REQ, 2, { method: 'GET', path: '/v1/hello', headers: { authorization: `Bearer ${token}` } })
    expect((await phone.response(2)).body).toMatchObject({ name: 'test-pc', desktopId: desktop.remote.desktopId })
    expect(Math.max(...central.notifications)).toBe(61)

    await phone.send(FRAME.OPEN, 3, { method: 'GET', path: '/v1/events', headers: { authorization: `Bearer ${token}` } })
    expect(await phone.response(3)).toEqual({ status: 200 })
    await until(() => desktop.remote.status().devices[0]?.connected === true, '스트림')
    expect(desktop.remote.status().devices[0]).toMatchObject({ connected: true, via: 'bluetooth' })
    expect(desktop.remote.status().bluetooth).toMatchObject({ state: 'advertising', links: 1, devices: ['Pixel 8'] })

    // 폰이 떠난다 (구독 해제) — 연결·스트림이 걷힌다
    central.unsubscribe()
    await until(() => !desktop.remote.status().devices[0]!.connected && desktop.remote.status().bluetooth?.links === 0, '끊김')
  })

  // 폰은 메시지 2 를 받는 순간 풀리지만 데스크탑은 메시지 2 가 링크에 다 실린 뒤(되밀림)에야 FrameChannel 을 붙인다 — 그사이 온 요청은
  // SecureLink 가 쥐고 있다가 FrameChannel 이 듣는 순간(생성자 안에서) 곧바로 넘긴다. 그때 serveFramed 가 아직 다 만들어지지 않았어도 받아야 한다
  it('폰이 핸드셰이크를 마치자마자(데스크탑이 메시지 2 를 다 보내기 전) 보낸 요청도 받는다', async () => {
    const desktop = await start({ noiseKeyFile: noiseKeyFile() })
    const bleno = new FakeBleno()
    bleno.autoNotify = false
    await bluetooth(desktop, bleno, { paceBytesPerSecond: 1_000 }) // 메시지 2(50바이트)가 다 나가는 데 50ms
    await until(() => desktop.remote.status().bluetooth?.state === 'advertising', '광고')
    const { token } = await desktop.pair()
    const { phone } = await connect(desktop, bleno, 'eager')
    expect(desktop.remote.status().bluetooth?.links).toBe(0) // 데스크탑은 아직 핸드셰이크 중
    await phone.send(FRAME.OPEN, 1, { method: 'GET', path: '/v1/events', headers: { authorization: `Bearer ${token}` } })
    await phone.send(FRAME.REQ, 2, { method: 'GET', path: '/v1/hello', headers: {} })
    expect(await phone.response(1)).toEqual({ status: 200 })
    expect((await phone.response(2)).status).toBe(401)
    await until(() => desktop.remote.status().devices[0]?.connected === true, '스트림')
  })

  it('핸드셰이크가 제한 시간 안에 안 끝나면 끊는다', async () => {
    const desktop = await start({ http: false, noiseKeyFile: noiseKeyFile() })
    const bleno = new FakeBleno()
    await bluetooth(desktop, bleno, { handshakeTimeoutMs: 40 })
    await until(() => desktop.remote.status().bluetooth?.state === 'advertising', '광고')
    const central = bleno.central('slow')
    central.subscribe() // 붙기만 하고 메시지 1 을 안 보낸다
    await until(() => bleno.calls.includes('disconnect:slow'), '시간 초과로 끊김')
    expect(central.closed()).toBe(true)
    expect(desktop.remote.status().bluetooth?.links).toBe(0)
  })

  it('폰은 2대까지 — 셋째는 붙자마자 끊고 그 쓰기는 받지 않는다(macOS 처럼 끊기가 효과 없을 때도)', async () => {
    const desktop = await start({ http: false, noiseKeyFile: noiseKeyFile() })
    const bleno = new FakeBleno()
    bleno.canDisconnect = false
    await bluetooth(desktop, bleno)
    await until(() => desktop.remote.status().bluetooth?.state === 'advertising', '광고')
    await connect(desktop, bleno, 'one')
    await connect(desktop, bleno, 'two')
    await until(() => desktop.remote.status().bluetooth?.links === 2, '둘')
    const third = bleno.central('three')
    third.subscribe()
    expect(bleno.calls).toContain('disconnect:three')
    expect(third.write(Uint8Array.of(0, 1, 2))).toBe(0x0e)
    // 하나가 떠나면 셋째가 다시 붙을 수 있다 (구독을 풀고 다시)
    bleno.central('one').unsubscribe()
    third.unsubscribe()
    const again = await connect(desktop, bleno, 'three')
    await again.phone.send(FRAME.REQ, 1, { method: 'GET', path: '/v1/hello', headers: {} })
    expect((await again.phone.response(1)).status).toBe(401)
  })

  it('틀린 키(다른 데스크탑의 bk)로 붙으면 끊는다 — 구독을 풀고 다시 붙기 전까지 그 연결의 쓰기는 무시한다', async () => {
    const desktop = await start({ http: false, noiseKeyFile: noiseKeyFile() })
    const bleno = new FakeBleno()
    bleno.canDisconnect = false // macOS — 끊기가 효과 없다
    await bluetooth(desktop, bleno)
    await until(() => desktop.remote.status().bluetooth?.state === 'advertising', '광고')
    const central = bleno.central('intruder')
    central.subscribe()
    const attempt = secureInitiator(central.link, generateNoiseKeyPair().publicKey, { prologue: bluetoothPrologue(desktop.remote.desktopId) })
    attempt.catch(() => {})
    await until(() => bleno.calls.includes('disconnect:intruder'), '끊김')
    expect(desktop.remote.status().bluetooth?.links).toBe(0)
    expect(central.write(Uint8Array.of(1, 2, 3))).toBe(0x0e)
    // 다른 데스크탑의 프롤로그(desktopId)도 마찬가지
    const other = bleno.central('other-desk')
    other.subscribe()
    const identity = await desktop.remote.noiseIdentity()
    void secureInitiator(other.link, identity.publicKey, { prologue: bluetoothPrologue('someone-else') }).catch(() => {})
    await until(() => bleno.calls.includes('disconnect:other-desk'), '프롤로그 불일치로 끊김')
  })

  it('되밀림 중에는 진행 이벤트를 최신 하나로 합친다 — notify 신호가 없는 플랫폼(Mac·Windows)은 속도 상한으로 조인다', async () => {
    expect(BLUETOOTH_PACE_BYTES_PER_SECOND).toBeGreaterThan(0)
    const desktop = await start({ noiseKeyFile: noiseKeyFile() })
    const bleno = new FakeBleno()
    bleno.autoNotify = false
    await bluetooth(desktop, bleno, { paceBytesPerSecond: 200_000 })
    await until(() => desktop.remote.status().bluetooth?.state === 'advertising', '광고')
    const { token } = await desktop.pair()
    await desktop.save('c1')
    const { central, phone } = await connect(desktop, bleno, 'slow', 247)
    await phone.send(FRAME.OPEN, 1, { method: 'GET', path: '/v1/events', headers: { authorization: `Bearer ${token}` } })
    await until(() => desktop.remote.status().devices[0]?.connected === true, '연결')

    await desktop.ctx.chat.send('c1', { text: 'go' })
    const call = await desktop.turn(1)
    let answer = ''
    let emitted = 0
    for (let step = 1; step <= 300; step++) {
      answer += `${step} 번째 줄입니다. 답이 조금씩 자랍니다 — the answer keeps growing.\n`
      const item = { kind: 'text' as const, id: 'txt_1', text: answer, done: step === 300 }
      emitted += JSON.stringify(item).length
      call.progress(item)
      if (step % 50 === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    }
    call.finish()
    await until(() => parseFrames(phone.stream(1)).some((frame) => frame.event === 'turn.ended'), 'turn.ended')
    const progress = parseFrames(phone.stream(1)).filter((frame) => frame.event === 'turn.progress')
    expect(progress.length).toBeLessThan(60)
    expect(progress.at(-1)!.data.item).toEqual({ kind: 'text', id: 'txt_1', text: answer, done: true })
    expect(central.notifications.every((size) => size <= 244)).toBe(true)
    expect(central.notifications.reduce((sum, size) => sum + size, 0)).toBeLessThan(emitted / 10)
  })

  it('토글을 끄면(플러그인을 내리면) 붙어 있던 폰을 끊고, 남은 타이머·리스너가 없다', async () => {
    const desktop = await start({ http: false, noiseKeyFile: noiseKeyFile() })
    const bleno = new FakeBleno()
    const { fiber } = await bluetooth(desktop, bleno, { handshakeTimeoutMs: 60 })
    await until(() => desktop.remote.status().bluetooth?.state === 'advertising', '광고')
    const { central } = await connect(desktop, bleno, 'phone')
    const waiting = bleno.central('handshaking') // 핸드셰이크 중 — 시간 제한 타이머가 걸려 있다
    waiting.subscribe()
    await until(() => desktop.remote.status().bluetooth?.links === 1, '연결')

    await fiber.dispose()
    await desktop.remote.ready()
    expect(central.closed()).toBe(true)
    expect(waiting.closed()).toBe(true)
    expect(bleno.listening()).toBe(0)
    const after = bleno.calls.length
    await new Promise((resolve) => setTimeout(resolve, 120)) // 핸드셰이크 제한 시간이 지나도 아무 일도 없다 (타이머가 걷혔다)
    expect(bleno.calls.length).toBe(after)
    // 내린 뒤에 온 쓰기·구독은 받지 않는다
    expect(central.write(Uint8Array.of(1))).toBe(0x0e)
  })
})

describe('짝짓기 응답·QR 의 bluetoothKey', () => {
  it('블루투스가 켜져 있을 때만 싣는다 — 꺼져 있으면 키 파일도 만들지 않는다', async () => {
    const desktop = await start({ noiseKeyFile: noiseKeyFile(), tls: { addresses: () => ['127.0.0.1'], allowPeer: () => true } })
    const without = await desktop.pair('first')
    expect('bluetoothKey' in without).toBe(false)
    expect(parsePairUri(desktop.remote.startPairing().pairing!.uri!)!.bluetoothKey).toBeUndefined()
    desktop.remote.cancelPairing()
    await expect(fs.stat(noiseKeyFile())).rejects.toThrow()

    const { fiber } = await bluetooth(desktop, new FakeBleno())
    const identity = await desktop.remote.noiseIdentity()
    const withKey = await desktop.pair('second')
    expect(withKey.bluetoothKey).toBe(identity.publicKeyText)
    expect(parsePairUri(desktop.remote.startPairing().pairing!.uri!)!.bluetoothKey).toBe(identity.publicKeyText)
    desktop.remote.cancelPairing()

    await fiber.dispose()
    await desktop.remote.ready()
    expect('bluetoothKey' in (await desktop.pair('third'))).toBe(false)
  })
})

describe('블루투스 단독 QR — 사내망이 꺼져 있어도 블루투스가 켜져 있으면 (이슈 #229)', () => {
  it('사내망(TLS) 끔 + 블루투스 켬 → QR 이 있다: a·fp 없이 d·c·x·bk', async () => {
    const desktop = await start({ noiseKeyFile: noiseKeyFile() }) // 평문 루프백(에뮬레이터용)만 — 사내망 연결 꺼짐
    expect(desktop.remote.startPairing().pairing!.uri).toBeUndefined() // 블루투스도 꺼져 있으면 지금처럼 없다
    desktop.remote.cancelPairing()

    await bluetooth(desktop, new FakeBleno())
    const identity = await desktop.remote.noiseIdentity()
    const pairing = desktop.remote.startPairing().pairing!
    expect(pairing.uri).toBeDefined()
    const link = parsePairUri(pairing.uri!)!
    expect(link).toEqual({ version: 1, desktopId: desktop.remote.desktopId, name: 'test-pc', addresses: [], code: pairing.code.replace(/-/g, ''), expiresAt: Math.floor(pairing.expiresAt / 1000), bluetoothKey: identity.publicKeyText })
    expect(pairing.uri).not.toContain('&a=')
    expect(pairing.uri).not.toContain('&fp=')
  })

  it('블루투스만 떠 있어도(HTTP 운반 없음) 짝짓기를 시작할 수 있고 QR 이 나온다 — 키는 짝짓기를 시작할 때 처음 읽고 QR 을 다시 알린다 (이슈 #268)', async () => {
    const desktop = await start({ http: false, noiseKeyFile: noiseKeyFile() })
    await bluetooth(desktop, new FakeBleno())
    await until(() => desktop.remote.status().bluetooth?.state === 'advertising', '광고')
    await expect(fs.stat(noiseKeyFile())).rejects.toThrow() // 광고까지는 키를 읽지 않았다
    const changed: (string | undefined)[] = []
    desktop.ctx.on('remote/changed', (status) => void changed.push(status.pairing?.uri))
    expect(desktop.remote.startPairing().pairing).toBeDefined()
    await until(() => desktop.remote.status().pairing?.uri !== undefined, 'QR')
    expect(changed.at(-1)).toBe(desktop.remote.status().pairing!.uri) // 화면에 알렸다
    expect(parsePairUri(desktop.remote.status().pairing!.uri!)).toMatchObject({ addresses: [], bluetoothKey: (await desktop.remote.noiseIdentity()).publicKeyText })
    await fs.stat(noiseKeyFile())
  })

  it('사내망·블루투스 둘 다 켜져 있으면 한 장에 둘 다', async () => {
    const desktop = await start({ noiseKeyFile: noiseKeyFile(), tls: { addresses: () => ['127.0.0.1'], allowPeer: () => true } })
    await bluetooth(desktop, new FakeBleno())
    desktop.remote.startPairing()
    await until(() => !!desktop.remote.status().pairing?.uri && parsePairUri(desktop.remote.status().pairing!.uri!)!.bluetoothKey !== undefined, 'QR 의 bk')
    const link = parsePairUri(desktop.remote.status().pairing!.uri!)!
    expect(link.fingerprint).toBe(desktop.remote.status().fingerprint)
    expect(link.addresses.length).toBeGreaterThan(0)
    expect(link.bluetoothKey).toBe((await desktop.remote.noiseIdentity()).publicKeyText)
  })
})

describe('hello 의 bluetoothKey — Wi-Fi 로 짝지은 폰이 키를 배운다 (이슈 #229)', () => {
  it('블루투스가 켜져 있으면 hello 에 공개키, 꺼져 있으면 필드가 없다', async () => {
    const desktop = await start({ noiseKeyFile: noiseKeyFile() })
    const { token } = await desktop.pair()
    const before = await desktop.api('GET', '/v1/hello', { token })
    expect(before.status).toBe(200)
    expect('bluetoothKey' in before.body).toBe(false)

    const { fiber } = await bluetooth(desktop, new FakeBleno())
    // 아직 아무도 키를 읽지 않았다 — hello 가 읽어서 싣는다 (이슈 #268)
    const learned = (await desktop.api('GET', '/v1/hello', { token })).body.bluetoothKey
    expect(learned).toBe((await desktop.remote.noiseIdentity()).publicKeyText)

    await fiber.dispose()
    await desktop.remote.ready()
    expect('bluetoothKey' in (await desktop.api('GET', '/v1/hello', { token })).body).toBe(false)
  })
})
