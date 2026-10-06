import type { Context } from 'cordis'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { REMOTE_DEFAULT_PORT, type RemoteService } from '../remote.ts'
import type { RemoteCarrierStatus, RemotePeer, RemoteReply, RemoteStreamSink } from './carrier.ts'

// HTTP 운반 (이슈 #68) — ctx.remote 밑의 운반 플러그인 하나다 (`inject: ['remote']`, 자기 ctx 키 없음). 리스너를 열고,
// 받은 요청을 운반 중립 모양으로 바꿔 ctx.remote.handle 에 넘기고, 답을 HTTP 로 싣는다. 계약·인증·짝짓기·이벤트는 모른다.
// HTTP 에만 있는 것은 여기 있다: 리스너·`Origin` 거절(브라우저·DNS rebinding)·본문 상한·SSE 머리.
//
// 이 운반은 **루프백(127.0.0.1) 평문 http 만** 연다(에뮬레이터 확인용). 평문 리스너는 루프백 주소가 아니면 열지 않는다(0.0.0.0·사내망 주소 거절).
// 사내망 주소는 TLS 운반(remote/https.ts)이 연다 — 요청 처리(remoteHandler)는 둘이 같다.
// 모바일 연결이 켜져 있는 동안만 ctx.remote 가 start 한다. 플러그인이 내려가면 포트를 닫는다.

/** 본문 상한 — 프롬프트 글 하나다 */
const MAX_BODY_BYTES = 256 * 1024

/** 리스너 하나 — 평문 http(루프백만) */
export interface RemoteListener {
  host: string
}

export interface RemoteHttpOptions {
  /** 기본 127.0.0.1 하나 */
  listeners?: RemoteListener[]
  /** 기본 47600. 0 이면 빈 포트 (테스트) */
  port?: number
}

/** 요청 하나를 운반 중립 모양으로 바꿔 ctx.remote.handle 에 넘기고 답을 HTTP 로 싣는다 — 평문(이 파일)과 TLS(https.ts)가 같이 쓴다.
 *  peer: 이 요청을 보낸 쪽 (인증 실패 제한의 열쇠·TLS 지문) */
export function remoteHandler(remote: RemoteService, peer: (request: http.IncomingMessage) => RemotePeer): http.RequestListener {
  async function serve(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (request.headers.origin !== undefined) return send(response, { status: 403, body: { error: 'requests with an Origin header are refused' } })
    const raw = await readBody(request)
    if (raw === undefined) return send(response, { status: 413, body: { error: 'body too large' } })
    const url = new URL(request.url ?? '/', 'http://remote')
    const abort = new AbortController()
    // 폰이 응답을 기다리다 끊었다
    response.on('close', () => {
      if (!response.writableEnded) abort.abort()
    })
    const outcome = await remote.handle(
      { method: request.method ?? '', path: url.pathname, query: url.searchParams, headers: { authorization: request.headers.authorization }, ...(raw && { body: raw }) },
      peer(request),
      { signal: abort.signal, openStream: () => sseSink(response) },
    )
    if (!('stream' in outcome)) send(response, outcome)
  }
  return (request, response) => {
    serve(request, response).catch((failure: unknown) => {
      console.error('[remote] 요청 처리 실패', (failure as Error).message)
      if (!response.headersSent) send(response, { status: 500, body: { error: 'internal error' } })
      else response.destroy()
    })
  }
}

/** 서버 하나를 그 주소에서 듣게 한다 — 못 열면 던진다. 연 뒤의 오류는 기록만 */
export function listenOn(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      server.on('error', (failure) => console.error('[remote] 서버 오류', failure.message))
      resolve((server.address() as AddressInfo).port)
    })
  })
}

/** `ip:port` — IPv6 는 `[ip]:port` */
export function hostPort(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`
}

export function RemoteHttp(ctx: Context, options: RemoteHttpOptions = {}): void {
  const remote = ctx.remote // 내려가는 중엔 ctx.remote 를 못 꺼낸다 — 올라올 때 쥔다
  let servers: http.Server[] = []
  let addresses: string[] = []
  let error: RemoteCarrierStatus['error']
  const serve = remoteHandler(remote, (request) => ({ carrier: 'http', key: request.socket.remoteAddress ?? '' }))

  ctx.effect(() =>
    remote.carrier({
      id: 'http',
      async start() {
        error = undefined
        const opened: http.Server[] = []
        const listening: string[] = []
        let port = options.port ?? REMOTE_DEFAULT_PORT
        try {
          for (const { host } of options.listeners ?? [{ host: '127.0.0.1' }]) {
            // 평문은 루프백만 — 사내망 주소는 TLS 리스너(다음 라운드)로만 연다
            if (!isLoopback(host)) throw Object.assign(new Error(`plain http is loopback-only: ${host}`), { code: 'ENOTLOOPBACK' })
            const server = http.createServer(serve)
            opened.push(server)
            port = await listenOn(server, port, host)
            listening.push(hostPort(host, port))
          }
        } catch (failure) {
          await Promise.all(opened.map(closeServer))
          const { code, message } = failure as NodeJS.ErrnoException
          error = { ...(code && { code }), message }
          return
        }
        servers = opened
        addresses = listening
      },
      async stop() {
        error = undefined
        const closing = servers
        servers = []
        addresses = []
        await Promise.all(closing.map(closeServer))
      },
      status: () => ({
        up: servers.length > 0,
        addresses,
        port: (servers[0]?.address() as AddressInfo | null | undefined)?.port ?? options.port ?? REMOTE_DEFAULT_PORT,
        ...(error && { error }),
      }),
    }),
  )
}
RemoteHttp.inject = ['remote']

/** 이벤트 스트림 — SSE 머리를 쓰고 응답을 통로로 내준다. 밀림은 소켓의 것 그대로(write 가 false → 'drain') */
function sseSink(response: http.ServerResponse): RemoteStreamSink {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  return {
    write: (text) => response.write(text),
    onDrain: (listener) => void response.on('drain', listener),
    end: (text) => void (text === undefined ? response.end() : response.end(text)),
    destroy: () => void response.destroy(),
    onClose: (listener) => void response.on('close', listener),
  }
}

function isLoopback(host: string): boolean {
  return host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

function send(response: http.ServerResponse, { status, body, headers }: RemoteReply): void {
  if (response.headersSent || response.destroyed) return
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers })
  response.end(text)
}

/** 본문 — 상한을 넘으면 undefined. 넘친 뒤에는 쌓지 않고 흘려보내기만 한다(끝까지 받아야 응답을 곱게 보낸다) */
async function readBody(request: http.IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size <= MAX_BODY_BYTES) chunks.push(chunk as Buffer)
  }
  return size > MAX_BODY_BYTES ? undefined : Buffer.concat(chunks).toString('utf8')
}

export function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve()
    server.close(() => resolve())
    server.closeAllConnections()
  })
}
