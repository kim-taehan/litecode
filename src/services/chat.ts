import { Context, Service } from 'cordis'
import './llm.ts'
import './sessions.ts'
import './providers.ts'
import type { ChatImage, ChatResult } from './llm.ts'
import { outgoing } from './attachments.ts'
import { SendQueues } from './sendQueue.ts'
import { tr } from '../i18n.ts'
import { isMode } from '../../shared/modes.ts'
import { addTurn, type ChatUsage } from '../../shared/usage.ts'
import { upsertItem } from '../../shared/chatReducer.ts'
import { chipsOf, queueLabel, titleFrom, TITLE_MAX, type ChatEventMap, type ChatOrigin, type ChatSnapshot, type QueuedSend, type SendResult } from '../../shared/chat.ts'
import type { Attention, AttentionAnswer, Conversation, HistoryMessage, TurnItem } from '../../shared/contract.ts'

// 대화별 "턴 소유" (ctx.chat, 이슈 #52) — 보내기·대기열·턴 끝 처리(제목·저장·통계 합산·대기열의 다음 것 보내기)·중지를 메인이 쥔다.
// 원래 화면(App.tsx 의 send·useSendQueue)이 하던 일이다. 화면은 손님이다: 보내기를 부탁하고(send) 이벤트를 받아 그린다 —
// 창을 닫았다 열어도(snapshot), 화면이 둘이어도(모바일) 대화마다 엔진에 가는 턴은 하나고 대기열도 하나다.
//
// - 엔진을 모른다: 턴은 ctx.llm.chat 으로만 돌리고, 목록 정보는 ctx.sessions 에 적는다
// - 대화마다 한 턴씩: 도는 중에 온 보내기는 대기열에 쌓이고, 턴이 끝나면(실패·중단이어도) 출처가 같은 것끼리 합쳐 다음 턴으로 간다.
//   사용자가 멈춘 턴(stop)은 대기열을 붙잡는다 — 보내지 않고 화면이 입력창으로 되돌린다(takeQueue)
// - 이벤트는 shared/chat.ts 의 ChatEventMap (shared/remote.ts 와 같은 모양) — Cordis 이름은 `chat/<이름>`
// - 알림(ctx.notifications)은 그대로 ctx.llm 의 'llm/turn-*' 를 듣는다
// - 다른 대화가 보낸 지시 (이슈 #55, 세션 도구 appMcp/tools/sessions.ts 가 send 로 넣는다): origin 이 `session:<보낸 대화>` 이고 from 에 보낸 대화의
//   id·제목이 있다. 사람 글과 합치지 않고(sendQueue), 그 말풍선에 출처를 적어 둔다(ctx.sessions.noteOrigin). 도는 턴은 자기 출처와 그 턴에서
//   보낸 지시 수를 쥔다 — 지시를 받아 도는 턴은 다시 지시하지 못하고(깊이 1), 한 턴에 보낼 수 있는 수에 상한이 있다

declare module 'cordis' {
  interface Context {
    chat: ChatService
  }
  interface Events {
    'chat/turn-started'(data: ChatEventMap['turn.started']): void
    'chat/turn-progress'(data: ChatEventMap['turn.progress']): void
    'chat/turn-attention'(data: ChatEventMap['turn.attention']): void
    'chat/turn-ended'(data: ChatEventMap['turn.ended']): void
    'chat/queue-changed'(data: ChatEventMap['queue.changed']): void
    'chat/conversations-changed'(data: ChatEventMap['conversations.changed']): void
  }
}

/** 도는 턴 하나 — 메인이 진행 줄·승인 카드를 쥔다 (보고 있지 않은 대화도, 화면이 없어도) */
interface LiveTurn {
  stop: AbortController
  startedAt: number
  /** 그 턴의 내 말 — 대화를 저장하고 turn.started 를 낸 뒤부터 있다 */
  message?: HistoryMessage
  progress: TurnItem[]
  attention: Attention[]
  /** 이 턴을 시작한 쪽 — 사람 또는 다른 대화 */
  origin: ChatOrigin
  /** 이 턴에서 다른 대화에 보낸 지시 수 */
  sends: number
}

export class ChatService extends Service {
  static readonly inject = ['llm', 'sessions', 'providers']

