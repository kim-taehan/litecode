import { Context, Service } from 'cordis'
import '../chat.ts'
import '../sessions.ts'
import '../projects.ts'
import '../providers.ts'
import '../settings.ts'
import '../notifications.ts'
import { tr } from '../../i18n.ts'
import { BLUETOOTH_CARRIER, type RemoteCarrier, type RemoteExchange, type RemoteOutcome, type RemotePeer, type RemoteRequest, type RemoteStreamSink } from './carrier.ts'
import { DeviceStore, FailureLimiter, type StoredDevice } from './devices.ts'
import { EventLog } from './eventLog.ts'
import { loadNoiseIdentity, type NoiseIdentity } from './noiseIdentity.ts'
import { StreamQueue } from './streamQueue.ts'
import { groupCode, newPairCode, newShortPairCode } from './pairing.ts'
import { fingerprintCode } from '../../../shared/remotePairing.ts'
import type { Conversation } from '../../../shared/contract.ts'
import { REMOTE_API_VERSION, REMOTE_PING_INTERVAL_MS, pairUri, remotePath, type RemoteEventMap, type RemoteEventName, type SendMessageResponse } from '../../../shared/remote.ts'
import { PAIR_CODE_TTL_MS, REMOTE_DEFAULT_PORT } from './limits.ts'
import type { ActiveCode, PendingPair, RemoteServiceOptions, RemoteStatus, Stream } from './types.ts'
import { bridgeChatEvents, type ChatEventsHost } from './chatEvents.ts'
import { pairRequest, type PairHost } from './pairRequest.ts'
import { remoteRoutes, type RouteHost } from './routes.ts'
import { coalesceKey, frame } from './wire.ts'
import os from 'node:os'

// RemoteService — ctx.remote 의 상태와 흐름 (이슈 #298 에서 remote.ts 에서 옮김, 동작 그대로). 서비스 설명·경계는 진입점 remote.ts 의 머리 주석.
// 여기 남은 것: 상태(설정 화면)·운반 올리기/띄우기/닫기·블루투스 키(지연 읽기)·짝짓기 코드 발급·[허용] 답·기기 해제·이벤트 링/스트림·요청 인증과 경로 고르기

export class RemoteService extends Service {
  static readonly inject = ['chat', 'sessions', 'projects', 'providers', 'settings']

  private store: DeviceStore
  private limiter: FailureLimiter
  private now: () => number
  private log: EventLog
  /** 올라온 운반 (플러그인이 carrier() 로 올린다) */
  private carriers = new Set<RemoteCarrier>()
  /** 그중 띄운 것 */
  private started = new Set<RemoteCarrier>()
  private code?: ActiveCode
  private pending = new Map<string, PendingPair>()
  private streams = new Set<Stream>()
  /** `대화 id\nclientMessageId` → 처음 결과 (재시도해도 턴은 하나) */
  private sent = new Map<string, Promise<SendMessageResponse>>()
  /** 폰이 만든 새 대화 — 첫 메시지를 보내기 전에는 저장하지 않는다 (데스크탑의 빈 새 대화와 같다: 보관 개수를 차지하지 않는다) */
  private drafts = new Map<string, Conversation>()
  /** 운반 띄우기·닫기를 한 줄로 세운다 — 내리자마자 올려도 포트가 닫힌 뒤 다시 연다 */
  private queue: Promise<void>
  private disposed = false
  /** 이 실행에서 마지막으로 알린 주소 목록 (쉼표로 이음) — 바뀌면 addresses.changed */
  private announced?: string
  private noise?: Promise<NoiseIdentity>
  /** 읽어 둔 블루투스 키 — noiseIdentity() 를 부른 뒤에만 있다(폰의 핸드셰이크·짝짓기 시작·hello, 이슈 #268). 짝짓기 응답·QR 의 bk */
  private noiseKey?: NoiseIdentity
  /** 기기 id → 이 실행에서 마지막으로 요청이 온 운반 id */
  private via = new Map<string, string>()

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

