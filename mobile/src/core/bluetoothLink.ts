// 블루투스 운반의 폰 쪽 (이슈 #211, 설계 _workspace/01ab_mobile_bluetooth.md 3·5절) — 데스크탑(주변기기, 광고)을 찾아 붙어 `/v1` 을 싣는다.
//
//   BleDriver(라디오) ─▶ BLE 링크(ByteLink, 조각 ≤ MTU−3) ─▶ Noise NK(secureInitiator, shared/noiseRecord.ts) ─▶ FramedTransport(framed.ts)
//
// 흐름: 권한·어댑터 확인 → 서비스 UUID(desktopId 에서 나온다) 필터 스캔(기한 있음 — 주소는 기억하지 않는다: macOS 의 BLE 주소는 바뀔 수 있다)
//       → 연결 → MTU 517 요청 → 연결 우선순위 high → tx 알림 구독 → rx 에 write-without-response(쓰기가 끝나야 다음 조각) → 핸드셰이크 → 프레임 운반.
// 링크가 끊기면 위 계층 상태(Noise·프레임)는 다 버린다. 다시 붙는 것은 Connection 의 재연결(지수 백오프)이 hello 를 부를 때 — 그때 이 흐름을 처음부터 한다.
// 라디오를 아는 것은 BleDriver 하나다: 앱은 react-native-ble-manager 로(app/bleManagerDriver.ts), 시험은 메모리 가짜로 만든다. 여기는 순수 TS.

import { BLUETOOTH_DEFAULT_CHUNK, BLUETOOTH_HANDSHAKE_TIMEOUT_MS, BLUETOOTH_REQUESTED_MTU, BLUETOOTH_RX_UUID, BLUETOOTH_TX_UUID, bluetoothServiceUuid } from '../../../shared/bluetooth.ts'
import { bluetoothPrologue, decodeNoiseKey } from '../../../shared/noiseNK.ts'
import { secureInitiator } from '../../../shared/noiseRecord.ts'
import type { ByteLink } from '../../../shared/remoteFraming.ts'
import { createFramedTransport, type FramedTransport } from './framed.ts'
import type { Transport } from './transport.ts'

/** 데스크탑을 찾는 스캔의 기한 */
export const BLUETOOTH_SCAN_TIMEOUT_MS = 10_000
/** ATT 머리 — 한 번에 실을 수 있는 바이트 = MTU − 3 */
const ATT_HEADER = 3

/**
 * 블루투스로 붙지 못한 사유 — 화면이 각각 다른 문구로 안내한다 (strings.ts bluetoothFailure).
 * no-key: 블루투스 키(QR 의 bk)나 데스크탑 id 가 없다 — QR 로 다시 짝지어야 한다 · unsupported: 이 폰에 BLE 가 없다 ·
 * permission: "근처 기기"(API 30 이하는 위치) 권한이 없다 · bluetooth-off: 폰의 블루투스가 꺼져 있다 ·
 * not-found: 기한 안에 데스크탑의 광고를 못 찾았다 · location-off: 못 찾았고 Android 11 이하다(위치가 꺼져 있으면 스캔 결과가 안 온다 — 꺼졌는지 직접은 못 본다) ·
 * connect-failed: 찾았지만 연결·서비스 찾기·알림 구독이 안 됐다 · handshake-failed: 붙었지만 보안 채널을 못 맺었다(키가 다르다 — 데스크탑 키가 바뀌었다 — 또는 도중에 끊김)
 */
export type BluetoothFailure = 'no-key' | 'unsupported' | 'permission' | 'bluetooth-off' | 'not-found' | 'location-off' | 'connect-failed' | 'handshake-failed'

/** 사람이 무엇을 해야 풀리는 사유 — 저절로 다시 시도하지 않는다(권한 창을 되풀이해 띄우지 않는다). 사용자가 [다시 시도] 를 누를 때까지 멈춘다 */
const NEEDS_USER: readonly BluetoothFailure[] = ['no-key', 'unsupported', 'permission', 'bluetooth-off']

export class BluetoothError extends Error {
  readonly reason: BluetoothFailure
  constructor(reason: BluetoothFailure, message: string = reason, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'BluetoothError'
    this.reason = reason
  }

  get needsUser(): boolean {
    return NEEDS_USER.includes(this.reason)
  }
}