  private queues = new SendQueues()
  /** 대화 id → 도는 턴. 보내기를 받은 그 순간(엔진에 닿기 전)부터 있다 — 같은 대화에 둘이 동시에 보내도 한 턴씩 */
  private turns = new Map<string, LiveTurn>()
  /** OS 파일 고르기로 사용자가 고른 첨부 경로 — 보낼 때 이 안의 것만 읽는다 (화면이 오염돼도 아무 파일이나 읽어 보내게 두지 않는다) */
  private picked = new Set<string>()

  constructor(ctx: Context) {
    super(ctx, 'chat')
    ctx.effect(() => this.queues.subscribe((cid) => void ctx.emit('chat/queue-changed', this.queueOf(cid))))
    // 지워진 대화의 대기열은 같이 사라진다 (다른 대화가 보내 둔 지시 포함)
    ctx.on('sessions/removed', (ids) => ids.forEach((id) => this.queues.clear(id)))
  }

  /** 파일 고르기가 준 경로를 적어 둔다 — send 의 첨부는 이 안의 것만 받는다 */
  allowAttachments(paths: readonly string[]): void {
    for (const file of paths) this.picked.add(file)
  }

  /** 보낸다. 그 대화의 턴이 도는 중이면(또는 붙잡힌 대기열이 있으면) 대기열에 쌓는다 — 턴이 끝나면 합쳐 간다.
   *  아니면 대화를 저장하고(새 대화면 첫 메시지로 제목) 'chat/turn-started' 를 낸 뒤 돌아온다 — 답은 이벤트로 온다 ('chat/turn-ended').
   *  저장 안 된 대화인데 project 가 없거나 모델을 모르면 던진다 */
  async send(cid: string, input: QueuedSend): Promise<SendResult> {
    const item = clean(input)
    if (this.queues.submit(cid, item, this.turns.has(cid))) return { state: 'queued' }
    const turn = this.open(cid, item.origin ?? 'user')
    const ready = await this.begin(cid, item, turn, false)
    if (ready) void this.run(cid, item, turn, ready)
    return { state: 'sent' }
  }

  /** 사용자가 대화 이름을 바꾼다 (이슈 #63) — 도는 중이어도 된다. 고친 목록 정보를 주고 목록 바뀜을 알린다 (다른 손님이 목록을 다시 받게).
   *  빈 이름·저장 안 된 대화면 undefined. 그 뒤로 제목은 다시 이름을 바꿀 때만 바뀐다 (ctx.sessions) */
  async rename(cid: string, name: string): Promise<Conversation | undefined> {
    const renamed = await this.ctx.sessions.rename(cid, name)
    if (renamed) this.ctx.emit('chat/conversations-changed', { project: renamed.project, removed: [] })
    return renamed
  }

  /** 대기열 되돌리기 — 그 출처가 쌓은 것을 합쳐 주고 뺀다 (부른 쪽 입력창으로). 붙잡힌 대기열도 풀린다. 없으면 undefined */
  takeQueue(cid: string, origin: ChatOrigin = 'user'): QueuedSend | undefined {
    const taken = this.queues.take(cid, origin)
    this.advance(cid) // 붙잡혀 있던 대기열에 다른 출처의 것(다른 대화의 지시)이 남았으면 이어 간다
    return taken
  }

  /** 대기열에서 다른 대화가 보낸 줄 하나를 뺀다 (index 는 'chat/queue-changed' 의 items 자리). 사람이 친 줄은 못 뺀다 — 뺐으면 true */
  dropQueued(cid: string, index: number): boolean {
    return this.queues.drop(cid, index)
  }

  /** 그 대화의 도는 턴 — 누가 시작했나(origin)·사람의 답을 기다리나(waiting). 안 돌면 undefined */
  turnOf(cid: string): { origin: ChatOrigin; waiting: boolean } | undefined {
    const turn = this.turns.get(cid)
    return turn && { origin: turn.origin, waiting: turn.attention.length > 0 }
  }

  /** 그 대화의 대기열에 쌓인 수 */
  queued(cid: string): number {
    return this.queues.items(cid).length
  }

  /** 그 대화의 도는 턴이 다른 대화에 지시를 하나 보낸다고 센다 — 한 턴의 상한(max)을 넘으면 세지 않고 false */
  countSend(cid: string, max: number): boolean {
    const turn = this.turns.get(cid)
    if (!turn || turn.sends >= max) return false
    turn.sends++
    return true
  }

