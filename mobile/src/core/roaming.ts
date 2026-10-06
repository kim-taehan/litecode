// 주소를 옮겨 다니는 클라이언트 — 데스크탑의 IP 가 바뀌어도(와이파이 ↔ VPN, DHCP) 같은 지문의 데스크탑을 다시 찾는다 (01t 4절).
// 붙을 때마다 첫 호출이 hello 다(Connection.connect). 그래서 hello 하나만 넓힌다: 지금 주소가 닿지 않으면 다른 후보를 **병렬로** 시도해
// 처음 닿은 곳으로 옮긴다. 닿은 hello 의 addresses 로 새 후보를 배운다. 어느 주소든 운반이 지문을 대조하므로 후보를 넓혀도 안전하다.

import type { Hello } from '../../../shared/remote.ts'
import { RemoteClient, RemoteError, type RemoteClientOptions } from './client.ts'
import { firstReachable, worstFailure } from './net.ts'
import { hostOf, isLoopbackHost, parseHostPort } from './pairQr.ts'

/** 쥐고 있을 후보 수 — 오래된 것부터 버린다 */
export const MAX_ADDRESSES = 8

export interface RoamingClientOptions extends RemoteClientOptions {
  /** 후보 `host:port` — 맨 앞이 지금 주소(baseUrl) */
  addresses: readonly string[]
  /** 후보가 바뀌었다(옮겼거나 새로 배웠다) — 저장하라. current 가 지금 주소 */
  onAddresses?(current: string, addresses: string[]): void
}

export class RoamingClient extends RemoteClient {
  private candidates: string[]
  private readonly scheme: string
  private readonly onAddresses: RoamingClientOptions['onAddresses']

  constructor(options: RoamingClientOptions) {
    super(options)
    this.scheme = /^https:/.test(this.baseUrl) ? 'https' : 'http'
    this.candidates = [...options.addresses]
    this.onAddresses = options.onAddresses
  }

  get address(): string {
    return this.baseUrl.replace(/^https?:\/\//, '')
  }

  get addresses(): readonly string[] {
    return this.candidates
  }

  override async hello(): Promise<Hello> {
    const before = this.address
    let hello: Hello
    try {
      hello = await super.hello()
    } catch (error) {
      if (error instanceof RemoteError) throw error // 닿았다 — 401(해제) 등은 그대로
      const others = this.candidates.filter((address) => address !== before)
      if (others.length === 0) throw error
      let found: { address: string; value: Hello }
      try {
        found = await firstReachable(others, (address) => this.helloAt(address))
      } catch (raceError) {
        throw raceError instanceof RemoteError ? raceError : worstFailure([error, raceError])
      }
      this.baseUrl = `${this.scheme}://${found.address}`
      hello = found.value
    }
    this.learn(hello.addresses ?? [])
    return hello
  }

  /** 데스크탑이 듣는 주소가 바뀌었다 (SSE `addresses.changed`) — 후보에 더한다 */
  adopt(addresses: readonly string[]): void {
    this.learn(addresses)
  }

  private helloAt(address: string): Promise<Hello> {
    return new RemoteClient({ transport: this.transport, baseUrl: `${this.scheme}://${address}`, token: this.token }).hello()
  }

  /** 지금 주소를 맨 앞에, 데스크탑이 알려 준 주소를 그다음에, 옛 후보를 뒤에 */
  private learn(addresses: readonly string[]): void {
    // 평문(이 컴퓨터 안)은 주소를 배우지 않는다 — 평문으로 다른 주소에 토큰을 보내지 않는다.
    // 데스크탑의 루프백 주소(평문 리스너)는 폰에서 뜻이 없다 — 빼 둔다
    const told =
      this.scheme === 'https'
        ? addresses.map(parseHostPort).filter((address): address is string => address !== undefined && !isLoopbackHost(hostOf(address)))
        : []
    const next = [...new Set([this.address, ...told, ...this.candidates])].slice(0, MAX_ADDRESSES)
    if (next.length === this.candidates.length && next.every((address, index) => address === this.candidates[index])) return
    this.candidates = next
    this.onAddresses?.(this.address, next)
  }
}
