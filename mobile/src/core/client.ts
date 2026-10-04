// remote client — shared/remote.ts 계약의 REST 호출과 이벤트 구독. 상태를 쥐지 않는다(주소·토큰뿐). 화면·React 를 모른다.

import {
  remotePath,
  type AttentionReplyResponse,
  type ConversationSnapshot,
  type CreateConversationRequest,
  type Hello,
  type PairRequest,
  type PairResponse,
  type QueueTakeResponse,
  type RemoteConversation,
  type RemoteEvent,
  type RemoteModel,
  type RemoteProject,
  type SendMessageRequest,
  type SendMessageResponse,
  type StopResponse,
} from '../../../shared/remote.ts'
import type { AttentionAnswer } from '../../../shared/contract.ts'
import { SseParser } from './sse.ts'
import type { Transport } from './transport.ts'

/** 데스크탑이 2xx 가 아닌 답을 했다. 닿지 못한 것(연결 실패·시간 초과)은 이것이 아니라 transport 의 오류 그대로다 */
export class RemoteError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'RemoteError'
    this.status = status
  }
}

export interface RemoteClientOptions {
  transport: Transport
  /** `http(s)://ip:port` */
  baseUrl: string
  /** 기기 토큰 — 페어링 전이면 없다 (pair 가 받으면 채운다) */
  token?: string
  /** 보통 요청의 기한 (기본 10초) */
  requestTimeoutMs?: number
  /** 보내기가 닿지 못했을 때 같은 clientMessageId 로 다시 보내는 횟수(기본 2)와 그 사이 간격(기본 500ms) */
  sendRetries?: number
  sendRetryDelayMs?: number
}

export interface EventHandlers {
  /** 구독이 열렸다 (200) */
  onOpen?(): void
  /** 바이트가 왔다 — ping 포함. 무응답 판정에 쓴다 */
  onActivity?(): void
  onEvent(event: RemoteEvent): void
  /** 스트림이 끝났다. 서버가 거절했으면 RemoteError(401 = 해제됨) */
  onEnd(error?: unknown): void
}

/** 데스크탑 [허용] 을 기다리는 롱폴(최대 60초)보다 길게 */
const PAIR_TIMEOUT_MS = 65_000

export class RemoteClient {
  token: string | undefined
  private readonly transport: Transport
  private readonly baseUrl: string
  private readonly requestTimeoutMs: number
  private readonly sendRetries: number
  private readonly sendRetryDelayMs: number

  constructor(options: RemoteClientOptions) {
    this.transport = options.transport
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.token = options.token
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000
    this.sendRetries = options.sendRetries ?? 2
    this.sendRetryDelayMs = options.sendRetryDelayMs ?? 500
  }

  /** 짝짓기 — 받은 토큰을 이 클라이언트에 채운다. 저장(Keystore)은 부른 쪽 몫 */
  async pair(request: PairRequest): Promise<PairResponse> {
    const paired = await this.call<PairResponse>('POST', remotePath.pair, request, PAIR_TIMEOUT_MS)
    this.token = paired.token
    return paired
  }

  hello(): Promise<Hello> {
    return this.call('GET', remotePath.hello)
  }

  projects(): Promise<RemoteProject[]> {
    return this.call('GET', remotePath.projects)
  }

  conversations(project: string): Promise<RemoteConversation[]> {
    return this.call('GET', `${remotePath.conversations}?project=${encodeURIComponent(project)}`)
  }

  createConversation(request: CreateConversationRequest): Promise<RemoteConversation> {
    return this.call('POST', remotePath.conversations, request)
  }

  conversation(cid: string): Promise<ConversationSnapshot> {
    return this.call('GET', remotePath.conversation(cid))
  }

  /**
   * 보내기. 닿지 못했으면(응답을 못 받았으면) **같은 clientMessageId 로** 다시 보낸다 — 첫 요청이 사실은 도착했더라도 데스크탑이
   * 같은 id 를 한 턴으로 본다. 데스크탑이 거절한 것(RemoteError)은 다시 보내지 않는다.
   */
  async send(cid: string, request: SendMessageRequest): Promise<SendMessageResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.call<SendMessageResponse>('POST', remotePath.messages(cid), request)
      } catch (error) {
        if (error instanceof RemoteError || attempt >= this.sendRetries) throw error
        await new Promise((resolve) => setTimeout(resolve, this.sendRetryDelayMs))
      }
    }
  }

  stop(cid: string): Promise<StopResponse> {
    return this.call('POST', remotePath.stop(cid))
  }

  /** 대기열 되돌리기 — 합친 글을 받고 대기열은 비워진다 */
  takeQueue(cid: string): Promise<QueueTakeResponse> {
    return this.call('POST', remotePath.queueTake(cid))
  }

  /** 승인·질문에 답한다. `handled: 'elsewhere'` 는 다른 기기가 먼저 답한 것 — 오류가 아니다 */
  reply(sessionId: string, requestId: string, answer: AttentionAnswer): Promise<AttentionReplyResponse> {
    return this.call('POST', remotePath.attention(sessionId, requestId), { answer })
  }

  models(): Promise<RemoteModel[]> {
    return this.call('GET', remotePath.models)
  }

  /** 이벤트 구독. run·after 를 주면 그 뒤부터 이어 받는다(못 이으면 서버가 `reset` 을 보낸다). 돌려준 함수로 닫는다 */
  events(from: { run?: string; after?: number }, handlers: EventHandlers): () => void {
    const query = [from.run === undefined ? '' : `run=${encodeURIComponent(from.run)}`, from.after === undefined ? '' : `after=${from.after}`].filter(Boolean).join('&')
    const parser = new SseParser()
    let rejected: RemoteError | undefined
    return this.transport.stream(
      { url: `${this.baseUrl}${remotePath.events}${query ? `?${query}` : ''}`, headers: this.headers() },
      {
        onOpen: (status) => {
          if (status === 200) handlers.onOpen?.()
          else rejected = new RemoteError(status, `events: HTTP ${status}`)
        },
        onData: (text) => {
          handlers.onActivity?.()
          for (const message of parser.feed(text)) {
            if (!message.event) continue
            let data: unknown
            try {
              data = JSON.parse(message.data)
            } catch {
              continue // 깨진 조각 하나로 스트림을 버리지 않는다
            }
            const seq = message.id === undefined ? undefined : Number(message.id)
            handlers.onEvent({ event: message.event, data, seq: Number.isFinite(seq) ? seq : undefined } as RemoteEvent)
          }
        },
        onEnd: (error) => handlers.onEnd(rejected ?? error),
      },
    )
  }

  private headers(): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}` } : {}
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
    const headers = this.headers()
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await this.transport.request({ method, url: `${this.baseUrl}${path}`, headers, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs })
    let parsed: unknown
    try {
      parsed = response.body ? JSON.parse(response.body) : undefined
    } catch {
      parsed = undefined
    }
    if (response.status < 200 || response.status >= 300) {
      const message = (parsed as { error?: unknown } | undefined)?.error
      throw new RemoteError(response.status, typeof message === 'string' ? message : `HTTP ${response.status}`)
    }
    return parsed as T
  }
}

/** 보내기 하나의 id — 다시 보낼 때 같은 값을 쓴다. 시간순으로 늘어나는 앞부분 + 무작위 */
export function newClientMessageId(now = Date.now()): string {
  return `cm_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}
