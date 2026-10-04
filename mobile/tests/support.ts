import type { RemoteEvent } from '../../shared/remote.ts'
import { FAKE_PAIR_CODE, type FakeDesktop } from '../dev/fake-desktop.mts'
import { createFetchTransport, RemoteClient, type StreamHandlers, type Transport, type TransportRequest, type TransportResponse } from '../src/core/index.ts'

/** 조건이 참이 될 때까지 (진짜 시간) */
export async function until(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`기다렸지만 오지 않았다: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** 가짜 데스크탑에 짝지은 클라이언트 */
export async function pairedClient(desktop: FakeDesktop, transport: Transport = createFetchTransport()): Promise<RemoteClient> {
  const client = new RemoteClient({ transport, baseUrl: desktop.url, sendRetryDelayMs: 0 })
  await client.pair({ code: FAKE_PAIR_CODE, deviceName: 'test', platform: 'android' })
  return client
}

/** 이벤트를 받아 모은다 */
export function collect(client: RemoteClient, from: { run?: string; after?: number } = {}) {
  const events: RemoteEvent[] = []
  let ended = false
  const close = client.events(from, { onEvent: (event) => events.push(event), onEnd: () => (ended = true) })
  return {
    events,
    close,
    ended: () => ended,
    names: () => events.map((event) => event.event),
    has: (name: RemoteEvent['event']) => events.some((event) => event.event === name),
  }
}

/** 손으로 움직이는 transport — 요청은 respond 가 답하고, 스트림은 테스트가 handlers 를 직접 부른다 */
export class ManualTransport implements Transport {
  requests: TransportRequest[] = []
  streams: { url: string; handlers: StreamHandlers; closed: boolean }[] = []
  respond: (request: TransportRequest) => TransportResponse = () => ({ status: 404, body: '{"error":"없다"}' })

  request(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request)
    return Promise.resolve().then(() => this.respond(request))
  }

  stream(request: { url: string }, handlers: StreamHandlers): () => void {
    const stream = { url: request.url, handlers, closed: false }
    this.streams.push(stream)
    return () => {
      stream.closed = true
    }
  }

  /** 마지막으로 연 스트림 */
  get last() {
    return this.streams[this.streams.length - 1]!
  }

  paths(): string[] {
    return this.requests.map((request) => new URL(request.url).pathname)
  }
}

export function sse(event: string, data: unknown, id?: number): string {
  return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}
