// 지문 고정 연결 (TLS 라운드, 01t 3·4·7절) — 데스크탑의 자체 서명 인증서를 **지문(SPKI SHA-256)으로만** 믿는다.
//
// - `PinnedNet.transport(지문)`: 그 지문의 서버에만 요청·스트림을 보낸다. 다른 인증서면 응용 데이터를 한 바이트도 보내기 전에 끊는다.
//   체인 검증(자체 서명이라 당연히 실패)·호스트 이름 검증은 하지 않는다 — 신원은 지문이 정한다.
// - `PinnedNet.probe(주소)`: TLS 핸드셰이크만 하고 서버 지문을 본다(응용 데이터 0). 직접 입력(TOFU)에서 처음 본 지문을 사람에게 보여 줄 때,
//   QR 의 주소 후보 중 지문이 맞는 곳을 고를 때 쓴다. **지문 없이 요청을 보내는 길은 없다** (trustAll 없음).
// 폰에서는 Kotlin 모듈(modules/litecode-pinned-net — OkHttp + X509TrustManager)이, 시험에서는 Node TLS 가 같은 모양(PinnedNetNative)을 낸다.
// 평문 http(이 컴퓨터 안 — 에뮬레이터)는 여기를 지나지 않는다: fetch 운반(transport.ts) 그대로다.

import { RemoteError } from './client.ts'
import type { StreamHandlers, Transport } from './transport.ts'

/** 닿지 못한 이유. timeout: 답이 없다(다른 망·방화벽·클라이언트 격리) · refused: 그 주소에 아무도 안 듣는다(모바일 연결이 꺼져 있다) ·
 *  pin-mismatch: 인증서 지문이 다르다 · unreachable: 그 밖(경로 없음·주소 틀림) */
export type NetFailure = 'timeout' | 'refused' | 'pin-mismatch' | 'unreachable'

export class NetError extends Error {
  readonly kind: NetFailure
  /** pin-mismatch 일 때 서버가 실제로 낸 지문 */
  readonly actual?: string
  constructor(kind: NetFailure, message: string, actual?: string) {
    super(message)
    this.name = 'NetError'
    this.kind = kind
    this.actual = actual
  }
}

/** 운반이 던진 것을 이유로 — NetError 가 아닌 것(fetch 의 오류 등)은 글로 가른다 */
export function netFailure(error: unknown): NetFailure {
  if (error instanceof NetError) return error.kind
  const text = errorText(error)
  if (/AbortError|timed? ?out|ETIMEDOUT/i.test(text)) return 'timeout'
  if (/ECONNREFUSED|refused/i.test(text)) return 'refused'
  return 'unreachable'
}

function errorText(error: unknown): string {
  const parts: string[] = []
  for (let current = error, depth = 0; current && depth < 4; current = (current as { cause?: unknown }).cause, depth++) {
    const { name, message, code } = current as { name?: unknown; message?: unknown; code?: unknown }
    parts.push([name, message, code].filter((part) => typeof part === 'string').join(' '))
  }
  return parts.join(' | ')
}

export interface PinnedNet {
  /** 핸드셰이크만 해서 서버 지문을 본다. 닿지 못하면 NetError */
  probe(address: string, timeoutMs: number): Promise<string>
  /** 이 지문의 서버에만 가는 운반 */
  transport(fingerprint: string): Transport
}

/** 여러 실패 중 사람에게 말할 하나 — 지문이 다른 곳이 있었으면 그것(가장 위험), 그다음 거부(PC 는 닿았다), 시간 초과, 그 밖 */
const PRIORITY: NetFailure[] = ['pin-mismatch', 'refused', 'timeout', 'unreachable']

export function worstFailure(errors: unknown[]): unknown {
  const ranked = errors.map((error) => ({ error, rank: PRIORITY.indexOf(netFailure(error)) }))
  ranked.sort((a, b) => a.rank - b.rank)
  return ranked[0]?.error ?? new NetError('unreachable', 'no address')
}

/**
 * 주소 후보를 **병렬로** 시도해 처음 닿은 것을 쓴다 (01t 4절). 데스크탑이 HTTP 로 답한 것(RemoteError — 401 등)도 "닿았다" 다:
 * 그 답을 그대로 던진다. 모두 닿지 못하면 worstFailure 를 던진다. 늦게 끝나는 시도는 버린다.
 */