  /** 그 대화가 쉴 때까지(도는 턴이 없을 때까지) 기다린다 — 기한 안에 쉬면 true. 턴이 끝나며 대기열의 다음 것이 바로 돌면 계속 기다린다 */
  waitIdle(cid: string, ms: number): Promise<boolean> {
    if (!this.turns.has(cid)) return Promise.resolve(true)
    return new Promise((resolve) => {
      const done = (idle: boolean): void => {
        clearTimeout(timer)
        off()
        resolve(idle)
      }
      const timer = setTimeout(() => done(false), ms)
      // 턴 끝 이벤트 바로 뒤에 다음 턴이 열린다(advance) — 그 뒤에 본다
      const off = this.ctx.on('chat/turn-ended', (data) => void (data.cid === cid && queueMicrotask(() => !this.turns.has(cid) && done(true))))
    })
  }

  /** 답변 중지 — 그 대화의 도는 턴을 멈춘다(엔진 턴도). 그 턴은 "중단됨" 으로 끝난다. 쌓인 대기열은 보내지 않고 붙잡는다
   *  ('chat/queue-changed' 의 held — 화면이 takeQueue 로 입력창에 되돌린다). 도는 턴이 없으면 false */
  stop(cid: string): boolean {
    this.queues.hold(cid)
    const turn = this.turns.get(cid)
    turn?.stop.abort()
    return !!turn
  }

  /** 승인·질문 카드의 답을 엔진에 전한다 (ctx.llm.reply 그대로 — 이미 풀린 요청·빈 답이면 던진다) */
  reply(sessionId: string, requestId: string, answer: AttentionAnswer): Promise<void> {
    return this.ctx.llm.reply(sessionId, requestId, answer)
  }

  /** 도는 턴의 하위 작업 하나만 멈춘다 (ctx.llm.stopSubtask 그대로) */
  stopSubtask(subtaskId: string): Promise<boolean> {
    return this.ctx.llm.stopSubtask(subtaskId)
  }

  /** 지금 도는 턴(내 말·진행 줄·승인 카드)과 대기열 — 화면이 다시 뜨면 이것으로 이어 그리고, 그 뒤는 이벤트로 */
  snapshot(): ChatSnapshot {
    const state: ChatSnapshot = {}
    for (const cid of new Set([...this.turns.keys(), ...this.queues.ids()])) {
      const turn = this.turns.get(cid)
      state[cid] = {
        ...(turn?.message && { turn: { message: turn.message, startedAt: turn.startedAt, progress: turn.progress, attention: turn.attention } }),
        queue: this.queueOf(cid),
      }
    }
    return state
  }

  private queueOf(cid: string): ChatEventMap['queue.changed'] {
    const items = this.queues.items(cid)
    return {
      cid,
      items: items.map(queueLabel),
      held: this.queues.held(cid),
      attachments: items.flatMap((item) => chipsOf(item.attachments ?? [])),
      sources: items.map((item) => item.from ?? null),
    }
  }

  private open(cid: string, origin: ChatOrigin): LiveTurn {
    const turn: LiveTurn = { stop: new AbortController(), startedAt: Date.now(), progress: [], attention: [], origin, sends: 0 }
    this.turns.set(cid, turn)
    return turn
  }

  /** 그 대화에 도는 턴이 없다 — 대기열의 다음 것(출처가 같은 것끼리 합친 것)을 보낸다. 붙잡힌 대기열은 남는다 */
  private advance(cid: string): void {
    if (this.turns.has(cid)) return
    const next = this.queues.next(cid)
    if (!next) return
    const following = this.open(cid, next.origin ?? 'user')
    void this.begin(cid, next, following, true)
      .then((ready) => ready && this.run(cid, next, following, ready))
      .catch((error: unknown) => console.error('[chat] 대기열 보내기 실패', (error as Error).message))
  }

