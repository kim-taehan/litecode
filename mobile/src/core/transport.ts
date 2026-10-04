// 전송 계층 — 연결 코어가 네트워크를 쓰는 유일한 문. 요청 하나 + 스트림(SSE) 하나, 이 두 함수가 전부다.
// 지금 구현은 fetch 하나(평문·시스템 신뢰). 데스크탑의 자체 서명 인증서를 지문으로 고정하는 네이티브 모듈(pinned-net —
// Android OkHttp, 01t 7절)은 다음 라운드에 **이 인터페이스의 다른 구현**으로 끼운다. 코어의 나머지는 바뀌지 않는다.

export interface TransportRequest {
  method: 'GET' | 'POST'
  /** 절대 URL */
  url: string
  headers?: Record<string, string>
  body?: string
  /** 이 시간 안에 응답이 다 안 오면 거절한다 */
  timeoutMs?: number
}

export interface TransportResponse {
  status: number
  body: string
}

export interface StreamHandlers {
  /** 응답 머리가 왔다 */
  onOpen(status: number): void
  /** 본문 조각 (글자로 풀린 것 — 줄 경계와 무관하게 잘려 온다) */
  onData(text: string): void
  /** 스트림이 끝났다 — 서버가 닫았거나(error 없음) 끊겼다. 정확히 한 번. 내가 닫은(close) 뒤에는 부르지 않는다 */
  onEnd(error?: unknown): void
}

export interface Transport {
  /** 상태 코드와 무관하게 응답이 오면 resolve, 닿지 못하면(연결 실패·시간 초과) reject */
  request(request: TransportRequest): Promise<TransportResponse>
  /** GET 스트림을 연다. 돌려준 함수를 부르면 닫는다 */
  stream(request: { url: string; headers?: Record<string, string> }, handlers: StreamHandlers): () => void
}

/** fetch 중 우리가 쓰는 만큼 — 전역 fetch(Node) 와 `expo/fetch` 둘 다 맞는다 */
export type FetchLike = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; text(): Promise<string>; body: ReadableStream<Uint8Array> | null }>

/**
 * fetch 로 만든 transport. React Native 의 기본 fetch 는 응답 본문을 스트림으로 주지 않는다 — 앱에서는 `expo/fetch` 의 fetch 를 넘긴다.
 * Node(테스트·가짜 데스크탑)에서는 전역 fetch 그대로.
 */
export function createFetchTransport(fetchImpl: FetchLike = fetch as FetchLike): Transport {
  return {
    async request({ method, url, headers, body, timeoutMs }) {
      const abort = new AbortController()
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => abort.abort(), timeoutMs)
      try {
        const response = await fetchImpl(url, { method, headers, body, signal: abort.signal })
        return { status: response.status, body: await response.text() }
      } finally {
        clearTimeout(timer)
      }
    },

    stream({ url, headers }, handlers) {
      const abort = new AbortController()
      let closed = false
      const end = (error?: unknown): void => {
        if (closed) return
        closed = true
        abort.abort()
        handlers.onEnd(error)
      }
      void (async () => {
        try {
          const response = await fetchImpl(url, { method: 'GET', headers: { ...headers, accept: 'text/event-stream' }, signal: abort.signal })
          if (closed) return
          handlers.onOpen(response.status)
          if (response.status !== 200 || !response.body) return end()
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          for (;;) {
            const { done, value } = await reader.read()
            if (closed) return
            if (done) return end()
            handlers.onData(decoder.decode(value, { stream: true }))
          }
        } catch (error) {
          end(error)
        }
      })()
      return () => {
        closed = true
        abort.abort()
      }
    },
  }
}
