import { Context, Service } from 'cordis'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import './chat.ts'
import './sessions.ts'
import './projects.ts'
import './providers.ts'
import './settings.ts'
import './notifications.ts'
import { tr } from '../i18n.ts'
import { DeviceStore, FailureLimiter, type DevicePlatform, type StoredDevice } from './remote/devices.ts'
import { EventLog } from './remote/eventLog.ts'
import { confirmCode, groupCode, newPairCode, normalizePairCode } from './remote/pairing.ts'
import { emptyChatView, withHistory } from '../../shared/chatReducer.ts'
import type { ChatOrigin } from '../../shared/chat.ts'
import type { AttentionAnswer, Conversation, History } from '../../shared/contract.ts'
import { DEFAULT_MODE, isMode, type Mode } from '../../shared/modes.ts'
import {
  REMOTE_API_VERSION,
  REMOTE_PING_INTERVAL_MS,
  remotePath,
  type AttentionReplyResponse,
  type ConversationSnapshot,
  type Hello,
  type ModelChoice,
  type PairResponse,
  type QueueTakeResponse,
  type RemoteConversation,
  type RemoteEventMap,
  type RemoteEventName,
  type RemoteModel,
  type RemoteProject,
  type SendMessageResponse,
  type StopResponse,
} from '../../shared/remote.ts'

// 모바일 연결 (ctx.remote, 이슈 #56 — 설계 _workspace/01t_mobile_arch.md 의 R1). 폰 앱이 붙는 문: 짝짓기·기기 관리·REST·SSE.
// 대화는 ctx.chat 이 쥔다 — 여기는 그 손님 하나를 네트워크로 내보내는 얇은 서비스다(모바일은 단독으로 대화를 유지하지 않는다).
// **엔진(opencode)을 모른다**: 쓰기는 전부 ctx.chat, 읽기는 ctx.sessions·ctx.projects·ctx.providers 로만 한다.
// 계약은 shared/remote.ts — 모바일 클라이언트(mobile/src/core)와 가짜 데스크탑(mobile/dev/fake-desktop.mts)이 같은 것을 본다.
//
// 이번 라운드의 전송 (리더 결정): **루프백(127.0.0.1) 평문 http 만.** Android 에뮬레이터(10.0.2.2)와 이 PC 안의 클라이언트만 닿는다.
// 사내망 주소·자체 서명 TLS·지문 고정은 다음 라운드 — 리스너를 주소 목록으로 받으므로 그때 TLS 리스너를 더하기만 하면 된다.
// 평문 리스너는 루프백 주소가 아니면 열지 않는다 (LAN 에 평문으로 여는 길이 없다). 0.0.0.0 은 어느 쪽으로도 안 연다.
//
// 경계 (01t 3절):
// - `Origin` 헤더가 있는 요청은 전부 거절 (브라우저·DNS rebinding — 우리 클라이언트는 브라우저가 아니다), 본문 상한
// - 짝짓기: 코드 12자(2분·1회용, 틀리면 5회째 폐기) + 데스크탑 [허용] 확인(최대 60초 롱폴) → 256bit 토큰(해시만 저장)
// - 그 밖의 모든 요청은 `Authorization: Bearer`. IP 당 인증 실패 10회/분 → 5분 차단. 해제하면 그 토큰은 401, 열린 스트림은 `device.revoked` 뒤 끊김
// - 폰에 열지 않는 것: pty·fs·`!`·`@`·설정·키·MCP·스킬 관리·**전체 권한 모드**(full 모드 대화엔 못 보낸다 — 403).
//   보낸 글은 그대로 프롬프트다(입력 트리거를 풀지 않는다). 프로젝트는 등록된 것만
// - 꺼져 있으면(기본) 포트를 열지 않는다. 서비스가 내려가면(기능 끄기·앱 종료) 닫는다

declare module 'cordis' {
  interface Context {
    remote: RemoteService
  }
  interface Events {
    /** 연결 상태·짝짓기·기기 목록이 바뀌었다 — 설정 > 모바일과 [허용] 확인이 그린다 */
    'remote/changed'(status: RemoteStatus): void
  }
}

