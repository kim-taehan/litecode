import { readFileSync } from 'node:fs'
import net from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FAKE_PAIR_CODE, startFakeDesktop, type FakeDesktop } from '../dev/fake-desktop.mts'
import { DesktopLink, lanUnsupported, pairFailure, type DesktopStore, type LinkState, type SavedDesktop } from '../src/app/link.ts'
import { createFetchTransport, createNativePinnedNet, fingerprintCode, NetError, pairUri, type PairLink } from '../src/core/index.ts'
import { nodePinnedNative, spkiFingerprint, type NodePinnedNative } from './nodePinned.ts'
import { until } from './support.ts'

// 사내망 짝짓기 (TLS 라운드) — 가짜 데스크탑을 자체 서명 https 로 띄우고(tests/fixtures), 폰의 짝(link.ts)이 지문 고정 운반으로 붙는다.
// QR(지문을 QR 로 받는다) · 직접 입력(TOFU — 처음 본 지문) · 저장·복원(같은 지문, 주소가 바뀌면 후보를 다) · 지문이 바뀌면 믿지 않는다.

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const DESKTOP_TLS = { key: fixture('desktop.key.pem'), cert: fixture('desktop.cert.pem') }
const DESKTOP_FP = spkiFingerprint(DESKTOP_TLS.cert)
const OTHER_FP = spkiFingerprint(fixture('other.cert.pem'))

function memoryStore(initial?: SavedDesktop): DesktopStore & { value: SavedDesktop | undefined } {
  const store = {
    value: initial,
    load: async () => store.value,
    save: async (desktop: SavedDesktop) => void (store.value = desktop),
    clear: async () => void (store.value = undefined),
  }
  return store
}

/** 아무도 안 듣는 포트 (열었다 닫았다) */
function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
  })
}

let desktop: FakeDesktop
let links: DesktopLink[]
let native: NodePinnedNative
beforeEach(async () => {
  desktop = await startFakeDesktop({ port: 0, stepMs: 5, manualPair: true, pairWaitMs: 2_000, tls: DESKTOP_TLS })
  links = []
  native = nodePinnedNative()
})
afterEach(async () => {
  for (const link of links) link.dispose()
  await desktop.close()
})

const NOW = Date.now()
function newLink(store: DesktopStore = memoryStore()): DesktopLink {
  const link = new DesktopLink({ store, transport: createFetchTransport(), pinned: createNativePinnedNet(native), platform: 'android', now: () => NOW })
  links.push(link)
  return link
}
const live = () => `127.0.0.1:${desktop.port}`
const qr = (extra: Partial<PairLink> = {}): string =>
  pairUri({ version: 1, desktopId: 'fake-desktop', name: '김의 MacBook', addresses: [live()], fingerprint: DESKTOP_FP, code: FAKE_PAIR_CODE, expiresAt: Math.floor(NOW / 1000) + 120, ...extra })
const phase = <P extends LinkState['phase']>(link: DesktopLink, name: P): Extract<LinkState, { phase: P }> => {
  expect(link.state.phase).toBe(name)
  return link.state as Extract<LinkState, { phase: P }>
}
/** 데스크탑에 짝짓기 요청이 닿으면 허용한다 */
async function allowWhenAsked(): Promise<{ deviceName: string; confirm: string }> {
  await until(() => desktop.pendingPair() !== undefined, '짝짓기 요청')
  const asked = desktop.pendingPair()!
  desktop.answerPair(true)
  return asked
}

