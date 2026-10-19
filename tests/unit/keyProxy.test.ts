import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tr } from '../../src/i18n.ts'
import { startKeyProxy, type KeyProxy, type ProxyTarget } from '../../src/services/keyProxy.ts'
import { proxyTarget } from '../../src/services/engine.ts'
import type { ProviderConfig } from '../../src/services/providers.ts'
import { engineModelId } from '../../shared/engineModelId.ts'

// 키 프록시 단위 테스트 — 외부 프로세스 없이 이 프로세스 안의 127.0.0.1 서버끼리만 돈다.
// 스트리밍·401·키 전달의 실물 확인은 tests/live/engine.live.test.ts.

let proxy: KeyProxy | undefined
let upstream: http.Server | undefined
afterEach(async () => {
  await proxy?.close()
  await new Promise<void>((resolve) => (upstream ? upstream.close(() => resolve()) : resolve()))
  proxy = upstream = undefined
})

async function startUpstream(): Promise<string> {
  upstream = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'))
  await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`
}

describe('startKeyProxy', () => {
  // 03_qa 2차: 헤더에 못 쓰는 문자가 든 키는 http.request 가 ERR_INVALID_CHAR 를 동기로 던졌다 → uncaughtException + 응답 없이 매달림.
  // 저장은 이제 막지만(providers.save) 예전에 저장된 키가 있을 수 있다 — 처리기의 어떤 동기 예외도 502 로 끝나야 한다
  it('저장된 키에 헤더로 못 쓰는 문자가 있어도 502(오류 코드만)로 응답하고, 다음 요청도 받는다', async () => {
    const baseURL = await startUpstream()
    let target: ProxyTarget = { baseURL, apiKey: 'sk-bad\nSECRET' }
    proxy = await startKeyProxy(() => target)
    const call = () =>
      fetch(`${proxy!.baseURLFor('gw')}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${proxy!.token}`, 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5_000), // 매달리면 여기서 실패한다
      })

    const bad = await call()
    expect(bad.status).toBe(502)
    const body = await bad.text()
    expect(body).toContain('ERR_INVALID_CHAR')
    expect(body).not.toContain('SECRET')

    target = { baseURL, apiKey: 'sk-good' }
    expect((await call()).status).toBe(200)
  })

  // 이슈 #231: 키체인이 키를 안 풀어 주면 ctx.providers.apiKey 가 EKEYSTORE 로 던진다 — ERR_PROXY 로 뭉개지 않고 안내 문구·코드를 싣고, 앱 로그에 한 줄
  it('targetOf 가 EKEYSTORE 오류를 던지면 502 에 그 안내 문구·코드를 싣고(ERR_PROXY 아님) console.error 로 코드·경로 앞부분만 한 줄 남긴다', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      proxy = await startKeyProxy(() => {
        throw Object.assign(new Error(tr('error.modelKeyStore')), { code: 'EKEYSTORE' })
      })
      const res = await fetch(`${proxy.baseURLFor('gw')}/chat/completions?x=SECRETQUERY`, {
        method: 'POST',
        headers: { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5_000),
      })
      expect(res.status).toBe(502)
      const body = (await res.json()) as { error: { message: string } }
      expect(body.error.message).toBe(tr('error.proxy', { message: tr('error.modelKeyStore') }))
      expect(body.error.message).toContain('EKEYSTORE')
      expect(body.error.message).not.toContain('ERR_PROXY')
      expect(logged).toHaveBeenCalledTimes(1)
      const line = String(logged.mock.calls[0]![0])
      expect(line).toContain('EKEYSTORE')
      expect(line).toContain('/gw')
      expect(line).not.toContain('SECRETQUERY')
      expect(line).not.toContain(proxy.token)
    } finally {
      logged.mockRestore()
    }
  })
})

// 모델별 "사고 끄기" (이슈 #477) — 사내망 실측: vLLM 게이트웨이에 chat_template_kwargs:{enable_thinking:false} 를 실으면 reasoning 이 꺼진다.
// 프록시가 켠 모델의 chat/completions 본문에만 병합한다. 깨진 본문은 그대로 넘기고(요청을 실패시키지 않는다), 응답은 스트림 그대로
describe('startKeyProxy — 본문에 더할 값 (사고 끄기, 이슈 #477)', () => {
  type Seen = { body: string; contentLength?: string }
  const thinkingOff = (model: string) => (model === 'qwen' ? { model, add: { chat_template_kwargs: { enable_thinking: false } } } : undefined)

  async function echoUpstream(seen: Seen[]): Promise<string> {
    upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        seen.push({ body: Buffer.concat(chunks).toString('utf8'), contentLength: req.headers['content-length'] })
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
      })
    })
    await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`
  }

  async function send(path: string, body: string, contentType = 'application/json'): Promise<Response> {
    return fetch(`${proxy!.baseURLFor('gw')}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy!.token}`, 'content-type': contentType },
      body,
      signal: AbortSignal.timeout(5_000),
    })
  }

  it('켠 모델의 chat/completions 본문에만 enable_thinking=false 를 싣고 content-length 를 다시 센다', async () => {
    const seen: Seen[] = []
    const baseURL = await echoUpstream(seen)
    proxy = await startKeyProxy(() => ({ baseURL, rewrite: thinkingOff }))

    expect((await send('/chat/completions', JSON.stringify({ model: 'qwen', messages: [{ role: 'user', content: '안녕' }] }))).status).toBe(200)
    const sent = JSON.parse(seen[0]!.body)
    expect(sent).toEqual({ model: 'qwen', messages: [{ role: 'user', content: '안녕' }], chat_template_kwargs: { enable_thinking: false } })
    expect(Number(seen[0]!.contentLength)).toBe(Buffer.byteLength(seen[0]!.body))
  })

  it('다른 모델·다른 경로에는 싣지 않는다 (본문 바이트 그대로)', async () => {
    const seen: Seen[] = []
    const baseURL = await echoUpstream(seen)
    proxy = await startKeyProxy(() => ({ baseURL, rewrite: thinkingOff }))
    const other = JSON.stringify({ model: 'llama', messages: [] })
    const elsewhere = JSON.stringify({ model: 'qwen', input: 'x' })

    await send('/chat/completions', other)
    await send('/embeddings', elsewhere)
    expect(seen.map((entry) => entry.body)).toEqual([other, elsewhere])
  })

  it('이미 있는 chat_template_kwargs 의 다른 키는 남긴다', async () => {
    const seen: Seen[] = []
    const baseURL = await echoUpstream(seen)
    proxy = await startKeyProxy(() => ({ baseURL, rewrite: thinkingOff }))

    await send('/chat/completions', JSON.stringify({ model: 'qwen', chat_template_kwargs: { foo: 1, enable_thinking: true } }))
    expect(JSON.parse(seen[0]!.body).chat_template_kwargs).toEqual({ foo: 1, enable_thinking: false })
  })

  it('깨진 JSON·JSON 아닌 본문은 손대지 않고 넘긴다 (content-length 도 맞다)', async () => {
    const seen: Seen[] = []
    const baseURL = await echoUpstream(seen)
    proxy = await startKeyProxy(() => ({ baseURL, rewrite: thinkingOff }))
    const broken = '{"model":"qwen",'
    const text = 'model=qwen'

    expect((await send('/chat/completions', broken)).status).toBe(200)
    expect((await send('/chat/completions', text, 'text/plain')).status).toBe(200)
    expect(seen.map((entry) => entry.body)).toEqual([broken, text])
    for (const entry of seen) expect(Number(entry.contentLength)).toBe(Buffer.byteLength(entry.body))
  })

  it('켠 모델이어도 응답 SSE 는 모으지 않고 흘린다 — 첫 조각이 끝나기 전에 도착한다', async () => {
    let finish!: () => void
    upstream = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: first\n\n')
        finish = () => res.end('data: [DONE]\n\n')
      })
    })
    await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve))
    const baseURL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`
    proxy = await startKeyProxy(() => ({ baseURL, rewrite: thinkingOff }))

    const res = await send('/chat/completions', JSON.stringify({ model: 'qwen', stream: true }))
    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe('data: first\n\n')
    finish()
    let rest = ''
    for (let part = await reader.read(); !part.done; part = await reader.read()) rest += new TextDecoder().decode(part.value)
    expect(rest).toBe('data: [DONE]\n\n')
  })

  it('Expect: 100-continue 요청도 던지지 않고 값을 싣는다 (모으는 요청은 expect 를 넘기지 않는다 — 03_qa 경고)', async () => {
    const seen: Seen[] = []
    const baseURL = await echoUpstream(seen)
    proxy = await startKeyProxy(() => ({ baseURL, rewrite: thinkingOff }))
    const body = JSON.stringify({ model: 'qwen', messages: [] })
    const proxyURL = new URL(`${proxy.baseURLFor('gw')}/chat/completions`)

    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request(
        proxyURL,
        { method: 'POST', headers: { authorization: `Bearer ${proxy!.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), expect: '100-continue' }, timeout: 5_000 },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      request.on('error', reject)
      request.on('timeout', () => request.destroy(new Error('timeout')))
      request.on('continue', () => request.end(body))
      request.flushHeaders()
    })

    expect(status).toBe(200)
    expect(JSON.parse(seen[0]!.body).chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(Number(seen[0]!.contentLength)).toBe(Buffer.byteLength(seen[0]!.body))
  })

  // 이슈 #500: Thinking 모델 — 엔진은 키(디폴트=id, 켬=id--think, 끔=id--nothink)를 보내고, 프록시가 설정(proxyTarget)으로 키를 풀어
  // 켬·끔이면 게이트웨이 이름(id)으로 바꾸고 enable_thinking 을 싣는다. 디폴트는 바이트 그대로
  describe('Thinking 키 → 게이트웨이 id (이슈 #500)', () => {
    const gateway = (baseURL: string): ProviderConfig => ({
      id: 'gw',
      displayName: 'GW',
      baseURL,
      protocol: 'openai-chat-completions',
      models: [{ id: 'qwen', displayName: 'Q', thinking: true }],
    })
    const on = engineModelId({ id: 'qwen' }, 'on')
    const off = engineModelId({ id: 'qwen' }, 'off')

    it('끔 키는 실제 id 로 바꾸고 enable_thinking=false 를 싣는다 (content-length 다시 셈)', async () => {
      const seen: Seen[] = []
      const baseURL = await echoUpstream(seen)
      proxy = await startKeyProxy(() => proxyTarget(gateway(baseURL), undefined))

      await send('/chat/completions', JSON.stringify({ model: off, messages: [{ role: 'user', content: '안녕' }] }))
      expect(JSON.parse(seen[0]!.body)).toEqual({ model: 'qwen', messages: [{ role: 'user', content: '안녕' }], chat_template_kwargs: { enable_thinking: false } })
      expect(Number(seen[0]!.contentLength)).toBe(Buffer.byteLength(seen[0]!.body))
    })

    it('켬 키는 실제 id 로 바꾸고 enable_thinking=true 를 싣는다 — 기존 chat_template_kwargs 의 다른 키는 남긴다', async () => {
      const seen: Seen[] = []
      const baseURL = await echoUpstream(seen)
      proxy = await startKeyProxy(() => proxyTarget(gateway(baseURL), undefined))

      await send('/chat/completions', JSON.stringify({ model: on, chat_template_kwargs: { foo: 1, enable_thinking: false } }))
      expect(JSON.parse(seen[0]!.body)).toEqual({ model: 'qwen', chat_template_kwargs: { foo: 1, enable_thinking: true } })
      expect(Number(seen[0]!.contentLength)).toBe(Buffer.byteLength(seen[0]!.body))
    })

    it('디폴트 키(=id)는 바이트 그대로', async () => {
      const seen: Seen[] = []
      const baseURL = await echoUpstream(seen)
      proxy = await startKeyProxy(() => proxyTarget(gateway(baseURL), undefined))
      const plain = JSON.stringify({ model: 'qwen', messages: [] })

      await send('/chat/completions', plain)
      expect(seen[0]!.body).toBe(plain)
    })
    it('다른 경로·비 JSON·깨진 본문은 바이트 그대로 (content-length 도 맞다)', async () => {
      const seen: Seen[] = []
      const baseURL = await echoUpstream(seen)
      proxy = await startKeyProxy(() => proxyTarget(gateway(baseURL), undefined))
      const elsewhere = JSON.stringify({ model: off, input: 'x' })
      const broken = `{"model":"${off}",`
      const text = `model=${off}`

      await send('/embeddings', elsewhere)
      await send('/chat/completions', broken)
      await send('/chat/completions', text, 'text/plain')
      expect(seen.map((entry) => entry.body)).toEqual([elsewhere, broken, text])
      for (const entry of seen) expect(Number(entry.contentLength)).toBe(Buffer.byteLength(entry.body))
    })
  })
})
