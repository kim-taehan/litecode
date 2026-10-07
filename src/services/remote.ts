import { Context, Service } from 'cordis'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import './chat.ts'
import './sessions.ts'
import './projects.ts'
import './providers.ts'
import type { KeyCipher } from './providers.ts'
import './settings.ts'
import './notifications.ts'
import { tr } from '../i18n.ts'
import { sameSecret } from './httpUtil.ts'
import { BLUETOOTH_CARRIER, type RemoteCarrier, type RemoteExchange, type RemoteOutcome, type RemotePeer, type RemoteRadioStatus, type RemoteReply, type RemoteRequest, type RemoteStreamSink } from './remote/carrier.ts'
import { DeviceStore, FailureLimiter, type DevicePlatform, type StoredDevice } from './remote/devices.ts'
import { EventLog } from './remote/eventLog.ts'
import { loadNoiseIdentity, type NoiseIdentity } from './remote/noiseIdentity.ts'
import { StreamQueue } from './remote/streamQueue.ts'
import { confirmCode, groupCode, newPairCode, newShortPairCode, normalizePairCode } from './remote/pairing.ts'
import { fingerprintCode } from '../../shared/remotePairing.ts'
import { emptyChatView, withHistory } from '../../shared/chatReducer.ts'
import type { ChatLive, ChatOrigin } from '../../shared/chat.ts'
import type { AttentionAnswer, Conversation, History, NoticeState } from '../../shared/contract.ts'
import { DEFAULT_MODE, isMode, type Mode } from '../../shared/modes.ts'
import {
  REMOTE_API_VERSION,
  REMOTE_PING_INTERVAL_MS,
  pairUri,
  remotePath,
  type AttentionReplyResponse,
  type ConversationSnapshot,
  type Hello,
  type ModelChoice,
  type PairRejected,
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
// **운반을 모른다** (이슈 #68, 설계 _workspace/01ab_mobile_bluetooth.md 5절): 이 서비스는 계약·인증·기기·짝짓기·이벤트 링을 쥐고,
// 요청은 운반 중립 모양(`handle(RemoteRequest, peer, exchange)` — remote/carrier.ts)으로만 받는다. HTTP·블루투스는 이 밑의
// **운반 플러그인**이다(`inject: ['remote']`, 자기 ctx 키 없음 — remote/http.ts): `ctx.remote.carrier(…)` 로 자신을 올리고 받은 요청을
// handle 에 넘긴다. 이 서비스가 떠 있는 동안 올라온 운반을 띄운다(start) — 내려가면 전부 닫는다(stop).
// 리스너·`Origin` 거절·본문 상한처럼 HTTP 에만 있는 것은 HTTP 운반에 있다. 인증 실패 제한의 열쇠는 운반이 준 peer 다.
//
// 경계 (01t 3절):
// - 짝짓기: 코드 12자(2분·1회용, 틀리면 5회째 폐기) + 데스크탑 [허용] 확인(최대 60초 롱폴) → 256bit 토큰(해시만 저장)
// - 그 밖의 모든 요청은 `Authorization: Bearer`. peer(HTTP 면 IP) 당 인증 실패 10회/분 → 5분 차단. 해제하면 그 토큰은 401, 열린 스트림은 `device.revoked` 뒤 끊김
// - 폰에 열지 않는 것: pty·fs·`!`·`@`·설정·키·MCP·스킬 관리·**전체 권한 모드**(full 모드 대화엔 못 보낸다 — 403).
//   보낸 글은 그대로 프롬프트다(입력 트리거를 풀지 않는다). 프로젝트는 등록된 것만
// - 켜짐은 하나다: 이 서비스가 떠 있음 = 켜짐 (기능 `remote`, 기본 꺼짐 — #124). 서비스가 내려가면(기능 끄기·앱 종료) 운반을 닫는다(포트를 닫는다)
// - 느린 운반에서 이벤트가 밀리면 같은 진행 줄(`turn.progress` 의 cid·item.id)은 최신 하나로 합친다 (remote/streamQueue.ts)

declare module 'cordis' {
  interface Context {
    remote: RemoteService
  }
  interface Events {
    /** 연결 상태·짝짓기·기기 목록이 바뀌었다 — 설정 > 모바일과 [허용] 확인이 그린다 */
    'remote/changed'(status: RemoteStatus): void
  }
}

/** 가짜 데스크탑과 같은 기본 포트 — 폰에 저장된 주소·방화벽 규칙이 오래 맞게 고정한다 (HTTP 운반이 듣는다) */
export const REMOTE_DEFAULT_PORT = 47600
const PAIR_CODE_TTL_MS = 2 * 60_000
const PAIR_WAIT_MS = 60_000
/** 긴 코드·짧은 코드를 합쳐 이만큼 틀리면 세션을 버린다 — 2자리 코드를 추측으로 맞힐 확률 3/100 (사용자 2026-10-06, 전에는 5) */
const PAIR_MAX_FAILURES = 3
/** 기억하는 clientMessageId 수 — 재시도는 보낸 직후에만 온다 */
const SENT_MEMORY = 1000
/** 폰이 만들고 아직 아무것도 안 보낸 새 대화 수 */
const DRAFT_LIMIT = 20
const DEVICE_NAME_MAX = 64

export interface RemoteServiceOptions {
  /** 기기 목록 JSON 파일 (앱에서는 userData/remote-devices.json) */
  file: string
  /** hello.name — 기본은 PC 이름 */
  name?: string
  appVersion?: string
  pingMs?: number
  /** 데스크탑 [허용] 을 기다리는 시간 */
  pairWaitMs?: number
  now?: () => number
  /** 블루투스 Noise 정적 키 파일 (앱에서는 userData/remote-noise-key.json, 이슈 #171) — noiseIdentity() 가 처음 불릴 때 만든다 */
  noiseKeyFile?: string
  /** noiseKeyFile 의 비밀키를 봉하는 수단 (safeStorage) */
  cipher?: KeyCipher
}

/** 데스크탑 [허용] 을 기다리는 짝짓기 요청 */
export interface RemotePairRequest {
  id: string
  deviceName: string
  platform: DevicePlatform
  /** 확인 코드 8자 (`ABCD-EFGH`) — 폰 화면과 같아야 한다. pinned 면 TLS 인증서 지문 앞 8자다 */
  confirm: string
  /** 사내망(TLS)으로 왔다 — confirm 이 지문 앞 8자 */
  pinned?: true
}

export interface RemoteDeviceInfo {
  id: string
  name: string
  platform: DevicePlatform
  pairedAt: number
  lastSeenAt?: number
  /** 지금 이벤트 스트림이 붙어 있다 */
  connected: boolean
  /** 지금(붙어 있으면 그 스트림의, 아니면 이 실행에서 마지막 요청의) 운반 id — 'http'·'https'·'bluetooth'. 이 실행에서 요청이 없었으면 없다 (이슈 #210 — 기기 줄의 연결 방법 배지) */
  via?: string
}

/** 설정 > 모바일이 그리는 상태 */
export interface RemoteStatus {
  port: number
  /** 듣고 있는 주소 (`ip:port`) — 못 떴으면 빈 목록 */
  addresses: string[]
  /** 운반이 못 뜬 사유 (code: EADDRINUSE 등) */
  error?: { code?: string; message: string }
  /** 사내망(TLS) 리스너의 인증서 지문 (SPKI SHA-256 base64url) — TLS 운반이 없거나 못 떴으면 없다 */
  fingerprint?: string
  /** 지문 앞 8자 (`ABCD-EFGH`, shared/remotePairing.ts fingerprintCode) — 직접 입력 화면과 [허용] 확인에 보인다 */
  fingerprintCode?: string
  /** 마지막으로 바깥(사내망 리스너)에서 접속이 들어온 시각 — 막힌 접속도 센다. 한 번도 없으면 없다 (진단: 클라이언트 격리·방화벽) */
  lastAttemptAt?: number
  /** 지금 쓸 수 있는 짝짓기 코드. code 는 긴 코드(QR·옛 폰), shortCode 는 직접 입력용 숫자 2자리 — 한 세션이다.
   *  uri 는 QR 에 실을 문자열(`litecode://pair?…`) — 사내망(TLS) 주소나 블루투스가 있을 때만 (블루투스만이면 a·fp 없는 블루투스 단독 QR, 이슈 #229) */
  pairing?: { code: string; shortCode: string; expiresAt: number; uri?: string }
  requests: RemotePairRequest[]
  devices: RemoteDeviceInfo[]
  /** 블루투스 운반이 올라와 있을 때만(기능 bluetooth, 이슈 #210) — 라디오 상태와 지금 블루투스로 이벤트 스트림이 붙은 기기 이름 */
  bluetooth?: RemoteRadioStatus & { devices: string[] }
}

interface ActiveCode {
  code: string
  /** 직접 입력용 숫자 2자리 — code 와 같은 세션(만료·1회용·틀린 시도) */
  shortCode: string
  expiresAt: number
  failures: number
}

interface PendingPair extends RemotePairRequest {
  settle(result: 'allow' | 'deny' | 'timeout' | 'gone'): void
}

interface Stream {
  queue: StreamQueue
  deviceId: string
  /** 이 스트림이 붙은 운반 id */
  carrier: string
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
  /** 도는 턴의 대화 id → 프로젝트 (notices.changed 에 싣는다 — ctx.chat 의 스냅샷에는 프로젝트가 없다) */
  private turnProjects = new Map<string, string>()
  /** 마지막으로 낸 notices.changed (JSON) — 같은 것을 두 번 내지 않는다 (알림 기능이 켜져 있으면 같은 변화가 두 길로 온다) */
  private lastNotices = '{}'
  /** 운반 띄우기·닫기를 한 줄로 세운다 — 내리자마자 올려도 포트가 닫힌 뒤 다시 연다 */
  private queue: Promise<void>
  private disposed = false
  /** 이 실행에서 마지막으로 알린 주소 목록 (쉼표로 이음) — 바뀌면 addresses.changed */
  private announced?: string
  private noise?: Promise<NoiseIdentity>
  /** 읽어 둔 블루투스 키 — 블루투스 운반이 noiseIdentity() 를 부른 뒤에만 있다. 짝짓기 응답·QR 의 bk */
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

    // ctx.chat 의 이벤트를 계약의 이벤트로 — 데스크탑 화면에만 필요한 덧붙인 필드(conversation·held·attachments·removed)는 뺀다
    ctx.on('chat/turn-started', ({ cid, message, origin, conversation }) => {
      this.drafts.delete(cid) // 보낸 대화는 ctx.chat 이 저장했다
      this.turnProjects.set(cid, conversation.project)
      this.emitEvent('turn.started', { cid, message, origin: remoteOrigin(origin) })
      this.emitNotices()
    })
    ctx.on('chat/turn-progress', ({ cid, item }) => this.emitEvent('turn.progress', { cid, item }))
    ctx.on('chat/turn-attention', ({ cid, requests }) => {
      this.emitEvent('turn.attention', { cid, requests })
      this.emitNotices()
    })
    ctx.on('chat/turn-ended', ({ cid, message, usage, outcome }) => {
      this.turnProjects.delete(cid)
      this.emitEvent('turn.ended', { cid, message, ...(usage && { usage }), outcome })
      this.emitNotices()
    })
    ctx.on('chat/queue-changed', ({ cid, items }) => this.emitEvent('queue.changed', { cid, items }))
    ctx.on('chat/conversations-changed', ({ project }) => this.emitEvent('conversations.changed', { project }))
    // 전체 권한은 폰에 열지 않는다 — 보낼 때(POST …/messages) 한 번 본 것으로는 대기열에 쌓인 사이 데스크탑이 full 로 바꾼 것을 못 막는다 (#186 B1).
    // 엔진에 넘기기 직전에 한 번 더 본다: 막힌 폰 글은 훅이 막은 글과 같이 대기열 맨 앞에 붙잡히고(폰이 되돌리기로 가져간다) 그 턴은 사유와 함께 실패로 끝난다
    ctx.on('chat/before-send', (send) => {
      if (send.mode === 'full' && send.origin.startsWith('device:')) send.blocked = tr('remote.fullAccessBlocked')
    })
    // 알림 기능이 꺼져 있으면 이 이벤트는 오지 않는다 (없어도 동작한다 — 진행 중·답 필요는 위 ctx.chat 이벤트로 나간다)
    ctx.on('notifications/changed', (state) => this.emitNotices(state))

    ctx.effect(() => () => {
      this.disposed = true
      return this.sync()
    })
  }

  /** 폰에 보낼 대화 상태 (#126 E3) — 진행 중·답 필요는 알림 기능(기본 꺼짐)과 무관하게 ctx.chat 의 도는 턴에서, 안 본 완료·실패·중단은
   *  알림 기능의 것 그대로. 서비스가 뜨기 전에 시작한 턴은 프로젝트를 몰라 여기엔 빠진다 (목록의 status 에는 실린다) */
  private emitNotices(unread: NoticeState = this.ctx.get('notifications')?.snapshot() ?? {}): void {
    const state: NoticeState = { ...unread }
    for (const [cid, live] of Object.entries(this.ctx.chat.snapshot())) {
      const status = liveStatus(live)
      const project = this.turnProjects.get(cid)
      if (status && project) state[cid] = { project, status }
    }
    const json = JSON.stringify(state)
    if (json === this.lastNotices) return
    this.lastNotices = json
    this.emitEvent('notices.changed', state)
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
    return [...this.carriers].some((carrier) => carrier.id === BLUETOOTH_CARRIER) ? this.noiseKey?.publicKeyText : undefined
  }

  /** [기기 연결] — 새 짝짓기 코드 (2분·1회용). 앞 코드는 버린다 */
  startPairing(): RemoteStatus {
    if (!this.live()) throw new Error(tr('remote.error.notListening'))
    this.code = { code: newPairCode(), shortCode: newShortPairCode(), expiresAt: this.now() + PAIR_CODE_TTL_MS, failures: 0 }
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
    if (request.method === 'POST' && request.path === remotePath.pair) return this.pair(body, exchange.signal, peer.fingerprint)

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

    for (const [key, route] of Object.entries(this.routes)) {
      const [method, pattern] = key.split(' ') as [string, string]
      const wanted = pattern.split('/').filter(Boolean)
      if (method !== request.method || wanted.length !== parts.length || !wanted.every((part, index) => part === '*' || part === parts[index])) continue
      const [status, answer] = await route({ params: parts.filter((_, index) => wanted[index] === '*'), query: request.query, body, device })
      return { status, body: answer }
    }
    return { status: 404, body: { error: 'no such path' } }
  }

  /** POST /v1/pair — 코드가 맞으면 그 코드를 쓰고(1회용) 데스크탑 [허용] 을 기다린다. 응답은 사용자가 답하거나 시간이 다 됐을 때.
   *  gone: 폰이 기다리다 떠났다. fingerprint: 요청이 지문으로 고정되는 운반(TLS)으로 왔으면 그 지문 — 확인 코드가 지문 앞 8자가 된다 */
  private pair(body: unknown, gone: AbortSignal, fingerprint?: string): RemoteReply | Promise<RemoteReply> {
    const input = body as { code?: unknown; deviceName?: unknown; platform?: unknown } | undefined
    // 이름은 데스크탑 확인 창·기기 목록에 그대로 보인다 — 제어 문자는 빼고 길이를 자른다
    const deviceName = typeof input?.deviceName === 'string' ? input.deviceName.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, DEVICE_NAME_MAX) : ''
    const platform = input?.platform
    if (typeof input?.code !== 'string' || !deviceName || (platform !== 'android' && platform !== 'ios')) {
      return { status: 400, body: { error: 'code, deviceName and platform are required' } }
    }
    const active = this.activeCode()
    if (!active) return { status: 403, body: { error: 'no pairing in progress', reason: 'no-code' } satisfies PairRejected }
    // 긴 코드(QR)든 짧은 코드(직접 입력)든 — 둘은 한 세션이다
    const given = normalizePairCode(input.code)
    if (!sameSecret(given, active.code) && !sameSecret(given, active.shortCode)) {
      if (++active.failures >= PAIR_MAX_FAILURES) this.code = undefined // 3회째 — 세션을 버린다(긴 코드·짧은 코드 모두). 새로 [기기 연결] 을 눌러야 한다
      this.changed()
      return { status: 403, body: { error: 'wrong pairing code', reason: 'wrong-code' } satisfies PairRejected }
    }
    this.code = undefined // 1회용

    return new Promise<RemoteReply>((resolve) => {
      const id = randomBytes(8).toString('hex')
      let settled = false
      const timer = setTimeout(() => entry.settle('timeout'), this.opts.pairWaitMs ?? PAIR_WAIT_MS)
      const entry: PendingPair = {
        id,
        deviceName,
        platform,
        // TLS 면 폰이 고정한 인증서의 지문 앞 8자, 루프백 평문이면 요청에서 만든 확인 코드 (shared/remotePairing.ts)
        // 확인 코드는 폰이 친 코드로 만든다 — 폰은 자기가 친 것밖에 모른다 (긴 코드면 전과 같다)
        confirm: fingerprint ? fingerprintCode(fingerprint) : confirmCode(given, deviceName, platform),
        ...(fingerprint && { pinned: true as const }),
        settle: (result) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          this.pending.delete(id)
          if (result === 'deny') resolve({ status: 403, body: { error: 'denied on the desktop', reason: 'denied' } satisfies PairRejected })
          else if (result === 'timeout') resolve({ status: 408, body: { error: 'nobody answered on the desktop' } })
          // 받을 상대가 없다 (폰이 떠났거나, 연결을 꺼서 운반이 곧 닫힌다)
          else if (result === 'gone') resolve({ status: 503, body: { error: 'pairing was abandoned' } })
          if (result !== 'allow') {
            if (!this.disposed) this.changed()
            return
          }
          void this.store.add(deviceName, platform).then(
            ({ device, token }) => {
              const bluetoothKey = this.bluetoothKey()
              resolve({ status: 200, body: { deviceId: device.id, token, ...(bluetoothKey && { bluetoothKey }) } satisfies PairResponse })
              this.changed()
            },
            (error: unknown) => {
              resolve({ status: 500, body: { error: (error as Error).message } })
              this.changed()
            },
          )
        },
      }
      this.pending.set(id, entry)
      // 폰이 기다리다 끊었다 — 확인 창을 거둔다
      gone.addEventListener('abort', () => entry.settle('gone'), { once: true })
      this.changed()
    })
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
        addresses: this.listening(),
        ...(this.fingerprint() && { fingerprint: this.fingerprint() }),
        // 블루투스가 켜져 있으면 공개키 — Wi-Fi 로 짝지은 폰이 다시 짝짓지 않고 블루투스 키를 배운다 (이슈 #229). 폰은 TLS 로 받은 것만 믿는다
        ...(this.bluetoothKey() && { bluetoothKey: this.bluetoothKey() }),
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
      // 진행 중·답 필요는 ctx.chat 의 도는 턴에서 (알림 기능과 무관 — emitNotices), 안 본 끝남만 알림 기능에서
      const live = this.ctx.chat.snapshot()
      return [200, list.map((entry) => toRemote(entry, liveStatus(live[entry.id]) ?? notices[entry.id]?.status))]
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
      // 전체 권한 대화의 승인은 데스크탑에서만 (#186 B2) — full 에서도 묻는 도구(litecode_create 등)를 폰이 허용하지 못하게.
      // 그 턴이 full 로 시작했거나(내 말의 mode) 대화가 지금 full 이면 막는다
      const [cid, live] = Object.entries(this.ctx.chat.snapshot()).find(([, entry]) => entry.turn?.attention.some((request) => request.sessionId === sessionId && request.id === requestId))!
      const conversation = (await this.ctx.sessions.list()).find((entry) => entry.id === cid)
      if (live.turn?.message.mode === 'full' || conversation?.mode === 'full') return [403, { error: 'conversations in full access mode are desktop-only' }]
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
    return this.ctx.projects.has(project)
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
}

