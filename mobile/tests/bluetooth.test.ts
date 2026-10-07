import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BLUETOOTH_RX_UUID, BLUETOOTH_TX_UUID, bluetoothServiceUuid } from '../../shared/bluetooth.ts'
import type { HistoryMessage } from '../../shared/contract.ts'
import { bluetoothPrologue, encodeNoiseKey, generateNoiseKeyPair, type NoiseKeyPair } from '../../shared/noiseNK.ts'
import { secureResponder } from '../../shared/noiseRecord.ts'
import { FRAME, FrameChannel, utf8, type ByteLink, type FrameMessage } from '../../shared/remoteFraming.ts'
import { confirmCode } from '../../shared/remotePairing.ts'
import { DesktopLink, type CarrierChoice, type DesktopStore, type SavedDesktop } from '../src/app/link.ts'
import { installRandomValues } from '../src/app/randomValues.ts'
import type { AppSession, Carrier } from '../src/app/session.ts'
import { S } from '../src/app/strings.ts'
import { gateView, pairFailureText, showsGate } from '../src/app/view.ts'
import { BluetoothError, connectBluetooth, fflateCodec, NetError, type BleDriver, type PinnedNet, type Transport } from '../src/core/index.ts'
import { until } from './support.ts'

// 블루투스 운반의 폰 쪽 (이슈 #211). 라디오는 쓰지 않는다 — 가짜 BleDriver 가 데스크탑(주변기기) 하나를 메모리로 흉내 낸다:
// 폰의 rx 쓰기 → 데스크탑 쪽 ByteLink 의 데이터, 데스크탑의 send → tx 알림(조각 ≤ MTU−3). 그 데스크탑 쪽에 secureResponder 를 얹고,
// 마지막 묶음은 그 위에 **진짜 ctx.remote**(진짜 ctx.chat·sessions·projects, 엔진만 가짜 — 루트 tests/unit/support/remoteHarness.ts)를 잇는다.

interface FakeBle {
  driver: BleDriver
  /** 드라이버에 들어온 호출 (순서대로) */
  log: string[]
  /** 폰이 rx 에 쓴 조각 길이들 */
  writes: number[]
  /** 데스크탑이 tx 로 알린 조각 길이들 */
  notifies: number[]
  /** 동시에 돈 쓰기의 최대 수 (1 이어야 한다 — 앞 쓰기가 끝나야 다음 조각) */
  maxConcurrentWrites: number
  /** 연결된 횟수 */
  connections: number
  /** 데스크탑이 멀어졌다 — 폰 쪽에 끊김이 온다 */
  dropRemote(): void
  advertising: boolean
}

/** 가짜 라디오 — serve 는 폰이 알림을 구독할 때마다 데스크탑 쪽 링크를 받는다 */
function fakeBle(serviceUuid: string, serve: (desk: ByteLink) => void, options: { mtu?: number | 'fail'; prepare?: () => void; subscribeFails?: boolean } = {}): FakeBle {
  const disconnectListeners = new Set<() => void>()
  let conn: { closed: boolean; notify?: (bytes: Uint8Array) => void; data: ((chunk: Uint8Array) => void)[]; close: ((error?: unknown) => void)[]; maxChunk: number } | undefined
  let writing = 0
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  const cut = (remote: boolean): void => {
    const current = conn
    if (!current || current.closed) return
    current.closed = true
    for (const listener of current.close) listener(remote ? new Error('central gone') : undefined)
    if (remote) for (const listener of [...disconnectListeners]) listener()
  }
  const fake: FakeBle = {
    log: [],
    writes: [],
    notifies: [],
    maxConcurrentWrites: 0,
    connections: 0,
    advertising: true,
    dropRemote: () => cut(true),
    driver: {
      async prepare() {
        fake.log.push('prepare')
        options.prepare?.()
      },
      async scan(uuid) {
        fake.log.push('scan')
        return fake.advertising && uuid === serviceUuid ? 'dev-1' : undefined
      },
      async connect(deviceId, uuid) {
        fake.log.push(`connect ${deviceId}`)
        expect(uuid).toBe(serviceUuid)
        fake.connections += 1
        conn = { closed: false, data: [], close: [], maxChunk: 20 }
      },
      async requestMtu(_deviceId, mtu) {
        fake.log.push(`mtu ${mtu}`)
        if (options.mtu === 'fail') throw new Error('mtu not supported')
        const agreed = options.mtu ?? 185
        conn!.maxChunk = agreed - 3
        return agreed
      },
      async requestHighPriority() {
        fake.log.push('priority')
      },
      async subscribe(_deviceId, _uuid, characteristic, onValue) {
        fake.log.push(`subscribe ${characteristic === BLUETOOTH_TX_UUID ? 'tx' : characteristic}`)
        if (options.subscribeFails) throw new Error('gatt error 133')
        const current = conn!
        current.notify = onValue
        let tail = Promise.resolve()
        serve({
          maxChunk: current.maxChunk,
          send(chunk) {
            if (current.closed) return Promise.reject(new Error('link closed'))
            if (chunk.length > current.maxChunk) throw new Error(`notify ${chunk.length} > ${current.maxChunk}`)
            const copy = chunk.slice()
            const sent = tail.then(async () => {
              await tick()
              if (current.closed) throw new Error('link closed')
              fake.notifies.push(copy.length)
              current.notify!(copy)
            })
            tail = sent.catch(() => {})
            return sent
          },
          onData: (listener) => void current.data.push(listener),
          onClose: (listener) => void current.close.push(listener),
          close: () => cut(true),
        })
      },
      async write(_deviceId, _uuid, characteristic, bytes) {
        expect(characteristic).toBe(BLUETOOTH_RX_UUID)
        const current = conn!
        writing += 1
        fake.maxConcurrentWrites = Math.max(fake.maxConcurrentWrites, writing)
        try {
          await tick()
          if (current.closed) throw new Error('not connected')
          fake.writes.push(bytes.length)
          const copy = bytes.slice()
          for (const listener of current.data) listener(copy)
        } finally {
          writing -= 1
        }
      },
      onDisconnect(_deviceId, listener) {
        disconnectListeners.add(listener)
        return () => disconnectListeners.delete(listener)
      },
      async disconnect() {
        fake.log.push('disconnect')
        cut(false)
      },
    },
  }
  return fake
}

