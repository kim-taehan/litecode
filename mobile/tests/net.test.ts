import { readFileSync } from 'node:fs'
import https from 'node:https'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createNativePinnedNet, firstReachable, NetError, netFailure, RemoteError, RoamingClient, type NativeStreamEvent, type PinnedNetNative, type Transport } from '../src/core/index.ts'
import { nodePinnedNative, spkiFingerprint } from './nodePinned.ts'
import { until } from './support.ts'

// 지문 고정 운반 (src/core/net.ts) — 주소 후보 고르기, 오류 가르기, 네이티브 다리, 그리고 가짜 TLS 서버(자체 서명 + 알려진 SPKI)에 실제로 붙기.

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const DESKTOP = { key: fixture('desktop.key.pem'), cert: fixture('desktop.cert.pem') }
const DESKTOP_FP = spkiFingerprint(DESKTOP.cert)
const OTHER_FP = spkiFingerprint(fixture('other.cert.pem'))

const later = <T>(ms: number, value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), ms))

describe('주소 후보를 병렬로 — 처음 닿은 것', () => {
  it('늦게 적힌 주소라도 먼저 답하면 그것', async () => {
    const result = await firstReachable(['a:1', 'b:1', 'c:1'], (address) => (address === 'a:1' ? later(80, 'a') : address === 'b:1' ? later(5, 'b') : Promise.reject(new NetError('refused', 'x'))))
    expect(result).toEqual({ address: 'b:1', value: 'b' })
  })

  it('다 실패하면 사람에게 말할 하나 — 지문 불일치 > 거부 > 시간 초과 > 그 밖', async () => {
    const fail = (kinds: NetError['kind'][]) => firstReachable(kinds.map((_, index) => `h${index}:1`), (address) => Promise.reject(new NetError(kinds[Number(address.slice(1, -2))]!, address)))
    await expect(fail(['timeout', 'pin-mismatch', 'refused'])).rejects.toMatchObject({ kind: 'pin-mismatch' })
    await expect(fail(['timeout', 'unreachable', 'refused'])).rejects.toMatchObject({ kind: 'refused' })
    await expect(fail(['unreachable', 'timeout'])).rejects.toMatchObject({ kind: 'timeout' })
    await expect(firstReachable([], () => Promise.resolve(1))).rejects.toMatchObject({ kind: 'unreachable' })
  })

  it('데스크탑이 HTTP 로 답한 것(401 등)은 닿은 것 — 다른 후보를 기다리지 않고 그 답을 던진다', async () => {
    const started = Date.now()
    await expect(firstReachable(['a:1', 'b:1'], (address) => (address === 'a:1' ? Promise.reject(new RemoteError(401, 'revoked')) : later(500, 'b')))).rejects.toMatchObject({ status: 401 })
    expect(Date.now() - started).toBeLessThan(400)
  })
})