describe('QR 로 짝짓기', () => {
  it('주소 후보 중 지문이 맞는 곳으로 — 폰 화면의 지문 8자 = 데스크탑 [허용] 창의 것 → 허용 → 지문·후보가 저장되고 붙는다', async () => {
    const store = memoryStore()
    const link = newLink(store)
    await link.restore()
    const dead = `127.0.0.1:${await closedPort()}`
    const pairing = link.pairQr(qr({ addresses: [dead, live()] }), ' Pixel 8 ')
    expect(link.state).toEqual({ phase: 'pairing', confirm: fingerprintCode(DESKTOP_FP), confirmKind: 'fingerprint' })
    const asked = await allowWhenAsked()
    expect(asked).toEqual({ deviceName: 'Pixel 8', confirm: fingerprintCode(DESKTOP_FP) })
    await pairing

    const { desktop: saved, session } = phase(link, 'linked')
    expect(saved).toMatchObject({ address: live(), baseUrl: `https://${live()}`, fingerprint: DESKTOP_FP, desktopName: '가짜 데스크탑 (개발용)' })
    expect(saved.addresses).toEqual([live(), dead])
    expect(store.value).toEqual(saved)
    expect(session.desktop.fingerprint).toBe(fingerprintCode(DESKTOP_FP))
    await until(() => session.getStatus().kind === 'connected' && session.getState().projects.length > 0, '붙어서 목록')
    // 페어링 코드는 한 곳에만 갔다 — 나머지는 핸드셰이크뿐
    expect(native.sent.filter((line) => line.endsWith('/v1/pair'))).toEqual([`POST https://${live()}/v1/pair`])
  })

  it('QR 의 지문과 서버 인증서가 다르면 fingerprint-mismatch — 페어링 코드를 보내지 않는다', async () => {
    const link = newLink()
    await link.restore()
    await link.pairQr(qr({ fingerprint: OTHER_FP }), 'Pixel 8')
    expect(link.state).toEqual({ phase: 'unpaired', failure: 'fingerprint-mismatch' })
    expect(native.sent).toEqual([])
    expect(desktop.pendingPair()).toBeUndefined()
  })

  it('QR 이 만료·다른 버전·우리 것 아님·깨짐이면 아무 데도 닿지 않고 각자의 사유로', async () => {
    const link = newLink()
    await link.restore()
    const cases: [string, string][] = [
      [qr({ expiresAt: Math.floor(NOW / 1000) - 300 }), 'qr-expired'],
      [qr().replace('v=1', 'v=9'), 'qr-version'],
      ['https://example.com/login', 'qr-foreign'],
      [qr().replace(/fp=[^&]+/, 'fp=short'), 'qr-invalid'],
    ]
    for (const [text, failure] of cases) {
      await link.pairQr(text, 'Pixel 8')
      expect(link.state, failure).toEqual({ phase: 'unpaired', failure })
    }
    await link.pairQr(qr(), '  ')
    expect(link.state).toEqual({ phase: 'unpaired', failure: 'no-name' })
    expect(native.sent).toEqual([])
  })

  it('후보에 다 닿지 못하면 이유를 가른다 — 아무도 안 듣는 포트면 refused', async () => {
    const link = newLink()
    await link.restore()
    await link.pairQr(qr({ addresses: [`127.0.0.1:${await closedPort()}`] }), 'Pixel 8')
    expect(link.state).toEqual({ phase: 'unpaired', failure: 'refused' })
  })

  it('데스크탑에서 거절하면 denied', async () => {
    const link = newLink()
    await link.restore()
    const pairing = link.pairQr(qr(), 'Pixel 8')
    await until(() => desktop.pendingPair() !== undefined, '짝짓기 요청')
    desktop.answerPair(false)
    await pairing
    expect(link.state).toEqual({ phase: 'unpaired', failure: 'denied' })
  })
})