const DESKTOP_ID = 'desk_bt_1'
const SERVICE = bluetoothServiceUuid(DESKTOP_ID)

/** 손으로 쓰는 데스크탑 — 보안 채널을 받고 프레임을 모은다 */
function handDesktop(keys: NoiseKeyPair) {
  const got: FrameMessage[] = []
  const channels: FrameChannel[] = []
  const serve = (desk: ByteLink): void =>
    void secureResponder(desk, keys, { prologue: bluetoothPrologue(DESKTOP_ID) }).then(
      (secure) => void channels.push(new FrameChannel(secure, { codec: fflateCodec, onMessage: (message) => void got.push(message) })),
      () => undefined,
    )
  return { got, channels, serve }
}

describe('블루투스 링크 — 찾기·연결·조각', () => {
  it('UUID 필터 스캔 → 연결 → MTU 517 요청 → 우선순위 → tx 구독 순서. 쓰기는 MTU−3 조각으로 한 번에 하나씩, 큰 알림은 다시 붙는다', async () => {
    const keys = generateNoiseKeyPair()
    const desk = handDesktop(keys)
    const ble = fakeBle(SERVICE, desk.serve, { mtu: 185 })
    const transport = await connectBluetooth(ble.driver, { desktopId: DESKTOP_ID, bluetoothKey: encodeNoiseKey(keys.publicKey) })
    expect(ble.log).toEqual(['prepare', 'scan', 'connect dev-1', 'mtu 517', 'priority', 'subscribe tx'])

    // 폰 → 데스크탑: 압축이 잘 안 되는 12KB 글
    const text = randomBytes(9_000).toString('base64') // 12KB, 잘 안 눌린다
    const answer = transport.request({ method: 'POST', url: 'bt://desk/v1/conversations/c1/messages', body: JSON.stringify({ text }) })
    await until(() => desk.got.some((message) => message.type === FRAME.REQ), 'REQ')
    const request = desk.got.find((message) => message.type === FRAME.REQ)!
    expect(JSON.parse(JSON.parse(utf8.decode(request.body)).body).text).toBe(text)
    expect(Math.max(...ble.writes)).toBeLessThanOrEqual(182)
    expect(ble.writes.length).toBeGreaterThan(9_000 / 182)
    expect(ble.maxConcurrentWrites).toBe(1)

    // 데스크탑 → 폰: 40KB 답이 182바이트 알림 수백 개로 와서 하나로 붙는다
    const big = { messages: Array.from({ length: 200 }, (_, index) => ({ role: 'assistant', text: `${index}:${randomBytes(150).toString('base64')}` })) }
    await desk.channels[0]!.send(FRAME.RES, request.id, utf8.encode(JSON.stringify({ status: 200, body: big })))
    expect(JSON.parse((await answer).body)).toEqual(big)
    expect(Math.max(...ble.notifies)).toBeLessThanOrEqual(182)
    expect(ble.notifies.length).toBeGreaterThan(100)
    transport.close()
    expect(ble.log.at(-1)).toBe('disconnect')
  })

  it('MTU 협상이 안 되면 기본 조각(20바이트)으로 간다', async () => {
    const keys = generateNoiseKeyPair()
    const desk = handDesktop(keys)
    const ble = fakeBle(SERVICE, desk.serve, { mtu: 'fail' })
    const transport = await connectBluetooth(ble.driver, { desktopId: DESKTOP_ID, bluetoothKey: encodeNoiseKey(keys.publicKey) })
    void transport.request({ method: 'GET', url: 'bt://desk/v1/hello' }).catch(() => undefined)
    await until(() => desk.got.length === 1, 'REQ')
    expect(Math.max(...ble.writes)).toBe(20)
    transport.close()
  })

  it('핸드셰이크 — 틀린 bk 면 handshake-failed 로 끊는다 (데스크탑이 메시지 1 을 못 푼다)', async () => {
    const keys = generateNoiseKeyPair()
    const desk = handDesktop(keys)
    const ble = fakeBle(SERVICE, desk.serve)
    const wrong = encodeNoiseKey(generateNoiseKeyPair().publicKey)
    const error = await connectBluetooth(ble.driver, { desktopId: DESKTOP_ID, bluetoothKey: wrong }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(BluetoothError)
    expect(error).toMatchObject({ reason: 'handshake-failed', needsUser: false })
    expect(desk.channels).toHaveLength(0)
  })

  it('핸드셰이크가 기한 안에 안 끝나면 handshake-failed', async () => {
    const keys = generateNoiseKeyPair()
    const ble = fakeBle(SERVICE, () => undefined) // 데스크탑이 답하지 않는다
    const error = await connectBluetooth(ble.driver, { desktopId: DESKTOP_ID, bluetoothKey: encodeNoiseKey(keys.publicKey) }, { handshakeTimeoutMs: 50 }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ reason: 'handshake-failed' })
    expect(ble.log).toContain('disconnect')
  })

  it('사유 코드: 키 없음(라디오를 건드리지 않는다) · 권한 · 꺼짐 · 못 찾음(Android 11 이하면 위치) · 연결 실패', async () => {
    const keys = generateNoiseKeyPair()
    const bk = encodeNoiseKey(keys.publicKey)
    const reason = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: BluetoothError) => `${error.reason}${error.needsUser ? '!' : ''}`)

    const quiet = fakeBle(SERVICE, () => undefined)
    expect(await reason(connectBluetooth(quiet.driver, { desktopId: DESKTOP_ID }))).toBe('no-key!')
    expect(await reason(connectBluetooth(quiet.driver, { bluetoothKey: bk }))).toBe('no-key!')
    expect(await reason(connectBluetooth(quiet.driver, { desktopId: DESKTOP_ID, bluetoothKey: 'short' }))).toBe('no-key!')
    expect(quiet.log).toEqual([])

    const denied = fakeBle(SERVICE, () => undefined, { prepare: () => { throw new BluetoothError('permission') } })
    expect(await reason(connectBluetooth(denied.driver, { desktopId: DESKTOP_ID, bluetoothKey: bk }))).toBe('permission!')
    expect(denied.log).toEqual(['prepare'])
    const off = fakeBle(SERVICE, () => undefined, { prepare: () => { throw new BluetoothError('bluetooth-off') } })
    expect(await reason(connectBluetooth(off.driver, { desktopId: DESKTOP_ID, bluetoothKey: bk }))).toBe('bluetooth-off!')

    const away = fakeBle(SERVICE, () => undefined)
    away.advertising = false
    expect(await reason(connectBluetooth(away.driver, { desktopId: DESKTOP_ID, bluetoothKey: bk }))).toBe('not-found')
    expect(await reason(connectBluetooth(away.driver, { desktopId: DESKTOP_ID, bluetoothKey: bk }, { legacyLocation: true }))).toBe('location-off')
    expect(away.log).toEqual(['prepare', 'scan', 'prepare', 'scan'])

    const broken = fakeBle(SERVICE, () => undefined, { subscribeFails: true })
    expect(await reason(connectBluetooth(broken.driver, { desktopId: DESKTOP_ID, bluetoothKey: bk }))).toBe('connect-failed')
    expect(broken.log.at(-1)).toBe('disconnect')
  })
})