export function firstReachable<T>(addresses: readonly string[], attempt: (address: string) => Promise<T>): Promise<{ address: string; value: T }> {
  return new Promise((resolve, reject) => {
    if (addresses.length === 0) return reject(new NetError('unreachable', 'no address'))
    const errors: unknown[] = []
    let settled = false
    for (const address of addresses) {
      attempt(address).then(
        (value) => {
          if (settled) return
          settled = true
          resolve({ address, value })
        },
        (error: unknown) => {
          if (settled) return
          if (error instanceof RemoteError) {
            settled = true
            return reject(error)
          }
          errors.push(error)
          if (errors.length === addresses.length) {
            settled = true
            reject(worstFailure(errors))
          }
        },
      )
    }
  })
}

// ── 네이티브 모듈과의 다리 ──────────────────────────────────────────────────────────────────────────

/** 네이티브가 거절할 때 싣는 code — Kotlin PinnedNetModule.kt 와 같아야 한다 */
export const NATIVE_ERROR: Record<string, NetFailure> = {
  ERR_PIN_MISMATCH: 'pin-mismatch',
  ERR_TIMEOUT: 'timeout',
  ERR_REFUSED: 'refused',
  ERR_UNREACHABLE: 'unreachable',
}

export interface NativeStreamEvent {
  id: string
  status?: number
  text?: string
  /** onStreamEnd: 끊긴 이유 (NATIVE_ERROR 의 키). 서버가 닫았으면 없다 */
  code?: string
  message?: string
}

/** 네이티브 모듈의 모양 (Expo 모듈 'LitecodePinnedNet'). 시험은 Node TLS 로 같은 모양을 만든다 */
export interface PinnedNetNative {
  probe(host: string, port: number, timeoutMs: number): Promise<string>
  request(url: string, method: string, headers: Record<string, string>, body: string | null, timeoutMs: number, pin: string): Promise<{ status: number; body: string }>
  /** 스트림을 연다 — 결과는 이벤트(onStreamOpen·onStreamData·onStreamEnd, id 로 가른다)로 온다 */
  openStream(id: string, url: string, headers: Record<string, string>, pin: string): void
  /** 닫는다 — 그 뒤로 그 id 의 이벤트는 오지 않는다(와도 버린다) */
  closeStream(id: string): void
  addListener(event: 'onStreamOpen' | 'onStreamData' | 'onStreamEnd', listener: (event: NativeStreamEvent) => void): { remove(): void }
}

/** 네이티브가 낸 오류(code·message)를 NetError 로 */
export function nativeError(error: unknown): NetError {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown }
  const text = typeof message === 'string' ? message : String(error)
  const kind = typeof code === 'string' ? NATIVE_ERROR[code] : undefined
  if (!kind) return new NetError(netFailure(error), text)
  return new NetError(kind, text, kind === 'pin-mismatch' ? /([A-Za-z0-9_-]{43})/.exec(text)?.[1] : undefined)
}

const DEFAULT_TIMEOUT_MS = 10_000

export function createNativePinnedNet(native: PinnedNetNative): PinnedNet {
  /** 열린 스트림 — 이벤트를 id 로 가른다 */
  const streams = new Map<string, StreamHandlers>()
  let nextId = 0
  let listening = false
  const listen = (): void => {
    if (listening) return
    listening = true
    native.addListener('onStreamOpen', (event) => streams.get(event.id)?.onOpen(event.status ?? 0))
    native.addListener('onStreamData', (event) => streams.get(event.id)?.onData(event.text ?? ''))
    native.addListener('onStreamEnd', (event) => {
      const handlers = streams.get(event.id)
      if (!handlers) return
      streams.delete(event.id)
      handlers.onEnd(event.code === undefined ? undefined : nativeError(event))
    })
  }

  return {
    async probe(address, timeoutMs) {
      const cut = address.lastIndexOf(':')
      try {
        return await native.probe(address.slice(0, cut).replace(/^\[|\]$/g, ''), Number(address.slice(cut + 1)), timeoutMs)
      } catch (error) {
        throw nativeError(error)
      }
    },

    transport(fingerprint) {
      return {
        async request({ method, url, headers, body, timeoutMs }) {
          try {
            return await native.request(url, method, headers ?? {}, body ?? null, timeoutMs ?? DEFAULT_TIMEOUT_MS, fingerprint)
          } catch (error) {
            throw nativeError(error)
          }
        },
        stream({ url, headers }, handlers) {
          listen()
          const id = `s${++nextId}`
          streams.set(id, handlers)
          try {
            native.openStream(id, url, { ...headers, accept: 'text/event-stream' }, fingerprint)
          } catch (error) {
            // 열지도 못했다 — 위층은 onEnd 를 한 번 받는다 (부른 쪽이 닫는 함수를 받은 뒤에)
            void Promise.resolve().then(() => streams.delete(id) && handlers.onEnd(nativeError(error)))
          }
          return () => {
            if (!streams.delete(id)) return
            native.closeStream(id)
          }
        },
      }
    },
  }
}
