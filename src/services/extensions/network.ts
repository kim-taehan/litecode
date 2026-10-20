import type { ExtensionCallError, ExtensionFetchResponse } from '../../../shared/extensions.ts'

// 확장의 network.fetch (이슈 #536) — iframe 은 CSP 로 직접 네트워크를 못 쓰고, 메인이 대신 요청한다. 허용 목록(origin) 검사는 서비스가 하고,
// 여기는 요청 하나의 규칙만: http/https 만, 기한(요청~본문 끝까지 한 번), 응답 크기 상한(넘으면 끊는다), 리다이렉트는 처음 주소와 같은 origin 만 따라간다
// (다른 origin 으로 가면 허용하지 않은 주소에 닿는다). 쿠키·자격 증명은 싣지 않는다(Node fetch 는 쿠키 저장소가 없다).

export interface FetchRequest {
  url: URL
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
}

export interface FetchOptions {
  fetch: typeof globalThis.fetch
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
  } catch {
    return { ok: false, error: timedOut ? 'network-timeout' : 'network-failed' }
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
