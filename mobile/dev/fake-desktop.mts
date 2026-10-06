// ⚠️ 개발용 가짜 데스크탑 — 제품 코드가 아니다. 앱 번들·설치본 어디에도 들어가지 않는다 (앱은 이 파일을 import 하지 않는다).
// **평문 http** 다: TLS 도, 지문 고정도, 데스크탑 [허용] 확인도 없다. 페어링 코드는 고정이고 몇 번이든 쓸 수 있다.
// (시험은 `tls` 옵션으로 자체 서명 https 로도 띄운다 — 폰의 지문 고정 경로를 재려고. 명령줄로는 평문만 띄운다.)
// 믿을 수 있는 망(내 PC·에뮬레이터·내 폰)에서 앱을 개발할 때만 띄운다. 진짜 대화·파일·키는 여기에 없다.
//
// 데스크탑 쪽 원격 서비스(ctx.chat·ctx.remote)가 아직 없어서, shared/remote.ts 계약(/v1 REST + SSE, 01t 2절)을 흉내 낸다 (이슈 #42):
// - 고정된 프로젝트 2개·대화 4개 (그중 하나는 full 모드 — 폰 전송이 403 으로 거절된다)
// - 메시지를 보내면 진행 줄(생각 → bash 도구 → 글)을 시간차로 흘리고 "echo: <보낸 글>" 로 끝낸다
// - 글에 `[ask]` 가 있으면 도구 전에 승인 요청을 낸다. 먼저 온 답이 이기고(ok) 그 뒤 답은 `elsewhere`. 거절하면 턴이 그 자리에서 끝난다
// - 턴이 도는 중에 보낸 것은 대기열에 쌓였다가 턴이 끝나면 줄바꿈으로 합쳐 한 턴으로 간다. 멈춘(stop) 턴 뒤에는 보내지 않고 남긴다
// - 이벤트는 최근 2000개를 쥐고 `?run=&after=` 로 이어 준다. 못 이으면 `reset`
//
// 띄우기 (Node 22.18+ — .ts 를 그대로 실행한다):
//   node mobile/dev/fake-desktop.mts                        # http://127.0.0.1:47600 (안드로이드 에뮬레이터에서는 http://10.0.2.2:47600)
//   node mobile/dev/fake-desktop.mts --host 192.168.0.12    # 실제 폰에서 붙을 때 — 그 주소에도 연다 (127.0.0.1 은 늘 연다)
//   옵션: --port <n>(기본 47600) · --step <ms>(진행 줄 간격, 기본 700) · --auto-allow(짝짓기를 묻지 않고 허용)
// 짝짓기: 폰이 코드를 보내면 터미널에 기기 이름과 확인 코드가 찍힌다 — 폰 화면의 것과 같은지 보고 `allow`(또는 `deny`)를 친다. 60초 안에 안 치면 408
// 뜬 뒤 터미널에 한 줄 치면: `allow`·`deny`(짝짓기 요청에 답) · `say c_login 안녕`(데스크탑에서 보낸 턴 — 폰 알림 시험) · `drop`(이벤트 스트림을 끊는다 — 다시 붙기 확인) · `restart`(데스크탑 재시작 흉내 — runId 가 바뀐다) ·
//   `revoke`(모든 기기 해제)

import { createHash, randomBytes, X509Certificate } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { pathToFileURL } from 'node:url'
import type { Attention, AttentionAnswer, HistoryMessage, NoticeState, TurnItem } from '../../shared/contract.ts'
import {
  REMOTE_API_VERSION,
  REMOTE_PING_INTERVAL_MS,
  type AttentionReplyResponse,
  type ConversationSnapshot,
  type CreateConversationRequest,
  type Hello,
  type PairRequest,
  type PairResponse,
  type QueueTakeResponse,
  type RemoteConversation,
  type RemoteEventMap,
  type RemoteEventName,
  type RemoteModel,
  type RemoteProject,
  type SendMessageRequest,
  type SendMessageResponse,
  type StopResponse,
} from '../../shared/remote.ts'
import { confirmCode, groupCode, normalizePairCode, pairDeviceName } from '../../shared/remotePairing.ts'
import { fingerprintCode } from '../src/core/pairQr.ts'