/** 가짜 데스크탑과 같은 기본 포트 — 폰에 저장된 주소·방화벽 규칙이 오래 맞게 고정한다 */
export const REMOTE_DEFAULT_PORT = 47600
/** 본문 상한 — 프롬프트 글 하나다 */
const MAX_BODY_BYTES = 256 * 1024
const PAIR_CODE_TTL_MS = 2 * 60_000
const PAIR_WAIT_MS = 60_000
const PAIR_MAX_FAILURES = 5
/** 기억하는 clientMessageId 수 — 재시도는 보낸 직후에만 온다 */
const SENT_MEMORY = 1000
/** 폰이 만들고 아직 아무것도 안 보낸 새 대화 수 */
const DRAFT_LIMIT = 20
const DEVICE_NAME_MAX = 64

/** 리스너 하나 — 지금은 평문 http(루프백만). 다음 라운드가 TLS 리스너를 더한다 */
export interface RemoteListener {
  host: string
}

export interface RemoteServiceOptions {
  /** 기기 목록 JSON 파일 (앱에서는 userData/remote-devices.json) */
  file: string
  /** 기본 127.0.0.1 하나 */
  listeners?: RemoteListener[]
  /** 기본 47600. 0 이면 빈 포트 (테스트) */
  port?: number
  /** hello.name — 기본은 PC 이름 */
  name?: string
  appVersion?: string
  pingMs?: number
  /** 데스크탑 [허용] 을 기다리는 시간 */
  pairWaitMs?: number
  now?: () => number
}

/** 데스크탑 [허용] 을 기다리는 짝짓기 요청 */
export interface RemotePairRequest {
  id: string
  deviceName: string
  platform: DevicePlatform
  /** 확인 코드 8자 (`ABCD-EFGH`) — 폰 화면과 같아야 한다 */
  confirm: string
}

export interface RemoteDeviceInfo {
  id: string
  name: string
  platform: DevicePlatform
  pairedAt: number
  lastSeenAt?: number
  /** 지금 이벤트 스트림이 붙어 있다 */
  connected: boolean
}

/** 설정 > 모바일이 그리는 상태 */
export interface RemoteStatus {
  enabled: boolean
  port: number
  /** 듣고 있는 주소 (`ip:port`) — 꺼졌거나 못 떴으면 빈 목록 */
  addresses: string[]
  /** 켰는데 못 뜬 사유 (code: EADDRINUSE 등) */
  error?: { code?: string; message: string }
  /** 지금 쓸 수 있는 짝짓기 코드. uri 는 QR 에 실을 문자열(`litecode://pair?…`) */
  pairing?: { code: string; expiresAt: number; uri: string }
  requests: RemotePairRequest[]
  devices: RemoteDeviceInfo[]
}

interface ActiveCode {
  code: string
  expiresAt: number
  failures: number
}

interface PendingPair extends RemotePairRequest {
  settle(result: 'allow' | 'deny' | 'timeout' | 'gone'): void
}

interface Stream {
  response: http.ServerResponse
  deviceId: string
}

type Reply = [status: number, body: unknown]

interface RouteInput {
  params: string[]
  query: URLSearchParams
  body: unknown
  device: StoredDevice
}

export class RemoteService extends Service {
  static readonly inject = ['chat', 'sessions', 'projects', 'providers', 'settings']

  private store: DeviceStore
  private limiter: FailureLimiter
  private now: () => number
  private log: EventLog
  private servers: http.Server[] = []
  private addresses: string[] = []
  private error?: RemoteStatus['error']
  private code?: ActiveCode
  private pending = new Map<string, PendingPair>()
  private streams = new Set<Stream>()
  /** `대화 id\nclientMessageId` → 처음 결과 (재시도해도 턴은 하나) */
  private sent = new Map<string, Promise<SendMessageResponse>>()
  /** 폰이 만든 새 대화 — 첫 메시지를 보내기 전에는 저장하지 않는다 (데스크탑의 빈 새 대화와 같다: 보관 개수를 차지하지 않는다) */
  private drafts = new Map<string, Conversation>()
  /** 켜고 끄기를 한 줄로 세운다 — 끄자마자 켜도 포트가 닫힌 뒤 다시 연다 */
  private queue: Promise<void>
  private disposed = false

