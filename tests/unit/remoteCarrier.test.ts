import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RemoteCarrier, RemoteCarrierStatus, RemoteStreamSink } from '../../src/services/remote/carrier.ts'
import { serveFramed } from '../../src/services/remote/framed.ts'
import { StreamQueue } from '../../src/services/remote/streamQueue.ts'
import { FRAME, FrameChannel, utf8, type FrameMessage } from '../../shared/remoteFraming.ts'
import type { Hello } from '../../shared/remote.ts'
import { zlibCodec } from '../../src/services/remote/framed.ts'
import { memoryPipe } from './support/memoryPipe.ts'
import { box, parseFrames, setUp, start, tearDown, until } from './support/remoteHarness.ts'

// 운반 중립 (이슈 #68, 설계 01ab 5절) — ctx.remote 의 핸들러는 어느 운반으로 온 요청인지 모른다. 여기서는 HTTP 가 아닌 길로 본다:
// 스트림 보내기 큐(밀릴 때 합치기), 운반 등록(carrier), 프레임 운반의 데스크탑 쪽(serveFramed) → 진짜 ctx.remote.

beforeEach(setUp)
afterEach(tearDown)

/** 손으로 움직이는 통로 — write 가 밀렸다고 답하게 하고, drain 을 테스트가 부른다 */
function manualSink(accept = true) {
  const written: string[] = []
  const drains: (() => void)[] = []
  const state = { accept, ended: false as boolean | string, destroyed: false }
  const sink: RemoteStreamSink = {
    write: (text) => (written.push(text), state.accept),
    onDrain: (listener) => void drains.push(listener),
    end: (text) => void (state.ended = text ?? true),
    destroy: () => void (state.destroyed = true),
    onClose: () => {},
  }
  return { sink, written, state, drain: () => drains.forEach((listener) => listener()) }
}

describe('스트림 보내기 큐 — 밀릴 때만 합친다', () => {
  it('통로가 받아 주는 동안은 온 그대로 하나씩 쓴다 (HTTP 가 늘 이렇다)', () => {
    const { sink, written } = manualSink()
    const queue = new StreamQueue(sink)
    queue.push('a1', 'a')
    queue.push('a2', 'a')
    queue.push('x')
    expect(written).toEqual(['a1', 'a2', 'x'])
    expect(queue.stats).toEqual({ pushed: 3, coalesced: 0 })
  })

  it('밀려 있는 동안 같은 열쇠는 최신 하나만 남긴다 — 남은 것은 온 순서(seq 순)를 지키고, 풀리면 한 번에 쓴다', () => {
    const { sink, written, state, drain } = manualSink(false)
    const queue = new StreamQueue(sink)
    queue.push('a1', 'a') // 쓰였다 — 통로가 "밀렸다" 고 답한다
    queue.push('a2', 'a')
    queue.push('b1', 'b')
    queue.push('attention') // 열쇠 없는 것은 합치지 않는다
    queue.push('a3', 'a') // a2 를 밀어낸다 — 자리는 맨 뒤(더 큰 seq 가 앞서면 폰이 뒤의 것을 버린다)
    queue.push('b2', 'b')
    queue.push('ended')
    expect(written).toEqual(['a1'])
    state.accept = true
    drain()
    expect(written).toEqual(['a1', 'attentiona3b2ended'])
    expect(queue.stats).toEqual({ pushed: 7, coalesced: 2 })
    queue.push('a4', 'a')
    expect(written.at(-1)).toBe('a4')
  })

  it('ping 은 밀려 있으면 버린다 (글이 가고 있으니 살아 있다는 신호가 필요 없다). 닫을 때는 밀린 것을 버리고 마지막 글만 보낸다', () => {
    const { sink, written, state, drain } = manualSink(false)
    const queue = new StreamQueue(sink)
    queue.ping(': ping\n\n')
    queue.ping(': ping\n\n')
    queue.push('event')
    expect(written).toEqual([': ping\n\n'])
    queue.end('revoked')
    expect(state.ended).toBe('revoked')
    drain()
    queue.push('late')
    expect(written).toEqual([': ping\n\n'])
  })
})

