import net from 'node:net'
import os from 'node:os'

// 사내망 주소 (01t 3절 "바인딩") — `0.0.0.0` 을 쓰지 않는다. 사설 IPv4 를 가진 인터페이스의 **주소마다** 듣고,
// 받은 연결도 사설 대역에서 온 것만 통과시킨다. 100.64/10(CGNAT — Tailscale 류 VPN)도 사설로 친다.
// IPv6 는 열지 않는다 (사내망 주소 후보는 IPv4 로 충분하고, 링크 로컬·임시 주소가 자주 바뀐다).

const PRIVATE_RANGES: [string, number][] = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
]

const privateBlock = new net.BlockList()
for (const [network, prefix] of PRIVATE_RANGES) privateBlock.addSubnet(network, prefix, 'ipv4')

/** 사설 대역의 IPv4 인가 (`::ffff:` 로 감싼 IPv4 도) — 그 밖(공인·루프백·링크 로컬·IPv6)은 아니다 */
export function isPrivatePeer(address: string | undefined): boolean {
  if (!address) return false
  const ip = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return net.isIPv4(ip) && privateBlock.check(ip, 'ipv4')
}

/** 지금 이 PC 의 사설 IPv4 주소 — 내부(루프백) 인터페이스는 뺀다. 순서는 인터페이스 순, 겹침 없음.
 *  Windows 의 인터페이스 이름·가상 어댑터(Hyper-V·WSL 의 172.x)도 그대로 들어간다 — 미검증 */
export function privateAddresses(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const found = new Set<string>()
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isPrivatePeer(entry.address)) found.add(entry.address)
    }
  }
  return [...found]
}

/** 모든 주소에서 듣는 값 — 쓰지 않는다 */
export function isUnspecified(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '::0' || host === ''
}