describe('오류 가르기', () => {
  it('NetError 는 그대로, fetch 의 오류는 글로', () => {
    expect(netFailure(new NetError('pin-mismatch', 'x'))).toBe('pin-mismatch')
    expect(netFailure(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe('timeout')
    expect(netFailure(new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }) }))).toBe('refused')
    expect(netFailure(new TypeError('fetch failed', { cause: Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' }) }))).toBe('unreachable')
    expect(netFailure(new Error('Network request failed'))).toBe('unreachable')
  })
})

describe('네이티브 다리 (createNativePinnedNet) — 가짜 네이티브', () => {
  function fakeNative() {
    const listeners = new Map<string, Set<(event: NativeStreamEvent) => void>>()
    const opened: { id: string; url: string; headers: Record<string, string>; pin: string }[] = []
    const closed: string[] = []
    let requestError: unknown
    const native: PinnedNetNative = {
      probe: () => Promise.reject(Object.assign(new Error('connect failed: ECONNREFUSED'), { code: 'ERR_REFUSED' })),
      request: (_url, _method, _headers, _body, _timeout, pin) => (requestError ? Promise.reject(requestError) : Promise.resolve({ status: 200, body: pin })),
      openStream: (id, url, headers, pin) => void opened.push({ id, url, headers, pin }),
      closeStream: (id) => void closed.push(id),
      addListener(event, listener) {
        const set = listeners.get(event) ?? new Set()
        set.add(listener)
        listeners.set(event, set)
        return { remove: () => set.delete(listener) }
      },
    }
    const emit = (event: string, body: NativeStreamEvent): void => listeners.get(event)?.forEach((listener) => listener(body))
    return { native, opened, closed, emit, failWith: (error: unknown) => (requestError = error) }
  }

  it('요청은 지문을 싣고 간다. 네이티브의 오류 code 는 NetError 로 — 지문 불일치면 실제 지문까지', async () => {
    const fake = fakeNative()
    const transport = createNativePinnedNet(fake.native).transport(DESKTOP_FP)
    expect(await transport.request({ method: 'GET', url: 'https://h:1/v1/hello' })).toEqual({ status: 200, body: DESKTOP_FP })

    fake.failWith(Object.assign(new Error(`certificate fingerprint mismatch: ${OTHER_FP}`), { code: 'ERR_PIN_MISMATCH' }))
    const error = await transport.request({ method: 'GET', url: 'https://h:1/v1/hello' }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(NetError)
    expect(error).toMatchObject({ kind: 'pin-mismatch', actual: OTHER_FP })
    fake.failWith(Object.assign(new Error('timeout'), { code: 'ERR_TIMEOUT' }))
    await expect(transport.request({ method: 'GET', url: 'https://h:1/' })).rejects.toMatchObject({ kind: 'timeout' })
    await expect(createNativePinnedNet(fake.native).probe('10.0.0.5:47600', 100)).rejects.toMatchObject({ kind: 'refused' })
  })

  it('스트림 이벤트를 id 로 가른다 — 닫은 뒤에는 아무것도 안 받는다, 끊김 code 는 NetError', async () => {
    const fake = fakeNative()
    const transport = createNativePinnedNet(fake.native).transport(DESKTOP_FP)
    const seen: string[] = []
    const handlers = (name: string) => ({
      onOpen: (status: number) => seen.push(`${name} open ${status}`),
      onData: (text: string) => seen.push(`${name} data ${text}`),
      onEnd: (error?: unknown) => seen.push(`${name} end ${error instanceof NetError ? error.kind : 'clean'}`),
    })
    const closeA = transport.stream({ url: 'https://h:1/v1/events', headers: { authorization: 'Bearer t' } }, handlers('A'))
    transport.stream({ url: 'https://h:1/v1/events' }, handlers('B'))
    const [a, b] = fake.opened
    expect(a).toMatchObject({ pin: DESKTOP_FP, headers: { authorization: 'Bearer t', accept: 'text/event-stream' } })

    fake.emit('onStreamOpen', { id: a!.id, status: 200 })
    fake.emit('onStreamData', { id: b!.id, text: 'x' })
    fake.emit('onStreamData', { id: a!.id, text: 'y' })
    closeA()
    expect(fake.closed).toEqual([a!.id])
    fake.emit('onStreamData', { id: a!.id, text: 'late' })
    fake.emit('onStreamEnd', { id: a!.id })
    fake.emit('onStreamEnd', { id: b!.id, code: 'ERR_PIN_MISMATCH', message: 'certificate fingerprint mismatch: zzz' })
    fake.emit('onStreamEnd', { id: b!.id }) // 두 번째 끝은 버린다
    expect(seen).toEqual(['A open 200', 'B data x', 'A data y', 'B end pin-mismatch'])
  })
})

describe('가짜 TLS 서버에 실제로 (Node TLS 로 만든 같은 모양의 네이티브)', () => {
  const servers: https.Server[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve)))))
  })

  /** 받은 요청을 세는 https 서버. /sse 는 글 두 조각을 흘리고 연 채로 둔다 */
  async function serve(): Promise<{ address: string; requests: string[] }> {
    const requests: string[] = []
    const server = https.createServer(DESKTOP, (request, response) => {
      requests.push(`${request.method} ${request.url}`)
      if (request.url === '/sse') {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('event: ready\ndata: {"runId":"r","seq":0}\n\n')
        setTimeout(() => response.write(': ping\n\n'), 10)
        return
      }
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ echo: body, auth: request.headers.authorization ?? null }))
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return { address: `127.0.0.1:${(server.address() as net.AddressInfo).port}`, requests }
  }

  it('probe 는 핸드셰이크만으로 서버 지문(SPKI SHA-256)을 본다 — 요청은 하나도 안 간다', async () => {
    const { address, requests } = await serve()
    expect(await createNativePinnedNet(nodePinnedNative()).probe(address, 2_000)).toBe(DESKTOP_FP)
    expect(requests).toEqual([])
  })

  it('지문이 맞으면 요청·스트림이 간다', async () => {
    const { address } = await serve()
    const transport = createNativePinnedNet(nodePinnedNative()).transport(DESKTOP_FP)
    const response = await transport.request({ method: 'POST', url: `https://${address}/v1/pair`, headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: '{"a":1}' })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ echo: '{"a":1}', auth: 'Bearer secret' })

    let text = ''
    let opened = 0
    const close = transport.stream({ url: `https://${address}/sse` }, { onOpen: (status) => (opened = status), onData: (chunk) => (text += chunk), onEnd: () => undefined })
    await until(() => text.includes(': ping'), 'SSE 조각')
    expect(opened).toBe(200)
    expect(text).toContain('event: ready')
    close()
  })

  it('지문이 다르면 요청도 스트림도 **한 바이트도 보내지 않고** pin-mismatch — 토큰이 새지 않는다', async () => {
    const { address, requests } = await serve()
    const native = nodePinnedNative()
    const transport = createNativePinnedNet(native).transport(OTHER_FP)
    const error = await transport.request({ method: 'GET', url: `https://${address}/v1/hello`, headers: { authorization: 'Bearer secret' } }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ kind: 'pin-mismatch', actual: DESKTOP_FP })

    let ended: unknown
    transport.stream({ url: `https://${address}/sse`, headers: { authorization: 'Bearer secret' } }, { onOpen: () => undefined, onData: () => undefined, onEnd: (reason) => (ended = reason ?? 'clean') })
    await until(() => ended !== undefined, '스트림 끝')
    expect(ended).toMatchObject({ kind: 'pin-mismatch' })
    expect(requests).toEqual([])
    expect(native.sent).toEqual([])
  })

  it('http:// 는 지문 고정 운반으로 나가지 않는다', async () => {
    await expect(createNativePinnedNet(nodePinnedNative()).transport(DESKTOP_FP).request({ method: 'GET', url: 'http://127.0.0.1:1/' })).rejects.toBeInstanceOf(NetError)
  })

  it('닿지 못한 이유: 아무도 안 듣는 포트 = refused, TCP 는 받지만 TLS 를 안 하는 곳 = timeout', async () => {
    const closedPort = await new Promise<number>((resolve) => {
      const server = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = server.address() as net.AddressInfo
        server.close(() => resolve(port))
      })
    })
    const pinned = createNativePinnedNet(nodePinnedNative())
    await expect(pinned.probe(`127.0.0.1:${closedPort}`, 1_000)).rejects.toMatchObject({ kind: 'refused' })

    const silent = net.createServer(() => undefined) // 받기만 하고 아무 말도 안 한다
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    try {
      await expect(pinned.probe(`127.0.0.1:${(silent.address() as net.AddressInfo).port}`, 150)).rejects.toMatchObject({ kind: 'timeout' })
    } finally {
      silent.close()
    }
  })
})

