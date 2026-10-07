import type { Context } from 'cordis'
import {
  BLUETOOTH_DEFAULT_CHUNK,
  BLUETOOTH_HANDSHAKE_TIMEOUT_MS,
  BLUETOOTH_MAX_CENTRALS,
  BLUETOOTH_REQUESTED_MTU,
  BLUETOOTH_RX_UUID,
  BLUETOOTH_TX_UUID,
  bluetoothServiceUuid,
} from '../../../shared/bluetooth.ts'
import { bluetoothPrologue } from '../../../shared/noiseNK.ts'
import { secureResponder } from '../../../shared/noiseRecord.ts'
import type { ByteLink } from '../../../shared/remoteFraming.ts'
import type { RemoteService } from '../remote.ts'
import type { FeatureReason } from '../../../shared/features.ts'
import { BLUETOOTH_CARRIER, type RemoteCarrierStatus, type RemoteRadioState, type RemoteRadioStatus } from './carrier.ts'
import { serveFramed, type FramedServer } from './framed.ts'
import type { NoiseIdentity } from './noiseIdentity.ts'

// 블루투스 운반 (이슈 #210, 설계 _workspace/01ab_mobile_bluetooth.md 5절) — ctx.remote 밑의 운반 플러그인이다(`inject: ['remote']`, 자기 ctx 키 없음).
// 기능 `bluetooth`(기본 꺼짐)의 묶음이라 토글이 곧 이 플러그인의 올리고 내리기다: 내리면 광고를 멈추고 붙어 있던 폰을 끊는다.
// 데스크탑이 BLE 주변기기(광고하는 쪽)다. 링크는 GATT 서비스 하나(UUID 는 desktopId 에서 — shared/bluetooth.ts) + 특성 둘:
//   rx (폰 → PC, write without response) ── 받은 바이트 ──▶ CentralLink ─▶ Noise NK 응답자(secureResponder) ─▶ FrameChannel(serveFramed) ─▶ ctx.remote.handle
//   tx (PC → 폰, notify)                 ◀── MTU−3 조각 ──┘
// - 네이티브 모듈(@stoprocent/bleno)은 **켤 때(start) 처음 읽는다** — 블루투스를 안 쓰는 사용자는 로드도 권한 창도 없다. 읽지 못하면(이 PC 의 플랫폼에
//   프리빌드가 없다 등) 상태 줄에 사유만 남고 ctx.remote·HTTP 는 그대로다. 읽는 수단은 load 로 받는다 — 테스트가 가짜를 넣는다.
// - 광고에는 서비스 UUID 하나만 싣는다(PC 이름 없음 — 이름 칸은 빈 글).
// - 믿음은 전부 Noise 에서 만든다: 링크는 평문이고 누구나 붙을 수 있다. 폰 최대 2대(셋째부터는 붙자마자 끊는다), 핸드셰이크 10초 제한.
//   틀린 키·변조·규칙 위반은 SecureLink/FrameChannel 이 링크를 닫고, 그러면 여기서 그 연결을 끊는다.
// - 되밀림: 알림 조각 하나를 보내고 다음 조각은 (a) 그 연결의 notify 신호가 오거나 (b) 조각 크기만큼 속도 상한(paceBytesPerSecond)의 시간이 지난 뒤에
//   보낸다. 그동안 위층의 보내기가 안 풀려 ctx.remote 의 스트림 큐가 진행 이벤트를 최신 하나로 합친다(remote/streamQueue.ts).
//   bleno 의 notify 신호는 Linux(HCI)에서만 온다 — macOS·Windows 는 네이티브가 알림을 자기 큐에 쌓고 신호를 주지 않는다(0.13.1 소스 확인).
//   그래서 Mac·Windows 에서는 (b) 가 실제 되밀림이다 — 속도 상한은 실측 전 값이다(설계 4절 "나쁨 20 KB/s·보통 50 KB/s" 사이).
// - 끊김 신호: Windows·Linux 는 disconnect, macOS 는 없다(CoreBluetooth 주변기기는 연결 끊김을 알리지 않는다) — tx 구독 해제를 끊김으로 본다.
//   우리가 끊는 것(bleno.disconnect)도 macOS 에서는 효과가 없다: 그 연결의 쓰기를 무시하고, 폰이 구독을 풀면(끊고 다시 붙으면) 새로 받는다.

