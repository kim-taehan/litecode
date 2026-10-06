// 사내망 짝짓기(TLS·QR)에서 폰이 데스크탑에 기대는 계약을 한곳에 모은다. 순수 TS(Node·RN 둘 다).
//
// ⚠️ 위 절반("shared 와 같은 것")은 데스크탑 브랜치(feat_156_remote_tls)의 shared/remote.ts(`PairLink`·`pairUri`·`parsePairUri`·`isLoopbackHost`)와
// shared/remotePairing.ts(`fingerprintCode`)를 **같은 이름·같은 모양으로 옮겨 둔 것**이다 — 이 워크트리의 shared/ 에는 아직 없다.
// 합칠 때 이 절을 지우고 shared 의 것을 다시 내보내면 된다(아래 절과 이 파일을 import 하는 곳은 그대로). 아래 절("폰 쪽")은 남는다.
//
//   QR:   litecode://pair?v=1&d=<desktopId>&n=<PC이름>&a=<ip:port,…>&fp=<SPKI sha256 b64url>&c=<12자 코드>&x=<만료 unix 초>
//   지문: 서버 인증서의 SubjectPublicKeyInfo(DER) SHA-256, base64url(`=` 없음, 43자). 체인은 보지 않는다
//   사람이 맞춰 보는 8자: 그 해시의 앞 40bit 를 Crockford base32 로 — `XXXX-XXXX` (데스크탑 [허용] 창의 "지문" 과 같다)

import { REMOTE_API_VERSION } from '../../../shared/remote.ts'
import { groupCode, normalizePairCode, PAIR_ALPHABET, PAIR_CODE_LENGTH } from '../../../shared/remotePairing.ts'

// ── shared 와 같은 것 (합칠 때 shared/remote.ts · shared/remotePairing.ts 의 것으로 교체) ─────────────────────────

/** 주소의 호스트가 루프백인가 — 데스크탑이 알리는 주소(hello·QR·addresses.changed) 중 이것만 평문 http 다 */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '')
  return bare === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)
}

/** QR 에 싣는 것 — `litecode://pair?v=1&d=…&n=…&a=ip:port,…&fp=…&c=…&x=…` (값은 encodeURIComponent, 순서는 이대로) */
export interface PairLink {
  /** v — REMOTE_API_VERSION */
  version: number
  /** d — hello.desktopId */
  desktopId: string
  /** n — PC 이름 */
  name: string
  /** a — https 로 붙을 주소 (`ip:port`, 쉼표로 이음). 루프백은 싣지 않는다 */
  addresses: string[]
  /** fp — SPKI SHA-256 base64url */
  fingerprint: string
  /** c — 짝짓기 코드 12자 (Crockford base32, 칸 나눔 없음). POST /v1/pair 의 code 에 그대로 */
  code: string
  /** x — 코드 만료 (unix 초) */
  expiresAt: number
}

export const PAIR_URI_PREFIX = 'litecode://pair?'

export function pairUri(link: PairLink): string {
  const fields: [string, string][] = [
    ['v', String(link.version)],
    ['d', link.desktopId],
    ['n', link.name],
    ['a', link.addresses.join(',')],
    ['fp', link.fingerprint],
    ['c', link.code],
    ['x', String(link.expiresAt)],
  ]
  return PAIR_URI_PREFIX + fields.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')
}

/** QR 글을 읽는다 — 모양이 다르면 undefined. `+` 는 공백으로 읽는다. URLSearchParams 없이 (RN 에서 덜 구현돼 있다) */
export function parsePairUri(text: string): PairLink | undefined {
  if (!text.startsWith(PAIR_URI_PREFIX)) return undefined
  const fields = new Map<string, string>()
  try {
    for (const pair of text.slice(PAIR_URI_PREFIX.length).split('&')) {
      const at = pair.indexOf('=')
      if (at > 0) fields.set(pair.slice(0, at), decodeURIComponent(pair.slice(at + 1).replace(/\+/g, ' ')))
    }
  } catch {
    return undefined
  }
  const version = Number(fields.get('v'))
  const expiresAt = Number(fields.get('x'))
  const addresses = (fields.get('a') ?? '').split(',').filter(Boolean)
  const fingerprint = fields.get('fp') ?? ''
  const { d: desktopId = '', n: name = '', c: code = '' } = Object.fromEntries(fields)
  if (!Number.isInteger(version) || !Number.isFinite(expiresAt) || !desktopId || !code || addresses.length === 0 || !/^[A-Za-z0-9_-]{43}$/.test(fingerprint)) return undefined
  return { version, desktopId, name, addresses, fingerprint, code, expiresAt }
}

