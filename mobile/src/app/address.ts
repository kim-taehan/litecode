// 데스크탑 주소 (순수 함수). **지금은 이 컴퓨터 안(루프백)으로만 붙는다** — 데스크탑이 평문 http 를 127.0.0.1 에만 열기 때문이다.
// 임의 주소에 평문으로 코드·토큰을 보내는 길을 만들지 않는다: 여기서 한 번 막고, APK 의 network security config 가 한 번 더 막는다
// (plugins/withLoopbackCleartext.js — 같은 호스트 목록). 사내망(LAN) 연결은 TLS·지문 고정 라운드에서 연다.

/** 데스크탑의 기본 포트 */
export const DEFAULT_PORT = 47600
/** 입력칸 기본값 — 안드로이드 에뮬레이터에서 본 호스트 PC */
export const DEFAULT_ADDRESS = `10.0.2.2:${DEFAULT_PORT}`

/** 평문 http 를 허용하는 호스트 — 에뮬레이터의 호스트 PC 와 자기 자신. plugins/withLoopbackCleartext.js 의 목록과 같아야 한다 */
export const LOOPBACK_HOSTS: readonly string[] = ['10.0.2.2', '127.0.0.1', 'localhost']

export interface DesktopAddress {
  host: string
  port: number
  /** `host:port` — 저장·표시용 */
  address: string
  /** `http://host:port` */
  baseUrl: string
}

/** 사람이 친 주소(`host`, `host:port`, 앞에 `http://` 가 붙어도 된다)를 읽는다. 읽을 수 없으면 undefined */
export function parseAddress(input: string): DesktopAddress | undefined {
  const match = /^(?:http:\/\/)?([A-Za-z0-9.-]+)(?::(\d{1,5}))?\/?$/.exec(input.trim())
  if (!match) return undefined
  const host = match[1]!.toLowerCase()
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2])
  if (port < 1 || port > 65535) return undefined
  return { host, port, address: `${host}:${port}`, baseUrl: `http://${host}:${port}` }
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.includes(host.toLowerCase())
}
