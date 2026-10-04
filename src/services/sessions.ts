import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { History } from './llm.ts'
import { shellContext } from './shell.ts'
import { isMode } from '../../shared/modes.ts'
import './llm.ts'
import { tr } from '../i18n.ts'
import type { Attachment, Conversation, MessageOrigin, ShellCard } from '../../shared/contract.ts'

// 화면에 실리는 타입의 정의는 shared/contract.ts 에 있다 (모바일 앱과 같이 쓴다 — 이슈 #42). 여기서는 다시 내보내기만 한다
export type { Conversation, ShellCard } from '../../shared/contract.ts'

// 대화 목록 정보 (ctx.sessions) — 재시작해도 대화 목록이 남게 작은 JSON 파일 하나에 둔다 (앱에서는 userData/sessions.json).
// 대화 **내용**의 정본은 opencode DB 다 — 여기는 목록에 보일 것만 쥔다: opencode 는 제목을 안 만들고 time.updated 도 안 바꾼다
// (01c Q1). 그래서 제목·마지막 활동 시각과, 화면이 쌓는 고른 모델·통계 합계를 앱이 들고 있는다. 내용은 ctx.llm.history 로 다시 부른다.
//
// 보관: 프로젝트마다 최근 limit 개(기본 50, 사용자 결정 2026-10-01). 넘치면 마지막 활동이 가장 오래된 것부터 지운다.
// 지우기(제한·수동 모두)는 목록에서 빼고 엔진 세션도 지운다. 엔진 삭제가 실패해도 목록에선 빼고 orphans 에 남겨 다음 시작 때 다시 지워 본다.
// 프로젝트를 최근 목록에서 빼도 여기는 그대로다 — 같은 폴더를 다시 열면 대화가 돌아온다.

declare module 'cordis' {
  interface Context {
    sessions: SessionsService
  }
  interface Events {
    /** 대화가 목록에서 빠졌다 (수동 삭제·보관 개수 초과) — ctx.notifications 가 그 알림을 거둔다 */
    'sessions/removed'(ids: string[]): void
  }
}

interface Stored {
  /** 맨 앞이 가장 최근에 만든 대화 */
  conversations: Conversation[]
  /** 목록에선 뺐지만 엔진에서 아직 못 지운 세션 id */
  orphans: string[]
}

export interface SessionsServiceOptions {
  /** 목록 JSON 파일 경로 */
  file: string
  /** 프로젝트마다 남길 대화 수 (기본 50) */
  limit?: number
}

export const DEFAULT_SESSION_LIMIT = 50

export class SessionsService extends Service {
  static readonly inject = ['llm']

  /** 읽기-고치기-쓰기를 한 줄로 세운다 (projects.ts 와 같은 이유) */
  private queue: Promise<unknown> = Promise.resolve()
  private sweeping: Promise<void> = Promise.resolve()

  constructor(
    ctx: Context,
    private opts: SessionsServiceOptions,
  ) {
    super(ctx, 'sessions')
    void this.sweep() // 지난 실행에서 못 지운 엔진 세션
  }

  /** 모든 프로젝트의 대화 (맨 앞이 가장 최근에 만든 것) */
  async list(): Promise<Conversation[]> {
    return (await this.read()).conversations
  }

  /** 새로 넣거나 그 자리에서 고친다. 그 프로젝트가 제한을 넘으면 마지막 활동이 가장 오래된 것부터 지우고 지운 대화 id 를 준다.
   *  엔진 세션 id 를 안 주면 저장된 것을 둔다 — 보내는 도중 attach 한 id 를, 그것을 아직 모르는 화면이 지우지 않게 */
  async save(input: Conversation): Promise<string[]> {
    const limit = this.opts.limit ?? DEFAULT_SESSION_LIMIT
    let removed: Conversation[] = []
    await this.update((stored) => {
      const existing = stored.conversations.find((entry) => entry.id === input.id)
      const next = pick({
        ...input,
        engineSessionId: input.engineSessionId ?? existing?.engineSessionId,
        labels: input.labels ?? existing?.labels,
        attachments: input.attachments ?? existing?.attachments,
        origins: input.origins ?? existing?.origins,
        shells: existing?.shells, // 카드는 메인만 고친다 — 화면이 보낸 목록 정보로 덮지 않는다
      })
      const conversations = existing
        ? stored.conversations.map((entry) => (entry === existing ? next : entry))
        : [next, ...stored.conversations]
      const same = conversations.filter((entry) => entry.project === next.project)
      removed = [...same].sort((a, b) => a.updatedAt - b.updatedAt).slice(0, Math.max(0, same.length - limit))
      return dropping(conversations, stored.orphans, removed)
    })
    if (removed.length > 0) {
      this.ctx.emit('sessions/removed', removed.map((entry) => entry.id))
      void this.sweep()
    }
    return removed.map((entry) => entry.id)
  }

