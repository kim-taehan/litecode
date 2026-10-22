import type { Context } from 'cordis'
import { engineModelId, resolveModelKey } from '../../../shared/engineModelId.ts'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import { tr } from '../../i18n.ts'
import { emptyChatView, withHistory } from '../../../shared/chatReducer.ts'
import type { ChatOrigin, QueuedSend } from '../../../shared/chat.ts'
import type { Conversation, History } from '../../../shared/contract.ts'
import { DEFAULT_MODE, isMode, type Mode } from '../../../shared/modes.ts'
import {
  REMOTE_API_VERSION,
  snapshotMessage,
  snapshotTailAt,
  snapshotShells,
  type AttentionReplyResponse,
  type ConversationSnapshot,
  type Hello,
  type ModelChoice,
  type QueueTakeResponse,
  type RemoteEventMap,
  type RemoteEventName,
  type RemoteModel,
  type RemoteProject,
  type SendMessageResponse,
  type StopResponse,
} from '../../../shared/remote.ts'
import type { DeviceStore } from './devices.ts'
import type { EventLog } from './eventLog.ts'
import { DRAFT_LIMIT, SENT_MEMORY } from './limits.ts'
import type { RemoteServiceOptions, Reply, RouteInput } from './types.ts'
import { isAnswer, liveStatus, toRemote } from './wire.ts'

// 짝지은 기기의 REST 요청 (이슈 #298 에서 remote.ts 의 RemoteService.routes 와 도우미를 옮김, 동작 그대로) — hello·프로젝트·대화 목록·새 대화·
// 대화 스냅샷·보내기·중지·대기열 되돌리기·승인 답·모델. 인증·경로 고르기는 서비스의 handle 이 하고, 여기는 표만 준다.
// **엔진을 모른다**: 쓰기는 전부 ctx.chat, 읽기는 ctx.sessions·ctx.projects·ctx.providers 로만

/** 요청 표에 넘기는 서비스의 상태 — 같은 Map·저장소를 그대로 넘긴다. 바뀌는 값(이벤트 링)은 함수로 그때그때 읽는다 */
export interface RouteHost {
  /** 서비스의 this.ctx */
  ctx: Context
  opts: RemoteServiceOptions
  store: DeviceStore
  /** 폰이 만든 새 대화 (RemoteService.drafts) */
  drafts: Map<string, Conversation>
  /** `대화 id\nclientMessageId` → 처음 결과 (RemoteService.sent) */
  sent: Map<string, Promise<SendMessageResponse>>
  now(): number
  /** 지금의 이벤트 링 — 운반을 다시 띄우면 새 링으로 바뀐다 */
  log(): EventLog
  listening(): string[]
  fingerprint(): string | undefined
  loadBluetoothKey(): Promise<string | undefined>
  emitEvent<K extends RemoteEventName>(event: K, data: RemoteEventMap[K]): void
}

export type Route = (input: RouteInput) => Promise<Reply> | Reply

