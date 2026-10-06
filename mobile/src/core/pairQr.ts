// 사내망 짝짓기(TLS·QR)에서 폰이 데스크탑에 기대는 계약을 한곳에 모은다. 순수 TS(Node·RN 둘 다).
//
//   QR:   litecode://pair?v=1&d=<desktopId>&n=<PC이름>&a=<ip:port,…>&fp=<SPKI sha256 b64url>&c=<12자 코드>&x=<만료 unix 초>
//   지문: 서버 인증서의 SubjectPublicKeyInfo(DER) SHA-256, base64url(`=` 없음, 43자). 체인은 보지 않는다
//   사람이 맞춰 보는 8자: 그 해시의 앞 40bit 를 Crockford base32 로 — `XXXX-XXXX` (데스크탑 [허용] 창의 "지문" 과 같다)

import { PAIR_URI_PREFIX, parsePairUri, REMOTE_API_VERSION, type PairLink } from '../../../shared/remote.ts'
import { normalizePairCode, PAIR_ALPHABET, PAIR_CODE_LENGTH } from '../../../shared/remotePairing.ts'

// shared 의 것을 그대로 다시 내보낸다 (데스크탑과 같은 코드 — 계약이 어긋나지 않게 한 곳에서만 만든다)
export { isLoopbackHost, pairUri, parsePairUri, PAIR_URI_PREFIX } from '../../../shared/remote.ts'
export type { PairLink } from '../../../shared/remote.ts'
export { fingerprintCode } from '../../../shared/remotePairing.ts'

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