describe('주소 배우기 (RoamingClient)', () => {
  it('hello·addresses.changed 로 온 주소를 후보에 더한다 — 지금 주소가 맨 앞, 데스크탑의 루프백은 뺀다, 평문 연결은 배우지 않는다', async () => {
    const seen: string[][] = []
    const transport: Transport = {
      request: async () => ({ status: 200, body: JSON.stringify({ desktopId: 'd', name: 'pc', appVersion: '1', apiVersion: 1, runId: 'r', seq: 0, addresses: ['127.0.0.1:47600', '192.168.0.12:47600'] }) }),
      stream: () => () => undefined,
    }
    const client = new RoamingClient({ transport, baseUrl: 'https://10.8.0.3:47600', token: 't', addresses: ['10.8.0.3:47600'], onAddresses: (current, addresses) => seen.push([current, ...addresses]) })
    await client.hello()
    client.adopt(['192.168.0.30:47600', '[::1]:47600', 'not an address'])
    client.adopt(['192.168.0.30:47600']) // 이미 있다 — 알리지 않는다
    expect(seen).toEqual([
      ['10.8.0.3:47600', '10.8.0.3:47600', '192.168.0.12:47600'],
      ['10.8.0.3:47600', '10.8.0.3:47600', '192.168.0.30:47600', '192.168.0.12:47600'],
    ])

    const plain = new RoamingClient({ transport, baseUrl: 'http://10.0.2.2:47600', token: 't', addresses: ['10.0.2.2:47600'], onAddresses: () => seen.push(['plain']) })
    await plain.hello()
    plain.adopt(['192.168.0.12:47600'])
    expect(seen).toHaveLength(2)
  })
})