// ── 짝(link.ts)·세션 — 고른 길로만 ─────────────────────────────────────────────────────────────────

function memoryStore(initial?: SavedDesktop): DesktopStore & { value: SavedDesktop | undefined } {
  const store = { value: initial, load: async () => store.value, save: async (desktop: SavedDesktop) => void (store.value = desktop), clear: async () => void (store.value = undefined) }
  return store
}
function choice(initial: Carrier): CarrierChoice & { value: Carrier } {
  const box = { value: initial, get: () => box.value, set: (carrier: Carrier) => void (box.value = carrier) }
  return box
}
/** Wi-Fi 운반 — 늘 닿지 못한다. 몇 번 불렸는지 센다 */
function deadWifi(): { transport: Transport; pinned: PinnedNet; calls: number } {
  const counter = { calls: 0 }
  const fail = () => {
    counter.calls += 1
    return Promise.reject(new NetError('timeout', 'no route'))
  }
  const transport: Transport = {
    request: fail,
    stream(_request, handlers) {
      void fail().catch((error: unknown) => handlers.onEnd(error))
      return () => {}
    },
  }
  return {
    transport,
    pinned: { probe: () => fail(), transport: () => transport },
    get calls() {
      return counter.calls
    },
  }
}
const SAVED: SavedDesktop = {
  address: '192.168.0.10:47600',
  baseUrl: 'https://192.168.0.10:47600',
  deviceId: 'dev_1',
  token: 'tok',
  desktopName: '김의 MacBook',
  fingerprint: 'q'.repeat(43),
  addresses: ['192.168.0.10:47600'],
  desktopId: DESKTOP_ID,
}