/** 링크가 위층에 알리는 한 번에 받는 크기 — 실제 알림 조각은 이것을 다시 그 연결의 MTU−3 으로 나눈다(조각 크기가 연결 중에 바뀌어도 위층은 모른다) */
const LINK_CHUNK = BLUETOOTH_REQUESTED_MTU - 3
/** 되밀림 신호가 없는 플랫폼(macOS·Windows)의 보내기 속도 상한 — 실측 전 값 (설계 4절) */
export const BLUETOOTH_PACE_BYTES_PER_SECOND = 24_000

const RESULT_SUCCESS = 0x00
const RESULT_UNLIKELY_ERROR = 0x0e

type Handle = string | number
type Listener = (...args: any[]) => void

/** @stoprocent/bleno 에서 쓰는 것만 (기본 내보내기 = Bleno 인스턴스) */
export interface BlenoLike {
  readonly state: string
  Characteristic: new (options: BlenoCharacteristicOptions) => object
  PrimaryService: new (options: { uuid: string; characteristics: object[] }) => object
  on(event: string, listener: Listener): unknown
  removeListener(event: string, listener: Listener): unknown
  setServices(services: object[], callback: (error?: Error | null) => void): void
  startAdvertising(name: string, serviceUuids: string[], callback: (error?: Error | null) => void): void
  stopAdvertising(callback?: () => void): void
  disconnect(handle?: Handle | null): void
  stop(): void
}

export interface BlenoCharacteristicOptions {
  uuid: string
  properties: string[]
  onWriteRequest?: (handle: Handle, data: Buffer, offset: number, withoutResponse: boolean, callback: (result: number) => void) => void
  onSubscribe?: (handle: Handle, maxValueSize: number, updateValueCallback: (data: Buffer) => void) => void
  onUnsubscribe?: (handle: Handle) => void
  onNotify?: (handle: Handle) => void
}

export interface RemoteBluetoothOptions {
  /** 네이티브 모듈을 읽는다 — 앱은 `import('@stoprocent/bleno')`, 테스트는 가짜. 켤 때 처음 부른다 */
  load(): Promise<BlenoLike>
  /** 기본 10초 (BLUETOOTH_HANDSHAKE_TIMEOUT_MS) */
  handshakeTimeoutMs?: number
  /** 기본 BLUETOOTH_PACE_BYTES_PER_SECOND */
  paceBytesPerSecond?: number
}

/** 설정 > 기능의 블루투스 연결 줄에 보일 문제 (이슈 #224, ctx.features.problem) — 설정 > 모바일 상태 줄과 같은 문구. 켜는 중·광고 중은 문제가 아니다 */
export function bluetoothProblem(radio: RemoteRadioStatus | undefined): FeatureReason | undefined {
  switch (radio?.state) {
    case 'poweredOff':
      return { key: 'remote.bluetooth.poweredOff' }
    case 'unauthorized':
      return { key: 'remote.bluetooth.unauthorized' }
    case 'unsupported':
      return radio.reason ? { key: 'remote.bluetooth.unsupportedReason', vars: { reason: radio.reason } } : { key: 'remote.bluetooth.unsupported' }
    case 'failed':
      return { key: 'remote.bluetooth.failed', vars: { reason: radio.reason ?? '' } }
    default:
      return undefined
  }
}

export function RemoteBluetooth(ctx: Context, options: RemoteBluetoothOptions): void {
  const remote = ctx.remote // 내려가는 중엔 ctx.remote 를 못 꺼낸다 — 올라올 때 쥔다
  const carrier = new BluetoothCarrier(remote, options)
  ctx.effect(() =>
    remote.carrier({
      id: BLUETOOTH_CARRIER,
      start: () => carrier.start(),
      stop: () => carrier.stop(),
      status: () => carrier.status(),
    }),
  )
}
RemoteBluetooth.inject = ['remote']

