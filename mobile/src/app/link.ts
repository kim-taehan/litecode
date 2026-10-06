// 데스크탑과의 짝 — 앱이 지금 어느 단계인지(불러오는 중 · 짝 없음 · 허용 대기 · 붙음)와 그 사이의 일(짝짓기·저장·복원·해제).
// 순수 TS 다: 저장소(DesktopStore)와 운반을 받아 쓴다 — 앱은 expo-secure-store·expo/fetch·지문 고정 모듈을(platform.ts), 테스트는 메모리·Node 를 넘긴다.
//
// 원칙(사용자 2026-10-04): 모바일은 데스크탑 기준으로 돈다 — 단독으로 세션을 유지하지 않는다. 짝이 없으면 연결 화면뿐이다.
// 짝짓기 세 갈래 (01t 3절) — 셋 다 마지막은 POST /v1/pair → 데스크탑에서 [허용](최대 60초) → 토큰:
//   QR(pairQr):       QR 의 주소 후보에 핸드셰이크를 병렬로 해 QR 지문과 같은 첫 곳으로 → 그 지문으로 고정. 화면엔 지문 앞 8자
//   직접 입력(https): 처음 본 인증서를 믿는다(TOFU) — 핸드셰이크로 지문을 보고 앞 8자를 크게 띄운다(데스크탑 [허용] 창의 것과 사람이 맞춰 본다)
//   직접 입력(http):  이 컴퓨터 안(에뮬레이터)만 — 평문. 확인 코드는 요청에서 만든 8자(shared/remotePairing.ts confirmCode)
// 붙은 뒤에는 저장한 지문으로만 붙는다. 지문이 바뀌었으면 자동으로 믿지 않고 연결 화면으로 돌아가 다시 짝짓게 한다.

import { confirmCode, normalizePairCode, PAIR_ALPHABET, PAIR_CODE_LENGTH, pairDeviceName } from '../../../shared/remotePairing.ts'
import type { Transport } from '../core/index.ts'
import { fingerprintCode, firstReachable, hostOf, isLoopbackHost as isDesktopLoopback, MAX_ADDRESSES, NetError, netFailure, parseHostPort, readPairQr, RemoteClient, RemoteError, type PinnedNet } from '../core/index.ts'
import { isLoopbackHost, parseAddress } from './address.ts'
import { createRemoteSession } from './remoteSession.ts'
import type { AppSession } from './session.ts'

/** 짝지은 데스크탑 하나 — 이것을 저장해 두고 앱을 다시 켜면 그대로 붙는다 */
export interface SavedDesktop {
  /** 지금(마지막으로 닿은) `host:port` */
  address: string
  /** `http(s)://` + address */
  baseUrl: string
  deviceId: string
  /** 기기 토큰 — 저장소는 Keystore 로 지키는 곳이어야 한다 */
  token: string
  desktopName: string
  /** 데스크탑 인증서 지문(SPKI SHA-256 base64url) — https 면 반드시 있다. 평문(이 컴퓨터 안)이면 없다 */
  fingerprint?: string
  /** 주소 후보 (address 포함) — 데스크탑 IP 가 바뀌면 이것들을 다 시도한다. 옛 저장(평문)에는 없다 */
  addresses?: string[]
}

export interface DesktopStore {
  load(): Promise<SavedDesktop | undefined>
  save(desktop: SavedDesktop): Promise<void>
  clear(): Promise<void>
}

