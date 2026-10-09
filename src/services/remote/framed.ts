import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { FRAME, FrameChannel, utf8, type ByteLink, type FrameCodec, type FrameMessage } from '../../../shared/remoteFraming.ts'
import type { RemoteExchange, RemoteOutcome, RemotePeer, RemoteRequest, RemoteStreamSink } from './carrier.ts'

// 프레이밍의 데스크탑 쪽 (이슈 #68) — 바이트 링크 하나(블루투스 연결 하나)에 실려 온 프레임을 운반 중립 핸들러(ctx.remote.handle)에 잇는다.
// 블루투스 운반 플러그인(다음 라운드)이 연결마다 이것을 하나씩 건다. 여기는 링크가 무엇인지 모른다 — 지금은 테스트의 메모리 파이프뿐이다.
//   REQ {method, path, headers, body}  → handle → RES {status, body}
//   OPEN {…}                           → handle → RES {status}(열렸다) → DATA(SSE 글자)* → END   /  열지 못했으면 RES {status, body} 로 끝
//   CANCEL                             → 그 id 의 요청을 떠난 것으로(signal), 스트림이면 닫는다
// 스트림의 write 는 그 글이 링크에 다 실릴 때까지 "밀렸다"(false) 를 돌려준다 — 그동안 쌓이는 이벤트는 ctx.remote 가 합친다.

/** 폰이 보내는 요청의 상한 (프롬프트 글 하나 — HTTP 운반의 본문 상한과 같은 크기 + JSON 겉) */
const MAX_REQUEST_BYTES = 320 * 1024

/** 데스크탑의 압축 수단 — node:zlib 의 raw deflate (폰은 fflate, 같은 형식) */
export const zlibCodec: FrameCodec = {
  deflate: (data) => plain(deflateRawSync(data)),
  inflate: (data, maxBytes) => plain(inflateRawSync(data, { maxOutputLength: maxBytes })),
}

/** Buffer 가 아닌 Uint8Array 로 (같은 메모리) */
function plain(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length)
}

export interface FramedServer {
  /** 보낸 것의 통계 (FrameChannel.stats) */
  stats: FrameChannel['stats']
  /** 링크를 끊고 돌던 요청·스트림을 거둔다 */
  close(): void
}

interface Handler {
  handle(request: RemoteRequest, peer: RemotePeer, exchange: RemoteExchange): Promise<RemoteOutcome>
}

export function serveFramed(link: ByteLink, remote: Handler, peer: RemotePeer, options: { codec?: FrameCodec } = {}): FramedServer {
  /** id → 돌고 있는 요청(떠났다는 신호)과 열린 스트림(닫혔다는 알림) */
  const open = new Map<number, { abort: AbortController; closeStream?: () => void }>()

  const channel = new FrameChannel(link, {
    codec: options.codec ?? zlibCodec,
    maxMessageBytes: MAX_REQUEST_BYTES,
    // 다음 마이크로태스크에 다룬다 (순서는 그대로) — 보안 링크(SecureLink)는 핸드셰이크 사이에 먼저 온 요청을 쥐고 있다가 이 채널이 듣는 순간,
    // 즉 이 생성자 안에서 넘긴다. 그때 곧바로 다루면 스트림을 여는 요청(OPEN)이 아직 만들어지지 않은 channel 을 건드려 죽는다(TDZ)
    // (이슈 #210 — 블루투스에서 폰은 메시지 2 를 받자마자 보내고, 데스크탑은 메시지 2 를 다 실은 뒤에 이 채널을 붙인다)
    onMessage: (message) => queueMicrotask(() => void receive(message)),
    onClose: () => {
      for (const entry of [...open.values()]) leave(entry)
      open.clear()
    },
  })

  const leave = (entry: { abort: AbortController; closeStream?: () => void }): void => {
    entry.abort.abort()
    entry.closeStream?.()
  }
  const send = (type: number, id: number, body?: unknown, error = false): void =>
    void channel.send(type, id, body === undefined ? undefined : utf8.encode(typeof body === 'string' ? body : JSON.stringify(body)), { error }).catch(() => {})

  const sink = (id: number, entry: { closeStream?: () => void }): RemoteStreamSink => {
    const drains: (() => void)[] = []
    const closes: (() => void)[] = []
    let closed = false
    const close = (): void => {
      if (closed) return
      closed = true
      open.delete(id)
      for (const listener of closes) listener()
    }
    // 상대가 닫았다(CANCEL)·링크가 끊겼다 — 못 보낸 것은 거둔다
    entry.closeStream = () => {
      channel.drop(id)
      close()
    }
    send(FRAME.RES, id, { status: 200 })
    return {
      write(text) {
        if (closed) return false
        channel.send(FRAME.DATA, id, utf8.encode(text)).then(
          () => {
            if (!closed && !channel.busy(id)) for (const listener of drains) listener()
          },
          () => {},
        )
        return false
      },
      onDrain: (listener) => void drains.push(listener),
      end(text) {
        if (closed) return
        if (text !== undefined) send(FRAME.DATA, id, text)
        send(FRAME.END, id)
        close()
      },
      destroy() {
        if (closed) return
        channel.drop(id)
        send(FRAME.END, id, undefined, true)
        close()
      },
      onClose: (listener) => void closes.push(listener),
    }
  }

  async function receive(message: FrameMessage): Promise<void> {
    const { type, id } = message
    if (channel.closed) return // 받은 뒤 다루기 전에 링크가 끊겼다 — 떠난 상대의 요청은 다루지 않는다
    if (type === FRAME.CANCEL) {
      const entry = open.get(id)
      if (!entry) return
      open.delete(id)
      return leave(entry)
    }
    if (type !== FRAME.REQ && type !== FRAME.OPEN) return // PING·모르는 종류는 흘려보낸다
    if (open.has(id)) return send(FRAME.RES, id, { status: 400, body: { error: 'request id in use' } })
    const entry: { abort: AbortController; closeStream?: () => void } = { abort: new AbortController() }
    open.set(id, entry)
    let streaming = false
    let outcome: RemoteOutcome
    try {
      const input = JSON.parse(utf8.decode(message.body)) as { method?: unknown; path?: unknown; headers?: { authorization?: unknown }; body?: unknown }
      if (typeof input?.method !== 'string' || typeof input.path !== 'string') throw new Error('malformed request')
      // 호스트는 뜻이 없다 — 경로와 쿼리만 쓴다
      const url = new URL(input.path, 'bt://desktop')
      outcome = await remote.handle(
        {
          method: input.method,
          path: url.pathname,
          query: url.searchParams,
          headers: { ...(typeof input.headers?.authorization === 'string' && { authorization: input.headers.authorization }) },
          ...(typeof input.body === 'string' && { body: input.body }),
        },
        peer,
        {
          signal: entry.abort.signal,
          openStream: () => {
            if (type !== FRAME.OPEN) throw new Error('not a stream request')
            streaming = true
            return sink(id, entry)
          },
        },
      )
    } catch (error) {
      if (streaming) return entry.closeStream?.()
      outcome = error instanceof SyntaxError || (error as Error).message === 'malformed request' ? { status: 400, body: { error: 'malformed request' } } : { status: 500, body: { error: 'internal error' } }
      if (outcome.status === 500) console.error('[remote] 요청 처리 실패', (error as Error).message)
    }
    if ('stream' in outcome) return
    if (open.get(id) === entry) open.delete(id)
    if (entry.abort.signal.aborted) return // 떠난 상대에게는 답하지 않는다
    send(FRAME.RES, id, { status: outcome.status, body: outcome.body })
  }

  return { stats: channel.stats, close: () => channel.close() }
}