describe('직접 입력 (TOFU)', () => {
  it('처음 본 인증서의 지문 앞 8자를 허용 전에 띄우고, 허용되면 그 지문으로 고정해 저장한다', async () => {
    const store = memoryStore()
    const link = newLink(store)
    await link.restore()
    const pairing = link.pair({ address: `https://${live()}`, code: 'dev0-dev0-dev0', deviceName: 'Pixel 8' })
    await until(() => desktop.pendingPair() !== undefined, '짝짓기 요청')
    const waiting = phase(link, 'pairing')
    expect(waiting).toEqual({ phase: 'pairing', confirm: fingerprintCode(DESKTOP_FP), confirmKind: 'fingerprint' })
    expect(desktop.pendingPair()!.confirm).toBe(waiting.confirm)
    desktop.answerPair(true)
    await pairing

    const { desktop: saved } = phase(link, 'linked')
    expect(saved).toMatchObject({ baseUrl: `https://${live()}`, fingerprint: DESKTOP_FP })
    expect(store.value?.fingerprint).toBe(DESKTOP_FP)
  })

  it('https 주소에 아무도 안 들으면 refused (요청 없음)', async () => {
    const link = newLink()
    await link.restore()
    await link.pair({ address: `https://127.0.0.1:${await closedPort()}`, code: FAKE_PAIR_CODE, deviceName: 'Pixel 8' })
    expect(link.state).toEqual({ phase: 'unpaired', failure: 'refused' })
    expect(native.sent).toEqual([])
  })

  it('운반의 실패를 사유로: 시간 초과 · 거부 · 지문 불일치 · 그 밖', () => {
    expect(pairFailure(new NetError('timeout', 'x'))).toBe('net-timeout')
    expect(pairFailure(new NetError('refused', 'x'))).toBe('refused')
    expect(pairFailure(new NetError('pin-mismatch', 'x'))).toBe('fingerprint-mismatch')
    expect(pairFailure(new NetError('unreachable', 'x'))).toBe('unreachable')
  })
})

describe('Android 10 미만 — 사내망(TLS 1.3) 연결을 시도하지 않는다 (QA W2)', () => {
  it('판정: android 이고 API 29 미만일 때만', () => {
    expect(lanUnsupported('android', 28)).toBe(true)
    expect(lanUnsupported('android', 24)).toBe(true)
    expect(lanUnsupported('android', 29)).toBe(false)
    expect(lanUnsupported('android', undefined)).toBe(false)
    expect(lanUnsupported('ios', 17)).toBe(false)
  })

  it('QR·https 직접 입력은 old-android 로 — 핸드셰이크도 요청도 없다. 이 컴퓨터 안 평문은 그대로 된다', async () => {
    const probes: string[] = []
    const probing = { ...native, probe: (host: string, port: number, timeoutMs: number) => (probes.push(`${host}:${port}`), native.probe(host, port, timeoutMs)) }
    const link = new DesktopLink({ store: memoryStore(), transport: createFetchTransport(), pinned: createNativePinnedNet(probing), platform: 'android', apiLevel: 28, now: () => NOW })
    links.push(link)
    await link.restore()
    await link.pairQr(qr(), 'Pixel 2')
    expect(link.state).toEqual({ phase: 'unpaired', failure: 'old-android' })
    await link.pair({ address: `https://${live()}`, code: FAKE_PAIR_CODE, deviceName: 'Pixel 2' })
    expect(link.state).toEqual({ phase: 'unpaired', failure: 'old-android' })
    expect(probes).toEqual([])
    expect(native.sent).toEqual([])

    const plain = await startFakeDesktop({ port: 0, stepMs: 5 })
    try {
      await link.pair({ address: `http://127.0.0.1:${plain.port}`, code: FAKE_PAIR_CODE, deviceName: 'Pixel 2' })
      expect(link.state.phase).toBe('linked')
    } finally {
      link.dispose()
      await plain.close()
    }
  })
})