/** 라디오 — react-native-ble-manager 를 감싼 것(앱)과 메모리 가짜(시험). 실패는 아무 오류나 던져도 된다(prepare 만 BluetoothError 로 사유를 준다) */
export interface BleDriver {
  /** 권한을 묻고 어댑터를 본다. 안 되면 BluetoothError(permission · bluetooth-off · unsupported) */
  prepare(): Promise<void>
  /** 이 서비스 UUID 를 광고하는 기기를 찾아 그 id 를. 기한 안에 못 찾으면 undefined */
  scan(serviceUuid: string, timeoutMs: number): Promise<string | undefined>
  /** 연결하고 서비스를 찾아 둔다 (그래야 쓰기·구독이 된다) */
  connect(deviceId: string, serviceUuid: string): Promise<void>
  /** 협상된 MTU */
  requestMtu(deviceId: string, mtu: number): Promise<number>
  requestHighPriority(deviceId: string): Promise<void>
  subscribe(deviceId: string, serviceUuid: string, characteristicUuid: string, onValue: (bytes: Uint8Array) => void): Promise<void>
  /** write without response — 조각 하나. 풀리면 다음 조각을 써도 된다 */
  write(deviceId: string, serviceUuid: string, characteristicUuid: string, bytes: Uint8Array): Promise<void>
  /** 상대가 끊었다(멀어졌다·데스크탑이 껐다). 돌려준 함수로 그만 듣는다 */
  onDisconnect(deviceId: string, listener: () => void): () => void
  disconnect(deviceId: string): Promise<void>
}

export interface BleLink extends ByteLink {
  /** 협상된 MTU */
  readonly mtu: number
}

/** 찾아 붙어 날 링크(rx/tx)를 연다 — 아직 암호화 전이다 */
export async function openBleLink(
  driver: BleDriver,
  options: { serviceUuid: string; scanTimeoutMs?: number; legacyLocation?: boolean; onReceived?(bytes: number): void },
): Promise<BleLink> {
  const { serviceUuid } = options
  const deviceId = await driver.scan(serviceUuid, options.scanTimeoutMs ?? BLUETOOTH_SCAN_TIMEOUT_MS)
  if (deviceId === undefined) throw new BluetoothError(options.legacyLocation ? 'location-off' : 'not-found', 'desktop not found')

  const dataListeners: ((chunk: Uint8Array) => void)[] = []
  const closeListeners: ((error?: unknown) => void)[] = []
  /** 위층이 듣기 전에 온 알림 */
  let early: Uint8Array[] = []
  let closed = false
  let offDisconnect = (): void => {}
  const finish = (error?: unknown): void => {
    if (closed) return
    closed = true
    offDisconnect()
    for (const listener of closeListeners) listener(error)
  }

  let mtu: number
  try {
    offDisconnect = driver.onDisconnect(deviceId, () => finish(new Error('bluetooth link lost')))
    await driver.connect(deviceId, serviceUuid)
    // 협상이 안 되면 기본 MTU(23) — 조각이 20바이트로 줄 뿐 된다
    mtu = await driver.requestMtu(deviceId, BLUETOOTH_REQUESTED_MTU).catch(() => BLUETOOTH_DEFAULT_CHUNK + ATT_HEADER)
    await driver.requestHighPriority(deviceId).catch(() => undefined)
    await driver.subscribe(deviceId, serviceUuid, BLUETOOTH_TX_UUID, (chunk) => {
      if (closed) return
      options.onReceived?.(chunk.length)
      if (dataListeners.length === 0) early.push(chunk)
      else for (const listener of dataListeners) listener(chunk)
    })
  } catch (error) {
    offDisconnect()
    void driver.disconnect(deviceId).catch(() => undefined)
    throw new BluetoothError('connect-failed', `could not connect: ${String((error as Error)?.message ?? error)}`, { cause: error })
  }
  if (closed) throw new BluetoothError('connect-failed', 'disconnected while connecting')

  const maxChunk = Math.max(BLUETOOTH_DEFAULT_CHUNK, mtu - ATT_HEADER)
  /** 쓰기를 한 줄로 — 앞 조각의 쓰기가 끝나야 다음 조각 */
  let tail: Promise<void> = Promise.resolve()
  return {
    mtu,
    maxChunk,
    send(chunk) {
      if (closed) return Promise.reject(new Error('link closed'))
      if (chunk.length > maxChunk) return Promise.reject(new Error(`chunk ${chunk.length} > maxChunk ${maxChunk}`))
      const copy = chunk.slice()
      const sent = tail.then(async () => {
        if (closed) throw new Error('link closed')
        try {
          await driver.write(deviceId, serviceUuid, BLUETOOTH_RX_UUID, copy)
        } catch (error) {
          // 쓰기가 안 되면 링크는 죽은 것이다 — 끊고 위층이 다시 붙게 한다
          finish(error)
          void driver.disconnect(deviceId).catch(() => undefined)
          throw error
        }
      })
      tail = sent.catch(() => {})
      return sent
    },
    onData(listener) {
      dataListeners.push(listener)
      const waiting = early
      early = []
      for (const chunk of waiting) listener(chunk)
    },
    onClose(listener) {
      closeListeners.push(listener)
    },
    close() {
      if (closed) return
      finish()
      void driver.disconnect(deviceId).catch(() => undefined)
    },
  }
}