describe('운반 등록 — ctx.remote.carrier', () => {
  /** 켜고 끈 기록을 남기는 가짜 운반 */
  function fakeCarrier(id: string, fail = false) {
    const calls: string[] = []
    let status: RemoteCarrierStatus = { up: false, addresses: [] }
    const carrier: RemoteCarrier = {
      id,
      async start() {
        calls.push('start')
        status = fail ? { up: false, addresses: [], error: { code: 'ENOBT', message: 'bluetooth is off' } } : { up: true, addresses: [] }
      },
      async stop() {
        calls.push('stop')
        status = { up: false, addresses: [] }
      },
      status: () => status,
    }
    return { carrier, calls }
  }

  it('서비스가 떠 있는 동안 운반을 띄운다 — 올리면 start, 내리면(등록 해제) stop, 서비스가 내려가면 stop', async () => {
    const { remote } = await start()
    const first = fakeCarrier('first')
    const off = remote.carrier(first.carrier)
    await remote.ready()
    expect(first.calls).toEqual(['start'])
    off()
    await remote.ready()
    expect(first.calls).toEqual(['start', 'stop'])
    const second = fakeCarrier('second')
    remote.carrier(second.carrier)
    await remote.ready()
    expect(second.calls).toEqual(['start'])
    await box.cleanups.pop()!() // 서비스를 내린다
    expect(second.calls).toEqual(['start', 'stop'])
    expect(first.calls).toHaveLength(2) // 내린 운반은 더 부르지 않는다
  })

  it('올린 운반은 곧바로 띄우고, 상태가 바뀌었다고 알린다', async () => {
    const { ctx, remote } = await start()
    const seen: number[] = []
    ctx.on('remote/changed', () => void seen.push(1))
    const { carrier, calls } = fakeCarrier('late')
    remote.carrier(carrier)
    await remote.ready()
    expect(calls).toEqual(['start'])
    expect(seen.length).toBeGreaterThan(0)
  })

  it('주소 없는 운반만 떠 있어도 연결은 살아 있다 — 짝짓기를 시작할 수 있고, 한 운반의 사유는 상태에 보인다', async () => {
    const { remote } = await start({ http: false })
    const up = fakeCarrier('pipe')
    const down = fakeCarrier('bt', true)
    remote.carrier(up.carrier)
    remote.carrier(down.carrier)
    await remote.ready()
    expect(remote.status()).toMatchObject({ addresses: [], error: { code: 'ENOBT' } })
    expect(remote.startPairing().pairing?.code).toMatch(/^[0-9A-Z-]{14}$/)
  })

  it('떠 있는 운반이 하나도 없으면 짝짓기를 시작할 수 없다', async () => {
    const { remote } = await start({ http: false })
    expect(() => remote.startPairing()).toThrow()
  })
})

// ── 프레임 운반의 데스크탑 쪽 — 링크 하나에 실려 온 프레임이 ctx.remote.handle 에 닿는다 ──

/** 파이프 건너편의 손으로 쓰는 폰 — 프레임을 직접 보내고 받은 것을 모은다 */
function rawPhone(link: ReturnType<typeof memoryPipe>['a']) {
  const got: FrameMessage[] = []
  let closed = false
  const channel = new FrameChannel(link, { codec: zlibCodec, onMessage: (message) => void got.push(message), onClose: () => (closed = true) })
  const json = (message: FrameMessage | undefined) => (message ? JSON.parse(utf8.decode(message.body)) : undefined)
  return {
    got,
    channel,
    closed: () => closed,
    send: (type: number, id: number, body?: unknown) => channel.send(type, id, body === undefined ? undefined : utf8.encode(JSON.stringify(body))),
    /** 그 id 의 RES 가 올 때까지 */
    async response(id: number): Promise<{ status: number; body: any }> {
      await until(() => got.some((message) => message.type === FRAME.RES && message.id === id), `RES ${id}`)
      return json(got.find((message) => message.type === FRAME.RES && message.id === id))
    },
    /** 그 스트림이 받은 SSE 글 */
    stream: (id: number) => got.filter((message) => message.type === FRAME.DATA && message.id === id).map((message) => utf8.decode(message.body)).join(''),
    ended: (id: number) => got.find((message) => message.type === FRAME.END && message.id === id),
  }
}