describe('저장·복원 — 같은 지문으로만', () => {
  async function pairedStore(): Promise<ReturnType<typeof memoryStore>> {
    const store = memoryStore()
    const link = newLink(store)
    await link.restore()
    const pairing = link.pairQr(qr(), 'Pixel 8')
    await allowWhenAsked()
    await pairing
    const { session } = phase(link, 'linked')
    await until(() => session.getStatus().kind === 'connected' && session.models.length > 0, '붙음') // 날아가던 요청이 다음 시험의 셈에 섞이지 않게
    link.dispose()
    return store
  }

  it('앱을 다시 켜면 저장된 지문으로 붙는다 (짝짓기 없이)', async () => {
    const store = await pairedStore()
    native.sent.length = 0
    const again = newLink(store)
    await again.restore()
    const { session } = phase(again, 'linked')
    await until(() => session.getStatus().kind === 'connected' && session.getState().projects.length > 0, '다시 붙음')
    expect(native.sent.some((line) => line.endsWith('/v1/pair'))).toBe(false)
  })

  it('저장된 주소가 죽었으면 다른 후보를 시도해 옮기고, 옮긴 주소를 저장한다', async () => {
    const store = await pairedStore()
    const dead = `127.0.0.1:${await closedPort()}`
    store.value = { ...store.value!, address: dead, baseUrl: `https://${dead}`, addresses: [dead, live()] }
    const again = newLink(store)
    await again.restore()
    const { session } = phase(again, 'linked')
    await until(() => session.getStatus().kind === 'connected', '다른 주소로 붙음')
    expect(session.desktop.address).toBe(live())
    await until(() => store.value?.address === live(), '옮긴 주소 저장')
    expect(store.value).toMatchObject({ baseUrl: `https://${live()}`, fingerprint: DESKTOP_FP })
    expect(store.value!.addresses![0]).toBe(live())
  })

  it('지문이 바뀌었으면 자동으로 믿지 않는다 — 토큰을 보내지 않고, 저장을 지우고 "다시 짝지으라" 로', async () => {
    const store = await pairedStore()
    store.value = { ...store.value!, fingerprint: OTHER_FP } // 데스크탑을 다시 설치했다 = 인증서 키가 바뀌었다
    native.sent.length = 0
    const again = newLink(store)
    await again.restore()
    await until(() => again.state.phase === 'unpaired', '끊김')
    expect(again.state).toEqual({ phase: 'unpaired', fingerprintChanged: true })
    expect(store.value).toBeUndefined()
    expect(native.sent).toEqual([])
  })

  it('옛 후보 주소에 다른 지문의 서버가 있고(DHCP 로 그 IP 를 옆 PC 가 받았다) 내 데스크탑이 꺼져 있으면 — 짝을 지우지 않고 다시 시도한다', async () => {
    const store = await pairedStore()
    const neighbour = await startFakeDesktop({ port: 0, stepMs: 5, tls: { key: fixture('other.key.pem'), cert: fixture('other.cert.pem') } })
    try {
      const dead = `127.0.0.1:${await closedPort()}`
      const other = `127.0.0.1:${neighbour.port}`
      store.value = { ...store.value!, address: dead, baseUrl: `https://${dead}`, addresses: [dead, other] }
      const saved = store.value
      native.sent.length = 0
      const again = newLink(store)
      await again.restore()
      const { session } = phase(again, 'linked')
      await until(() => session.getStatus().kind === 'reconnecting', '다시 시도 대기')
      expect(again.state.phase).toBe('linked')
      expect(store.value).toEqual(saved)
      expect(native.sent).toEqual([]) // 옆 PC 로 토큰이 가지 않았다
    } finally {
      await neighbour.close()
    }
  })

  it('지금 주소에서 지문이 다르고 다른 후보에도 닿지 못하면 — 그때만 "지문이 달라졌다"', async () => {
    const store = await pairedStore()
    const dead = `127.0.0.1:${await closedPort()}`
    store.value = { ...store.value!, fingerprint: OTHER_FP, addresses: [live(), dead] }
    const again = newLink(store)
    await again.restore()
    await until(() => again.state.phase === 'unpaired', '끊김')
    expect(again.state).toEqual({ phase: 'unpaired', fingerprintChanged: true })
    expect(store.value).toBeUndefined()
  })

  it('https 인데 지문이 없는 저장은 믿지 않는다 (없는 것으로)', async () => {
    const store = memoryStore({ address: live(), baseUrl: `https://${live()}`, deviceId: 'd', token: 't', desktopName: 'pc' })
    const link = newLink(store)
    await link.restore()
    expect(link.state).toEqual({ phase: 'unpaired' })
    expect(native.sent).toEqual([])
  })
})
