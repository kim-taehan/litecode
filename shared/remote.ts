// 모바일 원격 계약 — 폰 앱과 데스크탑(ctx.remote — src/services/remote.ts, 이슈 #56)이 주고받는 REST 요청·응답과 SSE 이벤트 (이슈 #42).
// 설계 정본: _workspace/01t_mobile_arch.md 2절. 페이로드는 데스크탑 화면이 쓰는 중립 타입(shared/contract.ts)을 그대로 싣는다.
// 양쪽이 이 파일 하나를 import 한다 — 계약이 바뀌면 앱 빌드가 깨진다. 이 계약을 말하는 서버는 ctx.remote 와 개발용 mobile/dev/fake-desktop.mts 다.
// Node·React Native 어느 쪽 API 도 쓰지 않는다 (타입 + 경로 문자열 + 상수).

import type { Attention, Conversation, ConversationStatus, History, HistoryMessage, NoticeState, Project, ShellCard, TurnItem, TurnUsage } from './contract.ts'
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
  /** 이 폰의 고정 키 (hex 32자, 이슈 #275) — 같은 키로 다시 짝지으면(사용자가 [허용]을 누르는 순간) 데스크탑이 옛 짝을 교체한다(옛 토큰 무효·연결 끊음).
   *  개인정보: 기기 고유값(Android ID — 재설치에도 같다)을 그대로 보내지 않고 sha256("litecode-device/1:" + 값) 의 앞 32자만 보낸다.
   *  데스크탑은 이것을 로컬의 기기 목록 파일에만 둔다. 없으면(옛 폰·네이티브 없음) 교체하지 않는다 */
  deviceKey?: string
}

/** PairRequest.deviceKey 의 모양 — 데스크탑은 모양만 본다(맞지 않으면 없는 것으로) */
export const DEVICE_KEY_PATTERN = /^[0-9a-f]{32}$/
/** POST /v1/pair 의 403 사유 — 폰은 글(error)이 아니라 이것으로 안내를 가른다.
 *  no-code: 진행 중인 짝짓기 코드가 없다(시작 안 함·2분 만료·이미 씀·5회 틀려 버림) · wrong-code: 코드가 틀렸다 · denied: 데스크탑에서 [거절] */
