// 프레임 운반 — `Transport`(request + stream)를 바이트 링크 하나 위에 구현한 것 (이슈 #68, 설계 01ab 5절). fetch 운반(transport.ts) 옆의
// 두 번째 구현이다: 블루투스처럼 소켓이 없는 링크에 `/v1` 을 그대로 싣는다. RemoteClient·Connection·리듀서는 바뀌지 않는다.
// 링크(ByteLink)가 무엇인지는 모른다 — 블루투스 모듈(다음 라운드)이 그 인터페이스를 구현해 넘긴다. 지금은 테스트의 메모리 파이프뿐이다.
//
//   request → REQ {method, path, headers, body} → RES {status, body}
//   stream  → OPEN {…} → RES {status}(200 이면 열렸다) → DATA(SSE 글자)* → END      닫기·기한 초과 → CANCEL
// URL 의 호스트는 뜻이 없다(경로와 쿼리만 쓴다 — `bt://<desktopId>/v1/…`). 링크가 끊기면 프레임 상태를 다 버린다: 기다리던 요청은 실패로,
// 열린 스트림은 오류로 끝난다. 다시 붙는 것은 위층(Connection)의 일이다 — 새 링크로 운반을 새로 만든다.

import { FRAME, FrameChannel, utf8, type ByteLink, type FrameCodec } from '../../../shared/remoteFraming.ts'
import { fflateCodec } from './deflate.ts'
import type { StreamHandlers, Transport, TransportResponse } from './transport.ts'

export interface FramedTransport extends Transport {
  /** 링크가 끊겼다 (다시 쓸 수 없다) */
  readonly closed: boolean
  onClose(listener: (error?: unknown) => void): void
  /** 링크를 끊는다 */
  close(): void
  /** 보낸 것의 통계 (압축 전 바이트·링크에 실린 바이트) */
  readonly stats: FrameChannel['stats']
}

interface PendingRequest {
  resolve(response: TransportResponse): void
  reject(error: unknown): void
  timer: ReturnType<typeof setTimeout> | undefined
}

export function createFramedTransport(link: ByteLink, options: { codec?: FrameCodec } = {}): FramedTransport {
  const requests = new Map<number, PendingRequest>()
  const streams = new Map<number, StreamHandlers>()
  const closeListeners: ((error?: unknown) => void)[] = []
  let nextId = 0

  const channel = new FrameChannel(link, {
    codec: options.codec ?? fflateCodec,
    onMessage({ type, id, body, error }) {
      if (type === FRAME.RES) {
        const parsed = parse(body)
        const request = requests.get(id)
        if (request) {
          requests.delete(id)
          clearTimeout(request.timer)
          if (!parsed) return request.reject(new Error('malformed response'))
          return request.resolve({ status: parsed.status, body: parsed.body === undefined ? '' : JSON.stringify(parsed.body) })
        }
        const stream = streams.get(id)
        if (!stream) return // 이미 거둔 것의 늦은 응답
        stream.onOpen(parsed?.status ?? 0)
        if (parsed?.status === 200) return
        streams.delete(id)
        return stream.onEnd()
      }
      const stream = streams.get(id)
      if (!stream) return
      if (type === FRAME.DATA) return stream.onData(utf8.decode(body))
      if (type === FRAME.END) {
        streams.delete(id)
        stream.onEnd(error ? new Error('stream closed by the desktop') : undefined)
      }
    },
    onClose(error) {
      const failure = error ?? new Error('link closed')
      const waiting = [...requests.values()]
      const open = [...streams.values()]
      requests.clear()
      streams.clear()
      for (const request of waiting) {
        clearTimeout(request.timer)
        request.reject(failure)
      }
      for (const stream of open) stream.onEnd(failure)
      for (const listener of closeListeners) listener(error)
    },
  })

  /** 쓰이고 있지 않은 id (u16) */
  const allocate = (): number => {
    do nextId = (nextId + 1) & 0xffff
    while (requests.has(nextId) || streams.has(nextId))
    return nextId
  }

  const wire = (method: string, url: string, headers: Record<string, string> | undefined, body?: string): Uint8Array => {
    // `scheme://host` 를 떼고 경로·쿼리만 (URL 클래스를 쓰지 않는다 — 글자 그대로 싣는다)
    const path = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').replace(/#.*$/, '') || '/'
    return utf8.encode(JSON.stringify({ method, path, headers: headers ?? {}, ...(body !== undefined && { body }) }))
  }

  return {
    get closed() {
      return channel.closed
    },
    stats: channel.stats,
    onClose: (listener) => void closeListeners.push(listener),
    close: () => channel.close(),

    request({ method, url, headers, body, timeoutMs }) {
      if (channel.closed) return Promise.reject(new Error('link closed'))
      return new Promise<TransportResponse>((resolve, reject) => {
        const id = allocate()
        const timer =
          timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                if (!requests.delete(id)) return
                channel.drop(id) // 아직 못 보낸 요청이면 거둔다
                void channel.send(FRAME.CANCEL, id).catch(() => {})
                reject(new Error('request timed out'))
              }, timeoutMs)
        requests.set(id, { resolve, reject, timer })
        // 보내기가 실패하는 길은 링크 끊김(onClose 가 거절한다)과 기한 초과(위에서 거절했다)뿐이다
        channel.send(FRAME.REQ, id, wire(method, url, headers, body)).catch(() => {})
      })
    },

    stream({ url, headers }, handlers) {
      if (channel.closed) {
        let cancelled = false
        void Promise.resolve().then(() => cancelled || handlers.onEnd(new Error('link closed')))
        return () => {
          cancelled = true
        }
      }
      const id = allocate()
      streams.set(id, handlers)
      channel.send(FRAME.OPEN, id, wire('GET', url, { ...headers, accept: 'text/event-stream' })).catch(() => {})
      return () => {
        if (!streams.delete(id)) return
        channel.drop(id)
        void channel.send(FRAME.CANCEL, id).catch(() => {})
      }
    },
  }
}

function parse(body: Uint8Array): { status: number; body?: unknown } | undefined {
  try {
    const value = JSON.parse(utf8.decode(body)) as { status?: unknown; body?: unknown } | null
    return typeof value?.status === 'number' ? { status: value.status, body: value.body } : undefined
  } catch {
    return undefined
  }
}
