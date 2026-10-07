// 데스크탑 주소 (순수 함수). 평문 http 는 **이 컴퓨터 안(루프백)으로만** 간다 — 에뮬레이터에서 호스트 PC 의 개발 서버·평문 리스너에 붙을 때.
// 그 밖의 주소는 늘 https + 지문 고정이다(core/net.ts). 임의 주소에 평문으로 코드·토큰을 보내는 길을 만들지 않는다: 여기서 한 번 막고,
// APK 의 network security config 가 한 번 더 막는다 (plugins/withLoopbackCleartext.js — 같은 호스트 목록).

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
  /** http = 평문(루프백에서만 쓸 수 있다) · https = 지문 고정 */
  scheme: 'http' | 'https'
  /** `http(s)://host:port` */
  baseUrl: string
}

/**
 * 사람이 친 주소(`host`, `host:port`, 앞에 `http://`·`https://` 가 붙어도 된다)를 읽는다. 읽을 수 없으면 undefined.
 * 방식을 안 썼으면 루프백은 http(에뮬레이터 개발 흐름 그대로), 그 밖은 https. `http://` 를 루프백 밖에 붙인 것은 부른 쪽이 거절한다
 */
export function parseAddress(input: string): DesktopAddress | undefined {
  const match = /^(?:(https?):\/\/)?([A-Za-z0-9.-]+)(?::(\d{1,5}))?\/?$/i.exec(input.trim())
  if (!match) return undefined
  const host = match[2]!.toLowerCase()
  const port = match[3] === undefined ? DEFAULT_PORT : Number(match[3])
  if (port < 1 || port > 65535) return undefined
  const scheme = match[1] === undefined ? (allowsPlainHttp(host) ? 'http' : 'https') : (match[1].toLowerCase() as 'http' | 'https')
  return { host, port, address: `${host}:${port}`, scheme, baseUrl: `${scheme}://${host}:${port}` }
}

export function allowsPlainHttp(host: string): boolean {
  return LOOPBACK_HOSTS.includes(host.toLowerCase())
}