export function remoteRoutes(host: RouteHost): Record<string, Route> {
  return {
    'GET /v1/hello': async () => {
      const bluetoothKey = await host.loadBluetoothKey()
      return [
        200,
        {
          desktopId: host.store.desktopId,
          name: host.opts.name ?? os.hostname(),
          appVersion: host.opts.appVersion ?? '',
          apiVersion: REMOTE_API_VERSION,
          runId: host.log().runId,
          seq: host.log().seq,
          addresses: host.listening(),
          ...(host.fingerprint() && { fingerprint: host.fingerprint() }),
          // 블루투스가 켜져 있으면 공개키 — Wi-Fi 로 짝지은 폰이 다시 짝짓지 않고 블루투스 키를 배운다 (이슈 #229). 폰은 TLS 로 받은 것만 믿는다
          ...(bluetoothKey && { bluetoothKey }),
        } satisfies Hello,
      ]
    },

    'GET /v1/projects': async () => [200, (await host.ctx.projects.list()) satisfies RemoteProject[]],

    'GET /v1/conversations': async ({ query }) => {
      const project = query.get('project')
      if (!project || !(await registered(host, project))) return [200, []]
      const notices = host.ctx.get('notifications')?.snapshot() ?? {}
      const stored = (await host.ctx.sessions.list()).filter((entry) => entry.project === project)
      const drafts = [...host.drafts.values()].filter((entry) => entry.project === project && !stored.some((saved) => saved.id === entry.id))
      const list = [...drafts, ...stored].sort((a, b) => b.updatedAt - a.updatedAt)
      // 진행 중·답 필요는 ctx.chat 의 도는 턴에서 (알림 기능과 무관 — emitNotices), 안 본 끝남만 알림 기능에서
      const live = host.ctx.chat.snapshot()
      return [200, list.map((entry) => toRemote({ ...entry, model: listedModel(host, entry.model) }, liveStatus(live[entry.id]) ?? notices[entry.id]?.status))]
    },

    // 새 대화 — 등록된 프로젝트에만. 첫 메시지를 보낼 때 ctx.chat 이 저장한다 (그 전엔 폰에만 보인다)
    'POST /v1/conversations': async ({ body }) => {
      const input = body as { project?: unknown; model?: unknown; mode?: unknown } | undefined
      if (typeof input?.project !== 'string' || !(await registered(host, input.project))) return [404, { error: 'not a registered project' }]
      if (input.mode === 'full') return [403, { error: 'full access mode is desktop-only' }]
      if (input.mode !== undefined && !isMode(input.mode)) return [400, { error: 'unknown mode' }]
      // 모델을 안 골랐으면 데스크탑에 설정된 첫 모델
      const model = modelOf(host, input.model === undefined ? models(host)[0] : input.model)
      if (!model) return [400, { error: input.model === undefined ? 'no model is configured on the desktop' : 'unknown model' }]
      const fallback = host.ctx.settings.get().defaultMode
      const mode: Mode = input.mode ?? (fallback === 'full' ? DEFAULT_MODE : fallback)
      const draft: Conversation = { id: `c_${randomBytes(12).toString('hex')}`, project: input.project, title: '', updatedAt: host.now(), model, mode }
      host.drafts.set(draft.id, draft)
      for (const id of [...host.drafts.keys()].slice(0, Math.max(0, host.drafts.size - DRAFT_LIMIT))) host.drafts.delete(id)
      host.emitEvent('conversations.changed', { project: draft.project })
      return [200, toRemote({ ...draft, model: listedModel(host, draft.model) })]
    },

    // 스냅샷 + 그 시점 seq. 기록을 읽는 사이 이 대화의 이벤트가 지나갔으면 다시 읽는다 — 스냅샷과 스트림 사이에 틈·겹침이 없게
    'GET /v1/conversations/*': async ({ params }) => {
      const cid = params[0]!
      const conversation = await conversationOf(host, cid)
      if (!conversation) return [404, { error: 'no such conversation' }]
      let history: History = { messages: [] }
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = host.log().seq
        history = host.drafts.has(cid) ? { messages: [] } : await host.ctx.sessions.history(cid)
        if (!host.log().after(before).some((entry) => (entry.data as { cid?: string } | null)?.cid === cid)) break
      }
      const live = host.ctx.chat.snapshot()[cid]
      const turn = live?.turn
      // 턴이 도는 중이면 기록은 그 턴의 내 말까지만 — 쓰다 만 답은 live.progress 가 그리고, 끝나면 turn.ended 가 붙인다.
      // 끼워 넣은 말이 있으면(이슈 #250) 그 뒤에 메인이 쥔 얼린 답·끼워 넣은 말 — live.progress 는 마지막 끼워 넣은 말 뒤의 줄이다
      const combined = turn ? [...withHistory({ ...emptyChatView, running: true, messages: [turn.message] }, history.messages).messages, ...(turn.interjections ?? [])] : history.messages
      // 폰은 전체 역사를 받지 않는다 (#365) — 꼬리(SNAPSHOT_MESSAGE_MAX, 질문 경계)만. 도는 턴은 그 턴의 "내 말"(질문)도 잘리면 안 된다 — 쓰다 만
      // 답이 질문 없이 보이게 되니, 둘 중 앞을(더 많은 쪽을) 쓴다. 마지막 것도 크면 메시지당 캡(진행 줄 전문).
      // live(도는 진행 줄)는 캡하지 않는다 — 폰이 곧 받을 turn.progress 이벤트와 같은 모양이라 스냅샷만 캡하면 줄이 이벤트에서 불게 된다
      const from = turn ? Math.min(snapshotTailAt(combined), Math.max(0, combined.lastIndexOf(turn.message))) : snapshotTailAt(combined)
      // `!` 카드는 읽기 전용으로 싣는다 (#265) — 폰에서 실행하는 길은 없다. 출력은 이미 OUTPUT_LIMIT 으로 잘려 있다. 잘린 범위의 카드는 빼고 position 을 다시 센다 (#365)
      const shells = snapshotShells(conversation.shells, from)
      const snapshot: ConversationSnapshot = {
        history: { ...history, messages: combined.slice(from).map(snapshotMessage) },
        ...(turn && { live: { progress: turn.progress, attention: turn.attention, queue: live.queue.items } }),
        ...(shells && { shells }),
        ...(from > 0 && { omitted: from }),
        seq: host.log().seq,
      }
      return [200, snapshot]
    },

    'POST /v1/conversations/*/messages': async ({ params, body, device }) => {
      const cid = params[0]!
      const input = body as { text?: unknown; clientMessageId?: unknown; mode?: unknown; model?: unknown } | undefined
      const conversation = await conversationOf(host, cid)
      if (!conversation) return [404, { error: 'no such conversation' }]
      const { text, clientMessageId } = input ?? {}
      if (typeof text !== 'string' || !text.trim() || typeof clientMessageId !== 'string' || !clientMessageId || clientMessageId.length > 128) {
        return [400, { error: 'text and clientMessageId are required' }]
      }
      const key = `${cid}\n${clientMessageId}`
      const before = host.sent.get(key)
      if (before) return before.then((result): Reply => [202, result], (error: unknown): Reply => [409, { error: (error as Error).message }])
      // 전체 권한(묻지 않고 다 실행)은 폰에 열지 않는다 — 그 모드로 바꾸지도, 그 모드의 대화에 보내지도 못한다
      if (input?.mode === 'full' || conversation.mode === 'full') return [403, { error: 'conversations in full access mode are desktop-only' }]
      if (input?.mode !== undefined && !isMode(input.mode)) return [400, { error: 'unknown mode' }]
      const picked = input?.model === undefined ? undefined : modelOf(host, input.model)
      if (input?.model !== undefined && !picked) return [400, { error: 'unknown model' }]
      const model = picked && keepThinking(host, conversation.model, picked)
      const draft = host.drafts.get(cid)
      const origin: ChatOrigin = `device:${device.id}`
      // 데스크탑은 이제 사람이 친 글이 대기열로만 가지만, 폰은 도는 턴에 자동으로 끼워 넣는 것을 유지한다 (이슈 #250) —
      // 끼워 넣을 수 없으면 send(대기열·새 턴)로
      const item: QueuedSend = {
        text,
        origin,
        ...(input?.mode !== undefined && { mode: input.mode as Mode }),
        ...(model && { model }),
        // 아직 저장 안 된 새 대화 — 만들 때 정한 프로젝트·모델·모드로 시작한다
        ...(draft && { project: draft.project, model: model ?? draft.model, mode: (input?.mode as Mode | undefined) ?? draft.mode }),
      }
      const interjected: SendMessageResponse = { state: 'interjected' }
      const sending: Promise<SendMessageResponse> = host.ctx.chat.interject(cid, item)
        ? Promise.resolve(interjected)
        : host.ctx.chat.send(cid, item).then(({ state }): SendMessageResponse => ({ state }))
      host.sent.set(key, sending)
      for (const old of [...host.sent.keys()].slice(0, Math.max(0, host.sent.size - SENT_MEMORY))) host.sent.delete(old)
      try {
        return [202, await sending]
      } catch (error) {
        host.sent.delete(key) // 시작도 못 했다 — 같은 id 로 다시 보낼 수 있다
        return [409, { error: (error as Error).message }]
      }
    },

    'POST /v1/conversations/*/stop': async ({ params }) => {
      if (!(await conversationOf(host, params[0]!))) return [404, { error: 'no such conversation' }]
      return [200, { stopped: host.ctx.chat.stop(params[0]!) } satisfies StopResponse]
    },

    // 대기열 되돌리기 — 이 기기가 쌓은 것만 (누른 쪽 입력창으로 간다)
    'POST /v1/conversations/*/queue/take': async ({ params, device }) => {
      if (!(await conversationOf(host, params[0]!))) return [404, { error: 'no such conversation' }]
      const taken = host.ctx.chat.takeQueue(params[0]!, `device:${device.id}`)
      return [200, { text: taken ? (taken.display ?? taken.text) : '' } satisfies QueueTakeResponse]
    },

    // 승인·질문의 답 — 먼저 온 답이 이긴다. 이미 풀린 요청(데스크탑이나 다른 기기가 답했다)은 오류가 아니라 `elsewhere`
    'POST /v1/attention/*/*': async ({ params, body }) => {
      const [sessionId, requestId] = params as [string, string]
      const answer = (body as { answer?: unknown } | undefined)?.answer
      if (!isAnswer(answer)) return [400, { error: 'answer is required' }]
      const waiting = (): boolean =>
        Object.values(host.ctx.chat.snapshot()).some((live) => live.turn?.attention.some((request) => request.sessionId === sessionId && request.id === requestId))
      const elsewhere: Reply = [200, { handled: 'elsewhere' } satisfies AttentionReplyResponse]
      if (!waiting()) return elsewhere
      // 전체 권한 대화의 승인은 데스크탑에서만 (#186 B2) — full 에서도 묻는 도구(litecode_create 등)를 폰이 허용하지 못하게.
      // 그 턴이 full 로 시작했거나(내 말의 mode) 대화가 지금 full 이면 막는다
      const [cid, live] = Object.entries(host.ctx.chat.snapshot()).find(([, entry]) => entry.turn?.attention.some((request) => request.sessionId === sessionId && request.id === requestId))!
      const conversation = (await host.ctx.sessions.list()).find((entry) => entry.id === cid)
      if (live.turn?.message.mode === 'full' || conversation?.mode === 'full') return [403, { error: 'conversations in full access mode are desktop-only' }]
      try {
        await host.ctx.chat.reply(sessionId, requestId, answer)
        return [200, { handled: 'ok' } satisfies AttentionReplyResponse]
      } catch (error) {
        const message = (error as Error).message
        // 그사이 풀렸다 — ctx.llm 이 "이미 끝난 요청" 으로 던지거나, 엔진이 404 로 답한다 (01s 2b)
        if (!waiting() || message === tr('error.attentionGone') || message === tr('error.attentionReply', { status: 404 })) return elsewhere
        return [message === tr('error.attentionAnswer') ? 400 : 502, { error: message }]
      }
    },

    'GET /v1/models': () => [200, models(host)],
  }
}