  constructor(
    ctx: Context,
    private opts: RemoteServiceOptions,
  ) {
    super(ctx, 'remote')
    this.now = opts.now ?? Date.now
    this.store = new DeviceStore(opts.file, this.now)
    this.limiter = new FailureLimiter(this.now)
    this.log = new EventLog(this.now)
    this.queue = this.store.load()
    this.sync()

    // ctx.chat 의 이벤트를 계약의 이벤트로 — 데스크탑 화면에만 필요한 덧붙인 필드(conversation·held·attachments·removed)는 뺀다
    ctx.on('chat/turn-started', ({ cid, message, origin }) => {
      this.drafts.delete(cid) // 보낸 대화는 ctx.chat 이 저장했다
      this.emitEvent('turn.started', { cid, message, origin: remoteOrigin(origin) })
    })
    ctx.on('chat/turn-progress', ({ cid, item }) => this.emitEvent('turn.progress', { cid, item }))
    ctx.on('chat/turn-attention', ({ cid, requests }) => this.emitEvent('turn.attention', { cid, requests }))
    ctx.on('chat/turn-ended', ({ cid, message, usage, outcome }) => this.emitEvent('turn.ended', { cid, message, ...(usage && { usage }), outcome }))
    ctx.on('chat/queue-changed', ({ cid, items }) => this.emitEvent('queue.changed', { cid, items }))
    ctx.on('chat/conversations-changed', ({ project }) => this.emitEvent('conversations.changed', { project }))
    // 알림 기능이 꺼져 있으면 이 이벤트는 오지 않는다 (없어도 동작한다)
    ctx.on('notifications/changed', (state) => this.emitEvent('notices.changed', state))

    ctx.effect(() => () => {
      this.disposed = true
      return this.sync()
    })
  }

  /** 파일을 읽고 밀린 켜기·끄기가 끝날 때까지 */
  ready(): Promise<void> {
    return this.queue
  }

  status(): RemoteStatus {
    const code = this.activeCode()
    const connected = new Set([...this.streams].map((stream) => stream.deviceId))
    return {
      enabled: this.store.enabled,
      port: this.port(),
      addresses: this.addresses,
      ...(this.error && { error: this.error }),
      ...(code && { pairing: { code: groupCode(code.code), expiresAt: code.expiresAt, uri: this.pairUri(code) } }),
      requests: [...this.pending.values()].map(({ id, deviceName, platform, confirm }) => ({ id, deviceName, platform, confirm })),
      devices: this.store.list().map(({ id, name, platform, pairedAt, lastSeenAt }) => ({ id, name, platform, pairedAt, lastSeenAt, connected: connected.has(id) })),
    }
  }

  /** 모바일 연결 켜기·끄기 — 켜면 듣기 시작하고(못 뜨면 status().error), 끄면 포트를 닫고 붙어 있던 폰을 끊는다 */
  async setEnabled(enabled: boolean): Promise<RemoteStatus> {
    await this.queue
    await this.store.setEnabled(enabled === true)
    await this.sync()
    return this.changed()
  }

  /** [기기 연결] — 새 짝짓기 코드 (2분·1회용). 앞 코드는 버린다 */
  startPairing(): RemoteStatus {
    if (this.servers.length === 0) throw new Error(tr('remote.error.notListening'))
    this.code = { code: newPairCode(), expiresAt: this.now() + PAIR_CODE_TTL_MS, failures: 0 }
    return this.changed()
  }

  cancelPairing(): RemoteStatus {
    this.code = undefined
    return this.changed()
  }

  /** 데스크탑 [허용]/[거절] */
  answerPair(requestId: string, allow: boolean): RemoteStatus {
    this.pending.get(requestId)?.settle(allow === true ? 'allow' : 'deny')
    return this.status()
  }

  /** 기기 해제 — 토큰 해시를 지우고, 열린 스트림에 `device.revoked` 를 보낸 뒤 끊는다 */
  async revoke(deviceId: string): Promise<RemoteStatus> {
    await this.store.remove(deviceId)
    for (const stream of [...this.streams]) {
      if (stream.deviceId !== deviceId) continue
      this.streams.delete(stream)
      stream.response.end(frame('device.revoked', {}))
    }
    return this.changed()
  }