export const FAKE_PAIR_CODE = 'DEV0DEV0DEV0'
const EVENT_RING = 2000

export interface FakeDesktopOptions {
  /** 127.0.0.1 말고 더 열 주소 */
  hosts?: string[]
  /** 0 이면 빈 포트 */
  port?: number
  /** 진행 줄 사이 간격 */
  stepMs?: number
  pingMs?: number
  /** 짝짓기 요청을 바로 허용하지 않고 answerPair 를 기다린다 (진짜 데스크탑의 [허용] 확인처럼). 기본은 바로 허용 */
  manualPair?: boolean
  /** manualPair 일 때 답을 기다리는 시간 (기본 60초 — 지나면 408) */
  pairWaitMs?: number
  /** manualPair 일 때 요청이 왔다 — confirm 은 폰 화면에 뜬 것과 같아야 하는 확인 코드 */
  onPairRequest?(request: { deviceName: string; confirm: string }): void
  /** 주면 https 로 연다 (시험용 자체 서명 인증서 — tests/fixtures). 확인 코드는 인증서 지문 앞 8자가 된다 */
  tls?: { key: string; cert: string }
}

export interface FakeDesktop {
  /** http(s)://127.0.0.1:<port> */
  url: string
  port: number
  /** tls 일 때 인증서 지문 (SPKI SHA-256 base64url) */
  fingerprint?: string
  /** 시작된 턴 수 (대기열에서 합쳐 간 것은 한 턴) */
  turnCount(): number
  /** 그 대화의 턴이 도는 중인가 */
  running(cid: string): boolean
  /** 열린 이벤트 스트림을 다 끊는다 (서버는 살아 있다) */
  dropStreams(): void
  /** 데스크탑 재시작 흉내 — runId 가 바뀌고 seq 가 0 부터 다시 간다. 돌던 턴은 "중단됨" 으로 남는다 */
  restart(): void
  /** 데스크탑에서 보낸 것처럼 그 대화에 턴을 시작한다 (폰이 보지 않는 대화에서 일이 생기게 — 알림 시험). 없는 대화·도는 중이면 false */
  say(cid: string, text: string): boolean
  /** 기다리는 짝짓기 요청 (manualPair) */
  pendingPair(): { deviceName: string; confirm: string } | undefined
  /** 기다리는 짝짓기 요청에 답한다. 기다리는 것이 없으면 false */
  answerPair(allow: boolean): boolean
  /** 모든 기기를 해제한다 — `device.revoked` 를 보내고 끊는다. 그 토큰은 401 */
  revokeAll(): void
  close(): Promise<void>
}

interface PendingPair {
  deviceName: string
  confirm: string
  settle(result: 'allow' | 'deny' | 'timeout'): void
}

interface Turn {
  startedAt: number
  items: Map<string, TurnItem>
  attention: Attention[]
  /** 남은 걸음 */
  steps: (() => 'wait' | void)[]
  timer?: ReturnType<typeof setTimeout>
}

interface Chat {
  info: RemoteConversation
  messages: HistoryMessage[]
  queue: string[]
  /** 멈춘 턴 뒤 — 대기열을 보내지 않고 남긴다 (되돌리면 풀린다) */
  held: boolean
  turn?: Turn
}

const PROJECTS: RemoteProject[] = [
  { path: '/Users/dev/work/litecode', name: 'litecode', displayPath: '~/work/litecode', favorite: true },
  { path: '/Users/dev/work/api-server', name: 'api-server', displayPath: '~/work/api-server', favorite: false },
]

const MODELS: RemoteModel[] = [
  { providerId: 'gateway', providerName: '사내 게이트웨이', modelId: 'qwen3.8-27b', displayName: 'Qwen 3.8 27B' },
  { providerId: 'gateway', providerName: '사내 게이트웨이', modelId: 'coder-large', displayName: 'Coder Large' },
]

