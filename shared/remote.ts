// 모바일 원격 계약 — 폰 앱과 데스크탑(ctx.remote — src/services/remote.ts, 이슈 #56)이 주고받는 REST 요청·응답과 SSE 이벤트 (이슈 #42).
// 설계 정본: _workspace/01t_mobile_arch.md 2절. 페이로드는 데스크탑 화면이 쓰는 중립 타입(shared/contract.ts)을 그대로 싣는다.
// 양쪽이 이 파일 하나를 import 한다 — 계약이 바뀌면 앱 빌드가 깨진다. 이 계약을 말하는 서버는 ctx.remote 와 개발용 mobile/dev/fake-desktop.mts 다.
// Node·React Native 어느 쪽 API 도 쓰지 않는다 (타입 + 경로 문자열 + 상수).

import type { Attention, Conversation, ConversationStatus, History, HistoryMessage, NoticeState, Project, TurnItem, TurnUsage } from './contract.ts'
import type { Mode } from './modes.ts'

/** 경로의 `/v1` 과 hello.apiVersion */
export const REMOTE_API_VERSION = 1
/** 서버가 조용할 때 `: ping` 을 보내는 간격 */
export const REMOTE_PING_INTERVAL_MS = 15_000
/** 이 시간 동안 스트림에 아무 바이트도 안 오면 폰이 끊긴 것으로 본다 */
export const REMOTE_SILENCE_TIMEOUT_MS = 30_000

const V1 = `/v1`
const seg = encodeURIComponent

/** 경로 — 서버 라우터와 클라이언트가 같은 문자열을 쓴다 */
export const remotePath = {
  pair: `${V1}/pair`,
  hello: `${V1}/hello`,
  projects: `${V1}/projects`,
  conversations: `${V1}/conversations`,
  conversation: (cid: string) => `${V1}/conversations/${seg(cid)}`,
  messages: (cid: string) => `${V1}/conversations/${seg(cid)}/messages`,
  stop: (cid: string) => `${V1}/conversations/${seg(cid)}/stop`,
  queueTake: (cid: string) => `${V1}/conversations/${seg(cid)}/queue/take`,
  attention: (sessionId: string, requestId: string) => `${V1}/attention/${seg(sessionId)}/${seg(requestId)}`,
  models: `${V1}/models`,
  events: `${V1}/events`,
} as const

/** 폰이 고를 수 있는 모드 — full(묻지 않고 다 실행)은 폰에 열지 않는다. 대화가 full 이면 폰 전송을 거절한다(403) */
export type RemoteMode = Exclude<Mode, 'full'>

export interface ModelChoice {
  providerId: string
  modelId: string
}

// ── REST ────────────────────────────────────────────────────────────────────────────────────────

/** POST /v1/pair (인증 없음). 코드는 일회용, 데스크탑 [허용] 을 기다린다(최대 60초 롱폴) */
export interface PairRequest {
  code: string
  deviceName: string
  platform: 'android' | 'ios'
}
export interface PairResponse {
  deviceId: string
  /** 기기 토큰 — 이후 모든 요청의 `Authorization: Bearer` */
  token: string
}

/** GET /v1/hello — 재연결 첫 호출. addresses(`ip:port`)로 폰이 새 주소를 배운다 */
export interface Hello {
  desktopId: string
  name: string
  appVersion: string
  apiVersion: number
  /** 데스크탑 실행마다 바뀐다 — 바뀌었으면 폰이 쥔 seq 는 무효다 */
  runId: string
  /** 지금까지 낸 마지막 이벤트의 seq */
  seq: number
  /** 듣는 주소 전부 (`ip:port`, IPv6 는 `[ip]:port`). 스킴은 호스트로 정해진다 — isLoopbackHost 면 평문 http, 아니면 https + 지문 고정 */
  addresses: string[]
  /** 사내망(TLS) 리스너의 인증서 지문 — SPKI SHA-256 base64url (fingerprintCode 참고). TLS 리스너가 없으면 없다 */
  fingerprint?: string
}

