import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fetchForExtension, parseFetchRequest, type FetchOptions } from '../../src/services/extensions/network.ts'

// 확장의 network.fetch (이슈 #536) — 요청 하나의 규칙: http/https 만, 기한, 응답 크기 상한, 같은 origin 리다이렉트만.
// 가짜 서버 둘(127.0.0.1 의 서로 다른 포트 = 서로 다른 origin)에 실제 fetch 로 요청한다

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void

let servers: http.Server[] = []

async function serve(handler: Handler): Promise<string> {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => handler(req, res, body))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

beforeEach(() => {
  servers = []
})
afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

const options: FetchOptions = { fetch: globalThis.fetch, timeoutMs: 2000, maxBytes: 1024, maxRedirects: 3 }

function request(params: unknown) {
  const parsed = parseFetchRequest(params)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.request
}

describe('parseFetchRequest', () => {
  it('http/https 만 — 다른 scheme·주소 아님은 url-invalid', () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/', 'data:text/plain,x', 'javascript:alert(1)', 'not a url']) {
      expect(parseFetchRequest({ url }), url).toEqual({ ok: false, error: 'url-invalid' })
    }
    expect(parseFetchRequest({ url: 'https://sonar.corp.local:9000/api' })).toMatchObject({ ok: true, request: { method: 'GET', headers: {} } })
  })

  it('모양이 틀리면 params-invalid — 메서드는 GET·POST, 헤더는 글, 본문은 POST 의 글만', () => {
    for (const params of [undefined, 'x', { url: 1 }, { url: 'http://a/', method: 'PUT' }, { url: 'http://a/', headers: { a: 1 } }, { url: 'http://a/', body: 'x' }, { url: 'http://a/', method: 'POST', body: {} }]) {
      expect(parseFetchRequest(params), JSON.stringify(params)).toEqual({ ok: false, error: 'params-invalid' })
    }
  })
})

describe('fetchForExtension', () => {
  it('GET — status·content-type·본문 글', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-other': 'hidden' })
      res.end('{"status":"OK"}')
    })
    expect(await fetchForExtension(request({ url: `${base}/api/qualitygates` }), options)).toEqual({
      ok: true,
      result: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"status":"OK"}' },
    })
  })

  it('POST — 헤더와 본문을 싣는다, 4xx 도 결과로 돌려준다', async () => {
    let seen: { method?: string; auth?: string; body?: string } = {}
    const base = await serve((req, res, body) => {
      seen = { method: req.method, auth: req.headers.authorization, body }
      res.writeHead(401)
      res.end('no')
    })
    const result = await fetchForExtension(request({ url: base, method: 'POST', headers: { authorization: 'Bearer t' }, body: 'a=1' }), options)
    expect(seen).toEqual({ method: 'POST', auth: 'Bearer t', body: 'a=1' })
    expect(result).toEqual({ ok: true, result: { status: 401, headers: {}, body: 'no' } })
  })

  it('응답이 상한을 넘으면 response-too-large — 선언된 길이로도, 길이 없이 흘려도', async () => {
    const declared = await serve((_req, res) => {
      res.writeHead(200, { 'content-length': '2048' })
      res.end('x'.repeat(2048))
    })
    const chunked = await serve((_req, res) => {
      res.writeHead(200)
      res.write('x'.repeat(800))
      res.end('x'.repeat(800))
    })
    expect(await fetchForExtension(request({ url: declared }), options)).toEqual({ ok: false, error: 'response-too-large' })
    expect(await fetchForExtension(request({ url: chunked }), options)).toEqual({ ok: false, error: 'response-too-large' })
  })

  it('기한을 넘기면 network-timeout — 머리를 못 받아도, 본문이 멈춰도', async () => {
    const silent = await serve(() => {})
    const stalled = await serve((_req, res) => {
      res.writeHead(200)
      res.write('part')
    })
    const short = { ...options, timeoutMs: 150 }
    expect(await fetchForExtension(request({ url: silent }), short)).toEqual({ ok: false, error: 'network-timeout' })
    expect(await fetchForExtension(request({ url: stalled }), short)).toEqual({ ok: false, error: 'network-timeout' })
  })

  it('같은 origin 리다이렉트는 따라가고, 다른 origin 이면 redirect-blocked — 그쪽에 요청하지 않는다', async () => {
    let otherHit = false
    const other = await serve((_req, res) => {
      otherHit = true
      res.end('other')
    })
    const base = await serve((req, res) => {
      if (req.url === '/start') return void res.writeHead(302, { location: '/end' }).end()
      if (req.url === '/away') return void res.writeHead(302, { location: `${other}/` }).end()
      res.end(`at ${req.url}`)
    })
    expect(await fetchForExtension(request({ url: `${base}/start` }), options)).toMatchObject({ ok: true, result: { status: 200, body: 'at /end' } })
    expect(await fetchForExtension(request({ url: `${base}/away` }), options)).toEqual({ ok: false, error: 'redirect-blocked' })
    expect(otherHit).toBe(false)
  })

  it('리다이렉트가 상한보다 많으면 redirect-blocked', async () => {
    const base = await serve((_req, res) => void res.writeHead(302, { location: '/again' }).end())
    expect(await fetchForExtension(request({ url: base }), options)).toEqual({ ok: false, error: 'redirect-blocked' })
  })

  it('303 은 GET 으로 따라간다 (본문 없이)', async () => {
    const seen: string[] = []
    const base = await serve((req, res, body) => {
      seen.push(`${req.method} ${req.url} ${body}`)
      if (req.url === '/form') return void res.writeHead(303, { location: '/done' }).end()
      res.end('ok')
    })
    await fetchForExtension(request({ url: `${base}/form`, method: 'POST', body: 'a=1' }), options)
    expect(seen).toEqual(['POST /form a=1', 'GET /done '])
  })

  it('TLS 오류(인증서·SSL)는 tls-failed — 그 밖의 연결 실패(network-failed)와 따로 (메시지는 Electron 33 net 실측 2026-10-20: 자체 서명 → net::ERR_CERT_AUTHORITY_INVALID)', async () => {
    const throwing = (message: string): FetchOptions => ({
      ...options,
      fetch: async () => {
        throw new Error(message)
      },
    })
    for (const message of ['net::ERR_CERT_AUTHORITY_INVALID', 'net::ERR_CERT_DATE_INVALID', 'net::ERR_SSL_PROTOCOL_ERROR', 'net::ERR_BAD_SSL_CLIENT_AUTH_CERT']) {
      expect(await fetchForExtension(request({ url: 'https://sonar.corp.local/' }), throwing(message)), message).toEqual({ ok: false, error: 'tls-failed' })
    }
    for (const message of ['net::ERR_NAME_NOT_RESOLVED', 'net::ERR_CONNECTION_REFUSED', 'fetch failed']) {
      expect(await fetchForExtension(request({ url: 'https://sonar.corp.local/' }), throwing(message)), message).toEqual({ ok: false, error: 'network-failed' })
    }
  })

  it('연결할 수 없으면 network-failed — 던지지 않는다', async () => {
    const base = await serve(() => {})
    const closed = servers.pop()!
    closed.closeAllConnections()
    await new Promise((resolve) => closed.close(resolve))
    expect(await fetchForExtension(request({ url: base }), options)).toEqual({ ok: false, error: 'network-failed' })
  })
})
