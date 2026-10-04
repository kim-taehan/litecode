import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { FRAME, FrameChannel, utf8, type ByteLink, type FrameCodec, type FrameMessage } from '../../shared/remoteFraming.ts'
import { memoryPipe } from '../../tests/unit/support/memoryPipe.ts'
import { RemoteClient, RemoteError, createFramedTransport, fflateCodec } from '../src/core/index.ts'

// 프레임 운반의 폰 쪽 (이슈 #68) — `Transport`(request + stream)를 바이트 링크 하나 위에 구현한 것. 링크는 메모리 파이프고,
// 건너편은 테스트가 손으로 쓰는 데스크탑이다 (압축은 데스크탑이 쓰는 node:zlib — 폰의 fflate 와 서로 풀리는지 같이 본다).

const zlib: FrameCodec = {
  deflate: (data) => new Uint8Array(deflateRawSync(data)),
  inflate: (data, maxBytes) => new Uint8Array(inflateRawSync(data, { maxOutputLength: maxBytes })),
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
async function until(done: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 2000 && !done(); tries++) await settle()
  if (!done()) throw new Error(`기다렸지만 오지 않았다: ${what}`)
}

interface Wire {
  method: string
  path: string
  headers: Record<string, string>
  body?: string
}

/** 파이프 건너편의 손으로 쓰는 데스크탑 */
function desk(link: ByteLink) {
  const got: FrameMessage[] = []
  const channel = new FrameChannel(link, { codec: zlib, onMessage: (message) => void got.push(message) })
  const of = (type: number) => got.filter((message) => message.type === type)
  return {
    got,
    channel,
    of,
    request: (index: number, type: number = FRAME.REQ): Wire => JSON.parse(utf8.decode(of(type)[index]!.body)),
    respond: (id: number, status: number, body?: unknown) => channel.send(FRAME.RES, id, utf8.encode(JSON.stringify({ status, body }))),
    data: (id: number, text: string) => channel.send(FRAME.DATA, id, utf8.encode(text)),
  }
}

function setup(options: { maxChunk?: number } = {}) {
  const pipe = memoryPipe({ maxChunk: options.maxChunk ?? 185 })
  const transport = createFramedTransport(pipe.a)
  return { pipe, transport, desktop: desk(pipe.b) }
}

/** 스트림 하나를 열고 받은 것을 적는다 */
function listen(transport: ReturnType<typeof setup>['transport'], url = 'bt://desk/v1/events?run=A&after=5') {
  const seen = { opened: [] as number[], text: '', ended: [] as unknown[] }
  const close = transport.stream(
    { url, headers: { authorization: 'Bearer t' } },
    { onOpen: (status) => void seen.opened.push(status), onData: (text) => void (seen.text += text), onEnd: (error) => void seen.ended.push(error) },
  )
  return { seen, close }
}

