import type { Context } from 'cordis'
import https from 'node:https'
import type { TLSSocket } from 'node:tls'
import { REMOTE_DEFAULT_PORT } from '../remote.ts'
import type { KeyCipher } from '../providers.ts'
import type { RemoteCarrierStatus } from './carrier.ts'
import { closeServer, hostPort, listenOn, remoteHandler } from './http.ts'
import { isPrivatePeer, isUnspecified, privateAddresses } from './lan.ts'
import { loadTlsIdentity, type TlsIdentity } from './tlsIdentity.ts'

// TLS 운반 (01t 3절) — 사내망에서 실제 폰이 붙는 길. HTTP 운반(remote/http.ts)과 **같은 경로·같은 REST/SSE** 를 https 로 낸다
// (요청 처리 remoteHandler 를 같이 쓴다). ctx.remote 밑의 운반 플러그인이다 (`inject: ['remote']`, 자기 ctx 키 없음).
// - TLS 1.3 만. 인증서는 자체 서명이고 폰은 공개키 지문(SPKI SHA-256)으로 고정한다 (remote/tlsIdentity.ts)
// - `0.0.0.0` 을 쓰지 않는다: 사설 IPv4 주소마다 listen(port, ip). 들어온 연결은 사설 대역에서 온 것만 — 그 밖은 TLS 전에 닫는다
// - 주소가 바뀌면(와이파이 전환·VPN) pollMs 마다 보고 다시 바인딩한다 — 그대로인 주소의 연결은 두고, 없어진 주소만 닫는다
// - 들어온 접속 시각(막은 것도)을 남긴다: 회사 Wi-Fi 의 클라이언트 격리·방화벽은 조용히 막는다 — "수신 시도 없음" 이 그 신호다
// 모바일 연결(기능 `remote`)이 켜져 있는 동안만 ctx.remote 가 start 한다. 플러그인이 내려가면 포트를 닫는다.

/** 주소 바꿈을 보는 간격 (01t: 10초 폴링) */
const POLL_MS = 10_000

export interface RemoteHttpsOptions {
  /** 키 파일 (앱에서는 userData/remote-tls-key.json) */
  keyFile: string
  /** 키를 봉하는 것 — 앱에서는 safeStorage */
  cipher?: KeyCipher
  /** 기본 47600 (평문 루프백과 주소가 달라 같은 포트를 쓴다). 0 이면 첫 주소에서 빈 포트를 받아 나머지도 그 포트 (테스트) */
  port?: number
  /** 들을 주소 — 기본은 지금 이 PC 의 사설 IPv4 (lan.ts privateAddresses). 테스트가 바꾼다 */
  addresses?: () => string[]
  /** 받을 상대 — 기본 사설 대역만 (lan.ts isPrivatePeer). 테스트가 루프백을 받게 바꾼다 */
  allowPeer?: (address: string | undefined) => boolean
  pollMs?: number
  now?: () => number
}

export function RemoteHttps(ctx: Context, options: RemoteHttpsOptions): void {
  const remote = ctx.remote // 내려가는 중엔 ctx.remote 를 못 꺼낸다 — 올라올 때 쥔다
  const wanted = options.addresses ?? (() => privateAddresses())
  const allowPeer = options.allowPeer ?? isPrivatePeer
  const now = options.now ?? Date.now
  let identity: TlsIdentity | undefined
  /** 듣는 주소 → 서버 */
  let servers = new Map<string, https.Server>()
  let port = options.port ?? REMOTE_DEFAULT_PORT
  let error: RemoteCarrierStatus['error']
  let lastAttemptAt: number | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  /** 바인딩을 한 줄로 세운다 — 폴링과 start·stop 이 겹치지 않게 */
  let binding: Promise<void> = Promise.resolve()

  const serve = (fingerprint: string) => remoteHandler(remote, (request) => ({ carrier: 'https', key: request.socket.remoteAddress ?? '', fingerprint }))

  /** 지금 주소 목록에 맞춘다 — 새 주소를 열고 없어진 주소를 닫는다. 바뀌었으면 true */
  async function rebind(): Promise<boolean> {
    if (!identity) return false
    const next = wanted().filter((host) => !isUnspecified(host)) // 모든 주소에서 듣지 않는다
    const gone = [...servers.keys()].filter((host) => !next.includes(host))
    const added = next.filter((host) => !servers.has(host))
    if (gone.length === 0 && added.length === 0) return false
    for (const host of gone) {
      const server = servers.get(host)!
      servers.delete(host)
      await closeServer(server)
    }
    const failures: { code?: string; message: string }[] = []
    for (const host of added) {
      const server = https.createServer({ key: identity.key, cert: identity.cert, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' }, serve(identity.fingerprint))
      // TCP 가 붙는 순간 (TLS 전) — 사설 대역 밖은 닫는다. 막은 것도 수신 시도로 센다
      server.on('connection', (socket) => {
        lastAttemptAt = now()
        if (!allowPeer(socket.remoteAddress)) socket.destroy()
        remote.carrierChanged()
      })
      // 지문이 다른 폰·TLS 를 모르는 접속 — 오류로 남길 일이 아니다
      server.on('tlsClientError', (_failure, socket: TLSSocket) => socket.destroy())
      try {
        port = await listenOn(server, port, host)
        servers.set(host, server)
      } catch (failure) {
        const { code, message } = failure as NodeJS.ErrnoException
        failures.push({ ...(code && { code }), message: `${host}: ${message}` })
      }
    }
    error = failures[0] ?? (servers.size === 0 ? { code: 'ENOLAN', message: 'no private network address on this PC' } : undefined)
    return true
  }

  function queue(work: () => Promise<void>): Promise<void> {
    binding = binding.then(work).catch((failure: unknown) => console.error('[remote] TLS 바인딩 실패', (failure as Error).message))
    return binding
  }

  async function close(): Promise<void> {
    if (timer) clearInterval(timer)
    timer = undefined
    const closing = [...servers.values()]
    servers = new Map()
    await Promise.all(closing.map(closeServer))
  }

  ctx.effect(() =>
    remote.carrier({
      id: 'https',
      start: () =>
        queue(async () => {
          await close() // 다시 불려도 하나만 돈다
          error = undefined
          port = options.port ?? REMOTE_DEFAULT_PORT
          try {
            identity ??= await loadTlsIdentity(options.keyFile, options.cipher)
          } catch (failure) {
            const { code, message, keyStore } = failure as NodeJS.ErrnoException & { keyStore?: true }
            error = { code: code ?? 'ETLSKEY', message, ...(keyStore && { keyStore }) }
            return
          }
          await rebind()
          if (servers.size === 0 && !error) error = { code: 'ENOLAN', message: 'no private network address on this PC' }
          // 주소가 바뀌면(와이파이 전환) 다시 바인딩하고 알린다
          timer = setInterval(() => void queue(async () => void ((await rebind()) && remote.carrierChanged())), options.pollMs ?? POLL_MS)
          timer.unref?.()
        }),
      stop: () =>
        queue(async () => {
          error = undefined
          await close()
        }),
      status: () => ({
        up: servers.size > 0,
        addresses: [...servers.keys()].map((host) => hostPort(host, port)),
        port,
        ...(error && { error }),
        ...(identity && servers.size > 0 && { fingerprint: identity.fingerprint }),
        ...(lastAttemptAt !== undefined && { lastAttemptAt }),
      }),
    }),
  )
}
RemoteHttps.inject = ['remote']
