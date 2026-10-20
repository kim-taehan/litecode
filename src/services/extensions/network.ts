import os from 'node:os'
import type { ExtensionCallError, ExtensionFetchResponse } from '../../../shared/extensions.ts'

// 확장의 network.fetch (이슈 #536) — iframe 은 CSP 로 직접 네트워크를 못 쓰고, 메인이 대신 요청한다. 허용 목록(origin) 검사는 서비스가 하고,
// 여기는 요청 하나의 규칙만: http/https 만, 기한(요청~본문 끝까지 한 번), 응답 크기 상한(넘으면 끊는다), 리다이렉트는 처음 주소와 같은 origin 만 따라간다
// (다른 origin 으로 가면 허용하지 않은 주소에 닿는다). 리다이렉트는 fetch 가 따라가지 않고 3xx 응답으로 줘야 한다(redirect 'manual').
// 앱에서는 메인이 Chromium 네트워크로 보내는 fetch 를 확장마다 넣는다(electron/extensionFetch.ts — 사내 CA·시스템 프록시, 확장별 session, 쿠키 안 실음).

export interface FetchRequest {
  url: URL
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
}

/** 요청 하나를 보내는 fetch — globalThis.fetch 도 맞는다 */
export type ExtensionFetch = (url: URL, init: { method: string; headers: Record<string, string>; body?: string; redirect?: 'manual'; signal?: AbortSignal }) => Promise<Response>

export interface FetchOptions {
  fetch: ExtensionFetch
  timeoutMs: number
  maxBytes: number
  maxRedirects: number
}

type Failure = { ok: false; error: ExtensionCallError }

/** 패널이 보낸 params → 요청. 모양이 틀리면 params-invalid, 주소가 http/https 가 아니면 url-invalid */
export function parseFetchRequest(params: unknown): { ok: true; request: FetchRequest } | Failure {
  if (typeof params !== 'object' || params === null) return { ok: false, error: 'params-invalid' }
  const { url, method = 'GET', headers = {}, body } = params as Record<string, unknown>
  if (typeof url !== 'string' || (method !== 'GET' && method !== 'POST')) return { ok: false, error: 'params-invalid' }
  if (typeof headers !== 'object' || headers === null || Object.values(headers).some((value) => typeof value !== 'string')) return { ok: false, error: 'params-invalid' }
  if (body !== undefined && (typeof body !== 'string' || method !== 'POST')) return { ok: false, error: 'params-invalid' }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, error: 'url-invalid' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, error: 'url-invalid' }
  return { ok: true, request: { url: parsed, method, headers: headers as Record<string, string>, ...(body !== undefined && { body }) } }
}

/** 앱 자신의 로컬 서버(키 프록시·엔진·데스크탑 MCP·모바일 연결) 주소인가 — 포트가 ports 에 있고 호스트가 루프백이거나 이 기기 주소(self, 모바일 연결은
 *  사설 IP 에서 듣는다). 허용하면 확장이 사용자의 LLM 키로 요청하거나 엔진을 조종할 수 있다. 같은 기기를 가리키는 다른 이름(DNS·mDNS)은 못 가린다 */
export function isAppAddress(url: URL, ports: readonly number[], self: readonly string[]): boolean {
  if (!ports.includes(Number(url.port || (url.protocol === 'https:' ? 443 : 80)))) return false
  const host = url.hostname.replace(/^\[|\]$/g, '') // URL 이 소문자·IPv4 숫자 표기(2130706433 → 127.0.0.1)를 정규화한다
  return host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '0.0.0.0' || host === '::' || host === '::1' || /^::ffff:7f/.test(host) || self.includes(host)
}

/** 이 기기의 네트워크 주소 (isAppAddress 의 self) */
export function selfAddresses(): string[] {
  return Object.values(os.networkInterfaces()).flatMap((entries) => (entries ?? []).map((entry) => entry.address.toLowerCase()))
}

/** 요청 하나 — 던지지 않는다 */
export async function fetchForExtension(request: FetchRequest, options: FetchOptions): Promise<{ ok: true; result: ExtensionFetchResponse } | Failure> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs)
  try {
    let url = request.url
    let method = request.method
    let body = request.body
    for (let hop = 0; ; hop++) {
      const response = await options.fetch(url, { method, headers: request.headers, ...(body !== undefined && { body }), redirect: 'manual', signal: controller.signal })
      const location = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && location !== null) {
        await response.body?.cancel()
        const next = new URL(location, url)
        if (next.origin !== request.url.origin || hop >= options.maxRedirects) return { ok: false, error: 'redirect-blocked' }
        // 303 과 POST 의 301·302 는 GET 으로 (브라우저와 같다)
        if (response.status === 303 || (method === 'POST' && (response.status === 301 || response.status === 302))) {
          method = 'GET'
          body = undefined
        }
        url = next
        continue
      }
      const text = await readLimited(response, options.maxBytes)
      if (text === undefined) {
        controller.abort()
        return { ok: false, error: 'response-too-large' }
      }
      const type = response.headers.get('content-type')
      return { ok: true, result: { status: response.status, headers: type === null ? {} : { 'content-type': type }, body: text } }
    }
  } catch (error) {
    if (timedOut) return { ok: false, error: 'network-timeout' }
    // Chromium 네트워크 오류 이름 (실측 Electron 33: 사내 CA 를 모르는 인증서 → net::ERR_CERT_AUTHORITY_INVALID) — 확장이 "인증서 문제" 를 따로 알릴 수 있게
    return { ok: false, error: /^net::ERR_(CERT_|SSL_|BAD_SSL_)/.test((error as Error).message) ? 'tls-failed' : 'network-failed' }
  } finally {
    clearTimeout(timer)
  }
}

/** 본문을 글로 — 상한을 넘으면 undefined (선언된 길이로 먼저 보고, 읽으면서 다시 본다) */
async function readLimited(response: Response, maxBytes: number): Promise<string | undefined> {
  const declared = Number(response.headers.get('content-length'))
  if (declared > maxBytes) {
    await response.body?.cancel()
    return undefined
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}