/**
 * 짝짓기가 안 된 사유 — 화면이 각각 다른 문구로 안내한다.
 * bad-address: 주소를 읽을 수 없다 · not-loopback: `http://` 를 이 컴퓨터 밖 주소에 붙였다(요청을 보내지 않는다) · bad-code: 코드가 12자가 아니다 ·
 * no-name: 기기 이름이 비었다 · wrong-code: 코드가 틀렸거나 만료됐다(403) · denied: 데스크탑에서 거절(403) · timeout: 아무도 안 눌렀다(408) ·
 * blocked: 여러 번 틀려 잠시 막혔다(429) · net-timeout: 주소가 답하지 않는다(다른 망·방화벽·클라이언트 격리) ·
 * refused: PC 는 닿았는데 그 포트에 아무도 안 듣는다(모바일 연결이 꺼져 있다) · fingerprint-mismatch: QR 의 지문과 서버 인증서가 다르다 ·
 * qr-foreign: litecode 연결 QR 이 아니다 · qr-version: 모르는 QR 형식(앱이 오래됐다) · qr-expired: QR 이 만료됐다 · qr-invalid: QR 이 깨졌다 ·
 * unreachable: 그 밖으로 닿지 못했다 · failed: 그 밖
 */
export type PairFailure =
  | 'bad-address'
  | 'not-loopback'
  | 'bad-code'
  | 'no-name'
  | 'wrong-code'
  | 'denied'
  | 'timeout'
  | 'blocked'
  | 'net-timeout'
  | 'refused'
  | 'fingerprint-mismatch'
  | 'qr-foreign'
  | 'qr-version'
  | 'qr-expired'
  | 'qr-invalid'
  | 'unreachable'
  | 'failed'

export type LinkState =
  /** 저장된 짝을 읽는 중 (앱을 켠 직후) */
  | { phase: 'loading' }
  /** 짝이 없다 — 연결 화면. failure: 방금 짝짓기가 안 된 사유, revoked: 데스크탑에서 해제됐다, fingerprintChanged: 저장한 지문과 다른 서버만 있었다 */
  | { phase: 'unpaired'; failure?: PairFailure; revoked?: boolean; fingerprintChanged?: boolean }
  /**
   * 짝짓는 중. confirm 이 있으면 요청을 보냈고 데스크탑의 [허용] 을 기다린다 — 데스크탑 창에 뜬 것과 같아야 하는 8자.
   * confirmKind: fingerprint = 인증서 지문 앞 8자(https), code = 요청에서 만든 확인 코드(평문). confirm 이 없으면 아직 데스크탑을 찾는 중
   */
  | { phase: 'pairing'; confirm?: string; confirmKind?: 'fingerprint' | 'code' }
  | { phase: 'linked'; session: AppSession; desktop: SavedDesktop }

export interface PairInput {
  address: string
  code: string
  deviceName: string
}

/** 데스크탑의 답(또는 답 없음)을 사유로 */
export function pairFailure(error: unknown): PairFailure {
  if (!(error instanceof RemoteError)) {
    const failure = netFailure(error)
    return failure === 'timeout' ? 'net-timeout' : failure === 'pin-mismatch' ? 'fingerprint-mismatch' : failure
  }
  if (error.status === 408) return 'timeout'
  if (error.status === 429) return 'blocked'
  // 403 은 둘이다: [거절] 을 눌렀거나, 코드가 틀렸거나(없거나 만료). 본문 글로만 갈린다 — src/services/remote.ts 의 'denied on the desktop'
  if (error.status === 403) return /denied/i.test(error.message) ? 'denied' : 'wrong-code'
  return 'failed'
}

/** 핸드셰이크(지문 보기)의 기한 */
const PROBE_TIMEOUT_MS = 6_000

export class DesktopLink {
  private current: LinkState = { phase: 'loading' }
  private readonly listeners = new Set<() => void>()
  private offSession: (() => void) | undefined

  /** transport: 평문(이 컴퓨터 안) 운반 · pinned: 지문 고정 운반 */
  constructor(private readonly deps: { store: DesktopStore; transport: Transport; pinned: PinnedNet; platform: 'android' | 'ios'; now?: () => number }) {}