export interface BluetoothTarget {
  /** QR 의 `d` (hello.desktopId) — 서비스 UUID 와 Noise 프롤로그가 여기서 나온다 */
  desktopId?: string
  /** QR 의 `bk` 또는 짝짓기 응답의 bluetoothKey (base64url 43자) */
  bluetoothKey?: string
}

/** 찾아 붙고 보안 채널을 맺어 프레임 운반을 돌려준다. 실패는 늘 BluetoothError */
export async function connectBluetooth(
  driver: BleDriver,
  target: BluetoothTarget,
  options: { scanTimeoutMs?: number; handshakeTimeoutMs?: number; legacyLocation?: boolean; onReceived?(bytes: number): void } = {},
): Promise<FramedTransport> {
  const key = target.bluetoothKey === undefined ? undefined : decodeNoiseKey(target.bluetoothKey)
  // 키가 없으면 라디오를 건드리지 않는다
  if (!key || !target.desktopId) throw new BluetoothError('no-key', 'no bluetooth key — pair again with the QR')
  const { desktopId } = target
  try {
    await driver.prepare()
  } catch (error) {
    throw error instanceof BluetoothError ? error : new BluetoothError('unsupported', String((error as Error)?.message ?? error), { cause: error })
  }
  const link = await openBleLink(driver, { serviceUuid: bluetoothServiceUuid(desktopId), scanTimeoutMs: options.scanTimeoutMs, legacyLocation: options.legacyLocation, onReceived: options.onReceived })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const secure = await Promise.race([
      secureInitiator(link, key, { prologue: bluetoothPrologue(desktopId) }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('handshake timed out')), options.handshakeTimeoutMs ?? BLUETOOTH_HANDSHAKE_TIMEOUT_MS)
      }),
    ])
    return createFramedTransport(secure)
  } catch (error) {
    // 틀린 키면 데스크탑이 메시지 1 을 못 풀고 끊는다 — 폰에는 "핸드셰이크 중 끊김" 으로 보인다
    link.close()
    throw new BluetoothError('handshake-failed', `secure channel failed: ${String((error as Error)?.message ?? error)}`, { cause: error })
  } finally {
    clearTimeout(timer)
  }
}

export interface BluetoothTransport extends Transport {
  /** 지금까지 링크로 받은 바이트(암호문·압축 그대로) — 긴 대화를 받는 진행 표시에 쓴다 */
  readonly receivedBytes: number
  /** 지금 링크를 끊고 더 열지 않는다 (세션을 거둘 때·길을 바꿀 때) */
  close(): void
}

/**
 * 링크를 그때그때 여는 운반 — 요청·스트림이 오면 열린 링크를 쓰고, 없거나 끊겼으면 새로 연다(동시에 와도 한 번만).
 * 여는 데 실패하면 그 요청·스트림이 그 오류(BluetoothError)로 실패한다 → Connection 이 사유를 보고 백오프하거나 멈춘다.
 */
export function createBluetoothTransport(open: (onReceived: (bytes: number) => void) => Promise<FramedTransport>): BluetoothTransport {
  let current: FramedTransport | undefined
  let opening: Promise<FramedTransport> | undefined
  let disposed = false
  let received = 0
  const count = (bytes: number): void => void (received += bytes)

  const ensure = (): Promise<FramedTransport> => {
    if (disposed) return Promise.reject(new Error('transport closed'))
    if (current && !current.closed) return Promise.resolve(current)
    opening ??= open(count).then(
      (transport) => {
        opening = undefined
        if (disposed) {
          transport.close()
          throw new Error('transport closed')
        }
        current = transport
        return transport
      },
      (error: unknown) => {
        opening = undefined
        throw error
      },
    )
    return opening
  }

  return {
    get receivedBytes() {
      return received
    },
    request: (request) => ensure().then((transport) => transport.request(request)),
    stream(request, handlers) {
      let closed = false
      let close: (() => void) | undefined
      ensure().then(
        (transport) => {
          if (!closed) close = transport.stream(request, handlers)
        },
        (error: unknown) => {
          if (!closed) handlers.onEnd(error)
        },
      )
      return () => {
        closed = true
        close?.()
      }
    },
    close() {
      disposed = true
      current?.close()
      current = undefined
    },
  }
}