let links: DesktopLink[] = []
afterEach(() => {
  for (const link of links) link.dispose()
  links = []
})
function newLink(options: { saved: SavedDesktop; carrier: CarrierChoice; bluetooth?: BleDriver; wifi?: ReturnType<typeof deadWifi> }): DesktopLink {
  const wifi = options.wifi ?? deadWifi()
  const link = new DesktopLink({ store: memoryStore(options.saved), transport: wifi.transport, pinned: wifi.pinned, platform: 'android', bluetooth: options.bluetooth, carrier: options.carrier })
  links.push(link)
  return link
}
const sessionOf = (link: DesktopLink): AppSession => {
  if (link.state.phase !== 'linked') throw new Error(`not linked: ${link.state.phase}`)
  return link.state.session
}

describe('연결 수단 고르기 — 고른 길로만, 자동 전환 없음', () => {
  it('Wi-Fi 를 골랐고 닿지 않으면 다시 시도할 뿐 블루투스로 넘어가지 않는다 — 블루투스는 버튼(chooseCarrier)을 누른 뒤에만', async () => {
    const keys = generateNoiseKeyPair()
    const ble = fakeBle(SERVICE, () => undefined)
    const wifi = deadWifi()
    const carrier = choice('wifi')
    const link = newLink({ saved: { ...SAVED, bluetoothKey: encodeNoiseKey(keys.publicKey) }, carrier, bluetooth: ble.driver, wifi })
    await link.restore()
    const session = sessionOf(link)
    expect(session.carrier).toBe('wifi')
    await until(() => session.getStatus().kind === 'reconnecting', '닿지 않음')
    // 1초 백오프 뒤 한 번 더 — 여전히 Wi-Fi 로만
    await until(() => wifi.calls >= 2, '다시 시도', 3_000)
    expect(ble.log).toEqual([])
    expect(carrier.value).toBe('wifi')
    // 화면: 사유 + [다시 시도] + [블루투스로 시도]
    expect(showsGate(session.getStatus(), session.hasConnected())).toBe(true)
    expect(gateView(session.getStatus(), session.getFailure(), 'wifi', '192.168.0.10:47600')).toMatchObject({ kind: 'failed', title: S.cannotReach.wifi, body: S.wifiFailure('192.168.0.10:47600') })

    // [블루투스로 시도] — 고른 것을 기억하고, Wi-Fi 세션을 거두고 블루투스로 붙는다
    link.chooseCarrier('bluetooth')
    expect(carrier.value).toBe('bluetooth')
    expect(link.state).toMatchObject({ phase: 'linked', carrier: 'bluetooth' })
    const bt = sessionOf(link)
    expect(bt).not.toBe(session)
    expect(bt.carrier).toBe('bluetooth')
    await until(() => ble.log.includes('scan'), '블루투스 스캔')
    const before = wifi.calls
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(wifi.calls).toBe(before) // 거둔 Wi-Fi 세션은 더 시도하지 않는다
  })

  it('bk 가 없는 짝에서 블루투스를 고르면 "QR 로 다시 짝지어야 합니다" — 라디오를 건드리지 않고, 저절로 다시 시도하지 않는다', async () => {
    const ble = fakeBle(SERVICE, () => undefined)
    const link = newLink({ saved: SAVED, carrier: choice('bluetooth'), bluetooth: ble.driver })
    await link.restore()
    const session = sessionOf(link)
    await until(() => session.getStatus().kind === 'needs-action', 'needs-action')
    expect(session.getFailure()).toMatchObject({ reason: 'no-key' })
    expect(gateView(session.getStatus(), session.getFailure(), 'bluetooth', SAVED.address)).toMatchObject({ kind: 'failed', title: S.cannotReach.bluetooth, body: S.bluetoothFailure['no-key'] })
    expect(S.bluetoothFailure['no-key']).toContain('QR 로 다시 짝지어야')
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(session.getStatus().kind).toBe('needs-action')
    expect(ble.log).toEqual([])
  })

  it('권한을 거절하면 멈춘다(권한 창을 되풀이하지 않는다) — [다시 시도] 를 누르면 그때 다시 묻는다', async () => {
    const keys = generateNoiseKeyPair()
    let allowed = false
    const desk = handDesktop(keys)
    const ble = fakeBle(SERVICE, desk.serve, { prepare: () => { if (!allowed) throw new BluetoothError('permission') } })
    const link = newLink({ saved: { ...SAVED, bluetoothKey: encodeNoiseKey(keys.publicKey) }, carrier: choice('bluetooth'), bluetooth: ble.driver })
    await link.restore()
    const session = sessionOf(link)
    await until(() => session.getStatus().kind === 'needs-action', 'needs-action')
    expect(gateView(session.getStatus(), session.getFailure(), 'bluetooth', '')).toMatchObject({ body: S.bluetoothFailure.permission })
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(ble.log).toEqual(['prepare'])
    allowed = true
    session.retry()
    expect(session.getStatus().kind).toBe('connecting')
    await until(() => desk.got.some((message) => message.type === FRAME.REQ), '허용 뒤 hello 가 블루투스로')
    expect(ble.log.filter((entry) => entry === 'prepare')).toHaveLength(2)
  })

  it('데스크탑을 못 찾으면(멀다·꺼져 있다) 사유를 보이고 기존 백오프로 다시 찾는다', async () => {
    const keys = generateNoiseKeyPair()
    const ble = fakeBle(SERVICE, () => undefined)
    ble.advertising = false
    const link = newLink({ saved: { ...SAVED, bluetoothKey: encodeNoiseKey(keys.publicKey) }, carrier: choice('bluetooth'), bluetooth: ble.driver })
    await link.restore()
    const session = sessionOf(link)
    await until(() => session.getStatus().kind === 'reconnecting', 'reconnecting')
    expect(gateView(session.getStatus(), session.getFailure(), 'bluetooth', '')).toMatchObject({ kind: 'failed', body: S.bluetoothFailure['not-found'] })
    await until(() => ble.log.filter((entry) => entry === 'scan').length >= 2, '다시 찾기', 3_000)
  })
})