interface Connection {
  key: string
  handle: Handle
  link: CentralLink
  timer?: ReturnType<typeof setTimeout>
  server?: FramedServer
}

class BluetoothCarrier {
  private bleno?: BlenoLike
  private identity?: NoiseIdentity
  private state: RemoteRadioState = 'starting'
  private reason?: string
  private running = false
  /** 켜고 끌 때마다 바뀐다 — 끈 뒤에 도착한 콜백을 버린다 */
  private generation = 0
  /** stateChange 를 걸었다(= 네이티브가 초기화됐다) — 끌 때 bleno.stop() 을 부를지 */
  private attached = false
  private advertisingRequested = false
  private connections = new Map<string, Connection>()
  /** 우리가 끊은(또는 받지 않은) 연결 — 폰이 구독을 풀거나 끊을 때까지 쓰기를 무시한다 (macOS 는 우리가 끊을 수 없다) */
  private refused = new Set<string>()
  private listeners: [string, Listener][] = []

  constructor(
    private remote: RemoteService,
    private options: RemoteBluetoothOptions,
  ) {}

  status(): RemoteCarrierStatus {
    const links = [...this.connections.values()].filter((connection) => connection.server).length
    return { up: this.running && this.state === 'advertising', addresses: [], radio: { state: this.state, ...(this.reason && { reason: this.reason }), links } }
  }

  /** ctx.remote 가 운반을 띄울 때 — 띄우지 못했어도 다시 부를 수 있다(이미 돌고 있으면 그대로) */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    const generation = ++this.generation
    this.state = 'starting'
    this.reason = undefined
    let bleno: BlenoLike
    try {
      bleno = await this.options.load()
    } catch (error) {
      if (generation === this.generation) this.fail('unsupported', error)
      return
    }
    let identity: NoiseIdentity
    try {
      identity = await this.remote.noiseIdentity()
    } catch (error) {
      if (generation === this.generation) this.fail('failed', error)
      return
    }
    if (generation !== this.generation) return // 기다리는 사이 껐다
    this.bleno = bleno
    this.identity = identity
    const serviceUuid = bluetoothServiceUuid(this.remote.desktopId)
    const prologue = bluetoothPrologue(this.remote.desktopId)

    const rx = new bleno.Characteristic({
      uuid: BLUETOOTH_RX_UUID,
      properties: ['writeWithoutResponse'],
      onWriteRequest: (handle, data, _offset, _withoutResponse, callback) => {
        const connection = this.begin(handle, prologue)
        callback(connection ? RESULT_SUCCESS : RESULT_UNLIKELY_ERROR)
        connection?.link.receive(new Uint8Array(data))
      },
    })
    const tx = new bleno.Characteristic({
      uuid: BLUETOOTH_TX_UUID,
      properties: ['notify'],
      onSubscribe: (handle, maxValueSize, update) => this.begin(handle, prologue)?.link.attach(maxValueSize, update),
      onUnsubscribe: (handle) => this.end(handle),
      onNotify: (handle) => this.connections.get(String(handle))?.link.notified(),
    })
    const service = new bleno.PrimaryService({ uuid: serviceUuid, characteristics: [rx, tx] })