/** 지문 앞 8자 `XXXX-XXXX` — 지문(base64url) 해시의 앞 40bit 를 Crockford base32 로 */
export function fingerprintCode(fingerprint: string): string {
  const bytes = base64UrlBytes(fingerprint)
  let text = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes.subarray(0, 5)) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      text += PAIR_ALPHABET[(buffer >> bits) & 31]
      buffer &= (1 << bits) - 1
    }
  }
  return groupCode(text)
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function base64UrlBytes(text: string): Uint8Array {
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const symbol of text) {
    const value = BASE64URL.indexOf(symbol)
    if (value < 0) continue
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 255)
      buffer &= (1 << bits) - 1
    }
  }
  return new Uint8Array(bytes)
}

// ── 폰 쪽 (이 파일에 남는다) ──────────────────────────────────────────────────────────────────────────

/** 폰과 PC 시계가 어긋날 수 있다 — 만료를 이만큼 늦게 본다 (코드의 진짜 만료는 데스크탑이 지킨다) */
export const PAIR_CLOCK_SKEW_MS = 60_000

/** not-litecode: 우리 QR 이 아니다 · version: 모르는 형식 버전(앱이 오래됐다) · expired: 만료 · invalid: 필드가 빠졌거나 모양이 틀렸다 */
export type PairQrProblem = 'not-litecode' | 'version' | 'expired' | 'invalid'

export function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
}

/** `host:port` 하나 (IPv4·호스트 이름·`[IPv6]`). 맞으면 소문자로 다듬은 것, 아니면 undefined */
export function parseHostPort(value: string): string | undefined {
  const match = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(value.trim())
  if (!match) return undefined
  const port = Number(match[2])
  if (port < 1 || port > 65535) return undefined
  return `${match[1]!.toLowerCase()}:${port}`
}

/** `host:port` 의 호스트 */
export function hostOf(address: string): string {
  return address.replace(/:\d+$/, '')
}

/**
 * 카메라가 읽은 글을 짝짓기에 쓸 수 있는지 본다 (parsePairUri 위에 폰이 더 보는 것: 버전·만료·주소 모양·코드 12자). now 는 ms.
 * 주소는 겹친 것을 빼고 소문자로 다듬는다
 */
export function readPairQr(text: string, now: number): { ok: true; link: PairLink } | { ok: false; problem: PairQrProblem } {
  const trimmed = text.trim()
  if (!trimmed.startsWith(PAIR_URI_PREFIX)) return { ok: false, problem: 'not-litecode' }
  const link = parsePairUri(trimmed)
  if (!link) return { ok: false, problem: 'invalid' }
  if (link.version !== REMOTE_API_VERSION) return { ok: false, problem: 'version' }
  const addresses: string[] = []
  for (const raw of link.addresses) {
    const address = parseHostPort(raw)
    if (!address) return { ok: false, problem: 'invalid' }
    if (!addresses.includes(address)) addresses.push(address)
  }
  const code = normalizePairCode(link.code)
  if (code.length !== PAIR_CODE_LENGTH || [...code].some((letter) => !PAIR_ALPHABET.includes(letter))) return { ok: false, problem: 'invalid' }
  if (now > link.expiresAt * 1000 + PAIR_CLOCK_SKEW_MS) return { ok: false, problem: 'expired' }
  return { ok: true, link: { ...link, addresses, code } }
}