describe('난수 — Hermes 에 없는 crypto.getRandomValues', () => {
  it('없으면 채우고(그러면 Noise 임시 키가 만들어진다), 있으면 건드리지 않는다', () => {
    const real = globalThis.crypto
    const source = vi.fn((array: Uint8Array) => real.getRandomValues(array as Uint8Array<ArrayBuffer>))
    vi.stubGlobal('crypto', undefined)
    try {
      expect(() => generateNoiseKeyPair()).toThrow(/getRandomValues/)
      expect(installRandomValues(source)).toBe(true)
      const pair = generateNoiseKeyPair()
      expect(pair.secretKey).toHaveLength(32)
      expect(source).toHaveBeenCalled()
      expect(installRandomValues(() => undefined)).toBe(false) // 두 번째는 그대로
    } finally {
      vi.unstubAllGlobals()
    }
    // 객체는 있는데 함수가 없을 때(일부 엔진)도 채운다
    const target: { crypto?: unknown } = { crypto: {} }
    expect(installRandomValues(source, target)).toBe(true)
    expect(typeof (target.crypto as { getRandomValues?: unknown }).getRandomValues).toBe('function')
  })

  it('앱 시작 지점(index.ts)이 맨 먼저 폴리필을 불러온다', () => {
    const imports = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('import '))
    expect(imports[0]).toBe("import './src/app/randomPolyfill.ts'")
    expect(readFileSync(new URL('../src/app/randomPolyfill.ts', import.meta.url), 'utf8')).toMatch(/from 'expo-crypto'/)
  })
})

// ── 진짜 데스크탑 서비스에 블루투스(가짜 라디오)로 ──────────────────────────────────────────────────

interface Turn {
  sessionId: string
  finish(): void
}
interface DesktopStatus {
  pairing?: { code: string; uri?: string }
  requests: { id: string; confirm: string; pinned?: true }[]
}
interface Desktop {
  ctx: { chat: { send(cid: string, input: { text: string }): Promise<unknown> } }
  remote: {
    startPairing(): DesktopStatus
    answerPair(id: string, allow: boolean): DesktopStatus
    status(): DesktopStatus
    noiseIdentity(): Promise<NoiseKeyPair & { publicKeyText: string }>
    readonly desktopId: string
  }
  llm: { calls: Turn[] }
  pipeCarrier(id?: string): Promise<void>
  attach(link: ByteLink, key?: string, carrier?: string): unknown
  seed(id: string, messages: HistoryMessage[]): Promise<void>
  save(id: string, extra?: Record<string, unknown>): Promise<unknown>
  turn(n: number): Promise<Turn>
}
interface Harness {
  box: { project: string; root: string }
  setUp(): Promise<void>
  tearDown(): Promise<void>
  start(options?: { http?: boolean; noiseKeyFile?: string }): Promise<Desktop>
}
const harnessUrl = new URL('../../tests/unit/support/remoteHarness.ts', import.meta.url).href
const harness = (await import(/* @vite-ignore */ harnessUrl)) as Harness