    // ctx.chat·알림의 이벤트를 계약의 이벤트로 (remote/chatEvents.ts) — 도는 턴의 프로젝트·마지막 notices.changed 도 거기서 쥔다
    bridgeChatEvents(ctx, this.chatEventsHost())

    ctx.effect(() => () => {
      this.disposed = true
      return this.sync()
    })
  }

  /** 파일을 읽고 밀린 운반 띄우기·닫기가 끝날 때까지 */
  ready(): Promise<void> {
    return this.queue
  }

  status(): RemoteStatus {
    const code = this.activeCode()
    const connected = new Set([...this.streams].map((stream) => stream.deviceId))
    const carriers = [...this.carriers].map((carrier) => carrier.status())
    const unreadable = this.store.unreadable as NodeJS.ErrnoException | undefined
    const error = carriers.find((carrier) => carrier.error)?.error ?? (unreadable && { code: unreadable.code, message: unreadable.message })
    const fingerprint = this.fingerprint()
    const attempts = carriers.flatMap((carrier) => (carrier.lastAttemptAt === undefined ? [] : [carrier.lastAttemptAt]))
    const uri = code && this.pairUri(code)
    const radio = [...this.carriers].find((carrier) => carrier.id === BLUETOOTH_CARRIER)?.status().radio
    const streams = [...this.streams]
    return {
      port: carriers.find((carrier) => carrier.port !== undefined)?.port ?? REMOTE_DEFAULT_PORT,
      addresses: this.listening(),
      ...(error && { error }),
      ...(fingerprint && { fingerprint, fingerprintCode: fingerprintCode(fingerprint) }),
      ...(attempts.length > 0 && { lastAttemptAt: Math.max(...attempts) }),
      ...(code && { pairing: { code: groupCode(code.code), shortCode: code.shortCode, expiresAt: code.expiresAt, ...(uri && { uri }) } }),
      requests: [...this.pending.values()].map(({ id, deviceName, platform, confirm, pinned }) => ({ id, deviceName, platform, confirm, ...(pinned && { pinned }) })),
      devices: this.store.list().map(({ id, name, platform, pairedAt, lastSeenAt }) => {
        const via = streams.find((stream) => stream.deviceId === id)?.carrier ?? this.via.get(id)
        return { id, name, platform, pairedAt, lastSeenAt, connected: connected.has(id), ...(via && { via }) }
      }),
      ...(radio && {
        bluetooth: {
          ...radio,
          devices: [...new Set(streams.filter((stream) => stream.carrier === BLUETOOTH_CARRIER).map((stream) => stream.deviceId))].flatMap(
            (id) => this.store.list().find((device) => device.id === id)?.name ?? [],
          ),
        },
      }),
    }
  }

  /** 운반을 올린다 (운반 플러그인이 ctx.effect 로 건다) — 돌려준 함수가 내린다. 곧바로 띄우고(못 뜨면 status().error),
   *  내리면 닫는다. 설정 화면은 status() 로 운반의 주소·사유를 본다 */
  carrier(carrier: RemoteCarrier): () => void {
    this.carriers.add(carrier)
    void this.sync()
    return () => {
      if (!this.carriers.delete(carrier)) return
      this.queue = this.queue
        .then(async () => {
          if (this.started.delete(carrier)) await carrier.stop()
          if (!this.disposed) this.changed()
        })
        .catch((error: unknown) => console.error('[remote] 운반 내리기 실패', (error as Error).message))
    }
  }

  /** 운반의 상태가 바뀌었다 (다시 바인딩한 주소·수신 시도) — 운반이 부른다. 주소가 바뀌었으면 폰에 `addresses.changed` 를 보낸다 */
  carrierChanged(): void {
    if (!this.disposed) this.changed()
  }

  /** 블루투스 Noise 채널의 데스크탑 정적 키쌍 (이슈 #171) — 처음 부를 때 읽거나 만든다. 블루투스 운반(③)이 쓰고 QR 의 bk 에 공개키를 싣는다.
   *  봉한 키를 못 풀면 거절하고(키 파일은 그대로) 다음 호출에 다시 시도한다 */
  noiseIdentity(): Promise<NoiseIdentity> {
    if (!this.opts.noiseKeyFile) return Promise.reject(new Error('no bluetooth key file'))
    this.noise ??= loadNoiseIdentity(this.opts.noiseKeyFile, this.opts.cipher).then(
      (identity) => (this.noiseKey = identity),
      (error: unknown) => {
        this.noise = undefined
        throw error
      },
    )
    return this.noise
  }

  /** 이 데스크탑의 id (QR 의 `d`) — 블루투스 운반이 서비스 UUID·Noise 프롤로그에 쓴다. 기기 목록 파일을 읽은 뒤(ready) 값이 정해진다 */
  get desktopId(): string {
    return this.store.desktopId
  }

  /** 짝짓기 응답·QR 에 실을 블루투스 키 — 블루투스 운반이 올라와 있고 키를 읽어 둔 때만. 여기서 키를 읽지 않는다(블루투스를 안 쓰는 사용자에게 키 파일을 만들지 않는다) */
  private bluetoothKey(): string | undefined {
    return this.bluetoothOn() ? this.noiseKey?.publicKeyText : undefined
  }

  private bluetoothOn(): boolean {
    return [...this.carriers].some((carrier) => carrier.id === BLUETOOTH_CARRIER)
  }

  /** bluetoothKey 와 같되, 블루투스가 켜져 있고 아직 안 읽었으면 지금 읽는다 (이슈 #268 — 광고를 시작할 때는 읽지 않는다). 못 읽으면 없다 */
  private async loadBluetoothKey(): Promise<string | undefined> {
    if (this.bluetoothOn()) await this.noiseIdentity().catch(() => undefined)
    return this.bluetoothKey()
  }

  /** [기기 연결] — 새 짝짓기 코드 (2분·1회용). 앞 코드는 버린다 */
  startPairing(): RemoteStatus {
    if (!this.live()) throw new Error(tr('remote.error.notListening'))
    this.code = { code: newPairCode(), shortCode: newShortPairCode(), expiresAt: this.now() + PAIR_CODE_TTL_MS, failures: 0 }
    // QR 의 bk — 블루투스 키를 아직 안 읽었으면 지금 읽고(이슈 #268), 읽히면 QR 을 다시 알린다
    if (this.bluetoothOn() && !this.noiseKey) void this.loadBluetoothKey().then((key) => key && !this.disposed && this.code && this.changed())
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
      stream.queue.end(frame('device.revoked', {}))
    }
    return this.changed()
  }

  // ── 운반 띄우기·닫기 ────────────────────────────────────────────────────────────────────────────────

  private sync(): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        if (this.disposed) {
          if (this.started.size > 0) await this.close()
          return
        }
        let started = false
        for (const carrier of this.carriers) {
          if (carrier.status().up) continue
          if (!this.live()) {
            this.log = new EventLog(this.now) // 새 실행 — 폰이 쥔 seq 는 무효다
            this.announced = undefined
          }
          this.started.add(carrier)
          await carrier.start()
          started = true
        }
        if (started && !this.disposed) this.changed()
      })
      .catch((error: unknown) => console.error('[remote] 운반 띄우기·닫기 실패', (error as Error).message))
    return this.queue
  }

  /** 운반들이 듣고 있는 주소 (`ip:port`) */
  private listening(): string[] {
    return [...this.carriers].flatMap((carrier) => carrier.status().addresses)
  }

  /** 지문으로 고정되는 운반(TLS)의 지문 — 떠 있는 것만 */
  private fingerprint(): string | undefined {
    return [...this.carriers].map((carrier) => carrier.status()).find((status) => status.up && status.fingerprint)?.fingerprint
  }

  /** 떠 있는 운반이 하나라도 있나 — 폰이 붙을 수 있다 */
  private live(): boolean {
    return [...this.carriers].some((carrier) => carrier.status().up)
  }

  private async close(): Promise<void> {
    this.code = undefined
    for (const request of [...this.pending.values()]) request.settle('gone')
    for (const stream of this.streams) stream.queue.destroy()
    this.streams.clear()
    this.drafts.clear()
    this.sent.clear()
    const started = [...this.started]
    this.started.clear()
    await Promise.all(started.map((carrier) => carrier.stop()))
  }

  private changed(): RemoteStatus {
    const status = this.status()
    // 이 실행에서 처음 본 주소는 알리지 않는다 (hello 가 준다) — 그 뒤 바뀌면 붙어 있는 폰에 알린다
    const addresses = status.addresses.join(',')
    if (this.announced !== undefined && addresses !== this.announced) this.emitEvent('addresses.changed', { addresses: status.addresses })
    if (this.live()) this.announced = addresses
    this.ctx.emit('remote/changed', status)
    return status
  }

  // ── 이벤트 ──────────────────────────────────────────────────────────────────────────────────

  private emitEvent<K extends RemoteEventName>(event: K, data: RemoteEventMap[K]): void {
    if (!this.live()) return // 떠 있는 운반이 없으면 쌓지 않는다 — 다시 뜨면 새 실행(runId)이다
    const entry = this.log.append(event, data)
    const text = frame(event, data, entry.seq)
    for (const stream of this.streams) stream.queue.push(text, coalesceKey(event, data))
  }

  private openEvents(device: StoredDevice, query: URLSearchParams, sink: RemoteStreamSink, carrier: string): void {
    const queue = new StreamQueue(sink)
    const run = query.get('run')
    const after = Number(query.get('after') ?? Number.NaN)
    const here = { runId: this.log.runId, seq: this.log.seq }
    if (run === null) {
      queue.push(frame('ready', here))
    } else if (this.log.canResume(run, after)) {
      queue.push(frame('ready', here))
      for (const entry of this.log.after(after)) queue.push(frame(entry.event, entry.data, entry.seq), coalesceKey(entry.event, entry.data))
    } else {
      queue.push(frame('reset', here))
    }
    const stream: Stream = { queue, deviceId: device.id, carrier }
    this.streams.add(stream)
    const ping = setInterval(() => queue.ping(': ping\n\n'), this.opts.pingMs ?? REMOTE_PING_INTERVAL_MS)
    // 폰이 끊었거나(또는 해제·끄기로 우리가 끊었다)
    sink.onClose(() => {
      clearInterval(ping)
      if (this.streams.delete(stream) && !this.disposed) this.changed()
    })
    this.changed()
  }

  // ── 요청 ───────────────────────────────────────────────────────────────────────────────────

  /** 요청 하나를 다룬다 — 어느 운반으로 왔는지 모른다. 응답 하나를 돌려주거나, 이벤트 스트림이면 exchange.openStream() 으로 연다.
   *  운반은 본문을 글로 읽어 넘기고(상한은 운반의 몫), 돌려받은 응답을 자기 방식으로 싣는다 */
  async handle(request: RemoteRequest, peer: RemotePeer, exchange: RemoteExchange): Promise<RemoteOutcome> {
    const from = `${peer.carrier}\n${peer.key}`
    const blockedMs = this.limiter.blocked(from)
    if (blockedMs !== undefined) return { status: 429, body: { error: 'too many failed attempts' }, headers: { 'retry-after': String(Math.ceil(blockedMs / 1000)) } }
    if (request.method !== 'GET' && request.method !== 'POST') return { status: 405, body: { error: 'method not allowed' }, headers: { allow: 'GET, POST' } }

    let body: unknown
    let parts: string[]
    try {
      body = request.body ? JSON.parse(request.body) : undefined
      parts = request.path.split('/').filter(Boolean).map(decodeURIComponent)
    } catch {
      return { status: 400, body: { error: 'malformed request' } }
    }

    // 기기 목록 파일을 못 읽었다 — 누가 짝지은 기기인지 모른다. 401 이면 폰이 해제된 줄 알고 다시 붙지 않는다 → 503(잠시 못 씀)으로 답하고 짝짓기도 받지 않는다 (이슈 #195)
    if (this.store.unreadable) return { status: 503, body: { error: 'the device list cannot be read on the desktop' } }
    if (request.method === 'POST' && request.path === remotePath.pair) return pairRequest(this.pairHost(), body, exchange.signal, peer.fingerprint)

    const device = this.store.authenticate(request.headers.authorization)
    if (!device) {
      this.limiter.fail(from)
      return { status: 401, body: { error: 'not a paired device' } }
    }
    this.store.seen(device.id)
    this.via.set(device.id, peer.carrier)
    if (request.method === 'GET' && request.path === remotePath.events) {
      this.openEvents(device, request.query, exchange.openStream(), peer.carrier)
      return { stream: true }
    }

    // 요청 표는 remote/routes.ts
    for (const [key, route] of Object.entries(remoteRoutes(this.routeHost()))) {
      const [method, pattern] = key.split(' ') as [string, string]
      const wanted = pattern.split('/').filter(Boolean)
      if (method !== request.method || wanted.length !== parts.length || !wanted.every((part, index) => part === '*' || part === parts[index])) continue
      const [status, answer] = await route({ params: parts.filter((_, index) => wanted[index] === '*'), query: request.query, body, device })
      return { status, body: answer }
    }
    return { status: 404, body: { error: 'no such path' } }
  }

  // ── 도우미 ──────────────────────────────────────────────────────────────────────────────────

  private activeCode(): ActiveCode | undefined {
    if (this.code && this.code.expiresAt <= this.now()) this.code = undefined
    return this.code
  }

  /** QR 에 실을 문자열 (01t 3절) — 지문으로 고정되는 운반(TLS)이 떠 있으면 그 운반의 주소·지문을, 블루투스가 켜져 있으면 bk 를 싣는다.
   *  평문 루프백 주소는 싣지 않는다. 사내망이 없고 블루투스만 있으면 a·fp 없는 블루투스 단독 QR (이슈 #229). 둘 다 없으면 QR 이 없다 */
  private pairUri(code: ActiveCode): string | undefined {
    const fingerprint = this.fingerprint()
    const addresses = fingerprint ? [...this.carriers].map((carrier) => carrier.status()).flatMap((status) => (status.up && status.fingerprint === fingerprint ? status.addresses : [])) : []
    const lan = fingerprint !== undefined && addresses.length > 0
    const bluetoothKey = this.bluetoothKey()
    if (!lan && !bluetoothKey) return undefined
    return pairUri({
      version: REMOTE_API_VERSION,
      desktopId: this.store.desktopId,
      name: this.opts.name ?? os.hostname(),
      addresses: lan ? addresses : [],
      ...(lan && { fingerprint }),
      code: code.code,
      expiresAt: Math.floor(code.expiresAt / 1000),
      ...(bluetoothKey && { bluetoothKey }),
    })
  }

  /** ctx.chat·알림 이벤트 옮기기(remote/chatEvents.ts)에 넘기는 이 서비스의 상태 */
  private chatEventsHost(): ChatEventsHost {
    return {
      ctx: this.ctx,
      drafts: this.drafts,
      emitEvent: (event, data) => this.emitEvent(event, data),
    }
  }

  /** 짝짓기 요청(remote/pairRequest.ts)에 넘기는 이 서비스의 상태 — 같은 Map·저장소를 그대로, 바뀌는 값은 함수로 */
  private pairHost(): PairHost {
    return {
      store: this.store,
      pending: this.pending,
      pairWaitMs: this.opts.pairWaitMs,
      activeCode: () => this.activeCode(),
      dropCode: () => {
        this.code = undefined
      },
      disposed: () => this.disposed,
      changed: () => this.changed(),
      revoke: (deviceId) => this.revoke(deviceId),
      loadBluetoothKey: () => this.loadBluetoothKey(),
    }
  }

  /** 요청 표(remote/routes.ts)에 넘기는 이 서비스의 상태 — 같은 Map·저장소를 그대로, 바뀌는 값(이벤트 링)은 함수로 */
  private routeHost(): RouteHost {
    return {
      ctx: this.ctx,
      opts: this.opts,
      store: this.store,
      drafts: this.drafts,
      sent: this.sent,
      now: () => this.now(),
      log: () => this.log,
      listening: () => this.listening(),
      fingerprint: () => this.fingerprint(),
      loadBluetoothKey: () => this.loadBluetoothKey(),
      emitEvent: (event, data) => this.emitEvent(event, data),
    }
  }
}