export type PairRejectReason = 'no-code' | 'wrong-code' | 'denied'
export interface PairRejected {
  error: string
  reason: PairRejectReason
}
export interface PairResponse {
  deviceId: string
  /** 기기 토큰 — 이후 모든 요청의 `Authorization: Bearer` */
  token: string
  /** 블루투스 연결이 켜져 있으면 데스크탑의 Noise 정적 공개키(X25519, base64url) — QR 없이 2자리 코드로 짝지은 폰이 블루투스 키를 TLS 안에서 받는다 (이슈 #171) */
  bluetoothKey?: string
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
  /** 블루투스 연결이 켜져 있으면 Noise 정적 공개키(QR 의 bk 와 같다, 이슈 #229). Wi-Fi 로 짝지은 폰이 이것을 배워 다시 짝짓지 않고 블루투스를 고를 수 있다.
   *  폰은 지문으로 고정한 TLS 로 받은 hello 의 것만 저장한다 — 평문(루프백)·블루투스로 받은 것은 믿지 않는다 */
  bluetoothKey?: string
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

/** QR 에 싣는 것 — `litecode://pair?v=1&d=…&n=…[&a=ip:port,…&fp=…]&c=…&x=…[&bk=…]` (값은 encodeURIComponent, 순서는 이대로).
 *  사내망 경로(a·fp)와 블루투스 경로(bk) 중 하나는 있어야 한다. a·fp 는 둘 다 있거나 둘 다 없다 — 둘 다 없으면 블루투스 단독 QR 이다 (이슈 #229,
 *  Wi-Fi 가 없는 곳에서 짝짓기). v 는 그대로 1: 이것을 모르는 옛 폰은 a·fp 가 없는 QR 을 "내용이 올바르지 않다"(qr-invalid)로 거절한다 */
export interface PairLink {
  /** v — REMOTE_API_VERSION */
  version: number
  /** d — hello.desktopId */
  desktopId: string
  /** n — PC 이름 */
  name: string
  /** a — https 로 붙을 주소 (`ip:port`, 쉼표로 이음). 루프백은 싣지 않는다. 블루투스 단독 QR 이면 빈 목록 */
  addresses: string[]
  /** fp — SPKI SHA-256 base64url. 블루투스 단독 QR 이면 없다 */
  fingerprint?: string
  /** c — 짝짓기 코드 12자 (Crockford base32, 칸 나눔 없음). POST /v1/pair 의 code 에 그대로 */
  code: string
  /** x — 코드 만료 (unix 초) */
  expiresAt: number
  /** bk — 블루투스 Noise NK 채널의 데스크탑 정적 X25519 공개키, base64url 43자 (이슈 #171, shared/noiseNK.ts). 선택: 없으면 블루투스로 못 붙는다.
   *  v 는 그대로 1 — 모르는 폰은 이 필드를 흘려보낸다 */
  bluetoothKey?: string
}

export const PAIR_URI_PREFIX = 'litecode://pair?'

/** 블루투스 단독 QR(주소·지문이 없다)이면 a·fp 를 아예 싣지 않는다 */
export function pairUri(link: PairLink): string {
  const lan = link.addresses.length > 0 || link.fingerprint !== undefined
  const fields: [string, string][] = [
    ['v', String(link.version)],
    ['d', link.desktopId],
    ['n', link.name],
    ...(lan
      ? [
          ['a', link.addresses.join(',')] as [string, string],
          ['fp', link.fingerprint ?? ''] as [string, string],
        ]
      : []),
    ['c', link.code],
    ['x', String(link.expiresAt)],
    ...(link.bluetoothKey !== undefined ? [['bk', link.bluetoothKey] as [string, string]] : []),
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
  const { d: desktopId = '', n: name = '', c: code = '', bk: bluetoothKey } = Object.fromEntries(fields)
  if (!Number.isInteger(version) || !Number.isFinite(expiresAt) || !desktopId || !code) return undefined
  if (bluetoothKey !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(bluetoothKey)) return undefined
  // 사내망 경로는 a·fp 가 둘 다 있어야 한다. 둘 다 없어도 되는 것은 bk 가 있을 때뿐(블루투스 단독)
  const lan = addresses.length > 0 || fingerprint !== ''
  if ((lan || bluetoothKey === undefined) && (addresses.length === 0 || !/^[A-Za-z0-9_-]{43}$/.test(fingerprint))) return undefined
  return { version, desktopId, name, addresses, ...(lan && { fingerprint }), code, expiresAt, ...(bluetoothKey !== undefined && { bluetoothKey }) }
}

/** GET /v1/projects */
export type RemoteProject = Project

/** GET /v1/conversations?project= 의 항목 — 목록 정보 중 서버가 실제로 싣는 것(ctx.remote 의 toRemote)만 + 상태 점. usage·labels·첨부 표·
 *  고정·`!` 카드(shells)는 오지 않는다 — 카드는 대화 스냅샷(ConversationSnapshot.shells)에 읽기 전용으로 온다 (폰에 셸을 열지 않는다) */
/** model 은 GET /v1/models 의 그 항목 키다 — 데스크탑에서 Thinking 켬·끔으로 둔 대화도 디폴트 키로 보인다 (이슈 #503, 대화에 저장된 키는 그대로) */
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
  /** 끝난 말풍선들 + (턴이 도는 중이면) 그 턴의 user 말까지, 끼워 넣은 말이 있으면 그 앞에 얼린 답과 그 말까지 (이슈 #250). 도는 턴의 진행 줄은 live.progress 에 있다.
   *  **전체 기록이 아니라 꼬리** (끝에서 SNAPSHOT_MESSAGE_MAX, 질문 경계) — 폰은 상태 화면이지 기록 읽는 곳이 아니다 (이슈 #365, `snapshotTailAt`·`snapshotMessage`) */
  history: History
  /** 턴이 도는 중일 때만 */
  live?: LiveTurn
  /** 이 대화의 `!명령` 결과 카드 (#265) — 읽기 전용. 카드가 없으면 필드가 없다. 새로 돈 카드는 스트림으로 오지 않는다 — 다시 읽을 때 보인다.
   *  history 와 함께 잘리면 보이는 범위만 싣고 position 은 보이는 말풍선 기준으로 다시 센다 (이슈 #365, `snapshotShells`) */
  shells?: ShellCard[]
  /** history 가 앞에서 잘린 메시지 수 — 폰이 "앞의 메시지 N개 생략" 을 그리는 것. 0 이면(안 잘린) 필드가 없다 (이슈 #365) */
  omitted?: number
  seq: number
}

// ── 대화 스냅샷의 내용 (이슈 #365) ────────────────────────────────────────────────────────────────
// 폰은 대화를 열 때 전체 역사를 받지 않는다 — **꼬리** (끝에서 SNAPSHOT_MESSAGE_MAX 개까지, 질문(user 말) 경계에서 잘림) 만 받는다.
// 폰은 상태 화면(무엇이 도는가·무엇이 답을 기다리는가 보기, 답하기, 다음 질문 보내기)이고 전체 기록 읽기는 데스크탑 화면의 몫이다 —
// 특히 블루투스 같은 느린 링크에서 긴 대화 스냅샷이 가장 큰 단일 페이로드였다 (실측 330KB → 20KB/s 에서 6.3초).
// 마지막 것 하나도 클 수 있다 (어시스턴트 메시지가 진행 줄 전문 — 생각·도구 입력·결과·diff — 을 싣는다) 그래서 **메시지당 상한**이다 —
// 백그라운드 작업의 상한(shared/tasks.ts)과 같은 선. **도는 턴의 진행 줄(live)은 캡하지 않는다** — 폰이 곧 받을 `turn.progress` 이벤트와
// 같은 모양이라, 스냅샷만 캡하면 그 줄이 이벤트가 올 때 불게 된다. 데스크탑 화면은 영향이 없다(이것은 ctx.remote 가 폰에 내보내는 페이로드의 모양뿐).

/** 스냅샷 메시지의 생각·응답 글(·지시문·하위 작업 지시) 글자 상한 — TASK_ITEM_TEXT_MAX 와 같은 선 */
export const SNAPSHOT_TEXT_MAX = 20_000
/** 도구 입력·결과·오류(·메시지 오류·재시도 글) 글자 상한 — TASK_TOOL_TEXT_MAX 와 같은 선 */
export const SNAPSHOT_DETAIL_MAX = 8_000
/** 대화 스냅샷 꼬리에 싣는 메시지 수 — 마지막 질문뿐(2개)으로는 폰에서 다음 질문을 잇기 애매해 5 로 (사용자 2026-10-14, "2개는 너무 적나 일단 5개 정도") */
export const SNAPSHOT_MESSAGE_MAX = 5

function clipTo(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text
}

/** 스냅샷 꼬리의 시작 자리 — 끝에서 SNAPSHOT_MESSAGE_MAX 까지만. 그 첫째가 답(assistant)이면 그 앞의 질문에서 잘라 "질문 없는 답" 이 먼저 보이지 않게 한다.
 *  도는 턴의 "내 말"(질문)이 잘리면 안 된다(쓰다 만 답이 질문 없이 보임) — 그 턴은 호출 쪽이 `lastIndexOf(턴 message)` 와 이 값 중 **앞** 을 쓴다 (routes) */
export function snapshotTailAt(messages: readonly HistoryMessage[]): number {
  let from = Math.max(0, messages.length - SNAPSHOT_MESSAGE_MAX)
  while (from < messages.length && messages[from]!.role !== 'user') from++
  return from
}

/** 진행 줄 한 줄을 폰에 싣는 크기로 — 글자 상한, 도구의 diff 는 뺀다(폰은 그린다 할 수 없는 전문). 하위 작업은 중첩 진행 줄을 뺀다(폰에 작업 탭이 없다 — #325) */
export function snapshotItem(item: TurnItem): TurnItem {
  switch (item.kind) {
    case 'think':
    case 'text':
    case 'context':
      return item.text.length > SNAPSHOT_TEXT_MAX ? { ...item, text: clipTo(item.text, SNAPSHOT_TEXT_MAX) } : item
    case 'tool': {
      const { diffs: _diffs, ...tool } = item
      return {
        ...tool,
        ...(tool.input !== undefined && { input: clipTo(tool.input, SNAPSHOT_DETAIL_MAX) }),
        ...(tool.result !== undefined && { result: clipTo(tool.result, SNAPSHOT_DETAIL_MAX) }),
        ...(tool.error !== undefined && { error: clipTo(tool.error, SNAPSHOT_DETAIL_MAX) }),
      }
    }
    case 'subtask':
      return {
        ...item,
        items: [],
        ...(item.prompt !== undefined && { prompt: clipTo(item.prompt, SNAPSHOT_TEXT_MAX) }),
        ...(item.error !== undefined && { error: clipTo(item.error, SNAPSHOT_DETAIL_MAX) }),
      }
    case 'changes':
      return item.diffs.length === 0 ? item : { ...item, diffs: [] }
    case 'retry':
      return item.message.length > SNAPSHOT_DETAIL_MAX ? { ...item, message: clipTo(item.message, SNAPSHOT_DETAIL_MAX) } : item
    case 'hook':
      return item.reason === undefined ? item : { ...item, reason: clipTo(item.reason, SNAPSHOT_DETAIL_MAX) }
    case 'compaction':
      return item
  }
}

/** 말풍선 하나를 폰에 싣는 크기로 — user 글도 캡한다(붙여 넣은 파일이 길 수 있다). 어시스턴트는 진행 줄을 snapshotItem 으로 (live 의 도는 진행 줄은 여기 지나지 않는다) */
export function snapshotMessage(message: HistoryMessage): HistoryMessage {
  return {
    ...message,
    text: clipTo(message.text, SNAPSHOT_TEXT_MAX),
    ...(message.error !== undefined && { error: clipTo(message.error, SNAPSHOT_DETAIL_MAX) }),
    ...(message.items !== undefined && { items: message.items.map(snapshotItem) }),
  }
}

/** 대화의 `!명령` 카드를 보이는 범위만 — 잘림(omitted) 이전의 카드는 기록과 함께 빼고, position 은 보이는 말풍선 기준으로 다시 센다 (0 = 첫 말풍선 앞).
 *  카드가 없으면(또는 전부 잘리면) undefined — 필드 자체가 없다 (기존과 같은 규칙) */
export function snapshotShells(shells: readonly ShellCard[] | undefined, omitted: number): ShellCard[] | undefined {
  if (shells === undefined) return undefined
  const kept = omitted === 0 ? [...shells] : shells.filter((shell) => shell.position >= omitted).map((shell) => (shell.position === omitted ? shell : { ...shell, position: shell.position - omitted }))
  return kept.length > 0 ? kept : undefined
}

/** POST /v1/conversations/{cid}/messages → 202. 같은 clientMessageId 를 다시 보내면 턴을 또 만들지 않고 처음 결과를 준다 */
export interface SendMessageRequest {
  text: string
  clientMessageId: string
  mode?: RemoteMode
  model?: ModelChoice
}
export interface SendMessageResponse {
  /** sent: 바로 턴이 됐다. queued: 턴이 도는 중이라 그 대화 대기열에 들어갔다. interjected: 도는 턴에 끼워 넣었다 (이슈 #250 — 'turn.interjected') */
  state: 'sent' | 'queued' | 'interjected'
}

/** POST /v1/conversations/{cid}/stop */
export interface StopResponse {
  stopped: boolean
}

/** POST /v1/conversations/{cid}/queue/take — 대기열을 합쳐 돌려주고 비운다 (누른 쪽 입력창으로). 비어 있으면 빈 글 */
export interface QueueTakeResponse {
  text: string
}

/** POST /v1/attention/{sessionId}/{requestId} — 본문은 { answer: AttentionAnswer }. 전체 권한 모드 대화의 요청이면 403 (데스크탑에서만 답한다) */
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
  /** 도는 턴에 사람이 친 말을 끼워 넣었다 (이슈 #250) — ChatEventMap 과 같다 */
  'turn.interjected': { cid: string; message: HistoryMessage }
  'turn.ended': { cid: string; message: HistoryMessage; usage?: TurnUsage; outcome: TurnOutcome; unanswered?: string[] }
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