// ── 도우미 ──────────────────────────────────────────────────────────────────────────────────

/** 주소·키 없이 — provider·모델의 id 와 이름만 */
function models(host: RouteHost): RemoteModel[] {
  return host.ctx.providers
    .list()
    .flatMap((provider) => provider.models.map((model) => ({ providerId: provider.id, providerName: provider.displayName, modelId: engineModelId(model), displayName: model.displayName || model.id })))
}

/** 폰이 고른 모델 — 데스크탑에 설정된 것만. 목록(models)은 항목당 디폴트 키 하나지만, Thinking 모델의 켬·끔 키(데스크탑 대화의 키를 폰이 그대로 돌려줄 때)도 받는다 (이슈 #500) */
function modelOf(host: RouteHost, value: unknown): ModelChoice | undefined {
  const choice = value as Partial<ModelChoice> | null
  if (typeof choice?.providerId !== 'string' || typeof choice.modelId !== 'string') return undefined
  const provider = host.ctx.providers.list().find((entry) => entry.id === choice.providerId)
  return provider && resolveModelKey(provider.models, choice.modelId) ? { providerId: provider.id, modelId: choice.modelId } : undefined
}

/** 키 → (provider 의) 항목. 못 풀면 undefined */
function itemOf(host: RouteHost, choice: ModelChoice | undefined) {
  const provider = choice && host.ctx.providers.list().find((entry) => entry.id === choice.providerId)
  return provider && resolveModelKey(provider.models, choice.modelId)?.model
}