describe('프레임 운반 → ctx.remote (HTTP 없이)', () => {
  async function framed(options: { maxChunk?: number } = {}) {
    const desktop = await start()
    const pipe = memoryPipe({ maxChunk: options.maxChunk ?? 185 })
    const server = serveFramed(pipe.b, desktop.remote, { carrier: 'pipe', key: 'link-1' })
    box.cleanups.push(() => server.close())
    return { ...desktop, pipe, server, phone: rawPhone(pipe.a) }
  }

  it('짝짓기·인증·REST 가 HTTP 와 같은 상태 코드·본문으로 돈다', async () => {
    const { remote, phone, save } = await framed()
    await save('c1')
    const code = remote.startPairing().pairing!.code

    await phone.send(FRAME.REQ, 1, { method: 'GET', path: '/v1/hello', headers: {} })
    expect(await phone.response(1)).toEqual({ status: 401, body: { error: 'not a paired device' } })

    await phone.send(FRAME.REQ, 2, { method: 'POST', path: '/v1/pair', headers: {}, body: JSON.stringify({ code, deviceName: 'Pixel', platform: 'android' }) })
    await until(() => remote.status().requests.length === 1, '짝짓기 요청')
    remote.answerPair(remote.status().requests[0]!.id, true)
    const paired = await phone.response(2)
    expect(paired.status).toBe(200)
    const headers = { authorization: `Bearer ${paired.body.token}` }

    await phone.send(FRAME.REQ, 3, { method: 'GET', path: '/v1/hello', headers })
    expect((await phone.response(3)).body as Hello).toMatchObject({ name: 'test-pc', apiVersion: 1 })
    await phone.send(FRAME.REQ, 4, { method: 'GET', path: `/v1/conversations?project=${encodeURIComponent(box.project)}`, headers })
    expect((await phone.response(4)).body).toMatchObject([{ id: 'c1' }])
    await phone.send(FRAME.REQ, 5, { method: 'DELETE', path: '/v1/conversations/c1', headers })
    expect((await phone.response(5)).status).toBe(405)
    await phone.send(FRAME.REQ, 6, { method: 'POST', path: '/v1/conversations/c1/messages', headers, body: '{' })
    expect((await phone.response(6)).status).toBe(400)
    await phone.channel.send(FRAME.REQ, 7, utf8.encode('not json'))
    expect((await phone.response(7)).status).toBe(400)
  })

  it('스트림 — OPEN 에 상태(200)로 답하고 SSE 글자를 DATA 로 흘린다. 인증이 틀리면 상태만 오고 열리지 않는다', async () => {
    const { ctx, remote, phone, pair, save, turn } = await framed({ maxChunk: 20 })
    const { token } = await pair()
    await save('c1')
    await phone.send(FRAME.OPEN, 9, { method: 'GET', path: '/v1/events', headers: { authorization: 'Bearer nope' } })
    expect((await phone.response(9)).status).toBe(401)

    await phone.send(FRAME.OPEN, 10, { method: 'GET', path: '/v1/events', headers: { authorization: `Bearer ${token}` } })
    expect(await phone.response(10)).toEqual({ status: 200 })
    await until(() => parseFrames(phone.stream(10)).length === 1, 'ready')
    expect(parseFrames(phone.stream(10))[0]).toMatchObject({ event: 'ready', seq: undefined })
    await until(() => remote.status().devices[0]!.connected, '연결 표시')

    await ctx.chat.send('c1', { text: '안녕' })
    ;(await turn(1)).finish()
    await until(() => parseFrames(phone.stream(10)).some((frame) => frame.event === 'turn.ended'), 'turn.ended')
    const seqs = parseFrames(phone.stream(10)).slice(1).map((frame) => frame.seq)
    expect(seqs).toEqual(seqs.map((_, index) => index + 1))

    // 폰이 닫는다 (CANCEL) — 데스크탑이 연결 표시를 거둔다
    await phone.channel.send(FRAME.CANCEL, 10)
    await until(() => !remote.status().devices[0]!.connected, '끊김 표시')
  })

  it('해제하면 device.revoked 를 받고 스트림이 끝난다(END). 링크가 끊기면 열린 스트림·기다리던 짝짓기가 걷힌다', async () => {
    const { remote, phone, pair, pipe } = await framed()
    const { token, deviceId } = await pair()
    await phone.send(FRAME.OPEN, 1, { method: 'GET', path: '/v1/events', headers: { authorization: `Bearer ${token}` } })
    await until(() => remote.status().devices[0]?.connected === true, '연결')
    await remote.revoke(deviceId)
    await until(() => phone.ended(1) !== undefined, 'END')
    expect(parseFrames(phone.stream(1)).at(-1)).toMatchObject({ event: 'device.revoked' })
    expect(phone.ended(1)!.error).toBe(false)

    const again = await pair('second')
    await phone.send(FRAME.OPEN, 2, { method: 'GET', path: '/v1/events', headers: { authorization: `Bearer ${again.token}` } })
    const code = remote.startPairing().pairing!.code
    await phone.send(FRAME.REQ, 3, { method: 'POST', path: '/v1/pair', headers: {}, body: JSON.stringify({ code, deviceName: 'x', platform: 'ios' }) })
    await until(() => remote.status().requests.length === 1 && remote.status().devices[0]!.connected, '요청·연결')
    pipe.cut()
    await until(() => remote.status().requests.length === 0 && !remote.status().devices[0]!.connected, '걷힘')
  })

  it('인증 실패 제한의 열쇠는 운반의 peer 다 — 이 링크가 막혀도 HTTP 로 온 요청은 그대로다', async () => {
    const { phone, pair, api } = await framed()
    const { token } = await pair()
    for (let id = 1; id <= 10; id++) {
      await phone.send(FRAME.REQ, id, { method: 'GET', path: '/v1/hello', headers: { authorization: 'Bearer wrong' } })
      expect((await phone.response(id)).status).toBe(401)
    }
    await phone.send(FRAME.REQ, 11, { method: 'GET', path: '/v1/hello', headers: { authorization: `Bearer ${token}` } })
    expect((await phone.response(11)).status).toBe(429)
    expect((await api('GET', '/v1/hello', { token })).status).toBe(200)
  })

  it('폰이 보낸 요청이 상한을 넘으면 링크를 끊는다', async () => {
    const { phone } = await framed({ maxChunk: 512 })
    void phone.send(FRAME.REQ, 1, { method: 'POST', path: '/v1/conversations/c1/messages', headers: {}, body: 'x'.repeat(400 * 1024) }).catch(() => {})
    await until(() => phone.closed(), '끊김')
  })

  it('느린 링크에서 진행 이벤트가 밀리면 같은 진행 줄은 최신 하나로 합친다 — 마지막 모습은 빠짐없이 닿는다', async () => {
    const desktop = await start()
    const { token } = await desktop.pair()
    await desktop.save('c1')
    const pipe = memoryPipe({ maxChunk: 185, bytesPerSecond: 200_000 })
    const server = serveFramed(pipe.b, desktop.remote, { carrier: 'pipe', key: 'slow' })
    box.cleanups.push(() => server.close())
    const phone = rawPhone(pipe.a)
    await phone.send(FRAME.OPEN, 1, { method: 'GET', path: '/v1/events', headers: { authorization: `Bearer ${token}` } })
    await until(() => desktop.remote.status().devices[0]!.connected, '연결')

    await desktop.ctx.chat.send('c1', { text: 'go' })
    const call = await desktop.turn(1)
    // 누적 전체를 300번 — 한 번에 ~20KB 까지 자란다 (합 ~3MB). 링크는 초당 200KB 다
    let answer = ''
    let emitted = 0
    for (let step = 1; step <= 300; step++) {
      answer += `${step} 번째 줄입니다. 답이 조금씩 자랍니다 — the answer keeps growing.\n`
      const item = { kind: 'text' as const, id: 'txt_1', text: answer, done: step === 300 }
      emitted += JSON.stringify(item).length
      call.progress(item)
      if (step % 50 === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    }
    call.finish()
    await until(() => parseFrames(phone.stream(1)).some((frame) => frame.event === 'turn.ended'), 'turn.ended')
    const frames = parseFrames(phone.stream(1))
    const progress = frames.filter((frame) => frame.event === 'turn.progress')
    expect(progress.length).toBeLessThan(60) // 300건이 다 가지 않았다
    expect(progress.at(-1)!.data.item).toEqual({ kind: 'text', id: 'txt_1', text: answer, done: true }) // 마지막 모습은 온전하다
    const seqs = frames.slice(1).map((frame) => frame.seq!)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b)) // seq 는 건너뛰어도 거꾸로 가지 않는다
    expect(pipe.bytes.bToA).toBeLessThan(emitted / 10)
  })
})