describe('진짜 ctx.remote 에 블루투스로 — hello · 목록 · 긴 대화 · 끊김과 이어받기', () => {
  beforeEach(() => harness.setUp())
  afterEach(() => harness.tearDown())

  it('짝짓기(블루투스 채널 안에서) → 블루투스를 고른 짝이 붙어 목록·긴 대화를 받고, 링크가 끊기면 다시 찾아 붙어 끊긴 사이의 이벤트를 이어받는다', async () => {
    const desktop = await harness.start({ http: false })
    await desktop.pipeCarrier()
    // 잘 안 눌리는 글 — 압축해도 수십 KB 가 링크로 온다
    const noise = (length: number): string => randomBytes((length * 3) / 4).toString('base64')
    const history: HistoryMessage[] = Array.from({ length: 80 }, (_, index) => ({ id: `msg_${index}`, role: index % 2 ? 'assistant' : 'user', text: noise(1_000) }))
    await desktop.seed('c_big', history)
    await desktop.save('c_small')

    // 데스크탑 쪽: 연결마다 Noise 응답자 → 프레임 운반(ctx.remote.handle)
    const keys = generateNoiseKeyPair()
    let served = 0
    const ble = fakeBle(SERVICE, (desk) => {
      served += 1
      void secureResponder(desk, keys, { prologue: bluetoothPrologue(DESKTOP_ID) }).then((secure) => void desktop.attach(secure, `bt-${served}`), () => undefined)
    })
    const bk = encodeNoiseKey(keys.publicKey)

    // 짝짓기도 이 채널 안에서 된다 — POST /v1/pair → 데스크탑 [허용] → 토큰 (HTTPS 와 글자 그대로 같다)
    const pairTransport = await connectBluetooth(ble.driver, { desktopId: DESKTOP_ID, bluetoothKey: bk })
    const code = desktop.remote.startPairing().pairing!.code
    const pairing = pairTransport.request({ method: 'POST', url: `bt://${DESKTOP_ID}/v1/pair`, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, deviceName: 'Pixel 8', platform: 'android' }) })
    await until(() => desktop.remote.status().requests.length === 1, '짝짓기 요청')
    desktop.remote.answerPair(desktop.remote.status().requests[0]!.id, true)
    const paired = JSON.parse((await pairing).body) as { deviceId: string; token: string }
    pairTransport.close()

    const wifi = deadWifi()
    const link = newLink({ saved: { ...SAVED, deviceId: paired.deviceId, token: paired.token, bluetoothKey: bk }, carrier: choice('bluetooth'), bluetooth: ble.driver, wifi })
    await link.restore()
    const session = sessionOf(link)
    expect(session.carrier).toBe('bluetooth')
    expect(showsGate(session.getStatus(), session.hasConnected())).toBe(true)
    await until(() => session.getStatus().kind === 'connected', '블루투스로 붙음', 10_000)
    expect(showsGate(session.getStatus(), session.hasConnected())).toBe(false)
    await until(() => (session.getState().conversations[harness.box.project] ?? []).length === 2 && session.models.length > 0, '대화 목록·모델', 10_000)
    expect(wifi.calls).toBe(0) // Wi-Fi 에는 한 번도 가지 않았다

    // 긴 대화 — 알림 수백 조각이 다시 붙어 스냅샷 하나로
    const before = session.receivedBytes()
    session.openConversation('c_big')
    await until(() => session.getState().views['c_big']?.messages.length === 80, '긴 대화', 10_000)
    expect(session.getState().views['c_big']!.messages[79]!.text).toBe(history[79]!.text)
    expect(session.receivedBytes() - before).toBeGreaterThan(30_000)
    session.openConversation('c_small')
    await until(() => session.getState().views['c_small'] !== undefined, '작은 대화')
    expect(Math.max(...ble.writes)).toBeLessThanOrEqual(182)
    expect(Math.max(...ble.notifies)).toBeLessThanOrEqual(182)
    expect(ble.maxConcurrentWrites).toBe(1)

    // 링크가 끊긴다(멀어졌다) — 그사이 데스크탑에서 턴이 시작된다
    const connectionsBefore = ble.connections
    ble.dropRemote()
    await until(() => session.getStatus().kind === 'reconnecting', '끊김')
    expect(session.hasConnected()).toBe(true)
    expect(showsGate(session.getStatus(), session.hasConnected())).toBe(false) // 한 번 붙은 뒤의 끊김은 상태 띠가 맡는다
    void desktop.ctx.chat.send('c_small', { text: '끊긴 사이에 보냄' })
    await desktop.turn(1)

    // 백오프(1초) 뒤 다시 찾아 붙고, hello → events?run=&after= 로 끊긴 사이의 turn.started 를 받는다
    await until(() => session.getStatus().kind === 'connected', '다시 붙음', 10_000)
    expect(ble.connections).toBe(connectionsBefore + 1)
    await until(() => session.getState().views['c_small']?.running === true, '끊긴 사이의 턴', 10_000)
    expect(session.getState().views['c_small']!.messages.at(-1)).toMatchObject({ role: 'user', text: '끊긴 사이에 보냄' })
    desktop.llm.calls[0]!.finish()
    await until(() => session.getState().views['c_small']?.running === false, '턴 끝')

    // [Wi-Fi 로 바꾸기] — 블루투스 링크를 끊고 Wi-Fi 세션으로
    link.chooseCarrier('wifi')
    expect(ble.log.at(-1)).toBe('disconnect')
    expect(sessionOf(link).carrier).toBe('wifi')
    await until(() => wifi.calls > 0, 'Wi-Fi 로 시도')
  }, 30_000)
})

// ── 블루투스만으로 짝짓기 (이슈 #229) — Wi-Fi 가 전혀 없는 곳 ──────────────────────────────────────────────