  /** 저장된 대화의 몇 필드만 고친다 — 고친 대화를 준다 (저장 안 된 대화면 undefined). 읽기-고치기-쓰기가 한 줄 안이라, 통째로 save 할 때처럼
   *  그 사이 다른 쪽이 적은 값을 덮지 않는다: ctx.chat 은 턴 끝에 시각·통계를, 화면은 고른 모델·모드를 적는다 (이슈 #52) */
  async patch(id: string, change: (entry: Conversation) => Partial<Pick<Conversation, 'updatedAt' | 'model' | 'mode' | 'usage' | 'engineSessionId'>>): Promise<Conversation | undefined> {
    const stored = await this.update((stored) => ({
      ...stored,
      conversations: stored.conversations.map((entry) => (entry.id === id ? pick({ ...entry, ...change(entry) }) : entry)),
    }))
    return stored.conversations.find((entry) => entry.id === id)
  }

  /** 엔진 세션이 생기자마자 붙인다 — 답을 기다리는 중에 앱이 꺼져도 다시 열 수 있게 (ctx.llm.chat 의 onSession) */
  async attach(id: string, engineSessionId: string): Promise<void> {
    await this.update((stored) => ({
      ...stored,
      conversations: stored.conversations.map((entry) => (entry.id === id ? { ...entry, engineSessionId } : entry)),
    }))
  }

  /** 엔진 메시지 하나가 말풍선에 보일 글을 적는다 — 다시 열어도 `/hi world` 가 풀어 쓴 본문 대신 보이게 (01d "말풍선 문제") */
  async label(id: string, messageId: string, display: string): Promise<void> {
    await this.update((stored) => ({
      ...stored,
      conversations: stored.conversations.map((entry) => (entry.id === id ? { ...entry, labels: { ...entry.labels, [messageId]: display } } : entry)),
    }))
  }

  /** 엔진 메시지 하나에 붙인 글 파일 칩을 적는다 (이슈 #44) — 글 파일은 본문에 풀려 가서 엔진 기록엔 첨부로 안 남는다. 다시 열 때 그 말풍선에 붙인다 */
  async noteAttachments(id: string, messageId: string, attachments: Attachment[]): Promise<void> {
    await this.update((stored) => ({
      ...stored,
      conversations: stored.conversations.map((entry) => (entry.id === id ? { ...entry, attachments: { ...entry.attachments, [messageId]: attachments } } : entry)),
    }))
  }

  /** 엔진 메시지 하나가 다른 대화가 보낸 지시임을 적는다 (이슈 #55) — 엔진 기록엔 감싼 글만 있다. 다시 열 때 그 말풍선에 딱지를 단다.
   *  보낸 대화가 지워져도 적어 둔 제목으로 보인다 */
  async noteOrigin(id: string, messageId: string, origin: MessageOrigin): Promise<void> {
    await this.update((stored) => ({
      ...stored,
      conversations: stored.conversations.map((entry) => (entry.id === id ? { ...entry, origins: { ...entry.origins, [messageId]: origin } } : entry)),
    }))
  }

  /** 끝난 `!명령` 카드를 그 대화에 붙인다. 아직 저장 안 된(빈 새) 대화면 아무것도 안 한다 */
  async addShell(id: string, card: ShellCard): Promise<void> {
    await this.update((stored) => ({
      ...stored,
      conversations: stored.conversations.map((entry) => (entry.id === id ? { ...entry, shells: [...(entry.shells ?? []), card] } : entry)),
    }))
  }