export async function startFakeDesktop(options: FakeDesktopOptions = {}): Promise<FakeDesktop> {
  const stepMs = options.stepMs ?? 700
  const pingMs = options.pingMs ?? REMOTE_PING_INTERVAL_MS
  const fingerprint = options.tls ? createHash('sha256').update(new X509Certificate(options.tls.cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64url') : undefined
  const model = { providerId: MODELS[0]!.providerId, modelId: MODELS[0]!.modelId }

  let runId = newRunId()
  let seq = 0
  let log: { seq: number; event: string; data: unknown }[] = []
  let counter = 0
  let turns = 0
  const tokens = new Map<string, string>() // 토큰 → deviceId
  let pending: PendingPair | undefined
  const streams = new Set<http.ServerResponse>()
  const sent = new Map<string, SendMessageResponse>() // clientMessageId → 처음 결과
  const notices: NoticeState = {}
  const chats = new Map<string, Chat>()

  const seed = (id: string, project: string, title: string, ageMs: number, mode: RemoteConversation['mode'], messages: HistoryMessage[]): void => {
    chats.set(id, { info: { id, project, title, updatedAt: Date.now() - ageMs, model, mode, engineSessionId: `ses_${id}` }, messages, queue: [], held: false })
  }
  seed('c_login', PROJECTS[0]!.path, '로그인 버그 수정', 2 * 60_000, 'build', [
    { id: 'msg_seed_1', role: 'user', text: '로그인이 안 돼. 원인 찾아줘', at: Date.now() - 3 * 60_000, mode: 'build' },
    {
      role: 'assistant',
      text: '원인은 **세션 쿠키의 만료 시각**을 초가 아니라 밀리초로 넣은 것입니다.\n\n```ts\ncookie.maxAge = ttl / 1000\n```\n\n`src/auth/session.ts` 를 고쳤습니다.',
      duration: 12_000,
      items: [
        { kind: 'think', id: 'seed_think', text: '로그인 흐름에서 쿠키를 어디서 만드는지 찾아본다.', done: true },
        { kind: 'tool', id: 'seed_tool', name: 'grep', status: 'done', summary: 'maxAge', input: '{"pattern":"maxAge"}', result: 'src/auth/session.ts:41' },
      ],
    },
  ])
  seed('c_tests', PROJECTS[0]!.path, '테스트 정리', 60 * 60_000, 'plan', [])
  seed('c_readme', PROJECTS[0]!.path, 'README 다듬기 (전체 권한)', 26 * 60 * 60_000, 'full', [])
  seed('c_deploy', PROJECTS[1]!.path, '배포 스크립트', 3 * 60 * 60_000, 'ask', [])

  // ── 이벤트 ──────────────────────────────────────────────────────────────────────────────────

  const frame = (event: string, data: unknown, id?: number): string => `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

  const emit = <K extends RemoteEventName>(event: K, data: RemoteEventMap[K]): void => {
    seq += 1
    log.push({ seq, event, data })
    if (log.length > EVENT_RING) log.shift()
    for (const stream of streams) stream.write(frame(event, data, seq))
  }

  const notice = (chat: Chat, status: NoticeState[string]['status'] | undefined): void => {
    if (status) notices[chat.info.id] = { project: chat.info.project, status }
    else delete notices[chat.info.id]
    emit('notices.changed', { ...notices })
  }

  // ── 턴 ─────────────────────────────────────────────────────────────────────────────────────

  const progress = (chat: Chat, item: TurnItem): void => {
    chat.turn?.items.set(item.id, item)
    emit('turn.progress', { cid: chat.info.id, item })
  }

  const endTurn = (chat: Chat, outcome: 'done' | 'interrupted', extra: Partial<HistoryMessage> = {}): void => {
    const turn = chat.turn
    if (!turn) return
    clearTimeout(turn.timer)
    chat.turn = undefined
    const text = [...turn.items.values()].flatMap((item) => (item.kind === 'text' ? [item.text] : [])).join('')
    const message: HistoryMessage = { role: 'assistant', text, items: [...turn.items.values()], duration: Date.now() - turn.startedAt, ...extra }
    chat.messages.push(message)
    chat.info.updatedAt = Date.now()
    emit('turn.ended', {
      cid: chat.info.id,
      message,
      outcome,
      usage: { steps: 2, tokens: { input: 1200, output: 80, reasoning: 20, cacheRead: 0, cacheWrite: 0 }, llmMs: stepMs * 4, toolMs: stepMs, ttftMs: stepMs, ttftSteps: 2, lastContextTokens: 1300 },
    })
    notice(chat, outcome === 'done' ? 'done' : 'interrupted')
    emit('conversations.changed', { project: chat.info.project })
    if (outcome === 'done' && !chat.held && chat.queue.length > 0) {
      const merged = chat.queue.join('\n')
      chat.queue = []
      emit('queue.changed', { cid: chat.info.id, items: [] })
      startTurn(chat, merged, `msg_fake_${++counter}`, 'desktop')
    }
  }

  const advance = (chat: Chat): void => {
    const turn = chat.turn
    if (!turn) return
    turn.timer = setTimeout(() => {
      const step = turn.steps.shift()
      if (!step) return
      if (step() !== 'wait' && chat.turn === turn) advance(chat)
    }, stepMs)
  }

  const startTurn = (chat: Chat, text: string, messageId: string, origin: string): void => {
    turns += 1
    const n = ++counter
    const cid = chat.info.id
    const answer = `echo: ${text}`
    const turn: Turn = { startedAt: Date.now(), items: new Map(), attention: [], steps: [] }
    const tool = (status: 'preparing' | 'running' | 'done'): TurnItem => ({
      kind: 'tool',
      id: `tool_${n}`,
      name: 'bash',
      status,
      summary: '받은 글을 그대로 출력',
      input: status === 'preparing' ? undefined : JSON.stringify({ command: `echo ${JSON.stringify(text)}` }),
      result: status === 'done' ? text : undefined,
    })
    turn.steps = [
      () => progress(chat, { kind: 'think', id: `think_${n}`, text: '요청을', done: false }),
      () => progress(chat, { kind: 'think', id: `think_${n}`, text: '요청을 살펴보고 그대로 되돌려 준다.', done: true }),
      ...(text.includes('[ask]')
        ? [
            (): 'wait' => {
              turn.attention = [{ kind: 'permission', id: `per_${n}`, sessionId: chat.info.engineSessionId ?? `ses_${cid}`, action: 'bash', resources: [`echo ${JSON.stringify(text)}`] }]
              emit('turn.attention', { cid, requests: turn.attention })
              notice(chat, 'attention')
              return 'wait'
            },
          ]
        : []),
      () => progress(chat, tool('preparing')),
      () => progress(chat, tool('running')),
      () => progress(chat, tool('done')),
      () => progress(chat, { kind: 'text', id: `text_${n}`, text: answer.slice(0, Math.ceil(answer.length / 2)), done: false }),
      () => progress(chat, { kind: 'text', id: `text_${n}`, text: answer, done: true }),
      () => endTurn(chat, 'done'),
    ]
    chat.turn = turn
    chat.held = false
    const message: HistoryMessage = { id: messageId, role: 'user', text, at: turn.startedAt, mode: chat.info.mode }
    chat.messages.push(message)
    if (!chat.info.title) chat.info.title = text.slice(0, 24)
    chat.info.updatedAt = turn.startedAt
    emit('turn.started', { cid, message, origin })
    notice(chat, 'running')
    emit('conversations.changed', { project: chat.info.project })
    advance(chat)
  }

  // ── REST ───────────────────────────────────────────────────────────────────────────────────

  const routes: Record<string, (ctx: { params: string[]; query: URLSearchParams; body: unknown; deviceId: string }) => [number, unknown]> = {
    'GET /v1/hello': () => [200, { desktopId: 'fake-desktop', name: '가짜 데스크탑 (개발용)', appVersion: '0.0.0-fake', apiVersion: REMOTE_API_VERSION, runId, seq, addresses: listening } satisfies Hello],
    'GET /v1/projects': () => [200, PROJECTS],
    'GET /v1/conversations': ({ query }) => {
      const project = query.get('project')
      const list = [...chats.values()].filter((chat) => chat.info.project === project).sort((a, b) => b.info.updatedAt - a.info.updatedAt)
      return [200, list.map((chat): RemoteConversation => ({ ...chat.info, status: notices[chat.info.id]?.status }))]
    },
    'POST /v1/conversations': ({ body }) => {
      const request = body as CreateConversationRequest
      if (!PROJECTS.some((project) => project.path === request?.project)) return [404, { error: '등록되지 않은 프로젝트' }]
      if ((request.mode as string | undefined) === 'full') return [403, { error: '전체 권한 모드는 데스크탑에서만' }]
      const id = `c_new_${++counter}`
      const chat: Chat = { info: { id, project: request.project, title: '', updatedAt: Date.now(), model: request.model ?? model, mode: request.mode ?? 'build', engineSessionId: `ses_${id}` }, messages: [], queue: [], held: false }
      chats.set(id, chat)
      emit('conversations.changed', { project: request.project })
      return [200, chat.info]
    },
    'GET /v1/conversations/*': ({ params }) => {
      const chat = chats.get(params[0]!)
      if (!chat) return [404, { error: '없는 대화' }]
      const live = chat.turn ? { progress: [...chat.turn.items.values()], attention: chat.turn.attention, queue: chat.queue } : undefined
      return [200, { history: { messages: [...chat.messages] }, live, seq } satisfies ConversationSnapshot]
    },
    'POST /v1/conversations/*/messages': ({ params, body, deviceId }) => {
      const chat = chats.get(params[0]!)
      const request = body as SendMessageRequest
      if (!chat) return [404, { error: '없는 대화' }]
      if (typeof request?.text !== 'string' || !request.text.trim() || typeof request.clientMessageId !== 'string') return [400, { error: 'text·clientMessageId 가 필요하다' }]
      const before = sent.get(request.clientMessageId)
      if (before) return [202, before]
      if ((request.mode as string | undefined) === 'full' || chat.info.mode === 'full') return [403, { error: '전체 권한 모드의 대화는 데스크탑에서만 보낼 수 있다' }]
      if (request.mode) chat.info.mode = request.mode
      if (request.model) chat.info.model = request.model
      let result: SendMessageResponse
      if (chat.turn || chat.queue.length > 0) {
        chat.queue.push(request.text)
        emit('queue.changed', { cid: chat.info.id, items: [...chat.queue] })
        result = { state: 'queued' }
      } else {
        startTurn(chat, request.text, request.clientMessageId, deviceId)
        result = { state: 'sent' }
      }
      sent.set(request.clientMessageId, result)
      return [202, result]
    },
    'POST /v1/conversations/*/stop': ({ params }) => {
      const chat = chats.get(params[0]!)
      if (!chat) return [404, { error: '없는 대화' }]
      if (!chat.turn) return [200, { stopped: false } satisfies StopResponse]
      chat.held = true
      endTurn(chat, 'interrupted', { interrupted: true, error: '중단됨' })
      return [200, { stopped: true } satisfies StopResponse]
    },
    'POST /v1/conversations/*/queue/take': ({ params }) => {
      const chat = chats.get(params[0]!)
      if (!chat) return [404, { error: '없는 대화' }]
      const text = chat.queue.join('\n')
      chat.held = false
      if (chat.queue.length > 0) {
        chat.queue = []
        emit('queue.changed', { cid: chat.info.id, items: [] })
      }
      return [200, { text } satisfies QueueTakeResponse]
    },
    'POST /v1/attention/*/*': ({ params, body }) => {
      const answer = (body as { answer?: AttentionAnswer } | undefined)?.answer
      const chat = [...chats.values()].find((candidate) => candidate.turn?.attention.some((request) => request.sessionId === params[0] && request.id === params[1]))
      // 이미 답한(또는 없는) 요청 — 진짜 데스크탑은 엔진의 404 를 이렇게 바꾼다
      if (!chat?.turn) return [200, { handled: 'elsewhere' } satisfies AttentionReplyResponse]
      chat.turn.attention = []
      emit('turn.attention', { cid: chat.info.id, requests: [] })
      if (answer === 'reject') {
        endTurn(chat, 'done', { declined: true })
      } else {
        notice(chat, 'running')
        advance(chat)
      }
      return [200, { handled: 'ok' } satisfies AttentionReplyResponse]
    },
    'GET /v1/models': () => [200, MODELS],
  }

  const openEvents = (query: URLSearchParams, response: http.ServerResponse): void => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const run = query.get('run')
    const after = Number(query.get('after') ?? Number.NaN)
    const oldest = log[0]?.seq ?? seq + 1
    if (run === null) {
      response.write(frame('ready', { runId, seq }))
    } else if (run === runId && after <= seq && after >= oldest - 1) {
      response.write(frame('ready', { runId, seq }))
      for (const entry of log) if (entry.seq > after) response.write(frame(entry.event, entry.data, entry.seq))
    } else {
      response.write(frame('reset', { runId, seq }))
    }
    streams.add(response)
    const ping = setInterval(() => response.write(': ping\n\n'), pingMs)
    response.on('close', () => {
      clearInterval(ping)
      streams.delete(response)
    })
  }

  const handle = async (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://fake')
    const reply = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    // 우리 클라이언트는 브라우저가 아니다 (01t 3절)
    if (request.headers.origin) return reply(403, { error: 'Origin 이 있는 요청은 받지 않는다' })

    let raw = ''
    for await (const chunk of request) raw += chunk
    let body: unknown
    try {
      body = raw ? JSON.parse(raw) : undefined
    } catch {
      return reply(400, { error: 'JSON 이 아니다' })
    }

    if (request.method === 'POST' && url.pathname === '/v1/pair') {
      // 진짜 데스크탑(src/services/remote.ts)과 같은 답: 틀린 코드 403 'wrong pairing code', 거절 403 'denied on the desktop', 시간 초과 408.
      // 다른 점: 코드가 고정이고 몇 번이든 쓸 수 있다(진짜는 2분·1회용·5회 폐기), 여러 번 틀려도 막지 않는다(진짜는 429)
      const pair = body as PairRequest | undefined
      const deviceName = typeof pair?.deviceName === 'string' ? pairDeviceName(pair.deviceName) : ''
      if (typeof pair?.code !== 'string' || !deviceName || (pair.platform !== 'android' && pair.platform !== 'ios')) return reply(400, { error: 'code, deviceName and platform are required' })
      if (normalizePairCode(pair.code) !== FAKE_PAIR_CODE) return reply(403, { error: 'wrong pairing code' })
      const allow = (): void => {
        const paired: PairResponse = { deviceId: `dev_${++counter}`, token: randomBytes(32).toString('hex') }
        tokens.set(paired.token, paired.deviceId)
        reply(200, paired)
      }
      if (!options.manualPair) return allow()
      // 데스크탑 [허용] 을 기다린다 — answerPair(터미널의 allow·deny) 또는 시간 초과
      pending?.settle('deny') // 앞 요청은 새 요청이 밀어낸다 (가짜 서버는 한 번에 하나만 쥔다)
      const timer = setTimeout(() => waiting.settle('timeout'), options.pairWaitMs ?? 60_000)
      const waiting: PendingPair = {
        deviceName,
        confirm: fingerprint ? fingerprintCode(fingerprint) : confirmCode(FAKE_PAIR_CODE, deviceName, pair.platform),
        settle(result) {
          if (pending !== waiting) return
          pending = undefined
          clearTimeout(timer)
          if (result === 'allow') allow()
          else if (result === 'deny') reply(403, { error: 'denied on the desktop' })
          else reply(408, { error: 'nobody answered on the desktop' })
        },
      }
      pending = waiting
      options.onPairRequest?.({ deviceName, confirm: waiting.confirm })
      return
    }

    const deviceId = tokens.get((request.headers.authorization ?? '').replace(/^Bearer /, ''))
    if (!deviceId) return reply(401, { error: '짝지은 기기가 아니다' })
    if (request.method === 'GET' && url.pathname === '/v1/events') return openEvents(url.searchParams, response)

    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    for (const [key, route] of Object.entries(routes)) {
      const [method, pattern] = key.split(' ') as [string, string]
      const wanted = pattern.split('/').filter(Boolean)
      if (method !== request.method || wanted.length !== parts.length || !wanted.every((part, index) => part === '*' || part === parts[index])) continue
      return reply(...route({ params: parts.filter((_, index) => wanted[index] === '*'), query: url.searchParams, body, deviceId }))
    }
    reply(404, { error: '없는 경로' })
  }

  // ── 리스너 ─────────────────────────────────────────────────────────────────────────────────

  const servers: http.Server[] = []
  const listening: string[] = []
  let port = options.port ?? 47600
  for (const host of ['127.0.0.1', ...(options.hosts ?? [])]) {
    const listener = (request: http.IncomingMessage, response: http.ServerResponse): void => void handle(request, response).catch(() => response.destroy())
    const server = options.tls ? https.createServer({ key: options.tls.key, cert: options.tls.cert }, listener) : http.createServer(listener)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, resolve)
    })
    port = (server.address() as { port: number }).port
    servers.push(server)
    listening.push(`${host}:${port}`)
  }

  const dropStreams = (): void => {
    for (const stream of streams) stream.destroy()
  }

  return {
    url: `${options.tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    port,
    fingerprint,
    turnCount: () => turns,
    running: (cid) => chats.get(cid)?.turn !== undefined,
    dropStreams,
    restart() {
      for (const chat of chats.values()) {
        if (!chat.turn) continue
        clearTimeout(chat.turn.timer)
        chat.messages.push({ role: 'assistant', text: '', items: [...chat.turn.items.values()], interrupted: true, error: '중단됨' })
        chat.turn = undefined
        chat.queue = []
      }
      for (const id of Object.keys(notices)) delete notices[id]
      runId = newRunId()
      seq = 0
      log = []
      dropStreams()
    },
    say(cid, text) {
      const chat = chats.get(cid)
      if (!chat || chat.turn) return false
      startTurn(chat, text, `msg_fake_${++counter}`, 'desktop')
      return true
    },
    pendingPair: () => pending && { deviceName: pending.deviceName, confirm: pending.confirm },
    answerPair(allow) {
      if (!pending) return false
      pending.settle(allow ? 'allow' : 'deny')
      return true
    },
    revokeAll() {
      tokens.clear()
      for (const stream of streams) stream.end(frame('device.revoked', {}))
    },
    async close() {
      pending?.settle('deny')
      for (const chat of chats.values()) clearTimeout(chat.turn?.timer)
      dropStreams()
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
    },
  }
}

function newRunId(): string {
  return `run_${randomBytes(6).toString('hex')}`
}

// ── 명령줄 ─────────────────────────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const values = (name: string): string[] => args.flatMap((arg, index) => (arg === name && args[index + 1] ? [args[index + 1]!] : []))
  const desktop = await startFakeDesktop({
    hosts: values('--host'),
    port: Number(values('--port')[0] ?? 47600),
    stepMs: Number(values('--step')[0] ?? 700),
    manualPair: !args.includes('--auto-allow'),
    onPairRequest: ({ deviceName, confirm }) => console.log(`짝짓기 요청: "${deviceName}" · 확인 코드 ${confirm} (폰 화면과 같은지 보고) → allow 또는 deny`),
  })
  console.log(`가짜 데스크탑 (개발용 · 평문 http) — ${['127.0.0.1', ...values('--host')].map((host) => `http://${host}:${desktop.port}`).join(' , ')}`)
  console.log(`페어링 코드: ${groupCode(FAKE_PAIR_CODE)}   (안드로이드 에뮬레이터에서는 10.0.2.2:${desktop.port})`)
  console.log('명령: allow | deny (짝짓기 요청에 답) · say <대화 id> <글> (데스크탑에서 보낸 턴 — [ask] 를 넣으면 승인 요청) · drop | restart | revoke   (Ctrl+C 로 끝낸다)')
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    for (const command of chunk.split('\n').map((line) => line.trim()).filter(Boolean)) {
      if (command === 'allow' || command === 'deny') console.log(desktop.answerPair(command === 'allow') ? `→ ${command}` : '기다리는 짝짓기 요청이 없다')
      else if (command.startsWith('say ')) {
        const [, cid = '', ...words] = command.split(' ')
        console.log(desktop.say(cid, words.join(' ') || '안녕') ? `→ say ${cid}` : `못 보냈다 (없는 대화거나 도는 중): ${cid}`)
      } else if (command === 'drop') (desktop.dropStreams(), console.log('→ drop'))
      else if (command === 'restart') (desktop.restart(), console.log('→ restart'))
      else if (command === 'revoke') (desktop.revokeAll(), console.log('→ revoke'))
      else console.log('모르는 명령')
    }
  })
}