describe('블루투스만으로 짝짓기 — 진짜 ctx.remote 의 블루투스 단독 QR, Wi-Fi 호출 0번', () => {
  beforeEach(() => harness.setUp())
  afterEach(() => harness.tearDown())

  /** 사내망 없이 블루투스만 켠 데스크탑 + 그 광고를 흉내 내는 가짜 라디오 (연결마다 Noise 응답자 → ctx.remote) */
  async function bluetoothDesktop(options: { prepare?: () => void } = {}) {
    const desktop = await harness.start({ http: false, noiseKeyFile: `${harness.box.root}/remote-noise-key.json` })
    await desktop.pipeCarrier('bluetooth')
    const identity = await desktop.remote.noiseIdentity()
    const desktopId = desktop.remote.desktopId
    let served = 0
    const ble = fakeBle(
      bluetoothServiceUuid(desktopId),
      (desk) => {
        served += 1
        void secureResponder(desk, identity, { prologue: bluetoothPrologue(desktopId) }).then((secure) => void desktop.attach(secure, `bt-${served}`, 'bluetooth'), () => undefined)
      },
      { prepare: options.prepare },
    )
    return { desktop, identity, desktopId, ble }
  }
  function pairingLink(ble: FakeBle, carrier = choice('wifi')) {
    const wifi = deadWifi()
    const store = memoryStore()
    const link = new DesktopLink({ store, transport: wifi.transport, pinned: wifi.pinned, platform: 'android', bluetooth: ble.driver, carrier })
    links.push(link)
    return { link, wifi, store, carrier }
  }
  /** QR 의 c 를 다른 (모양은 맞는) 코드로 */
  const withCode = (uri: string, code: string): string => uri.replace(/([?&]c=)[^&]+/, `$1${code}`)

  it('QR(a·fp 없음) → 블루투스 링크로 POST /v1/pair → 확인 코드가 폰·데스크탑 [허용] 창에 같다 → 허용 → 토큰·키 저장, 블루투스로 붙는다', async () => {
    const { desktop, identity, desktopId, ble } = await bluetoothDesktop()
    const status = desktop.remote.startPairing()
    const uri = status.pairing!.uri!
    expect(uri).not.toContain('&a=')
    const { link, wifi, store, carrier } = pairingLink(ble)
    await link.restore()

    const pairing = link.pairQr(uri, ' Pixel 8 ')
    await until(() => desktop.remote.status().requests.length === 1, '짝짓기 요청')
    const request = desktop.remote.status().requests[0]!
    // 확인 코드: 블루투스로 온 요청은 지문이 없다 → 요청에서 만든 8자(confirmCode). 폰은 자기가 보낸 것으로 같은 글을 낸다
    expect(request.pinned).toBeUndefined()
    expect(request.confirm).toBe(confirmCode(status.pairing!.code.replace(/-/g, ''), 'Pixel 8', 'android'))
    expect(link.state).toEqual({ phase: 'pairing', confirm: request.confirm, confirmKind: 'code' })
    desktop.remote.answerPair(request.id, true)
    await pairing

    expect(link.state).toMatchObject({ phase: 'linked', carrier: 'bluetooth' })
    expect(store.value).toMatchObject({ desktopId, bluetoothKey: identity.publicKeyText, desktopName: 'test-pc', address: '' })
    expect(store.value!.fingerprint).toBeUndefined()
    expect(carrier.value).toBe('bluetooth') // 블루투스로 짝지었다 — 마지막 선택
    const session = sessionOf(link)
    await until(() => session.getStatus().kind === 'connected', '블루투스로 붙음', 10_000)
    expect(wifi.calls).toBe(0) // Wi-Fi 는 한 번도 시도하지 않았다
    expect(ble.connections).toBe(2) // 짝짓기 링크 하나(닫았다) + 세션 링크 하나
  }, 20_000)

  it('데스크탑에서 [거절] 하면 denied — Wi-Fi 호출 없음', async () => {
    const { desktop, ble } = await bluetoothDesktop()
    const uri = desktop.remote.startPairing().pairing!.uri!
    const { link, wifi } = pairingLink(ble)
    await link.restore()
    const pairing = link.pairQr(uri, 'Pixel 8')
    await until(() => desktop.remote.status().requests.length === 1, '짝짓기 요청')
    desktop.remote.answerPair(desktop.remote.status().requests[0]!.id, false)
    await pairing
    expect(link.state).toMatchObject({ phase: 'unpaired', failure: 'denied' })
    expect(wifi.calls).toBe(0)
    expect(ble.log.at(-1)).toBe('disconnect') // 짝짓기 링크를 닫았다
  })

  it('틀린 코드 3번이면 짝짓기 세션이 버려진다 — 그 뒤엔 맞는 코드도 wrong-code (사내망과 같은 규칙)', async () => {
    const { desktop, ble } = await bluetoothDesktop()
    const uri = desktop.remote.startPairing().pairing!.uri!
    const { link, wifi } = pairingLink(ble)
    await link.restore()
    for (let attempt = 0; attempt < 3; attempt++) {
      await link.pairQr(withCode(uri, 'ZZZZZZZZZZZZ'), 'Pixel 8')
      expect(link.state, `시도 ${attempt + 1}`).toMatchObject({ phase: 'unpaired', failure: 'wrong-code' })
    }
    expect(desktop.remote.status().pairing).toBeUndefined()
    await link.pairQr(uri, 'Pixel 8')
    expect(link.state).toMatchObject({ phase: 'unpaired', failure: 'wrong-code' })
    expect(desktop.remote.status().requests).toHaveLength(0)
    expect(wifi.calls).toBe(0)
  })

  it('"근처 기기" 권한을 거절하면 짝짓기 화면에 연결 화면과 같은 문구 — 꺼짐·못 찾음도', async () => {
    let problem: BluetoothError | undefined = new BluetoothError('permission')
    const { desktop, ble } = await bluetoothDesktop({ prepare: () => { if (problem) throw problem } })
    const uri = desktop.remote.startPairing().pairing!.uri!
    const { link, wifi } = pairingLink(ble)
    await link.restore()

    await link.pairQr(uri, 'Pixel 8')
    expect(link.state).toMatchObject({ phase: 'unpaired', failure: 'bluetooth', bluetooth: 'permission' })
    const shown = link.state as Extract<typeof link.state, { phase: 'unpaired' }>
    expect(pairFailureText(shown.failure!, shown.bluetooth)).toBe(S.bluetoothFailure.permission)
    expect(shown.detail).toContain('permission')

    problem = new BluetoothError('bluetooth-off')
    await link.pairQr(uri, 'Pixel 8')
    expect(link.state).toMatchObject({ failure: 'bluetooth', bluetooth: 'bluetooth-off' })

    problem = undefined
    ble.advertising = false
    await link.pairQr(uri, 'Pixel 8')
    expect(link.state).toMatchObject({ failure: 'bluetooth', bluetooth: 'not-found' })
    expect(pairFailureText('bluetooth', 'not-found')).toBe(S.bluetoothFailure['not-found'])
    expect(desktop.remote.status().requests).toHaveLength(0)
    expect(desktop.remote.status().pairing).toBeDefined() // 코드는 쓰지 않았다
    expect(wifi.calls).toBe(0)
  })

  it('사내망·블루투스가 둘 다 실린 QR — 마지막 선택이 블루투스면 블루투스로 짝짓고 a·fp 도 저장한다(나중에 Wi-Fi 를 고를 수 있게)', async () => {
    const { desktop, identity, ble } = await bluetoothDesktop()
    const plain = desktop.remote.startPairing().pairing!.uri!
    const fp = 'q'.repeat(43)
    const uri = plain.replace('&c=', `&a=${encodeURIComponent('192.168.0.10:47600')}&fp=${fp}&c=`)
    const { link, wifi, store } = pairingLink(ble, choice('bluetooth'))
    await link.restore()
    const pairing = link.pairQr(uri, 'Pixel 8')
    await until(() => desktop.remote.status().requests.length === 1, '짝짓기 요청')
    desktop.remote.answerPair(desktop.remote.status().requests[0]!.id, true)
    await pairing
    expect(link.state).toMatchObject({ phase: 'linked', carrier: 'bluetooth' })
    expect(store.value).toMatchObject({ fingerprint: fp, address: '192.168.0.10:47600', baseUrl: 'https://192.168.0.10:47600', bluetoothKey: identity.publicKeyText })
    expect(wifi.calls).toBe(0)
  })
})