/** 폰에 보이는 대화의 모델 — 목록(models)의 그 항목 키(디폴트 키). 폰은 Thinking 을 모르고 목록에서 키로 이름을 찾으니, 켬·끔 키를 그대로 주면
 *  머리에 내부 키가 보인다 (이슈 #503). 대화에는 키 그대로 남고 폰은 대화 모델을 되돌려 보내지 않는다(고른 것만 보낸다). 못 풀면 그대로 */
function listedModel(host: RouteHost, model: ModelChoice | undefined): ModelChoice | undefined {
  const item = itemOf(host, model)
  return model && item ? { providerId: model.providerId, modelId: engineModelId(item) } : model
}

/** 폰은 Thinking 을 고를 수 없다 — 고른 모델이 대화의 지금 모델과 같은 항목이면 지금 키(켬·끔)를 그대로 둔다 (이슈 #503) */
function keepThinking(host: RouteHost, current: ModelChoice | undefined, picked: ModelChoice): ModelChoice {
  const item = itemOf(host, current)
  return current && item && current.providerId === picked.providerId && itemOf(host, picked)?.id === item.id ? current : picked
}

async function registered(host: RouteHost, project: string): Promise<boolean> {
  return host.ctx.projects.has(project)
}

/** 폰이 닿을 수 있는 대화 — 등록된 프로젝트의 저장된 대화, 또는 폰이 만든 새 대화 */
async function conversationOf(host: RouteHost, cid: string): Promise<Conversation | undefined> {
  const found = (await host.ctx.sessions.list()).find((entry) => entry.id === cid) ?? host.drafts.get(cid)
  return found && (await registered(host, found.project)) ? found : undefined
}