  // ── 켜고 끄기 ────────────────────────────────────────────────────────────────────────────────

  private sync(): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        const wanted = this.store.enabled && !this.disposed
        if (wanted && this.servers.length === 0) await this.open()
        else if (!wanted && (this.servers.length > 0 || this.error)) await this.close()
      })
      .catch((error: unknown) => console.error('[remote] 켜고 끄기 실패', (error as Error).message))
    return this.queue
  }

  private port(): number {
    const first = this.servers[0]?.address() as AddressInfo | null | undefined
    return first?.port ?? this.opts.port ?? REMOTE_DEFAULT_PORT
  }

  private async open(): Promise<void> {
    this.error = undefined
    this.log = new EventLog(this.now) // 새 실행 — 폰이 쥔 seq 는 무효다
    const servers: http.Server[] = []
    const addresses: string[] = []
    let port = this.opts.port ?? REMOTE_DEFAULT_PORT
    try {
      for (const { host } of this.opts.listeners ?? [{ host: '127.0.0.1' }]) {
        // 평문은 루프백만 — 사내망 주소는 TLS 리스너(다음 라운드)로만 연다
        if (!isLoopback(host)) throw Object.assign(new Error(`plain http is loopback-only: ${host}`), { code: 'ENOTLOOPBACK' })
        const server = http.createServer((request, response) => {
          this.handle(request, response).catch((error: unknown) => {
            console.error('[remote] 요청 처리 실패', (error as Error).message)
            if (!response.headersSent) send(response, 500, { error: 'internal error' })
            else response.destroy()
          })
        })
        servers.push(server)
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(port, host, () => {
            server.off('error', reject)
            server.on('error', (error) => console.error('[remote] 서버 오류', error.message))
            resolve()
          })
        })
        port = (server.address() as AddressInfo).port
        addresses.push(`${host.includes(':') ? `[${host}]` : host}:${port}`)
      }
    } catch (error) {
      await Promise.all(servers.map(closeServer))
      const { code, message } = error as NodeJS.ErrnoException
      this.error = { ...(code && { code }), message }
      return
    }
    this.servers = servers
    this.addresses = addresses
  }

  private async close(): Promise<void> {
    this.error = undefined
    this.code = undefined
    for (const request of [...this.pending.values()]) request.settle('gone')
    for (const stream of this.streams) stream.response.destroy()
    this.streams.clear()
    this.drafts.clear()
    this.sent.clear()
    const servers = this.servers
    this.servers = []
    this.addresses = []
    await Promise.all(servers.map(closeServer))
  }

  private changed(): RemoteStatus {
    const status = this.status()
    this.ctx.emit('remote/changed', status)
    return status
  }

  // ── 이벤트 ──────────────────────────────────────────────────────────────────────────────────

  private emitEvent<K extends RemoteEventName>(event: K, data: RemoteEventMap[K]): void {
    if (this.servers.length === 0) return // 꺼져 있으면 쌓지 않는다 — 다시 켜면 새 실행(runId)이다
    const entry = this.log.append(event, data)
    for (const stream of this.streams) stream.response.write(frame(event, data, entry.seq))
  }

  private openEvents(device: StoredDevice, query: URLSearchParams, response: http.ServerResponse): void {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const run = query.get('run')
    const after = Number(query.get('after') ?? Number.NaN)
    const here = { runId: this.log.runId, seq: this.log.seq }
    if (run === null) {
      response.write(frame('ready', here))
    } else if (this.log.canResume(run, after)) {
      response.write(frame('ready', here))
      for (const entry of this.log.after(after)) response.write(frame(entry.event, entry.data, entry.seq))
    } else {
      response.write(frame('reset', here))
    }
    const stream: Stream = { response, deviceId: device.id }
    this.streams.add(stream)
    const ping = setInterval(() => response.write(': ping\n\n'), this.opts.pingMs ?? REMOTE_PING_INTERVAL_MS)
    // 폰이 끊었거나(또는 해제·끄기로 우리가 끊었다)
    response.on('close', () => {
      clearInterval(ping)
      if (this.streams.delete(stream) && !this.disposed) this.changed()
    })
    this.changed()
  }

  // ── 요청 ───────────────────────────────────────────────────────────────────────────────────

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const ip = request.socket.remoteAddress ?? ''
    if (request.headers.origin !== undefined) return send(response, 403, { error: 'requests with an Origin header are refused' })
    const blockedMs = this.limiter.blocked(ip)
    if (blockedMs !== undefined) return send(response, 429, { error: 'too many failed attempts' }, { 'retry-after': String(Math.ceil(blockedMs / 1000)) })
    if (request.method !== 'GET' && request.method !== 'POST') return send(response, 405, { error: 'method not allowed' }, { allow: 'GET, POST' })

    const raw = await readBody(request)
    if (raw === undefined) return send(response, 413, { error: 'body too large' })
    let body: unknown
    let parts: string[]
    const url = new URL(request.url ?? '/', 'http://remote')
    try {
      body = raw ? JSON.parse(raw) : undefined
      parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    } catch {
      return send(response, 400, { error: 'malformed request' })
    }

    if (request.method === 'POST' && url.pathname === remotePath.pair) return this.pair(body, response)

    const device = this.store.authenticate(request.headers.authorization)
    if (!device) {
      this.limiter.fail(ip)
      return send(response, 401, { error: 'not a paired device' })
    }
    this.store.seen(device.id)
    if (request.method === 'GET' && url.pathname === remotePath.events) return this.openEvents(device, url.searchParams, response)

    for (const [key, route] of Object.entries(this.routes)) {
      const [method, pattern] = key.split(' ') as [string, string]
      const wanted = pattern.split('/').filter(Boolean)
      if (method !== request.method || wanted.length !== parts.length || !wanted.every((part, index) => part === '*' || part === parts[index])) continue
      const [status, answer] = await route({ params: parts.filter((_, index) => wanted[index] === '*'), query: url.searchParams, body, device })
      return send(response, status, answer)
    }
    send(response, 404, { error: 'no such path' })
  }

  /** POST /v1/pair — 코드가 맞으면 그 코드를 쓰고(1회용) 데스크탑 [허용] 을 기다린다. 응답은 사용자가 답하거나 시간이 다 됐을 때 */
  private pair(body: unknown, response: http.ServerResponse): void {
    const input = body as { code?: unknown; deviceName?: unknown; platform?: unknown } | undefined
    // 이름은 데스크탑 확인 창·기기 목록에 그대로 보인다 — 제어 문자는 빼고 길이를 자른다
    const deviceName = typeof input?.deviceName === 'string' ? input.deviceName.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, DEVICE_NAME_MAX) : ''
    const platform = input?.platform
    if (typeof input?.code !== 'string' || !deviceName || (platform !== 'android' && platform !== 'ios')) {
      return send(response, 400, { error: 'code, deviceName and platform are required' })
    }
    const active = this.activeCode()
    if (!active) return send(response, 403, { error: 'no pairing in progress' })
    if (!sameText(normalizePairCode(input.code), active.code)) {
      if (++active.failures >= PAIR_MAX_FAILURES) this.code = undefined // 5회째 — 코드를 버린다. 새로 [기기 연결] 을 눌러야 한다
      this.changed()
      return send(response, 403, { error: 'wrong pairing code' })
    }
    this.code = undefined // 1회용

    const id = randomBytes(8).toString('hex')
    let settled = false
    const timer = setTimeout(() => entry.settle('timeout'), this.opts.pairWaitMs ?? PAIR_WAIT_MS)
    const entry: PendingPair = {
      id,
      deviceName,
      platform,
      confirm: confirmCode(active.code, deviceName, platform),
      settle: (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.pending.delete(id)
        if (result === 'deny') send(response, 403, { error: 'denied on the desktop' })
        else if (result === 'timeout') send(response, 408, { error: 'nobody answered on the desktop' })
        else if (result === 'gone') response.destroy()
        if (result !== 'allow') {
          if (!this.disposed) this.changed()
          return
        }
        void this.store.add(deviceName, platform).then(
          ({ device, token }) => {
            send(response, 200, { deviceId: device.id, token } satisfies PairResponse)
            this.changed()
          },
          (error: unknown) => {
            send(response, 500, { error: (error as Error).message })
            this.changed()
          },
        )
      },
    }
    this.pending.set(id, entry)
    // 폰이 기다리다 끊었다 — 확인 창을 거둔다
    response.on('close', () => {
      if (!response.writableEnded) entry.settle('gone')
    })
    this.changed()
  }

  private routes: Record<string, (input: RouteInput) => Promise<Reply> | Reply> = {
    'GET /v1/hello': () => [
      200,
      {
        desktopId: this.store.desktopId,
        name: this.opts.name ?? os.hostname(),
        appVersion: this.opts.appVersion ?? '',
        apiVersion: REMOTE_API_VERSION,
        runId: this.log.runId,
        seq: this.log.seq,
        addresses: this.addresses,
      } satisfies Hello,
    ],

    'GET /v1/projects': async () => [200, (await this.ctx.projects.list()) satisfies RemoteProject[]],

    'GET /v1/conversations': async ({ query }) => {
      const project = query.get('project')
      if (!project || !(await this.registered(project))) return [200, []]
      const notices = this.ctx.get('notifications')?.snapshot() ?? {}
      const stored = (await this.ctx.sessions.list()).filter((entry) => entry.project === project)
      const drafts = [...this.drafts.values()].filter((entry) => entry.project === project && !stored.some((saved) => saved.id === entry.id))
      const list = [...drafts, ...stored].sort((a, b) => b.updatedAt - a.updatedAt)
      return [200, list.map((entry) => toRemote(entry, notices[entry.id]?.status))]
    },

    // 새 대화 — 등록된 프로젝트에만. 첫 메시지를 보낼 때 ctx.chat 이 저장한다 (그 전엔 폰에만 보인다)
    'POST /v1/conversations': async ({ body }) => {
      const input = body as { project?: unknown; model?: unknown; mode?: unknown } | undefined
      if (typeof input?.project !== 'string' || !(await this.registered(input.project))) return [404, { error: 'not a registered project' }]
      if (input.mode === 'full') return [403, { error: 'full access mode is desktop-only' }]
      if (input.mode !== undefined && !isMode(input.mode)) return [400, { error: 'unknown mode' }]
      // 모델을 안 골랐으면 데스크탑에 설정된 첫 모델
      const model = this.modelOf(input.model === undefined ? this.models()[0] : input.model)
      if (!model) return [400, { error: input.model === undefined ? 'no model is configured on the desktop' : 'unknown model' }]
      const fallback = this.ctx.settings.get().defaultMode
      const mode: Mode = input.mode ?? (fallback === 'full' ? DEFAULT_MODE : fallback)
      const draft: Conversation = { id: `c_${randomBytes(12).toString('hex')}`, project: input.project, title: '', updatedAt: this.now(), model, mode }
      this.drafts.set(draft.id, draft)
      for (const id of [...this.drafts.keys()].slice(0, Math.max(0, this.drafts.size - DRAFT_LIMIT))) this.drafts.delete(id)
      this.emitEvent('conversations.changed', { project: draft.project })
      return [200, toRemote(draft)]
    },

    // 스냅샷 + 그 시점 seq. 기록을 읽는 사이 이 대화의 이벤트가 지나갔으면 다시 읽는다 — 스냅샷과 스트림 사이에 틈·겹침이 없게
    'GET /v1/conversations/*': async ({ params }) => {
      const cid = params[0]!
      const conversation = await this.conversationOf(cid)
      if (!conversation) return [404, { error: 'no such conversation' }]
      let history: History = { messages: [] }
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = this.log.seq
        history = this.drafts.has(cid) ? { messages: [] } : await this.ctx.sessions.history(cid)
        if (!this.log.after(before).some((entry) => (entry.data as { cid?: string } | null)?.cid === cid)) break
      }
      const live = this.ctx.chat.snapshot()[cid]
      const turn = live?.turn
      const snapshot: ConversationSnapshot = turn
        ? {
            // 턴이 도는 중이면 기록은 그 턴의 내 말까지만 — 쓰다 만 답은 live.progress 가 그리고, 끝나면 turn.ended 가 붙인다
            history: { ...history, messages: withHistory({ ...emptyChatView, running: true, messages: [turn.message] }, history.messages).messages },
            live: { progress: turn.progress, attention: turn.attention, queue: live.queue.items },
            seq: this.log.seq,
          }
        : { history, seq: this.log.seq }
      return [200, snapshot]
    },

    'POST /v1/conversations/*/messages': async ({ params, body, device }) => {
      const cid = params[0]!
      const input = body as { text?: unknown; clientMessageId?: unknown; mode?: unknown; model?: unknown } | undefined
      const conversation = await this.conversationOf(cid)
      if (!conversation) return [404, { error: 'no such conversation' }]
      const { text, clientMessageId } = input ?? {}
      if (typeof text !== 'string' || !text.trim() || typeof clientMessageId !== 'string' || !clientMessageId || clientMessageId.length > 128) {
        return [400, { error: 'text and clientMessageId are required' }]
      }
      const key = `${cid}\n${clientMessageId}`
      const before = this.sent.get(key)
      if (before) return before.then((result): Reply => [202, result], (error: unknown): Reply => [409, { error: (error as Error).message }])
      // 전체 권한(묻지 않고 다 실행)은 폰에 열지 않는다 — 그 모드로 바꾸지도, 그 모드의 대화에 보내지도 못한다
      if (input?.mode === 'full' || conversation.mode === 'full') return [403, { error: 'conversations in full access mode are desktop-only' }]
      if (input?.mode !== undefined && !isMode(input.mode)) return [400, { error: 'unknown mode' }]
      const model = input?.model === undefined ? undefined : this.modelOf(input.model)
      if (input?.model !== undefined && !model) return [400, { error: 'unknown model' }]
      const draft = this.drafts.get(cid)
      const origin: ChatOrigin = `device:${device.id}`
      const sending = this.ctx.chat
        .send(cid, {
          text,
          origin,
          ...(input?.mode !== undefined && { mode: input.mode as Mode }),
          ...(model && { model }),
          // 아직 저장 안 된 새 대화 — 만들 때 정한 프로젝트·모델·모드로 시작한다
          ...(draft && { project: draft.project, model: model ?? draft.model, mode: (input?.mode as Mode | undefined) ?? draft.mode }),
        })
        .then(({ state }): SendMessageResponse => ({ state }))
      this.sent.set(key, sending)
      for (const old of [...this.sent.keys()].slice(0, Math.max(0, this.sent.size - SENT_MEMORY))) this.sent.delete(old)
      try {
        return [202, await sending]
      } catch (error) {
        this.sent.delete(key) // 시작도 못 했다 — 같은 id 로 다시 보낼 수 있다
        return [409, { error: (error as Error).message }]
      }
    },

    'POST /v1/conversations/*/stop': async ({ params }) => {
      if (!(await this.conversationOf(params[0]!))) return [404, { error: 'no such conversation' }]
      return [200, { stopped: this.ctx.chat.stop(params[0]!) } satisfies StopResponse]
    },

    // 대기열 되돌리기 — 이 기기가 쌓은 것만 (누른 쪽 입력창으로 간다)
    'POST /v1/conversations/*/queue/take': async ({ params, device }) => {
      if (!(await this.conversationOf(params[0]!))) return [404, { error: 'no such conversation' }]
      const taken = this.ctx.chat.takeQueue(params[0]!, `device:${device.id}`)
      return [200, { text: taken ? (taken.display ?? taken.text) : '' } satisfies QueueTakeResponse]
    },

    // 승인·질문의 답 — 먼저 온 답이 이긴다. 이미 풀린 요청(데스크탑이나 다른 기기가 답했다)은 오류가 아니라 `elsewhere`
    'POST /v1/attention/*/*': async ({ params, body }) => {
      const [sessionId, requestId] = params as [string, string]
      const answer = (body as { answer?: unknown } | undefined)?.answer
      if (!isAnswer(answer)) return [400, { error: 'answer is required' }]
      const waiting = (): boolean =>
        Object.values(this.ctx.chat.snapshot()).some((live) => live.turn?.attention.some((request) => request.sessionId === sessionId && request.id === requestId))
      const elsewhere: Reply = [200, { handled: 'elsewhere' } satisfies AttentionReplyResponse]
      if (!waiting()) return elsewhere
      try {
        await this.ctx.chat.reply(sessionId, requestId, answer)
        return [200, { handled: 'ok' } satisfies AttentionReplyResponse]
      } catch (error) {
        const message = (error as Error).message
        // 그사이 풀렸다 — ctx.llm 이 "이미 끝난 요청" 으로 던지거나, 엔진이 404 로 답한다 (01s 2b)
        if (!waiting() || message === tr('error.attentionGone') || message === tr('error.attentionReply', { status: 404 })) return elsewhere
        return [message === tr('error.attentionAnswer') ? 400 : 502, { error: message }]
      }
    },

    'GET /v1/models': () => [200, this.models()],
  }

  // ── 도우미 ──────────────────────────────────────────────────────────────────────────────────

  /** 주소·키 없이 — provider·모델의 id 와 이름만 */
  private models(): RemoteModel[] {
    return this.ctx.providers
      .list()
      .flatMap((provider) => provider.models.map((model) => ({ providerId: provider.id, providerName: provider.displayName, modelId: model.id, displayName: model.displayName || model.id })))
  }

  /** 폰이 고른 모델 — 데스크탑에 설정된 것만 */
  private modelOf(value: unknown): ModelChoice | undefined {
    const choice = value as Partial<ModelChoice> | null
    const found = this.models().find((model) => model.providerId === choice?.providerId && model.modelId === choice?.modelId)
    return found && { providerId: found.providerId, modelId: found.modelId }
  }

  private async registered(project: string): Promise<boolean> {
    return (await this.ctx.projects.list()).some((entry) => entry.path === project)
  }

  /** 폰이 닿을 수 있는 대화 — 등록된 프로젝트의 저장된 대화, 또는 폰이 만든 새 대화 */
  private async conversationOf(cid: string): Promise<Conversation | undefined> {
    const found = (await this.ctx.sessions.list()).find((entry) => entry.id === cid) ?? this.drafts.get(cid)
    return found && (await this.registered(found.project)) ? found : undefined
  }

  private activeCode(): ActiveCode | undefined {
    if (this.code && this.code.expiresAt <= this.now()) this.code = undefined
    return this.code
  }

  /** QR 에 실을 문자열 (01t 3절). 지문(fp)은 TLS 라운드에서 채운다 — 지금은 비어 있다 */
  private pairUri(code: ActiveCode): string {
    const query = new URLSearchParams({
      v: String(REMOTE_API_VERSION),
      d: this.store.desktopId,
      n: this.opts.name ?? os.hostname(),
      a: this.addresses.join(','),
      fp: '',
      c: code.code,
      x: String(Math.floor(code.expiresAt / 1000)),
    })
    return `litecode://pair?${query.toString()}`
  }
}

/** ctx.chat 의 출처를 계약의 origin 으로 — 폰이 보낸 것은 그 기기 id, 그 밖(데스크탑 화면·다른 대화의 지시)은 'desktop' */
function remoteOrigin(origin: string): string {
  return origin.startsWith('device:') ? origin.slice('device:'.length) : 'desktop'
}

/** 목록 정보에서 폰에 안 주는 것(통계·보일 글 표·첨부 표·`!` 카드)을 뺀다 */
function toRemote({ id, project, engineSessionId, title, updatedAt, model, mode }: Conversation, status?: RemoteConversation['status']): RemoteConversation {
  return { id, project, title, updatedAt, ...(engineSessionId && { engineSessionId }), ...(model && { model }), ...(mode && { mode }), ...(status && { status }) }
}

function isAnswer(value: unknown): value is AttentionAnswer {
  return value === 'once' || value === 'reject' || (Array.isArray(value) && value.every((entry) => Array.isArray(entry) && entry.every((label) => typeof label === 'string')))
}

function isLoopback(host: string): boolean {
  return host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

function sameText(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function frame(event: string, data: unknown, id?: number): string {
  return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function send(response: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
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

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve()
    server.close(() => resolve())
    server.closeAllConnections()
  })
}