    const onState = (state: string): void => {
      if (generation !== this.generation) return
      if (state !== 'poweredOn') {
        this.advertisingRequested = false
        this.state = state === 'poweredOff' ? 'poweredOff' : state === 'unauthorized' ? 'unauthorized' : state === 'unsupported' ? 'unsupported' : 'starting'
        this.reason = undefined
        for (const key of [...this.connections.keys()]) this.end(key) // 라디오가 사라졌다 — 붙어 있던 것은 끊겼다
        return this.remote.carrierChanged()
      }
      if (this.advertisingRequested) return
      this.advertisingRequested = true
      bleno.setServices([service], (error) => {
        if (generation !== this.generation) return
        if (error) return this.fail('unsupported', error)
        // 광고에는 서비스 UUID 하나만 — 이름 칸은 비운다(PC 이름을 근처에 알리지 않는다)
        bleno.startAdvertising('', [serviceUuid], (failure) => {
          if (generation !== this.generation) return
          if (failure) return this.fail('unsupported', failure)
          this.state = 'advertising'
          this.reason = undefined
          this.remote.carrierChanged()
        })
      })
    }
    this.listen(bleno, 'stateChange', onState)
    this.listen(bleno, 'accept', (_address: string, handle: Handle) => void this.begin(handle ?? _address, prologue))
    this.listen(bleno, 'disconnect', (_address: string, handle: Handle) => this.end(handle ?? _address))
    this.attached = true // stateChange 를 걸면 bleno 가 네이티브를 초기화한다 (macOS 는 이때 블루투스 허용을 묻는다)
    if (bleno.state === 'poweredOn') onState('poweredOn')
  }

  /** 광고를 멈추고 붙어 있던 폰을 끊는다. 사유도 지운다 */
  async stop(): Promise<void> {
    this.running = false
    this.generation++
    for (const key of [...this.connections.keys()]) this.drop(key)
    this.refused.clear()
    const bleno = this.bleno
    if (bleno) {
      for (const [event, listener] of this.listeners) bleno.removeListener(event, listener)
      if (this.attached) {
        // 네이티브가 이미 정리됐으면 던진다 (macOS: "BLEManager has already been cleaned up") — 끄는 길이라 삼킨다
        for (const step of [() => bleno.stopAdvertising(), () => bleno.disconnect(), () => bleno.stop()]) {
          try {
            step()
          } catch {}
        }
      }
    }
    this.listeners = []
    this.attached = false
    this.advertisingRequested = false
    this.bleno = undefined
    this.identity = undefined
    this.state = 'starting'
    this.reason = undefined
  }

  private listen(bleno: BlenoLike, event: string, listener: Listener): void {
    this.listeners.push([event, listener])
    bleno.on(event, listener)
  }

  private fail(state: RemoteRadioState, error: unknown): void {
    this.state = state
    this.reason = error instanceof Error ? error.message : String(error)
    this.remote.carrierChanged()
  }

  /** 그 연결을 받는다 (이미 받았으면 그것). 끊은 연결이거나 자리가 없으면 없다 — 자리가 없으면 끊는다 */
  private begin(handle: Handle, prologue: Uint8Array): Connection | undefined {
    const key = String(handle)
    const known = this.connections.get(key)
    if (known) return known
    if (this.refused.has(key) || !this.running || !this.identity) return undefined
    if (this.connections.size >= BLUETOOTH_MAX_CENTRALS) {
      this.refused.add(key)
      this.disconnect(handle)
      return undefined
    }
    const link = new CentralLink(this.options.paceBytesPerSecond ?? BLUETOOTH_PACE_BYTES_PER_SECOND, () => this.drop(key))
    const connection: Connection = { key, handle, link }
    this.connections.set(key, connection)
    connection.timer = setTimeout(() => this.drop(key), this.options.handshakeTimeoutMs ?? BLUETOOTH_HANDSHAKE_TIMEOUT_MS)
    secureResponder(link, this.identity, { prologue }).then(
      (secure) => {
        if (this.connections.get(key) !== connection) return secure.close()
        clearTimeout(connection.timer)
        connection.timer = undefined
        connection.server = serveFramed(secure, this.remote, { carrier: BLUETOOTH_CARRIER, key })
        this.remote.carrierChanged()
      },
      // 틀린 키·깨진 메시지·시간 초과 — SecureLink 가 이미 링크를 닫았다. 같은 열쇠로 새로 붙은 연결은 건드리지 않는다
      () => void (this.connections.get(key) === connection && this.drop(key)),
    )
    return connection
  }

  /** 폰이 떠났다 (구독 해제·끊김) — 그 연결을 거두고, 다시 붙으면 새로 받는다 */
  private end(handle: Handle): void {
    const key = String(handle)
    this.refused.delete(key)
    this.remove(key)
  }

  /** 우리가 끊는다 (시간 초과·규칙 위반·끄기) — 폰이 떠날 때까지 그 연결의 쓰기를 무시한다 */
  private drop(key: string): void {
    const connection = this.connections.get(key)
    if (!connection) return
    if (this.running) this.refused.add(key)
    this.remove(key)
    this.disconnect(connection.handle)
  }

  private remove(key: string): void {
    const connection = this.connections.get(key)
    if (!connection) return
    this.connections.delete(key)
    clearTimeout(connection.timer)
    connection.link.cut()
    if (this.running) this.remote.carrierChanged()
  }

  private disconnect(handle: Handle): void {
    try {
      this.bleno?.disconnect(handle)
    } catch {}
  }
}