/** ctx.chat 의 출처를 계약의 origin 으로 — 폰이 보낸 것은 그 기기 id, 그 밖(데스크탑 화면·다른 대화의 지시)은 'desktop' */
function remoteOrigin(origin: string): string {
  return origin.startsWith('device:') ? origin.slice('device:'.length) : 'desktop'
}

/** 도는 턴의 상태 — 승인·질문을 기다리면 답 필요, 아니면 진행 중. 도는 턴이 없으면 없다 */
function liveStatus(live: ChatLive | undefined): 'running' | 'attention' | undefined {
  if (!live?.turn) return undefined
  return live.turn.attention.length > 0 ? 'attention' : 'running'
}

/** 목록 정보에서 폰에 안 주는 것(통계·보일 글 표·첨부 표·`!` 카드)을 뺀다 */
function toRemote({ id, project, engineSessionId, title, updatedAt, model, mode }: Conversation, status?: RemoteConversation['status']): RemoteConversation {
  return { id, project, title, updatedAt, ...(engineSessionId && { engineSessionId }), ...(model && { model }), ...(mode && { mode }), ...(status && { status }) }
}

function isAnswer(value: unknown): value is AttentionAnswer {
  return value === 'once' || value === 'reject' || (Array.isArray(value) && value.every((entry) => Array.isArray(entry) && entry.every((label) => typeof label === 'string')))
}

function frame(event: string, data: unknown, id?: number): string {
  return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** 밀릴 때 합칠 열쇠 — `turn.progress` 는 같은 진행 줄(cid·item.id)을 누적 전체로 다시 보낸다. 그 밖의 이벤트는 합치지 않는다 */
function coalesceKey(event: string, data: unknown): string | undefined {
  if (event !== 'turn.progress') return undefined
  const { cid, item } = data as RemoteEventMap['turn.progress']
  return `${cid}\n${item.id}`
}
