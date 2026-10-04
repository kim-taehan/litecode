// 데스크탑과의 짝 — 앱이 지금 어느 단계인지(불러오는 중 · 짝 없음 · 허용 대기 · 붙음)와 그 사이의 일(짝짓기·저장·복원·해제).
// 순수 TS 다: 저장소(DesktopStore)와 transport 를 받아 쓴다 — 앱은 expo-secure-store·expo/fetch 를(platform.ts), 테스트는 메모리·Node fetch 를 넘긴다.
//
// 원칙(사용자 2026-10-04): 모바일은 데스크탑 기준으로 돈다 — 단독으로 세션을 유지하지 않는다. 짝이 없으면 연결 화면뿐이다.
// 짝짓기(01t 3절, 지금은 직접 입력만): 주소 + 코드 12자 + 기기 이름 → POST /v1/pair → 데스크탑에서 [허용](최대 60초) → 토큰.
// 기다리는 동안 양쪽 화면에 같은 확인 코드 8자가 보인다(shared/remotePairing.ts confirmCode).

import { confirmCode, normalizePairCode, PAIR_ALPHABET, PAIR_CODE_LENGTH, pairDeviceName } from '../../../shared/remotePairing.ts'
import { RemoteClient, RemoteError, type Transport } from '../core/index.ts'
import { isLoopbackHost, parseAddress } from './address.ts'
import { createRemoteSession } from './remoteSession.ts'
import type { AppSession } from './session.ts'

/** 짝지은 데스크탑 하나 — 이것을 저장해 두고 앱을 다시 켜면 그대로 붙는다 */
export interface SavedDesktop {
  /** `host:port` */
  address: string
  baseUrl: string
  deviceId: string
  /** 기기 토큰 — 저장소는 Keystore 로 지키는 곳이어야 한다 */
  token: string
  desktopName: string
}

export interface DesktopStore {
  load(): Promise<SavedDesktop | undefined>
  save(desktop: SavedDesktop): Promise<void>
  clear(): Promise<void>
}

/**
 * 짝짓기가 안 된 사유 — 화면이 각각 다른 문구로 안내한다.
 * bad-address: 주소를 읽을 수 없다 · not-loopback: 이 컴퓨터 안 주소가 아니다(요청을 보내지 않는다) · bad-code: 코드가 12자가 아니다 ·
 * no-name: 기기 이름이 비었다 · wrong-code: 코드가 틀렸거나 만료됐다(403) · denied: 데스크탑에서 거절(403) · timeout: 아무도 안 눌렀다(408) ·
 * blocked: 여러 번 틀려 잠시 막혔다(429) · unreachable: 주소에 닿지 못했다 · failed: 그 밖
 */
export type PairFailure = 'bad-address' | 'not-loopback' | 'bad-code' | 'no-name' | 'wrong-code' | 'denied' | 'timeout' | 'blocked' | 'unreachable' | 'failed'

export type LinkState =
  /** 저장된 짝을 읽는 중 (앱을 켠 직후) */
  | { phase: 'loading' }
  /** 짝이 없다 — 연결 화면. failure: 방금 짝짓기가 안 된 사유, revoked: 데스크탑에서 해제됐다 */
  | { phase: 'unpaired'; failure?: PairFailure; revoked?: boolean }
  /** 요청을 보냈고 데스크탑의 [허용] 을 기다린다. confirm 은 데스크탑 창에 뜬 것과 같아야 하는 확인 코드 */
  | { phase: 'pairing'; confirm: string }
  | { phase: 'linked'; session: AppSession; desktop: SavedDesktop }

export interface PairInput {
  address: string
  code: string
  deviceName: string
}

/** 데스크탑의 답(또는 답 없음)을 사유로 */
export function pairFailure(error: unknown): PairFailure {
  if (!(error instanceof RemoteError)) return 'unreachable'
  if (error.status === 408) return 'timeout'
  if (error.status === 429) return 'blocked'
  // 403 은 둘이다: [거절] 을 눌렀거나, 코드가 틀렸거나(없거나 만료). 본문 글로만 갈린다 — src/services/remote.ts 의 'denied on the desktop'
  if (error.status === 403) return /denied/i.test(error.message) ? 'denied' : 'wrong-code'
  return 'failed'
}

export class DesktopLink {
  private current: LinkState = { phase: 'loading' }
  private readonly listeners = new Set<() => void>()
  private offSession: (() => void) | undefined

  constructor(private readonly deps: { store: DesktopStore; transport: Transport; platform: 'android' | 'ios' }) {}

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
    if (saved) this.attach(saved)
    else this.set({ phase: 'unpaired' })
  }

  async pair(input: PairInput): Promise<void> {
    if (this.current.phase !== 'unpaired') return
    const fail = (failure: PairFailure): void => this.set({ phase: 'unpaired', failure })

    const target = parseAddress(input.address)
    if (!target) return fail('bad-address')
    // 평문으로 코드·토큰이 나가는 길은 이 컴퓨터 안으로만
    if (!isLoopbackHost(target.host)) return fail('not-loopback')
    const code = normalizePairCode(input.code)
    if (code.length !== PAIR_CODE_LENGTH || [...code].some((letter) => !PAIR_ALPHABET.includes(letter))) return fail('bad-code')
    const deviceName = pairDeviceName(input.deviceName)
    if (!deviceName) return fail('no-name')

    const { platform, transport, store } = this.deps
    this.set({ phase: 'pairing', confirm: confirmCode(code, deviceName, platform) })
    const client = new RemoteClient({ transport, baseUrl: target.baseUrl })
    try {
      const paired = await client.pair({ code, deviceName, platform })
      const desktopName = await client.hello().then(
        (hello) => hello.name,
        () => target.address,
      )
      const saved: SavedDesktop = { address: target.address, baseUrl: target.baseUrl, deviceId: paired.deviceId, token: paired.token, desktopName }
      await store.save(saved)
      this.attach(saved)
    } catch (error) {
      fail(pairFailure(error))
    }
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

  private attach(desktop: SavedDesktop): void {
    const session = createRemoteSession({ transport: this.deps.transport, baseUrl: desktop.baseUrl, token: desktop.token, desktop: { name: desktop.desktopName, address: desktop.address } })
    // 데스크탑에서 해제됐다(device.revoked·401) — 토큰은 죽었다. 저장을 지우고 연결 화면으로
    this.offSession = session.subscribe(() => {
      if (session.getStatus().kind !== 'revoked') return
      this.detach()
      this.set({ phase: 'unpaired', revoked: true })
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
    for (const listener of this.listeners) listener()
  }
}