describe('프레임 운반 (폰 쪽 Transport)', () => {
  it('요청 — 경로와 쿼리만 실어 보내고(호스트는 뜻이 없다) 상태·본문을 돌려받는다', async () => {
    const { transport, desktop } = setup()
    const answer = transport.request({ method: 'POST', url: 'bt://any-host/v1/conversations/c%201/messages?x=1', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: '{"text":"안녕"}' })
    await until(() => desktop.of(FRAME.REQ).length === 1, 'REQ')
    expect(desktop.request(0)).toEqual({ method: 'POST', path: '/v1/conversations/c%201/messages?x=1', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: '{"text":"안녕"}' })
    await desktop.respond(desktop.of(FRAME.REQ)[0]!.id, 202, { state: 'sent' })
    expect(await answer).toEqual({ status: 202, body: '{"state":"sent"}' })
  })

  it('본문 없는 응답은 빈 글이다. 2xx 가 아니어도 응답이면 풀린다 — RemoteClient 가 RemoteError 로 바꾼다', async () => {
    const { transport, desktop } = setup()
    const client = new RemoteClient({ transport, baseUrl: 'bt://desk', token: 't' })
    const empty = transport.request({ method: 'GET', url: 'bt://desk/v1/x' })
    const hello = client.hello()
    await until(() => desktop.of(FRAME.REQ).length === 2, 'REQ 둘')
    await desktop.respond(desktop.of(FRAME.REQ)[0]!.id, 200)
    await desktop.respond(desktop.of(FRAME.REQ)[1]!.id, 401, { error: 'not a paired device' })
    expect(await empty).toEqual({ status: 200, body: '' })
    await expect(hello).rejects.toMatchObject({ status: 401, message: 'not a paired device' })
    await expect(hello).rejects.toBeInstanceOf(RemoteError)
  })

  it('큰 본문은 양쪽에서 압축돼 가고 원문으로 풀린다 (폰 fflate ↔ 데스크탑 node:zlib)', async () => {
    const { transport, desktop, pipe } = setup({ maxChunk: 512 })
    const prompt = '긴 글을 붙여 넣었다. the quick brown fox jumps over the lazy dog.\n'.repeat(400)
    const snapshot = { history: { messages: Array.from({ length: 300 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `메시지 ${index} — `.repeat(40) })) }, seq: 9 }
    const answer = transport.request({ method: 'POST', url: 'bt://desk/v1/conversations/c1/messages', body: JSON.stringify({ text: prompt, clientMessageId: 'a' }) })
    await until(() => desktop.of(FRAME.REQ).length === 1, 'REQ')
    expect(JSON.parse(desktop.request(0).body!).text).toBe(prompt)
    expect(pipe.bytes.aToB).toBeLessThan(utf8.encode(prompt).length / 10)
    await desktop.respond(desktop.of(FRAME.REQ)[0]!.id, 200, snapshot)
    const received = await answer
    expect(JSON.parse(received.body)).toEqual(snapshot)
    expect(pipe.bytes.bToA).toBeLessThan(received.body.length / 5)
  })

  it('fflate 로 누른 것을 node:zlib 가 풀고, 그 반대도 된다 (raw deflate)', () => {
    const text = utf8.encode('같은 형식이어야 한다 — raw deflate. '.repeat(200))
    expect(zlib.inflate(fflateCodec.deflate(text), 1 << 20)).toEqual(text)
    expect(fflateCodec.inflate(zlib.deflate(text), 1 << 20)).toEqual(text)
    expect(() => fflateCodec.inflate(zlib.deflate(new Uint8Array(100_000)), 1000)).toThrow()
  })

  it('요청 여럿과 스트림이 한 링크에 섞여도 제 짝을 찾는다 — 응답 순서가 뒤바뀌어도', async () => {
    const { transport, desktop } = setup({ maxChunk: 20 })
    const { seen } = listen(transport)
    const answers = [1, 2, 3, 4, 5].map((n) => transport.request({ method: 'GET', url: `bt://desk/v1/item/${n}` }))
    await until(() => desktop.of(FRAME.REQ).length === 5 && desktop.of(FRAME.OPEN).length === 1, '전부 도착')
    const streamId = desktop.of(FRAME.OPEN)[0]!.id
    expect(new Set(desktop.got.map((message) => message.id)).size).toBe(6) // id 가 겹치지 않는다
    await desktop.respond(streamId, 200)
    for (const message of [...desktop.of(FRAME.REQ)].reverse()) {
      void desktop.data(streamId, `event: e\ndata: ${message.id}\n\n`)
      void desktop.respond(message.id, 200, { path: (JSON.parse(utf8.decode(message.body)) as Wire).path })
    }
    expect((await Promise.all(answers)).map((answer) => JSON.parse(answer.body).path)).toEqual([1, 2, 3, 4, 5].map((n) => `/v1/item/${n}`))
    await until(() => seen.text.split('\n\n').length === 6, '스트림 글')
    expect(seen.opened).toEqual([200])
  })

  it('기한 안에 응답이 안 오면 거절하고 데스크탑에 거둔다고 알린다 (CANCEL). 늦게 온 응답은 버린다', async () => {
    const { transport, desktop } = setup()
    await expect(transport.request({ method: 'GET', url: 'bt://desk/v1/slow', timeoutMs: 30 })).rejects.toThrow()
    await until(() => desktop.of(FRAME.CANCEL).length === 1, 'CANCEL')
    const id = desktop.of(FRAME.REQ)[0]!.id
    expect(desktop.of(FRAME.CANCEL)[0]!.id).toBe(id)
    await desktop.respond(id, 200, {})
    // 그 뒤의 요청은 멀쩡하다
    const next = transport.request({ method: 'GET', url: 'bt://desk/v1/next' })
    await until(() => desktop.of(FRAME.REQ).length === 2, '다음 REQ')
    await desktop.respond(desktop.of(FRAME.REQ)[1]!.id, 200, { ok: true })
    expect((await next).body).toBe('{"ok":true}')
  })

  it('스트림 — 열림(상태) → 글 조각 → 끝. 거절당하면 상태만 받고 끝난다', async () => {
    const { transport, desktop } = setup()
    const first = listen(transport)
    await until(() => desktop.of(FRAME.OPEN).length === 1, 'OPEN')
    expect(desktop.request(0, FRAME.OPEN)).toEqual({ method: 'GET', path: '/v1/events?run=A&after=5', headers: { authorization: 'Bearer t', accept: 'text/event-stream' } })
    const id = desktop.of(FRAME.OPEN)[0]!.id
    await desktop.respond(id, 200)
    await desktop.data(id, 'event: ready\ndata: {}\n\n')
    await desktop.data(id, ': ping\n\n')
    await desktop.channel.send(FRAME.END, id)
    await until(() => first.seen.ended.length === 1, '끝')
    expect(first.seen).toEqual({ opened: [200], text: 'event: ready\ndata: {}\n\n: ping\n\n', ended: [undefined] })

    const refused = listen(transport)
    await until(() => desktop.of(FRAME.OPEN).length === 2, 'OPEN 둘')
    await desktop.respond(desktop.of(FRAME.OPEN)[1]!.id, 401, { error: 'not a paired device' })
    await until(() => refused.seen.ended.length === 1, '거절')
    expect(refused.seen).toEqual({ opened: [401], text: '', ended: [undefined] })
  })

  it('내가 닫은 스트림은 CANCEL 을 보내고, 그 뒤로는 아무것도 부르지 않는다. 데스크탑이 끊은 것(ERROR)은 오류로 끝난다', async () => {
    const { transport, desktop } = setup()
    const mine = listen(transport)
    await until(() => desktop.of(FRAME.OPEN).length === 1, 'OPEN')
    const id = desktop.of(FRAME.OPEN)[0]!.id
    await desktop.respond(id, 200)
    await until(() => mine.seen.opened.length === 1, '열림')
    mine.close()
    await until(() => desktop.of(FRAME.CANCEL).length === 1, 'CANCEL')
    await desktop.data(id, 'late\n\n')
    await desktop.channel.send(FRAME.END, id)
    await settle()
    expect(mine.seen).toEqual({ opened: [200], text: '', ended: [] })

    const cut = listen(transport)
    await until(() => desktop.of(FRAME.OPEN).length === 2, 'OPEN 둘')
    const second = desktop.of(FRAME.OPEN)[1]!.id
    await desktop.respond(second, 200)
    await desktop.channel.send(FRAME.END, second, undefined, { error: true })
    await until(() => cut.seen.ended.length === 1, '끊김')
    expect(cut.seen.ended[0]).toBeInstanceOf(Error)
  })

  it('링크가 끊기면 기다리던 요청은 실패로 끝나고 스트림은 오류로 끝난다 — 그 뒤의 요청·스트림도 곧바로 실패다', async () => {
    const { transport, desktop, pipe } = setup()
    const stream = listen(transport)
    const waiting = transport.request({ method: 'GET', url: 'bt://desk/v1/hello', timeoutMs: 10_000 })
    await until(() => desktop.got.length === 2, '도착')
    const closed: unknown[] = []
    transport.onClose((error) => void closed.push(error))
    pipe.cut(new Error('멀어졌다'))
    await expect(waiting).rejects.toThrow('멀어졌다')
    expect(stream.seen.ended).toHaveLength(1)
    expect(stream.seen.ended[0]).toBeInstanceOf(Error)
    expect(closed).toHaveLength(1)
    expect(transport.closed).toBe(true)
    await expect(transport.request({ method: 'GET', url: 'bt://desk/v1/hello' })).rejects.toThrow()
    const late = listen(transport)
    await until(() => late.seen.ended.length === 1, '늦은 스트림')
    expect(late.seen.opened).toEqual([])
  })
})