  get state(): LinkState {
    return this.current
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 앱을 켰을 때 — 저장된 짝이 있으면 바로 붙는다 */
  async restore(): Promise<void> {
    let saved: SavedDesktop | undefined
    try {
      saved = await this.deps.store.load()
    } catch {
      saved = undefined // 읽지 못한 저장은 없는 것으로 — 다시 짝지으면 덮인다
    }
    if (this.current.phase !== 'loading') return
    // https 인데 지문이 없는 저장은 믿을 근거가 없다 — 없는 것으로
    if (saved && saved.baseUrl.startsWith('https:') && !saved.fingerprint) saved = undefined
    if (saved) this.attach(saved)
    else this.set({ phase: 'unpaired' })
  }

  /** 직접 입력 — 이 컴퓨터 안은 평문, 그 밖은 처음 본 지문을 믿는다(TOFU) */
  async pair(input: PairInput): Promise<void> {
    if (this.current.phase !== 'unpaired') return
    const fail = (failure: PairFailure): void => this.set({ phase: 'unpaired', failure })

    const target = parseAddress(input.address)
    if (!target) return fail('bad-address')
    // 평문으로 코드·토큰이 나가는 길은 이 컴퓨터 안으로만
    if (target.scheme === 'http' && !isLoopbackHost(target.host)) return fail('not-loopback')
    const code = normalizePairCode(input.code)
    if (code.length !== PAIR_CODE_LENGTH || [...code].some((letter) => !PAIR_ALPHABET.includes(letter))) return fail('bad-code')
    const deviceName = pairDeviceName(input.deviceName)
    if (!deviceName) return fail('no-name')

    const { platform } = this.deps
    if (target.scheme === 'http') {
      this.set({ phase: 'pairing', confirm: confirmCode(code, deviceName, platform), confirmKind: 'code' })
      return this.finish({ transport: this.deps.transport, address: target.address, baseUrl: target.baseUrl, code, deviceName, fallbackName: target.address })
    }

    this.set({ phase: 'pairing' })
    let fingerprint: string
    try {
      fingerprint = await this.deps.pinned.probe(target.address, PROBE_TIMEOUT_MS)
    } catch (error) {
      return fail(pairFailure(error))
    }
    this.set({ phase: 'pairing', confirm: fingerprintCode(fingerprint), confirmKind: 'fingerprint' })
    return this.finish({ transport: this.deps.pinned.transport(fingerprint), fingerprint, address: target.address, baseUrl: target.baseUrl, code, deviceName, fallbackName: target.address })
  }

  /** QR 로 — 카메라가 읽은 글 그대로. 지문은 QR 의 것으로 고정하고, 주소 후보 중 그 지문의 서버가 먼저 답한 곳으로 */
  async pairQr(text: string, deviceNameInput: string): Promise<void> {
    if (this.current.phase !== 'unpaired') return
    const fail = (failure: PairFailure): void => this.set({ phase: 'unpaired', failure })

    const parsed = readPairQr(text, (this.deps.now ?? Date.now)())
    if (!parsed.ok) return fail(parsed.problem === 'not-litecode' ? 'qr-foreign' : parsed.problem === 'version' ? 'qr-version' : parsed.problem === 'expired' ? 'qr-expired' : 'qr-invalid')
    const deviceName = pairDeviceName(deviceNameInput)
    if (!deviceName) return fail('no-name')
    const { link } = parsed

    this.set({ phase: 'pairing', confirm: fingerprintCode(link.fingerprint), confirmKind: 'fingerprint' })
    let address: string
    try {
      // 핸드셰이크만 — 페어링 코드는 일회용이라 여러 곳에 보내지 않는다
      ;({ address } = await firstReachable(link.addresses, async (candidate) => {
        const seen = await this.deps.pinned.probe(candidate, PROBE_TIMEOUT_MS)
        if (seen !== link.fingerprint) throw new NetError('pin-mismatch', `fingerprint mismatch at ${candidate}`, seen)
      }))
    } catch (error) {
      return fail(pairFailure(error))
    }
    // QR 의 주소는 호스트가 무엇이든(10.0.2.2 라도) 늘 https + 지문 고정
    return this.finish({
      transport: this.deps.pinned.transport(link.fingerprint),
      fingerprint: link.fingerprint,
      address,
      baseUrl: `https://${address}`,
      addresses: link.addresses,
      code: link.code,
      deviceName,
      fallbackName: link.name || address,
    })
  }

  /** 설정의 "연결 해제" — 저장을 지우고 연결 화면으로. (데스크탑의 기기 목록에서 빼는 것은 데스크탑에서 한다) */
  async disconnect(): Promise<void> {
    this.detach()
    this.set({ phase: 'unpaired' })
    await this.deps.store.clear().catch(() => undefined)
  }

  /** 다 거둔다 (앱이 내려갈 때·테스트) */
  dispose(): void {
    this.detach()
    this.listeners.clear()
  }

  /** 페어링 요청 → [허용] → 저장 → 붙기 */
  private async finish(request: {
    transport: Transport
    fingerprint?: string
    address: string
    baseUrl: string
    addresses?: string[]
    code: string
    deviceName: string
    fallbackName: string
  }): Promise<void> {
    const { platform, store } = this.deps
    const client = new RemoteClient({ transport: request.transport, baseUrl: request.baseUrl })
    try {
      const paired = await client.pair({ code: request.code, deviceName: request.deviceName, platform })
      const hello = await client.hello().catch(() => undefined)
      const saved: SavedDesktop = {
        address: request.address,
        baseUrl: request.baseUrl,
        deviceId: paired.deviceId,
        token: paired.token,
        desktopName: hello?.name ?? request.fallbackName,
      }
      if (request.fingerprint) {
        saved.fingerprint = request.fingerprint
        const told = (hello?.addresses ?? []).map(parseHostPort).filter((address): address is string => address !== undefined && !isDesktopLoopback(hostOf(address)))
        saved.addresses = [...new Set([request.address, ...told, ...(request.addresses ?? [])])].slice(0, MAX_ADDRESSES)
      }
      await store.save(saved)
      this.attach(saved)
    } catch (error) {
      this.set({ phase: 'unpaired', failure: pairFailure(error) })
    }
  }

  private attach(desktop: SavedDesktop): void {
    const session = createRemoteSession({
      transport: desktop.fingerprint ? this.deps.pinned.transport(desktop.fingerprint) : this.deps.transport,
      baseUrl: desktop.baseUrl,
      addresses: desktop.addresses ?? [desktop.address],
      token: desktop.token,
      desktop: { name: desktop.desktopName, address: desktop.address, fingerprint: desktop.fingerprint && fingerprintCode(desktop.fingerprint) },
      // 옮겼거나 새 주소를 배웠다 — 다음에 켤 때 그 주소부터
      onAddresses: (address, addresses) => {
        if (this.current.phase !== 'linked' || this.current.session !== session) return
        const moved: SavedDesktop = { ...desktop, address, baseUrl: desktop.baseUrl.replace(/\/\/.*$/, `//${address}`), addresses }
        this.current = { phase: 'linked', session, desktop: moved }
        void this.deps.store.save(moved).catch(() => undefined)
        this.notify()
      },
    })
    // 데스크탑에서 해제됐다(device.revoked·401) — 토큰은 죽었다. 지문이 바뀌었다 — 믿지 않는다. 둘 다 저장을 지우고 연결 화면으로
    this.offSession = session.subscribe(() => {
      const kind = session.getStatus().kind
      if (kind !== 'revoked' && kind !== 'fingerprint-changed') return
      this.detach()
      this.set(kind === 'revoked' ? { phase: 'unpaired', revoked: true } : { phase: 'unpaired', fingerprintChanged: true })
      void this.deps.store.clear().catch(() => undefined)
    })
    this.set({ phase: 'linked', session, desktop })
  }

  private detach(): void {
    this.offSession?.()
    this.offSession = undefined
    if (this.current.phase === 'linked') this.current.session.dispose()
  }

  private set(state: LinkState): void {
    this.current = state
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