// ── 사내망 연결 (TLS + 지문 고정 + QR, 01t 3절) ─────────────────────────────────────────────────────
// 데스크탑은 평문 http 를 루프백(127.0.0.1)에서만, https(TLS 1.3, 자체 서명)를 사설 IPv4(10/8·172.16/12·192.168/16·100.64/10) 주소마다 연다.
// 경로·REST·SSE 는 둘이 같다. https 는 인증서 체인을 믿지 않고 **공개키 지문(SPKI SHA-256)** 이 QR·처음 본 값과 같을 때만 붙는다.
// 포트는 둘 다 기본 47600 (주소가 달라 같은 포트를 쓴다).

/** 주소의 호스트가 루프백인가 — 데스크탑이 알리는 주소(hello·QR·addresses.changed) 중 이것만 평문 http 다 */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '')
  return bare === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)
}

/** QR 에 싣는 것 — `litecode://pair?v=1&d=…&n=…&a=ip:port,…&fp=…&c=…&x=…` (값은 encodeURIComponent, 순서는 이대로) */
export interface PairLink {
  /** v — REMOTE_API_VERSION */
  version: number
  /** d — hello.desktopId */
  desktopId: string
  /** n — PC 이름 */
  name: string
  /** a — https 로 붙을 주소 (`ip:port`, 쉼표로 이음). 루프백은 싣지 않는다 */
  addresses: string[]
  /** fp — SPKI SHA-256 base64url */
  fingerprint: string
  /** c — 짝짓기 코드 12자 (Crockford base32, 칸 나눔 없음). POST /v1/pair 의 code 에 그대로 */
  code: string
  /** x — 코드 만료 (unix 초) */
  expiresAt: number
}

export const PAIR_URI_PREFIX = 'litecode://pair?'

export function pairUri(link: PairLink): string {
  const fields: [string, string][] = [
    ['v', String(link.version)],
    ['d', link.desktopId],
    ['n', link.name],
    ['a', link.addresses.join(',')],
    ['fp', link.fingerprint],
    ['c', link.code],
    ['x', String(link.expiresAt)],
  ]
  return PAIR_URI_PREFIX + fields.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')
}

/** QR 글을 읽는다 — 모양이 다르면 undefined. `+` 는 공백으로 읽는다. URLSearchParams 없이 (RN 에서 덜 구현돼 있다) */
export function parsePairUri(text: string): PairLink | undefined {
  if (!text.startsWith(PAIR_URI_PREFIX)) return undefined
  const fields = new Map<string, string>()
  try {
    for (const pair of text.slice(PAIR_URI_PREFIX.length).split('&')) {
      const at = pair.indexOf('=')
      if (at > 0) fields.set(pair.slice(0, at), decodeURIComponent(pair.slice(at + 1).replace(/\+/g, ' ')))
    }
  } catch {
    return undefined
  }
  const version = Number(fields.get('v'))
  const expiresAt = Number(fields.get('x'))
  const addresses = (fields.get('a') ?? '').split(',').filter(Boolean)
  const fingerprint = fields.get('fp') ?? ''
  const { d: desktopId = '', n: name = '', c: code = '' } = Object.fromEntries(fields)
  if (!Number.isInteger(version) || !Number.isFinite(expiresAt) || !desktopId || !code || addresses.length === 0 || !/^[A-Za-z0-9_-]{43}$/.test(fingerprint)) return undefined
  return { version, desktopId, name, addresses, fingerprint, code, expiresAt }
}

/** GET /v1/projects */
export type RemoteProject = Project

/** GET /v1/conversations?project= 의 항목 — 목록 정보 중 서버가 실제로 싣는 것(ctx.remote 의 toRemote)만 + 상태 점. usage·labels·첨부 표·
 *  고정·`!` 카드(shells — 폰에 셸을 열지 않는다)는 오지 않는다 */
export interface RemoteConversation extends Pick<Conversation, 'id' | 'project' | 'title' | 'updatedAt' | 'engineSessionId' | 'model' | 'mode'> {
  status?: ConversationStatus
}

/** POST /v1/conversations — project 는 데스크탑에 등록된 것이어야 한다 */
export interface CreateConversationRequest {
  project: string
  model?: ModelChoice
  mode?: RemoteMode
}

/** 진행 중 턴의 지금 모습 */
export interface LiveTurn {
  progress: TurnItem[]
  attention: Attention[]
  queue: string[]
}