describe('연결 화면 기본 선택 (이슈 #229)', () => {
  const BT_ONLY: SavedDesktop = { address: '', baseUrl: `bt://${DESKTOP_ID}`, deviceId: 'dev_1', token: 'tok', desktopName: 'PC', desktopId: DESKTOP_ID, bluetoothKey: 'B'.repeat(42) + 'A' }

  it('사내망 주소가 없는 짝(블루투스 단독)은 고른 적이 없으면 블루투스로, 주소가 있으면 Wi-Fi', async () => {
    const ble = fakeBle(SERVICE, () => undefined)
    const wifi = deadWifi()
    const btOnly = new DesktopLink({ store: memoryStore(BT_ONLY), transport: wifi.transport, pinned: wifi.pinned, platform: 'android', bluetooth: ble.driver })
    const lan = new DesktopLink({ store: memoryStore(SAVED), transport: wifi.transport, pinned: wifi.pinned, platform: 'android', bluetooth: ble.driver })
    links.push(btOnly, lan)
    await btOnly.restore()
    await lan.restore()
    expect(btOnly.state).toMatchObject({ phase: 'linked', carrier: 'bluetooth' })
    expect(lan.state).toMatchObject({ phase: 'linked', carrier: 'wifi' })
  })

  it('블루투스 단독 짝에서 Wi-Fi 를 고르면(자동 전환 없음) 주소가 없다는 안내', () => {
    const view = gateView({ kind: 'reconnecting', attempt: 1, retryAt: 0 }, new NetError('unreachable', 'no address'), 'wifi', '')
    expect(view).toMatchObject({ kind: 'failed', title: S.cannotReach.wifi, body: S.wifiNoAddress })
  })
})