  /** 보내기 전 처리 — 목록 정보를 저장하고(새 대화면 제목을 짓고, 그 대화를 이 턴의 모델·모드에 묶는다) 내 말과 함께 턴 시작을 알린다.
   *  flushed: 대기열에서 나온 것 — 그 대화가 그사이 지워졌으면 버린다(undefined), 모델·모드는 대화에 저장된 것(쌓인 뒤 바꾼 것)을 따른다 */
  private async begin(cid: string, item: QueuedSend, turn: LiveTurn, flushed: boolean): Promise<Conversation | undefined> {
    try {
      const existing = (await this.ctx.sessions.list()).find((entry) => entry.id === cid)
      const project = existing?.project ?? item.project
      if (!existing && flushed) return this.abandon(cid, turn)
      if (!project) throw new Error(tr('error.noConversation'))
      const model = flushed ? (existing?.model ?? item.model) : (item.model ?? existing?.model)
      if (!model) throw new Error(tr('shellCard.shareNoModel'))
      const mode = flushed ? (existing?.mode ?? item.mode) : (item.mode ?? existing?.mode)
      const files = item.attachments ?? []
      const shown = item.display ?? item.text
      const conversation: Conversation = {
        id: cid,
        project,
        engineSessionId: existing?.engineSessionId,
        title: existing ? existing.title : item.title || titleFrom(shown || (files[0]?.name ?? '')), // 글 없이 첨부만 보냈으면 첫 파일 이름
        updatedAt: Date.now(),
        model, // 보낸 대화는 그 모델에 묶인다 — 나중에 다른 대화에서 고른 것을 따라가지 않는다
        mode, // 모드도 — 설정의 기본 모드가 나중에 바뀌어도 이 대화는 그대로
        usage: existing?.usage,
      }
      // 보내기 전에 목록에 저장해 둔다 — 엔진 세션이 생기면 여기에 붙는다 (답을 기다리는 중 앱이 꺼져도 다시 열리게)
      const removed = await this.ctx.sessions.save(conversation)
      turn.message = {
        id: this.ctx.llm.newMessageId(),
        role: 'user',
        text: shown,
        at: turn.startedAt,
        ...(mode && { mode }),
        ...(files.length > 0 && { attachments: chipsOf(files) }),
        ...(item.from && { origin: item.from }),
      }
      this.ctx.emit('chat/conversations-changed', { project, removed })
      this.ctx.emit('chat/turn-started', { cid, message: turn.message, origin: item.origin ?? 'user', conversation })
      return conversation
    } catch (error) {
      this.abandon(cid, turn)
      throw error
    }
  }

  /** 시작도 못 한 턴을 거둔다 — 그사이 쌓인 것이 있으면 다음 것으로 간다 */
  private abandon(cid: string, turn: LiveTurn): undefined {
    if (this.turns.get(cid) === turn) this.turns.delete(cid)
    this.advance(cid)
    return undefined
  }

  /** 턴 하나를 엔진에 돌리고 끝을 처리한다 — 시각·엔진 세션·통계 합계를 저장하고 답과 함께 턴 끝을 알린 뒤, 대기열의 다음 것으로 간다 */
  private async run(cid: string, item: QueuedSend, turn: LiveTurn, conversation: Conversation): Promise<void> {
    const result = await this.ask(cid, item, turn, conversation).catch((error: unknown): ChatResult => ({ ok: false, error: (error as Error).message }))
    const stored = await this.ctx.sessions
      .patch(cid, (entry) => ({
        updatedAt: Date.now(),
        engineSessionId: result.sessionId ?? entry.engineSessionId,
        usage: result.usage ? addTurn(entry.usage as ChatUsage | undefined, result.usage) : entry.usage,
      }))
      .catch(() => undefined)
    const message: HistoryMessage = {
      role: 'assistant',
      text: result.ok ? (result.text ?? '') : '',
      ...(!result.ok && { error: String(result.error) }),
      items: turn.progress,
      duration: Date.now() - turn.startedAt,
      ...(result.interrupted && { interrupted: true }),
      ...(result.declined && { declined: true }),
    }
    this.turns.delete(cid)
    this.ctx.emit('chat/turn-ended', {
      cid,
      message,
      ...(result.usage && { usage: result.usage }),
      outcome: result.ok ? 'done' : result.interrupted ? 'interrupted' : 'failed',
      ...(stored && { conversation: stored }),
    })
    this.advance(cid)
  }