/** 폰 하나와의 바이트 링크 — 받은 쓰기를 위로 올리고, 보낼 것을 그 연결의 MTU−3 조각으로 나눠 알림으로 싣는다 (조각마다 되밀림을 기다린다) */
export class CentralLink implements ByteLink {
  readonly maxChunk = LINK_CHUNK
  private notifySize = BLUETOOTH_DEFAULT_CHUNK
  private update?: (data: Buffer) => void
  private subscribed: { promise: Promise<void>; resolve(): void; reject(error: Error): void }
  private pending?: { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  private sending: Promise<void> = Promise.resolve()
  private dataListeners: ((chunk: Uint8Array) => void)[] = []
  private closeListeners: ((error?: unknown) => void)[] = []
  private done = false

  constructor(
    private paceBytesPerSecond: number,
    /** 위층이 링크를 닫았다 (close) — 운반이 그 연결을 끊는다 */
    private onLocalClose: () => void,
  ) {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((ok, fail) => {
      resolve = ok
      reject = fail
    })
    promise.catch(() => {})
    this.subscribed = { promise, resolve, reject }
  }

  /** 폰이 tx 를 구독했다 — 그 연결의 한 번에 실을 수 있는 크기(MTU−3)와 알림 보내기 */
  attach(maxValueSize: number, update: (data: Buffer) => void): void {
    if (this.done) return
    this.notifySize = maxValueSize > 0 ? maxValueSize : BLUETOOTH_DEFAULT_CHUNK
    this.update = update
    this.subscribed.resolve()
  }

  /** 이 연결로 알림 하나가 나갔다 (Linux 만 온다) */
  notified(): void {
    const pending = this.pending
    if (!pending) return
    this.pending = undefined
    clearTimeout(pending.timer)
    pending.resolve()
  }

  receive(chunk: Uint8Array): void {
    if (this.done) return
    for (const listener of this.dataListeners) listener(chunk)
  }

  send(chunk: Uint8Array): Promise<void> {
    if (this.done) return Promise.reject(new Error('link closed'))
    const data = Buffer.from(chunk) // 복사 — 위층이 버퍼를 다시 쓴다
    const next = this.sending.then(async () => {
      await this.subscribed.promise
      let at = 0
      while (at < data.length) {
        if (this.done) throw new Error('link closed')
        const size = this.notifySize
        const piece = data.subarray(at, at + size)
        this.update!(piece)
        await this.sent(piece.length)
        at += size
      }
    })
    this.sending = next.catch(() => {})
    return next
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.dataListeners.push(listener)
  }

  onClose(listener: (error?: unknown) => void): void {
    if (this.done) listener()
    else this.closeListeners.push(listener)
  }

  close(): void {
    if (this.done) return
    this.onLocalClose()
  }

  /** 링크가 끝났다 (어느 쪽이든) — 기다리던 보내기를 거두고 위에 알린다. 한 번 */
  cut(): void {
    if (this.done) return
    this.done = true
    const error = new Error('link closed')
    this.subscribed.reject(error)
    const pending = this.pending
    this.pending = undefined
    if (pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    for (const listener of this.closeListeners) listener()
    this.closeListeners = []
    this.dataListeners = []
  }

  /** 조각 하나가 나갈 때까지 — notify 신호 또는 속도 상한의 시간 */
  private sent(bytes: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.done) return reject(new Error('link closed'))
      const timer = setTimeout(() => this.notified(), (bytes / this.paceBytesPerSecond) * 1000)
      this.pending = { resolve, reject, timer }
    })
  }
}