  /** 카드를 AI 에게 보낸다 — 명령·출력을 그 대화의 엔진 세션 맥락에만 넣는다(LLM 은 안 돈다, ctx.llm.addContext). 세션이 없으면
   *  만든다(모델이 필요하다). 보내기 전에 메시지 id 를 적어 둔다 — 보낸 뒤 앱이 꺼져도 그 본문이 말풍선으로 새지 않게. 실패하면 되돌린다 */
  async shareShell(id: string, cardId: string, providerId: string, modelId: string): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
    const conversation = (await this.read()).conversations.find((entry) => entry.id === id)
    const card = conversation?.shells?.find((entry) => entry.id === cardId)
    if (!conversation || !card) return { ok: false, error: tr('error.noCard') }
    if (card.sharedMessageId) return { ok: true, sessionId: conversation.engineSessionId }
    const messageId = this.ctx.llm.newMessageId()
    const mark = (sharedMessageId: string | undefined) =>
      this.update((stored) => ({
        ...stored,
        conversations: stored.conversations.map((entry) =>
          entry.id === id ? { ...entry, shells: entry.shells?.map((shell) => (shell.id === cardId ? { ...shell, sharedMessageId } : shell)) } : entry,
        ),
      }))
    await mark(messageId)
    const result = await this.ctx.llm.addContext(
      providerId,
      modelId,
      conversation.project,
      shellContext(card, conversation.project),
      messageId,
      conversation.engineSessionId,
      (created) => this.attach(id, created),
    )
    if (!result.ok) await mark(undefined)
    return result
  }

  /** 목록에서 빼고 엔진 세션도 지운다. 되돌리기 없음 */
  async remove(id: string): Promise<void> {
    await this.update((stored) => dropping(stored.conversations, stored.orphans, stored.conversations.filter((entry) => entry.id === id)))
    this.ctx.emit('sessions/removed', [id])
    void this.sweep()
  }

  /** 대화 하나의 말풍선 — 엔진 세션이 아직 없으면(첫 메시지가 세션을 만들기 전에 실패) 빈 목록 */
  async history(id: string): Promise<History> {
    const conversation = (await this.read()).conversations.find((entry) => entry.id === id)
    if (!conversation) return { messages: [], error: tr('error.noConversation') }
    if (!conversation.engineSessionId) return { messages: [] }
    const shared = new Set((conversation.shells ?? []).flatMap((card) => (card.sharedMessageId ? [card.sharedMessageId] : [])))
    const history = await this.ctx.llm.history(conversation.project, conversation.engineSessionId, shared)
    const labels = conversation.labels ?? {}
    const noted = conversation.attachments ?? {}
    const origins = conversation.origins ?? {}
    return {
      ...history,
      messages: history.messages.map((message) => {
        if (!message.id) return message
        const files = noted[message.id]
        return {
          ...message,
          ...(message.id in labels && { text: labels[message.id]! }),
          // 앱이 적어 둔 글 파일 칩 + 엔진 기록의 이미지 칩 (화면의 chipsOf 와 같은 순서)
          ...(files && { attachments: [...files, ...(message.attachments ?? [])] }),
          ...(message.id in origins && { origin: origins[message.id]! }),
        }
      }),
    }
  }

  /** orphans 를 하나씩 지워 보고, 지운 게 있으면 DB 파일 정리를 부탁한다. 실패한 것은 남겨 다음에 다시 — 한 번에 한 줄만 돈다 */
  private sweep(): Promise<void> {
    this.sweeping = this.sweeping.then(async () => {
      let deleted = false
      for (const engineSessionId of (await this.read()).orphans) {
        try {
          await this.ctx.llm.deleteSession(engineSessionId)
        } catch {
          continue
        }
        deleted = true
        await this.update((stored) => ({ ...stored, orphans: stored.orphans.filter((entry) => entry !== engineSessionId) }))
      }
      // 지운 본문은 DB 파일(WAL·빈 페이지)에 남는다 — 걷어낸다 (01_probe)
      if (deleted) this.ctx.llm.purgeDeleted()
    })
    return this.sweeping
  }

  private update(mutate: (stored: Stored) => Stored): Promise<Stored> {
    const next = this.queue.then(async () => {
      const stored = mutate(await this.read())
      await fs.mkdir(path.dirname(this.opts.file), { recursive: true })
      const temp = `${this.opts.file}.${process.pid}.tmp`
      await fs.writeFile(temp, JSON.stringify(stored))
      await fs.rename(temp, this.opts.file) // 쓰다 죽어도 이전 파일이 남게
      return stored
    })
    this.queue = next.catch(() => {}) // 한 번 실패해도 다음 갱신은 돈다
    return next
  }

  /** 파일이 없거나 손상됐으면 빈 목록 — 앱 시작을 막지 않는다 (내용은 opencode DB 에 그대로 있다) */
  private async read(): Promise<Stored> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.opts.file, 'utf8')) as Partial<Record<keyof Stored, unknown>> | null
      const conversations = Array.isArray(parsed?.conversations) ? parsed.conversations.filter(isConversation).map(pick) : []
      const orphans = Array.isArray(parsed?.orphans) ? parsed.orphans.filter((entry): entry is string => typeof entry === 'string') : []
      return { conversations, orphans }
    } catch {
      return { conversations: [], orphans: [] }
    }
  }
}

/** 지울 대화를 목록에서 빼고 그 엔진 세션을 orphans 에 넣는다 */
function dropping(conversations: Conversation[], orphans: string[], removed: Conversation[]): Stored {
  return {
    conversations: conversations.filter((entry) => !removed.includes(entry)),
    orphans: [...orphans, ...removed.flatMap((entry) => (entry.engineSessionId ? [entry.engineSessionId] : []))],
  }
}

/** 아는 필드만 남긴다 — 화면이 말풍선 등을 실어 보내도 파일에는 목록 정보만 */
function pick({ id, project, engineSessionId, title, updatedAt, model, mode, usage, labels, attachments, origins, shells }: Conversation): Conversation {
  return { id, project, engineSessionId, title, updatedAt, model, mode: isMode(mode) ? mode : undefined, usage, labels, attachments, origins, shells }
}

function isConversation(value: unknown): value is Conversation {
  const entry = value as Partial<Conversation> | null
  return (
    typeof entry?.id === 'string' &&
    typeof entry.project === 'string' &&
    typeof entry.title === 'string' &&
    typeof entry.updatedAt === 'number' &&
    (entry.engineSessionId === undefined || typeof entry.engineSessionId === 'string')
  )
}