  /** 첨부를 읽고(글 파일은 본문에 풀고 이미지는 따로) 보일 글·칩을 적어 둔 뒤 ctx.llm 에 한 턴을 맡긴다 */
  private async ask(cid: string, item: QueuedSend, turn: LiveTurn, conversation: Conversation): Promise<ChatResult> {
    const { project, model, mode } = conversation
    const sessionId = conversation.engineSessionId
    const typed = item.text
    // 첨부 (이슈 #44) — 메인이 읽는다. 글 파일은 본문에 `@경로`·코드 블록으로 풀고, 이미지는 ctx.llm 이 file 파트로 싣는다.
    // 못 붙이는 것이 있으면 보내지 않고 그 사유로 끝낸다 (화면은 실패한 턴으로 보인다)
    const attached = item.attachments ?? []
    let prompt = typed
    let images: ChatImage[] = []
    if (attached.length > 0) {
      try {
        if (attached.some((file) => !this.picked.has(file.path))) throw new Error(tr('attach.notPicked'))
        // 이미지를 안 받는 모델에 보내면 opencode 가 ERROR 글로 바꿔 보내고 이미지는 그래도 DB 에 남는다 (01y) — 화면이 막지만 여기서도 본다
        const imageInput = this.ctx.providers.get(model!.providerId)?.models.find((entry) => entry.id === model!.modelId)?.imageInput
        if (!imageInput && attached.some((file) => file.kind === 'image')) throw new Error(tr('plus.menu.image.blocked'))
        ;({ text: prompt, images } = await outgoing(project, typed, attached))
      } catch (error) {
        return { ok: false, sessionId, error: (error as Error).message }
      }
    }
    const files = attached.filter((file) => file.kind !== 'image').map(({ name, size }) => ({ kind: 'file' as const, name, size }))
    // 보낸 본문과 보일 글이 다르면(`/` 명령·글 파일 첨부) 그 엔진 메시지 id 로 보일 글을 적어 둔다 — 다시 열어도 친 글이 보이게.
    // 글 파일 칩도 그 id 로 적는다 (엔진 기록엔 첨부로 안 남는다 — 이미지 칩은 엔진 기록의 file 파트에서 온다)
    const display = item.display !== undefined && item.display !== typed ? item.display : undefined
    const shown = display || (files.length > 0 ? typed : undefined)
    const messageId = turn.message!.id!
    if (shown !== undefined) await this.ctx.sessions.label(cid, messageId, shown)
    if (files.length > 0) await this.ctx.sessions.noteAttachments(cid, messageId, files)
    if (item.from) await this.ctx.sessions.noteOrigin(cid, messageId, item.from) // 다시 열어도 "다른 대화에서 온 지시" 로 보이게
    return this.ctx.llm.chat(
      model!.providerId,
      model!.modelId,
      project,
      prompt,
      sessionId,
      (created) => this.ctx.sessions.attach(cid, created),
      messageId,
      (progress) => {
        if (this.turns.get(cid) !== turn) return // 끝난 뒤 늦게 온 것은 버린다
        turn.progress = upsertItem(turn.progress, progress)
        this.ctx.emit('chat/turn-progress', { cid, item: progress })
      },
      isMode(mode) ? mode : undefined,
      (requests) => {
        if (this.turns.get(cid) !== turn) return
        turn.attention = requests
        this.ctx.emit('chat/turn-attention', { cid, requests })
      },
      turn.stop.signal, // 답변 중지 — 첫 턴은 아직 엔진 세션이 없어 대화 id 로 쥔다
      images,
    )
  }
}

/** 받은 보내기에서 아는 필드만 — 화면(IPC)이 준 값이라 모양을 믿지 않는다 */
function clean(input: QueuedSend): QueuedSend {
  const attachments = Array.isArray(input.attachments) ? input.attachments : []
  return {
    text: String(input.text ?? ''),
    ...(typeof input.display === 'string' && { display: input.display }),
    ...(attachments.length > 0 && { attachments }),
    ...(isMode(input.mode) && { mode: input.mode }),
    ...(input.model && typeof input.model.providerId === 'string' && typeof input.model.modelId === 'string' && { model: { providerId: input.model.providerId, modelId: input.model.modelId } }),
    ...(typeof input.project === 'string' && input.project && { project: input.project }),
    ...(typeof input.origin === 'string' && { origin: input.origin }),
    // 보낸 대화는 출처가 다른 대화일 때만 — 사람이 보낸 것에 딱지가 붙지 않게
    ...(typeof input.origin === 'string' && input.origin !== 'user' && typeof input.from?.conversationId === 'string' && typeof input.from.title === 'string' && {
      from: { conversationId: input.from.conversationId, title: input.from.title },
    }),
    ...(typeof input.title === 'string' && input.title.trim() && { title: input.title.trim().slice(0, TITLE_MAX) }),
  }
}