/** GET /v1/conversations/{cid} — 스냅샷 + 그 시점 seq. 이 대화의 이벤트는 seq 초과분만 적용한다 (스냅샷과 스트림 사이에 틈이 없다) */
export interface ConversationSnapshot {
  /** 끝난 말풍선들 + (턴이 도는 중이면) 그 턴의 user 말까지. 도는 턴의 진행 줄은 live.progress 에 있다 */
  history: History
  /** 턴이 도는 중일 때만 */
  live?: LiveTurn
  seq: number
}

/** POST /v1/conversations/{cid}/messages → 202. 같은 clientMessageId 를 다시 보내면 턴을 또 만들지 않고 처음 결과를 준다 */
export interface SendMessageRequest {
  text: string
  clientMessageId: string
  mode?: RemoteMode
  model?: ModelChoice
}
export interface SendMessageResponse {
  /** sent: 바로 턴이 됐다. queued: 턴이 도는 중이라 그 대화 대기열에 들어갔다 */
  state: 'sent' | 'queued'
}

/** POST /v1/conversations/{cid}/stop */
export interface StopResponse {
  stopped: boolean
}

/** POST /v1/conversations/{cid}/queue/take — 대기열을 합쳐 돌려주고 비운다 (누른 쪽 입력창으로). 비어 있으면 빈 글 */
export interface QueueTakeResponse {
  text: string
}

/** POST /v1/attention/{sessionId}/{requestId} — 본문은 { answer: AttentionAnswer } */
export interface AttentionReplyResponse {
  /** elsewhere: 다른 기기가 먼저 답했다 (오류가 아니다) */
  handled: 'ok' | 'elsewhere'
}

/** GET /v1/models 의 항목 — 주소·키는 없다 */
export interface RemoteModel {
  providerId: string
  providerName: string
  modelId: string
  displayName: string
}

// ── SSE (GET /v1/events?run=&after=) ──────────────────────────────────────────────────────────────
// `event:` = 이름, `data:` = JSON. 기록되는 이벤트는 `id:` = seq 가 붙고 `after` 로 이어 받는다.
// ready·reset·device.revoked 는 그 연결에만 하는 말이라 id 가 없다 (기록되지 않는다).
// **seq 는 건너뛸 수 있다** (이슈 #68): 운반이 밀리면 데스크탑이 아직 못 보낸 `turn.progress` 중 같은 진행 줄(cid·item.id)은 최신 하나만
// 보낸다 — 누적 전체를 싣는 이벤트라 옛 모습은 필요 없다. seq 는 늘 커지기만 한다. 받는 쪽은 "이미 본 seq 이하" 만 버리면 된다.

export type TurnOutcome = 'done' | 'failed' | 'interrupted'

export interface RemoteEventMap {
  /** 구독이 열렸다. 이어 받기면 그 뒤로 seq > after 인 이벤트가 재생된다 */
  ready: { runId: string; seq: number }
  /** 이어 받을 수 없다(데스크탑 재시작·너무 오래 끊김) — 목록과 열린 대화의 스냅샷을 다시 받아라. seq 는 지금 서버의 마지막 seq */
  reset: { runId: string; seq: number }
  /** origin: 'desktop' 또는 보낸 기기의 deviceId */
  'turn.started': { cid: string; message: HistoryMessage; origin: string }
  /** 같은 item.id 는 통째로 교체 */
  'turn.progress': { cid: string; item: TurnItem }
  /** 그 대화가 지금 기다리는 승인·질문 전부 (빈 배열 = 더 없다) */
  'turn.attention': { cid: string; requests: Attention[] }
  'turn.ended': { cid: string; message: HistoryMessage; usage?: TurnUsage; outcome: TurnOutcome }
  'queue.changed': { cid: string; items: string[] }
  /** 그 프로젝트의 대화 목록을 다시 받아라 */
  'conversations.changed': { project: string }
  'notices.changed': NoticeState
  /** 듣는 주소가 바뀌었다 (와이파이 전환 등 — 데스크탑이 다시 바인딩했다). hello.addresses 와 같은 모양 */
  'addresses.changed': { addresses: string[] }
  /** 이 기기가 해제됐다 — 직후 연결이 끊기고 토큰은 401 이 된다 */
  'device.revoked': Record<string, never>
}

export type RemoteEventName = keyof RemoteEventMap

/** 받은 이벤트 하나. seq 는 `id:` 줄 (없는 이벤트는 undefined) */
export type RemoteEvent = { [K in RemoteEventName]: { event: K; data: RemoteEventMap[K]; seq?: number } }[RemoteEventName]
