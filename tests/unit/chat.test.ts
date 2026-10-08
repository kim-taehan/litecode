import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatService } from '../../src/services/chat.ts'
import { SessionsService } from '../../src/services/sessions.ts'
import type { ChatImage, ChatOptions, ChatResult } from '../../src/services/llm.ts'
import { setMainLanguage, tr } from '../../src/i18n.ts'
import type { Attention, AttentionAnswer, TurnItem, TurnUsage } from '../../shared/contract.ts'
import type { ChatEventMap, QueuedSend } from '../../shared/chat.ts'

// ctx.chat — 대화별 턴 소유 (이슈 #52). 원래 화면(App.tsx send·useSendQueue)이 하던 규칙을 그대로 지킨다: 턴 중 보내기는 대기열,
// 턴 끝(실패·중단 포함)에 합쳐 한 턴, 멈춘 턴은 대기열을 붙잡음, 첫 메시지로 제목, 보낸 모델·모드에 묶기, 통계 합산, `/` 명령의 보일 글.
// ctx.llm 은 가짜다 — 턴을 받아 쥐고 있다가 시험이 끝낸다(finish)·진행 줄을 흘린다. ctx.sessions 는 진짜(임시 파일)다.

interface Call {
  providerId: string
  modelId: string
  directory: string
  prompt: string
  sessionId?: string
  messageId?: string
  mode?: string
  images: readonly ChatImage[]
  progress(item: TurnItem): void
  attention(requests: Attention[]): void
  finish(result?: Partial<ChatResult>): void
}

/** 도는 턴에 잡은 끼워 넣기 자리 하나 (ctx.llm.reserve, 이슈 #250) */
interface Reserved {
  turn: string
  messageId: string
  sent?: { prompt: string; images?: readonly ChatImage[]; context?: string }
  cancelled?: boolean
}

class FakeLlm extends Service {
  calls: Call[] = []
  replies: unknown[][] = []
  /** 끼워 넣기 자리를 내준다 — 끄면 엔진이 아직 턴을 안 받은 것처럼 늘 없다(대기열로 간다). 대기열 시험들은 그 길을 본다 */
  steerable = false
  reserved: Reserved[] = []
  /** 아직 끝나지 않은 턴의 messageId */
  private live = new Set<string>()
  /** 동시에 돌던 턴의 최대 수 — 대화 하나에 한 턴씩인지 본다 */
  peak = 0
  private open = 0
  private ids = 0
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
  newMessageId(): string {
    return `msg_${++this.ids}`
  }
  async chat({ providerId, modelId, directory, prompt, sessionId, onSession, messageId, onProgress, mode, onAttention, stop, images = [] }: ChatOptions): Promise<ChatResult> {
    const id = sessionId ?? `ses_${this.calls.length + 1}`
    if (!sessionId) await onSession?.(id)
    this.peak = Math.max(this.peak, ++this.open)
    if (messageId) this.live.add(messageId)
    return new Promise<ChatResult>((resolve) => {
      const end = (result: ChatResult) => {
        this.open--
        if (messageId) this.live.delete(messageId)
        // 보내지 않은(cancel) 끼워 넣은 말은 답 없음 — 보낸 말의 답 여부는 시험이 finish 의 unanswered 로 정한다
        const cancelled = this.reserved.filter((entry) => entry.turn === messageId && entry.cancelled).map((entry) => entry.messageId)
        resolve(result.unanswered || cancelled.length === 0 ? result : { ...result, unanswered: cancelled })
      }
      this.calls.push({
        providerId, modelId, directory, prompt, sessionId, messageId, mode, images,
        progress: (item) => onProgress?.(item),
        attention: (requests) => onAttention?.(requests),
        finish: (result = {}) => end({ ok: true, sessionId: id, text: `echo: ${prompt}`, ...result }),
      })
      stop?.addEventListener('abort', () => end({ ok: false, sessionId: id, error: tr('error.stopped'), interrupted: true }))
    })
  }
  reserve(turn: string, messageId: string) {
    if (!this.steerable || !this.live.has(turn)) return undefined
    const entry: Reserved = { turn, messageId }
    this.reserved.push(entry)
    return {
      send: async (input: NonNullable<Reserved['sent']>) => {
        entry.sent = input
        return true
      },
      cancel: () => void (entry.cancelled = true),
    }
  }
  /** 손으로 부른 요약 (/compact, 이슈 #144) — 받아 쥐고 있다가 시험이 끝낸다 */
  compacts: { providerId: string; modelId: string; directory: string; sessionId: string; progress(item: TurnItem): void; finish(result?: Partial<ChatResult> & { messageId?: string }): void }[] = []
  async compact(providerId: string, modelId: string, directory: string, sessionId: string, onProgress?: (item: TurnItem) => void, stop?: AbortSignal): Promise<ChatResult & { messageId?: string }> {
    return new Promise((resolve) => {
      this.compacts.push({ providerId, modelId, directory, sessionId, progress: (item) => onProgress?.(item), finish: (result = {}) => resolve({ ok: true, sessionId, text: '', messageId: 'msg_compact', ...result }) })
      stop?.addEventListener('abort', () => resolve({ ok: false, sessionId, error: tr('error.stopped'), interrupted: true }))
    })
  }
  async reply(...args: unknown[]): Promise<void> {
    this.replies.push(args)
  }
  async stopSubtask(id: string): Promise<boolean> {
    return id === 'sub_1'
  }
  async deleteSession(): Promise<void> {}
  purgeDeleted(): void {}
}

class FakeProviders extends Service {
  constructor(ctx: Context) {
    super(ctx, 'providers')
  }
  get(id: string) {
    return id === 'gw' ? { models: [{ id: 'm1' }, { id: 'm2' }] } : undefined
  }
}

type Recorded = { [K in keyof ChatEventMap]: [K, ChatEventMap[K]] }[keyof ChatEventMap]

let root: string
const MODEL = { providerId: 'gw', modelId: 'm1' }
const usage = (output: number): TurnUsage => ({
  steps: 1,
  tokens: { input: 10, output, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  llmMs: 100,
  toolMs: 0,
  ttftMs: 10,
  ttftSteps: 1,
  lastContextTokens: 10 + output,
})

beforeEach(async () => {
  setMainLanguage('ko')
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-chat-')))
})

afterEach(async () => {
  // 아직 돌던 턴이 목록 파일을 쓰는 중일 수 있다 (엔진 세션 붙이기) — 다시 해 본다
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

async function start(limit?: number) {
  const ctx = new Context()
  ctx.plugin(FakeLlm)
  ctx.plugin(FakeProviders)
  ctx.plugin(SessionsService, { file: path.join(root, 'sessions.json'), limit })
  ctx.plugin(ChatService)
  const ready = await new Promise<Context>((resolve) => ctx.inject(['chat', 'sessions', 'llm'], resolve))
  const events: Recorded[] = []
  ctx.on('chat/turn-started', (data) => void events.push(['turn.started', data]))
  ctx.on('chat/turn-progress', (data) => void events.push(['turn.progress', data]))
  ctx.on('chat/turn-attention', (data) => void events.push(['turn.attention', data]))
  ctx.on('chat/turn-ended', (data) => void events.push(['turn.ended', data]))
  ctx.on('chat/turn-interjected', (data) => void events.push(['turn.interjected', data]))
  ctx.on('chat/queue-changed', (data) => void events.push(['queue.changed', data]))
  ctx.on('chat/conversations-changed', (data) => void events.push(['conversations.changed', data]))
  const llm = ready.llm as unknown as FakeLlm
  const names = () => events.map(([name]) => name)
  const of = <K extends keyof ChatEventMap>(name: K) => events.filter((event): event is Extract<Recorded, [K, unknown]> => event[0] === name).map((event) => event[1] as ChatEventMap[K])
  /** 엔진에 n 번째 턴이 닿을 때까지 */
  const turn = async (n: number): Promise<Call> => {
    await until(() => llm.calls.length >= n)
    return llm.calls[n - 1]!
  }
  /** 턴 끝 이벤트가 n 개 나올 때까지 */
  const ended = async (n: number) => {
    await until(() => of('turn.ended').length >= n)
    return of('turn.ended')[n - 1]!
  }
  const stored = async (id: string) => (await ready.sessions.list()).find((entry) => entry.id === id)
  return { ctx: ready, chat: ready.chat, sessions: ready.sessions, llm, events, names, of, turn, ended, stored }
}

async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; tries < 400 && !done(); tries++) await new Promise((resolve) => setTimeout(resolve, 5))
  if (!done()) throw new Error('기다리던 일이 일어나지 않았다')
}

const input = (text: string, patch: Partial<QueuedSend> = {}): QueuedSend => ({ project: '/work/a', text, model: MODEL, mode: 'build', ...patch })

describe('ChatService — 보내기와 턴 끝 처리', () => {
  it('첫 메시지: 대화를 저장하고(제목 = 첫 줄, 모델·모드에 묶음) 내 말과 함께 턴 시작을 알린 뒤 바로 돌아온다 — 답은 턴 끝 이벤트로', async () => {
    const { chat, turn, ended, stored, names, of } = await start()
    expect(await chat.send('c1', input('\n  첫 줄 제목  \n둘째 줄'))).toEqual({ state: 'sent' })
    expect(names()).toEqual(['conversations.changed', 'turn.started'])
    const started = of('turn.started')[0]!
    expect(started).toMatchObject({ cid: 'c1', origin: 'user', message: { role: 'user', text: '\n  첫 줄 제목  \n둘째 줄', mode: 'build' } })
    expect(started.message.id).toBeTruthy()
    expect(started.conversation).toMatchObject({ id: 'c1', project: '/work/a', title: '첫 줄 제목', model: MODEL, mode: 'build' })
    expect(await stored('c1')).toMatchObject({ title: '첫 줄 제목', model: MODEL, mode: 'build' })

    const call = await turn(1)
    expect(call).toMatchObject({ providerId: 'gw', modelId: 'm1', directory: '/work/a', prompt: '\n  첫 줄 제목  \n둘째 줄', sessionId: undefined, mode: 'build', messageId: started.message.id })
    expect((await stored('c1'))?.engineSessionId).toBe('ses_1') // 답을 기다리는 중에 이미 붙어 있다 (앱이 꺼져도 다시 열리게)

    call.finish({ usage: usage(5) })
    const end = await ended(1)
    expect(end).toMatchObject({ cid: 'c1', outcome: 'done', message: { role: 'assistant', text: `echo: ${call.prompt}`, items: [] }, usage: usage(5) })
    expect(end.message.error).toBeUndefined()
    expect(end.message.duration).toBeGreaterThanOrEqual(0)
    expect(end.conversation).toMatchObject({ engineSessionId: 'ses_1', usage: { turns: 1, steps: 1, tokens: { output: 5 } } })
    expect(await stored('c1')).toMatchObject({ title: '첫 줄 제목', usage: { turns: 1 } })
  })

  it('이어지는 턴: 제목은 그대로, 엔진 세션을 이어 쓰고, 통계는 저장된 합계에 더한다. 시각이 오른다', async () => {
    const { chat, turn, ended, stored } = await start()
    await chat.send('c1', input('처음'))
    ;(await turn(1)).finish({ usage: usage(5) })
    const before = (await ended(1)).conversation!.updatedAt
    await chat.send('c1', input('둘째 질문'))
    const second = await turn(2)
    expect(second.sessionId).toBe('ses_1')
    second.finish({ usage: usage(7) })
    const end = await ended(2)
    expect(end.conversation).toMatchObject({ title: '처음', usage: { turns: 2, steps: 2, tokens: { output: 12 }, lastContextTokens: 17 } })
    expect(end.conversation!.updatedAt).toBeGreaterThanOrEqual(before)
    expect((await stored('c1'))?.usage).toMatchObject({ turns: 2 })
  })

  it('진행 줄·승인 카드를 이벤트로 흘리고 쥐고 있다가, 턴이 끝나면 답에 진행 줄을 싣는다. 끝난 뒤 늦게 온 것은 버린다', async () => {
    const { chat, turn, ended, of, names } = await start()
    await chat.send('c1', input('hi'))
    const call = await turn(1)
    const think: TurnItem = { kind: 'think', id: 't1', text: '생', done: false }
    const thought: TurnItem = { kind: 'think', id: 't1', text: '생각', done: true }
    const tool: TurnItem = { kind: 'tool', id: 'x1', name: 'bash', status: 'running' }
    const ask: Attention = { kind: 'permission', id: 'per_1', sessionId: 'ses_1', action: 'bash', resources: ['ls'] }
    call.progress(think)
    call.progress(tool)
    call.progress(thought)
    call.attention([ask])
    expect(chat.snapshot().c1!.turn).toMatchObject({ progress: [thought, tool], attention: [ask] })
    call.attention([])
    call.finish()
    const end = await ended(1)
    expect(end.message.items).toEqual([thought, tool]) // 같은 id 는 그 자리에서 교체
    expect(of('turn.progress').map((event) => event.item)).toEqual([think, tool, thought])
    expect(of('turn.attention').map((event) => event.requests)).toEqual([[ask], []])
    call.progress({ kind: 'text', id: 'late', text: '늦음', done: true })
    call.attention([ask])
    expect(names().at(-1)).toBe('turn.ended')
  })

  it('실패한 턴: outcome failed, 답 말풍선에 사유. 통계가 없으면 합계는 그대로', async () => {
    const { chat, turn, ended } = await start()
    await chat.send('c1', input('hi'))
    ;(await turn(1)).finish({ ok: false, text: undefined, error: 'HTTP 500' })
    const end = await ended(1)
    expect(end).toMatchObject({ outcome: 'failed', message: { role: 'assistant', text: '', error: 'HTTP 500' } })
    expect(end.message.interrupted).toBeUndefined()
    expect(end.usage).toBeUndefined()
    expect(end.conversation!.usage).toBeUndefined()
  })

  it('승인·질문을 거절해 끝난 턴은 실패가 아니다 (declined)', async () => {
    const { chat, turn, ended } = await start()
    await chat.send('c1', input('hi'))
    ;(await turn(1)).finish({ declined: true })
    expect(await ended(1)).toMatchObject({ outcome: 'done', message: { declined: true } })
  })

  it('`/` 명령: 엔진엔 풀어 쓴 본문, 말풍선·제목엔 친 글 — 그 엔진 메시지 id 로 보일 글을 적어 둔다 (다시 열어도 친 글)', async () => {
    const { chat, turn, of, stored } = await start()
    await chat.send('c1', input('Say world (풀어 쓴 template)', { display: '/hi world' }))
    const started = of('turn.started')[0]!
    expect(started.message.text).toBe('/hi world')
    expect(started.conversation.title).toBe('/hi world')
    const call = await turn(1)
    expect(call.prompt).toBe('Say world (풀어 쓴 template)')
    expect((await stored('c1'))?.labels).toEqual({ [started.message.id!]: '/hi world' })
  })

  it('보일 글이 본문과 같으면 따로 적지 않는다 ("이 계획대로 실행")', async () => {
    const { chat, turn, stored } = await start()
    await chat.send('c1', input('계획대로 실행해', { display: '계획대로 실행해', mode: 'build' }))
    await turn(1)
    expect((await stored('c1'))?.labels).toBeUndefined()
  })

  it('모드·모델을 바꿔 보내면 그 턴부터 그 대화의 것이 된다 — 내 말에 모드가 실린다 (전환 구분선)', async () => {
    const { chat, turn, ended, of, stored } = await start()
    await chat.send('c1', input('계획 세워', { mode: 'plan' }))
    ;(await turn(1)).finish()
    await ended(1)
    await chat.send('c1', input('실행', { mode: 'build', model: { providerId: 'gw', modelId: 'm2' } }))
    const second = await turn(2)
    expect(second).toMatchObject({ mode: 'build', modelId: 'm2' })
    expect(of('turn.started').map((event) => event.message.mode)).toEqual(['plan', 'build'])
    expect(await stored('c1')).toMatchObject({ mode: 'build', model: { providerId: 'gw', modelId: 'm2' } })
  })

  it('저장 안 된 대화인데 프로젝트를 모르면 던진다 — 턴이 남지 않아 다음 보내기는 된다', async () => {
    const { chat, names } = await start()
    await expect(chat.send('c1', { text: 'hi', model: MODEL })).rejects.toThrow(tr('error.noConversation'))
    expect(names()).toEqual([])
    expect(await chat.send('c1', input('hi'))).toEqual({ state: 'sent' })
  })

  it('보관 개수를 넘어 지워진 대화를 목록 바뀜 이벤트로 알린다', async () => {
    const { chat, of } = await start(1)
    await chat.send('c1', input('하나'))
    await new Promise((resolve) => setTimeout(resolve, 5)) // 보관은 마지막 활동 시각 순 — 같은 ms 면 순서를 못 가린다
    await chat.send('c2', input('둘'))
    expect(of('conversations.changed')).toEqual([{ project: '/work/a', removed: [] }, { project: '/work/a', removed: ['c1'] }])
  })
})

describe('ChatService — 대기열', () => {
  it('턴 중 보내기는 대기열에 쌓이고(엔진엔 안 간다), 턴이 끝나면 한 메시지로 합쳐 한 턴으로 간다', async () => {
    const { chat, llm, turn, ended, of, names } = await start()
    await chat.send('c1', input('처음'))
    const first = await turn(1)
    expect(await chat.send('c1', input('둘째'))).toEqual({ state: 'queued' })
    expect(await chat.send('c1', input('풀어 쓴 셋째', { display: '/셋째' }))).toEqual({ state: 'queued' })
    expect(of('queue.changed').at(-1)).toEqual({ cid: 'c1', items: ['둘째', '/셋째'], held: false, attachments: [], sources: [null, null] })
    expect(llm.calls).toHaveLength(1)

    first.finish()
    const second = await turn(2)
    expect(second.prompt).toBe('둘째\n풀어 쓴 셋째')
    expect(of('turn.started')[1]!.message.text).toBe('둘째\n/셋째')
    // 순서: 앞 턴 끝 → 대기열 비움 → 다음 턴 시작
    expect(names().slice(-4)).toEqual(['turn.ended', 'queue.changed', 'conversations.changed', 'turn.started'])
    expect(of('queue.changed').at(-1)).toMatchObject({ items: [], held: false })
    second.finish()
    await ended(2)
    expect(llm.calls).toHaveLength(2)
    expect(llm.peak).toBe(1)
  })

  it('실패한 턴 뒤에도 대기열은 나간다 ("턴이 더는 안 돈다" 가 기준)', async () => {
    const { chat, turn } = await start()
    await chat.send('c1', input('처음'))
    const first = await turn(1)
    await chat.send('c1', input('다음'))
    first.finish({ ok: false, error: 'boom' })
    expect((await turn(2)).prompt).toBe('다음')
  })

  it('음성 대화 (#240): 답이 오는 동안 여러 번 말해도 순서대로 — 한 답 중에 한 말은 합쳐 다음 턴, 그다음 답 중에 한 말은 그다음 턴', async () => {
    const { chat, llm, turn, ended } = await start()
    expect(await chat.send('c1', input('하나'))).toEqual({ state: 'sent' })
    const first = await turn(1)
    // 첫 답이 오는 동안 두 번 말했다 (화면은 매번 같은 보내기를 부른다 — 대기열은 메인의 것)
    expect(await chat.send('c1', input('둘'))).toEqual({ state: 'queued' })
    expect(await chat.send('c1', input('셋'))).toEqual({ state: 'queued' })
    first.finish()
    const second = await turn(2)
    expect(second.prompt).toBe('둘\n셋')
    // 둘째 답이 오는 동안 또 말했다 — 앞 것을 앞지르지 않고 그 뒤 턴으로
    expect(await chat.send('c1', input('넷'))).toEqual({ state: 'queued' })
    expect(chat.queued('c1')).toBe(1)
    second.finish()
    const third = await turn(3)
    third.finish()
    await ended(3)
    expect(llm.calls.map((call) => call.prompt)).toEqual(['하나', '둘\n셋', '넷'])
    expect(llm.peak).toBe(1)
    // 답이 다 끝난 뒤에 한 말은 바로 간다
    expect(await chat.send('c1', input('다섯'))).toEqual({ state: 'sent' })
    ;(await turn(4)).finish()
    await ended(4)
  })

  it('두 손님이 같은 대화에 동시에 보내도 한 턴씩 — 하나는 바로, 하나는 대기열', async () => {
    const { chat, llm, turn, ended } = await start()
    const results = await Promise.all([chat.send('c1', input('A')), chat.send('c1', input('B'))])
    expect(results.map((result) => result.state)).toEqual(['sent', 'queued'])
    ;(await turn(1)).finish()
    ;(await turn(2)).finish()
    await ended(2)
    expect(llm.calls.map((call) => call.prompt)).toEqual(['A', 'B'])
    expect(llm.peak).toBe(1)
  })

  it('다른 대화는 따로 돈다 — 한 대화의 턴이 다른 대화(다른 프로젝트)의 보내기를 막지 않는다', async () => {
    const { chat, llm, turn, ended } = await start()
    expect(await chat.send('c1', input('A'))).toEqual({ state: 'sent' })
    expect(await chat.send('c2', input('B', { project: '/work/b' }))).toEqual({ state: 'sent' })
    await turn(2)
    expect(llm.peak).toBe(2)
    llm.calls.find((call) => call.prompt === 'B')!.finish()
    expect((await ended(1)).cid).toBe('c2')
    expect(chat.snapshot().c1?.turn).toBeDefined()
  })

  it('되돌리기(takeQueue) — 합친 것을 주고 비운다. 그 뒤 턴이 끝나도 보내지 않는다', async () => {
    const { chat, llm, turn, ended, of } = await start()
    await chat.send('c1', input('처음'))
    const first = await turn(1)
    await chat.send('c1', input('a'))
    await chat.send('c1', input('b'))
    expect(chat.takeQueue('c1')).toMatchObject({ text: 'a\nb' })
    expect(of('queue.changed').at(-1)).toMatchObject({ items: [] })
    expect(chat.takeQueue('c1')).toBeUndefined()
    first.finish()
    await ended(1)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(llm.calls).toHaveLength(1)
  })

  it('출처가 다른 것끼리는 합치지 않고 쌓인 순서대로 한 턴씩 — 턴 시작에 출처가 실린다', async () => {
    const { chat, turn, of } = await start()
    await chat.send('c1', input('처음'))
    const first = await turn(1)
    await chat.send('c1', input('사람 1'))
    await chat.send('c1', input('사람 2'))
    await chat.send('c1', input('다른 대화의 지시', { origin: 'session:c9' }))
    first.finish()
    const second = await turn(2)
    expect(second.prompt).toBe('사람 1\n사람 2')
    second.finish()
    const third = await turn(3)
    expect(third.prompt).toBe('다른 대화의 지시')
    expect(of('turn.started').map((event) => event.origin)).toEqual(['user', 'user', 'session:c9'])
  })

  // 이슈 #55 — 다른 대화가 보낸 지시 (세션 도구가 send 로 넣는다)
  it('다른 대화의 지시: LLM 엔 본문(감싼 글), 말풍선엔 보일 글과 출처 — 적어 둔 출처는 다시 열 때 쓴다. 도는 턴은 자기 출처를 안다', async () => {
    const { chat, turn, of, stored } = await start()
    const from = { conversationId: 'c9', title: '릴리스 준비' }
    await chat.send('c1', input('<wrapped>지시</wrapped>', { display: '지시', origin: 'session:c9', from }))
    await turn(1)
    expect(of('turn.started')[0]).toMatchObject({ origin: 'session:c9', message: { text: '지시', origin: from } })
    expect(chat.turnOf('c1')).toEqual({ origin: 'session:c9', waiting: false })
    expect(chat.snapshot()['c1']!.turn!.message.origin).toEqual(from)
    const saved = (await stored('c1'))!
    const messageId = of('turn.started')[0]!.message.id!
    expect(saved.labels).toEqual({ [messageId]: '지시' })
    expect(saved.origins).toEqual({ [messageId]: from })
    expect(chat.turnOf('nope')).toBeUndefined()
  })

  it('화면(IPC)이 보낸 것에 출처 정보(from)가 실려 와도 사람이 보낸 것에는 딱지가 붙지 않는다', async () => {
    const { chat, turn, of, stored } = await start()
    await chat.send('c1', input('사람 글', { origin: 'user', from: { conversationId: 'c9', title: '속임' } }))
    await turn(1)
    expect(of('turn.started')[0]!.message.origin).toBeUndefined()
    expect((await stored('c1'))!.origins).toBeUndefined()
  })

  it('한 턴에 보낸 지시 수를 센다 — 상한을 넘으면 세지 않는다. 도는 턴이 없으면 못 센다', async () => {
    const { chat, turn } = await start()
    expect(chat.countSend('c1', 2)).toBe(false)
    await chat.send('c1', input('처음'))
    const first = await turn(1)
    expect([chat.countSend('c1', 2), chat.countSend('c1', 2), chat.countSend('c1', 2)]).toEqual([true, true, false])
    first.finish()
    await chat.send('c1', input('다음 턴'))
    await turn(2)
    expect(chat.countSend('c1', 2)).toBe(true) // 턴마다 새로 센다
  })

  it('대기열의 다음 턴은 그 대화에 저장된 모델로 간다 — 쌓은 뒤 턴 중에 바꾼 모델을 따른다', async () => {
    const { chat, sessions, turn } = await start()
    await chat.send('c1', input('처음'))
    const first = await turn(1)
    await chat.send('c1', input('다음'))
    await sessions.patch('c1', () => ({ model: { providerId: 'gw', modelId: 'm2' } }))
    first.finish()
    expect((await turn(2)).modelId).toBe('m2')
  })

  it('대기열에 쌓인 채 그 대화가 지워졌으면 버린다 (다시 만들지 않는다)', async () => {
    const { chat, sessions, llm, turn, ended, stored } = await start()
    await chat.send('c1', input('처음'))
    const first = await turn(1)
    await chat.send('c1', input('다음'))
    await sessions.remove('c1')
    first.finish()
    await ended(1)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(llm.calls).toHaveLength(1)
    expect(await stored('c1')).toBeUndefined()
    expect(chat.snapshot().c1).toBeUndefined()
  })
})

describe('ChatService — 지워진 대화의 도는 턴 (전수 검사 #126)', () => {
  it('도는 턴의 대화가 지워지면 그 턴을 멈춘다 — "중단됨" 으로 끝나고 다시 저장되지 않는다', async () => {
    const { chat, sessions, turn, ended, stored } = await start()
    await chat.send('c1', input('처음'))
    await turn(1)
    await sessions.remove('c1')
    expect((await ended(1)).outcome).toBe('interrupted')
    expect(chat.running()).toBe(0)
    expect(await stored('c1')).toBeUndefined()
  })

  it('다른 대화의 턴은 그대로 돈다', async () => {
    const { chat, sessions, turn, of } = await start()
    await chat.send('c1', input('하나'))
    await chat.send('c2', input('둘'))
    await turn(2)
    await sessions.remove('c1')
    await until(() => of('turn.ended').length >= 1)
    expect(of('turn.ended').map((event) => event.cid)).toEqual(['c1'])
    expect(chat.turnOf('c2')).toBeDefined()
  })
})

describe('ChatService — 답변 중지 (이슈 #3)', () => {
  it('멈추면 그 턴은 "중단됨" 으로 끝나고, 대기열은 보내지 않고 붙잡는다 — 되돌리면(takeQueue) 풀리고 다음 보내기는 바로 간다', async () => {
    const { chat, llm, turn, ended, of } = await start()
    await chat.send('c1', input('처음'))
    await turn(1)
    await chat.send('c1', input('a'))
    await chat.send('c1', input('b'))
    expect(chat.stop('c1')).toBe(true)
    expect(of('queue.changed').at(-1)).toEqual({ cid: 'c1', items: ['a', 'b'], held: true, attachments: [], sources: [null, null] })
    const end = await ended(1)
    expect(end).toMatchObject({ outcome: 'interrupted', message: { error: tr('error.stopped'), interrupted: true } })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(llm.calls).toHaveLength(1)
    expect(chat.snapshot().c1).toMatchObject({ queue: { items: ['a', 'b'], held: true } })
    expect(chat.snapshot().c1!.turn).toBeUndefined()

    expect(chat.takeQueue('c1')).toMatchObject({ text: 'a\nb' })
    expect(of('queue.changed').at(-1)).toMatchObject({ items: [], held: false })
    expect(await chat.send('c1', input('다시'))).toEqual({ state: 'sent' })
  })

  it('붙잡힌 대기열이 남아 있으면 턴이 안 돌아도 뒤에 쌓는다 — 순서가 뒤바뀌지 않게', async () => {
    const { chat, turn, ended, of } = await start()
    await chat.send('c1', input('처음'))
    await turn(1)
    await chat.send('c1', input('a'))
    chat.stop('c1')
    await ended(1)
    expect(await chat.send('c1', input('b'))).toEqual({ state: 'queued' })
    expect(of('queue.changed').at(-1)).toMatchObject({ items: ['a', 'b'], held: true })
  })

  it('쌓인 것 없이 멈추면 붙잡지 않는다. 도는 턴이 없으면 false', async () => {
    const { chat, turn, ended, of } = await start()
    expect(chat.stop('c1')).toBe(false)
    await chat.send('c1', input('처음'))
    await turn(1)
    expect(chat.stop('c1')).toBe(true)
    expect((await ended(1)).outcome).toBe('interrupted')
    expect(of('queue.changed')).toEqual([])
    expect(await chat.send('c1', input('다음'))).toEqual({ state: 'sent' })
  })
})

describe('ChatService — 첨부 (이슈 #44)', () => {
  it('파일 고르기로 고르지 않은 경로는 읽지 않는다 — 엔진에 안 가고 실패한 턴으로 끝난다', async () => {
    const { chat, llm, ended } = await start()
    const file = path.join(root, 'notes.md')
    await fs.writeFile(file, '# 메모')
    await chat.send('c1', input('봐 줘', { project: root, attachments: [{ kind: 'file', path: file, name: 'notes.md', size: 6 }] }))
    expect(await ended(1)).toMatchObject({ outcome: 'failed', message: { error: tr('attach.notPicked') } })
    expect(llm.calls).toHaveLength(0)
  })

  it('고른 글 파일은 본문에 풀려 가고, 말풍선엔 친 글과 칩 — 그 엔진 메시지 id 로 적어 둔다. 글 없이 첨부만 보내면 제목은 파일 이름', async () => {
    const { chat, turn, of, stored } = await start()
    const file = path.join(root, 'notes.md')
    await fs.writeFile(file, '# 메모')
    const attachments = [{ kind: 'file' as const, path: file, name: 'notes.md', size: 6 }]
    chat.allowAttachments([file])
    await chat.send('c1', input('', { project: root, attachments }))
    const started = of('turn.started')[0]!
    expect(started.conversation.title).toBe('notes.md')
    expect(started.message).toMatchObject({ text: '', attachments: [{ kind: 'file', name: 'notes.md', size: 6 }] })
    const call = await turn(1)
    expect(call.prompt).toContain('notes.md')
    const saved = await stored('c1')
    expect(saved?.labels).toEqual({ [started.message.id!]: '' })
    expect(saved?.attachments).toEqual({ [started.message.id!]: [{ kind: 'file', name: 'notes.md', size: 6 }] })
  })

  it('첨부를 읽은 뒤(못 읽어 실패한 턴도) 그 경로들을 알린다 — 붙여넣은 이미지의 임시 파일을 지울 때 (이슈 #80)', async () => {
    const { ctx, chat, turn, ended } = await start()
    const read: string[][] = []
    ctx.on('chat/attachments-read', (paths) => void read.push(paths))
    const file = path.join(root, 'read.md')
    await fs.writeFile(file, '# 메모')
    chat.allowAttachments([file])
    await chat.send('c1', input('봐 줘', { project: root, attachments: [{ kind: 'file', path: file, name: 'read.md', size: 6 }] }))
    const first = await turn(1)
    expect(read).toEqual([[file]])
    first.finish()
    await ended(1)
    const gone = path.join(root, 'gone.md')
    chat.allowAttachments([gone])
    await chat.send('c1', input('이것도', { project: root, attachments: [{ kind: 'file', path: gone, name: 'gone.md', size: 1 }] }))
    expect((await ended(2)).outcome).toBe('failed')
    expect(read).toEqual([[file], [gone]])
    await chat.send('c1', input('첨부 없이', { project: root }))
    ;(await turn(2)).finish()
    await ended(3)
    expect(read).toHaveLength(2)
  })

  it('대기열에 쌓인 첨부는 순서대로 합쳐 나가고, 대기열 이벤트에 칩으로 실린다 (상한 세기)', async () => {
    const { chat, turn, of } = await start()
    const a = path.join(root, 'a.md')
    const b = path.join(root, 'b.md')
    await fs.writeFile(a, 'A')
    await fs.writeFile(b, 'B')
    chat.allowAttachments([a, b])
    await chat.send('c1', input('처음', { project: root }))
    const first = await turn(1)
    await chat.send('c1', input('', { project: root, attachments: [{ kind: 'file', path: a, name: 'a.md', size: 1 }] }))
    await chat.send('c1', input('둘 다 봐', { project: root, attachments: [{ kind: 'file', path: b, name: 'b.md', size: 1 }] }))
    expect(of('queue.changed').at(-1)).toMatchObject({ items: ['a.md', '둘 다 봐 · b.md'], attachments: [{ kind: 'file', name: 'a.md', size: 1 }, { kind: 'file', name: 'b.md', size: 1 }] })
    first.finish()
    const second = await turn(2)
    expect(second.prompt.indexOf('a.md')).toBeGreaterThan(-1)
    expect(second.prompt.indexOf('a.md')).toBeLessThan(second.prompt.indexOf('b.md'))
    expect(of('turn.started')[1]!.message).toMatchObject({ text: '둘 다 봐', attachments: [{ name: 'a.md' }, { name: 'b.md' }] })
  })
})

describe('ChatService — 첨부 허용 목록에서 빼기 (전수 검사 #126)', () => {
  const chip = (file: string) => ({ kind: 'file' as const, path: file, name: path.basename(file), size: 1 })

  it('보낸 첨부는 허용 목록에서 빠진다 — 다시 고르지 않고 같은 경로를 실어 보내면 읽지 않는다', async () => {
    const { chat, llm, turn, ended } = await start()
    const file = path.join(root, 'once.md')
    await fs.writeFile(file, 'A')
    chat.allowAttachments([file])
    await chat.send('c1', input('봐 줘', { project: root, attachments: [chip(file)] }))
    ;(await turn(1)).finish()
    await ended(1)
    await chat.send('c1', input('또', { project: root, attachments: [chip(file)] }))
    expect(await ended(2)).toMatchObject({ outcome: 'failed', message: { error: tr('attach.notPicked') } })
    expect(llm.calls).toHaveLength(1)
  })

  it('칩을 뺀 경로(revokeAttachments)는 읽지 않는다', async () => {
    const { chat, llm, ended } = await start()
    const file = path.join(root, 'dropped.md')
    await fs.writeFile(file, 'A')
    chat.allowAttachments([file])
    chat.revokeAttachments([file, path.join(root, 'never-picked.md')])
    await chat.send('c1', input('봐 줘', { project: root, attachments: [chip(file)] }))
    expect(await ended(1)).toMatchObject({ outcome: 'failed', message: { error: tr('attach.notPicked') } })
    expect(llm.calls).toHaveLength(0)
  })

  it('같은 파일을 두 번 골랐으면(두 대화의 입력창) 한 번 보내도 다른 쪽은 그대로 보낼 수 있다', async () => {
    const { chat, llm, turn } = await start()
    const file = path.join(root, 'twice.md')
    await fs.writeFile(file, 'A')
    chat.allowAttachments([file])
    chat.allowAttachments([file])
    await chat.send('c1', input('하나', { project: root, attachments: [chip(file)] }))
    await turn(1)
    await chat.send('c2', input('둘', { project: root, attachments: [chip(file)] }))
    await turn(2)
    expect(llm.calls.map((call) => call.prompt.includes('twice.md'))).toEqual([true, true])
  })
})

describe('ChatService — 스냅샷과 전달', () => {
  it('스냅샷: 도는 턴의 내 말·시작 시각·진행 줄과 대기열. 아무것도 없는 대화는 빠진다', async () => {
    const { chat, turn, ended, of } = await start()
    expect(chat.snapshot()).toEqual({})
    await chat.send('c1', input('처음'))
    const call = await turn(1)
    await chat.send('c1', input('다음'))
    const item: TurnItem = { kind: 'text', id: 'a', text: '답', done: false }
    call.progress(item)
    const { message } = of('turn.started')[0]!
    expect(chat.snapshot()).toEqual({
      c1: { turn: { message, startedAt: message.at, progress: [item], attention: [] }, queue: { cid: 'c1', items: ['다음'], held: false, attachments: [], sources: [null] } },
    })
    chat.takeQueue('c1')
    call.finish()
    await ended(1)
    expect(chat.snapshot()).toEqual({})
  })

  it('승인·질문의 답과 하위 작업 중지는 엔진 경계(ctx.llm)로 그대로 전한다', async () => {
    const { chat, llm } = await start()
    const answer: AttentionAnswer = 'once'
    await chat.reply('ses_1', 'per_1', answer)
    expect(llm.replies).toEqual([['ses_1', 'per_1', 'once']])
    // 지시 보내기를 허용하며 고른 받을 대화 (이슈 #67) 도 그대로 전한다
    await chat.reply('ses_1', 'per_2', answer, { kind: 'conversation', conversationId: 'c9' })
    expect(llm.replies.slice(1)).toEqual([
      ['ses_1', 'per_2', 'once', { kind: 'conversation', conversationId: 'c9' }],
    ])
    expect(await chat.stopSubtask('sub_1')).toBe(true)
    expect(await chat.stopSubtask('nope')).toBe(false)
  })
})

describe('ChatService — 대화 고정 (이슈 #79)', () => {
  it('고정·해제를 저장하고 목록 바뀜을 알린다 — 그 뒤 턴이 돌아도 고정은 그대로다', async () => {
    const { chat, turn, ended, stored, of } = await start()
    await chat.send('c1', input('처음 보낸 글'))
    ;(await turn(1)).finish()
    await ended(1)
    const before = of('conversations.changed').length

    expect(await chat.pin('c1', true)).toMatchObject({ id: 'c1', pinned: true })
    expect(of('conversations.changed').slice(before)).toEqual([{ project: '/work/a', removed: [] }])

    await chat.send('c1', input('둘째 질문'))
    ;(await turn(2)).finish()
    await ended(2)
    expect((await stored('c1'))!.pinned).toBe(true)

    const beforeUnpin = of('conversations.changed').length
    expect((await chat.pin('c1', false))!.pinned).toBeUndefined()
    expect(of('conversations.changed').slice(beforeUnpin)).toEqual([{ project: '/work/a', removed: [] }])
  })

  it('저장 안 된 대화는 고정하지 않는다 — 알림도 없다', async () => {
    const { chat, of } = await start()
    const before = of('conversations.changed').length

    expect(await chat.pin('없는-대화', true)).toBeUndefined()
    expect(of('conversations.changed').length).toBe(before)
  })
})

describe('ChatService — 대화 이름 바꾸기 (이슈 #63)', () => {
  it('제목을 바꿔 저장하고 목록 바뀜을 알린다 — 고친 대화를 준다. 그 뒤 턴이 돌아도 제목은 바꾼 그대로다 (자동 제목이 안 덮는다)', async () => {
    const { chat, turn, ended, stored, of } = await start()
    await chat.send('c1', input('처음 보낸 글'))
    ;(await turn(1)).finish()
    await ended(1)
    const before = of('conversations.changed').length

    expect(await chat.rename('c1', '  결제 API 문서 정리 ')).toMatchObject({ id: 'c1', title: '결제 API 문서 정리' })
    expect(of('conversations.changed').slice(before)).toEqual([{ project: '/work/a', removed: [] }])

    await chat.send('c1', input('둘째 질문'))
    expect(of('turn.started')[1]!.conversation.title).toBe('결제 API 문서 정리')
    ;(await turn(2)).finish()
    expect((await ended(2)).conversation!.title).toBe('결제 API 문서 정리')
    expect((await stored('c1'))!.title).toBe('결제 API 문서 정리')
  })

  it('도는 중인 대화도 바꿀 수 있다 — 턴 끝에 실려 오는 목록 정보도 새 제목이다', async () => {
    const { chat, turn, ended, stored } = await start()
    await chat.send('c1', input('처음'))
    const call = await turn(1)

    expect((await chat.rename('c1', '도는 중에 바꾼 이름'))!.title).toBe('도는 중에 바꾼 이름')
    call.finish({ usage: usage(5) })
    expect((await ended(1)).conversation).toMatchObject({ title: '도는 중에 바꾼 이름', usage: { turns: 1 } })
    expect((await stored('c1'))!.title).toBe('도는 중에 바꾼 이름')
  })

  it('빈 이름·저장 안 된 대화는 바꾸지 않는다 — 알림도 없다', async () => {
    const { chat, turn, stored, of } = await start()
    await chat.send('c1', input('처음'))
    await turn(1)
    const before = of('conversations.changed').length

    expect(await chat.rename('c1', '   ')).toBeUndefined()
    expect(await chat.rename('없는-대화', '이름')).toBeUndefined()
    expect(of('conversations.changed').length).toBe(before)
    expect((await stored('c1'))!.title).toBe('처음')
  })
})

describe('ChatService — 도는 턴 수 (종료 확인이 묻는다, 이슈 #92)', () => {
  it('대화마다 도는 턴 하나씩 센다 — 대기열에 쌓인 것은 세지 않고, 끝나면 준다', async () => {
    const { chat, turn, ended } = await start()
    expect(chat.running()).toBe(0)
    await chat.send('c1', input('하나'))
    await chat.send('c1', input('대기열'))
    await chat.send('c2', input('둘'))
    expect(chat.running()).toBe(2)

    await turn(2)
    chat.stop('c1') // 멈춘 턴은 대기열을 붙잡는다 — 다음 턴이 돌지 않는다
    await ended(1)
    expect(chat.running()).toBe(1)
    ;(await turn(2)).finish()
    await ended(2)
    expect(chat.running()).toBe(0)
  })
})

// 손으로 부르는 요약 (/compact, 이슈 #144) — 요약도 "도는 턴" 이다: 도는 중 표시·멈춤·대기열이 보통 턴과 같이 움직인다
describe('ChatService — 요약 (/compact)', () => {
  /** 한 턴을 끝낸 대화 c1 */
  async function talked() {
    const started = await start()
    await started.chat.send('c1', input('첫 질문'))
    ;(await started.turn(1)).finish()
    await started.ended(1)
    return started
  }

  it('그 대화의 세션·모델로 요약을 한 번 부르고, 턴처럼 시작·진행 줄·끝을 알린다 — 내 말은 친 글(/compact), 다시 열어도 보이게 적어 둔다', async () => {
    const { chat, llm, ctx, of, ended } = await talked()
    expect(await chat.compact('c1')).toEqual({ ok: true })
    expect(chat.turnOf('c1')).toMatchObject({ origin: 'user' })
    await until(() => llm.compacts.length === 1)
    expect(llm.compacts[0]).toMatchObject({ providerId: 'gw', modelId: 'm1', directory: '/work/a', sessionId: 'ses_1' })
    expect(of('turn.started')[1]).toMatchObject({ cid: 'c1', origin: 'user', message: { role: 'user', text: '/compact' } })
    const line: TurnItem = { kind: 'compaction', id: 'msg_compact:compaction', status: 'running' }
    llm.compacts[0]!.progress(line)
    expect(of('turn.progress').at(-1)).toEqual({ cid: 'c1', item: line })
    expect(chat.snapshot()['c1']?.turn?.progress).toEqual([line])
    llm.compacts[0]!.progress({ ...line, status: 'done' })
    llm.compacts[0]!.finish()
    const end = await ended(2)
    expect(end).toMatchObject({ cid: 'c1', outcome: 'done', message: { role: 'assistant', text: '', items: [{ ...line, status: 'done' }] } })
    expect(chat.turnOf('c1')).toBeUndefined()
    expect(llm.calls).toHaveLength(1) // 프롬프트로 보내지 않는다
    expect((await ctx.sessions.list()).find((entry) => entry.id === 'c1')?.labels).toMatchObject({ msg_compact: '/compact' })
  })

  it('턴이 도는 중이면 거절한다 — 대기열에 넣지 않는다', async () => {
    const { chat, llm, turn } = await start()
    await chat.send('c1', input('긴 질문'))
    await turn(1)
    expect(await chat.compact('c1')).toEqual({ ok: false, error: tr('compact.busy') })
    expect(chat.queued('c1')).toBe(0)
    expect(llm.compacts).toHaveLength(0)
    llm.calls[0]!.finish()
  })

  it('요약이 도는 중에 또 부르면 거절하고, 그사이 보낸 글은 대기열에 쌓였다가 요약이 끝나면 간다', async () => {
    const { chat, llm, turn, ended } = await talked()
    expect(await chat.compact('c1')).toEqual({ ok: true })
    expect(await chat.compact('c1')).toEqual({ ok: false, error: tr('compact.busy') })
    expect(await chat.send('c1', input('요약 뒤 질문'))).toEqual({ state: 'queued' })
    await until(() => llm.compacts.length === 1)
    llm.compacts[0]!.finish()
    await ended(2)
    expect((await turn(2)).prompt).toBe('요약 뒤 질문')
    llm.calls[1]!.finish()
    await ended(3)
    expect(llm.compacts).toHaveLength(1)
  })

  it('아직 한 번도 안 보낸 대화면 요약할 내용이 없다고 알린다 — 엔진을 부르지 않고 턴도 열지 않는다', async () => {
    const { chat, llm, names } = await start()
    expect(await chat.compact('c-new')).toEqual({ ok: false, error: tr('compact.empty') })
    expect(llm.compacts).toHaveLength(0)
    expect(chat.turnOf('c-new')).toBeUndefined()
    expect(names()).toEqual([])
  })

  it('멈춤이 듣는다 — 요약 턴은 "중단됨" 으로 끝난다', async () => {
    const { chat, llm, ended } = await talked()
    await chat.compact('c1')
    await until(() => llm.compacts.length === 1)
    expect(chat.stop('c1')).toBe(true)
    expect(await ended(2)).toMatchObject({ cid: 'c1', outcome: 'interrupted', message: { interrupted: true, error: tr('error.stopped') } })
    expect(chat.turnOf('c1')).toBeUndefined()
  })
})

// 도는 턴에 끼워 넣기 (이슈 #250) — 사람이 친 글(데스크탑·폰)은 대기열 대신 그 턴에 끼워 넣는다 (ctx.llm.reserve → send). 다른 대화의 지시·
// 앱이 이어 보낸 것·요약 턴은 지금처럼 대기열. 말풍선은 'chat/turn-interjected', 그때까지의 진행 줄은 그 앞의 답으로 얼린다
describe('ChatService — 도는 턴에 끼워 넣기 (이슈 #250)', () => {
  async function steering() {
    const started = await start()
    started.llm.steerable = true
    await started.chat.send('c1', input('A 일', { mode: 'plan' }))
    const first = await started.turn(1)
    return { ...started, first }
  }
  const text = (id: string, body: string): TurnItem => ({ kind: 'text', id, text: body, done: true })
  const tool: TurnItem = { kind: 'tool', id: 'x1', name: 'bash', status: 'running' }

  it('사람이 친 글은 대기열이 아니라 도는 턴에 간다 — 그 턴의 모드로 말풍선(interjected)을 내고, 엔진엔 그 턴 자리로 보낸다', async () => {
    const { chat, llm, first, of, names } = await steering()
    first.progress(tool)
    expect(await chat.send('c1', input('B 말', { mode: 'build', model: { providerId: 'gw', modelId: 'm2' } }))).toEqual({ state: 'interjected' })
    expect(names()).not.toContain('queue.changed')
    expect(chat.queued('c1')).toBe(0)
    const said = of('turn.interjected')[0]!
    expect(said).toMatchObject({ cid: 'c1', message: { role: 'user', text: 'B 말', mode: 'plan', interjected: true } })
    expect(llm.reserved).toHaveLength(1)
    expect(llm.reserved[0]).toMatchObject({ turn: first.messageId, messageId: said.message.id })
    await until(() => llm.reserved[0]!.sent !== undefined)
    expect(llm.reserved[0]!.sent).toMatchObject({ prompt: 'B 말', images: [] })
    expect(llm.calls).toHaveLength(1)
  })

  it('끼운 뒤 진행 줄은 말풍선 아래로, 끼우기 전 줄이 바뀌면 얼린 답 안에서 — 스냅샷·턴 끝 답도 그 모양, 답 글은 마지막 말 뒤의 글', async () => {
    const { chat, first, ended } = await steering()
    first.progress(tool)
    first.progress(text('a', 'A 중간 '))
    await chat.send('c1', input('B 말'))
    const finished: TurnItem = { ...tool, status: 'done' } as TurnItem
    first.progress(finished)
    first.progress(text('b', 'B 에 답함'))
    const live = chat.snapshot().c1!.turn!
    expect(live.progress).toEqual([text('b', 'B 에 답함')])
    expect(live.interjections).toMatchObject([{ role: 'assistant', text: 'A 중간 ', items: [finished, text('a', 'A 중간 ')] }, { role: 'user', text: 'B 말', interjected: true }])
    first.finish({ text: 'A 중간 B 에 답함' })
    const end = await ended(1)
    expect(end.message).toMatchObject({ role: 'assistant', text: 'B 에 답함', items: [text('b', 'B 에 답함')] })
    expect(end.unanswered).toBeUndefined()
  })

  it('턴 끝 확장점(after-turn)이 받는 답 글도 마지막 말 뒤의 글이다', async () => {
    const { ctx, chat, first, ended } = await steering()
    const texts: string[] = []
    ctx.on('chat/after-turn', (turn) => void texts.push(turn.text))
    first.progress(text('a', 'A 글'))
    await chat.send('c1', input('B 말'))
    first.progress(text('b', 'B 답'))
    first.finish({ text: 'A 글B 답' })
    await ended(1)
    expect(texts).toEqual(['B 답'])
  })

  it('폰(device:)이 친 글도 끼워 넣는다', async () => {
    const { chat } = await steering()
    expect(await chat.send('c1', input('폰에서', { origin: 'device:d1' }))).toEqual({ state: 'interjected' })
  })

  it('다른 대화의 지시·앱이 이어 보낸 것(hook)은 끼워 넣지 않고 대기열에 — 자리를 잡지도 않는다', async () => {
    const { chat, llm } = await steering()
    expect(await chat.send('c1', input('지시', { origin: 'session:c9', from: { conversationId: 'c9', title: '다른 대화' } }))).toEqual({ state: 'queued' })
    expect(await chat.send('c1', input('이어서', { origin: 'hook' }))).toEqual({ state: 'queued' })
    expect(chat.queued('c1')).toBe(2)
    expect(llm.reserved).toEqual([])
  })

  it('요약(/compact) 턴 중에 친 글은 대기열에 — 엔진이 그 턴에 자리를 주지 않는다', async () => {
    const { chat, llm, first, ended } = await steering()
    first.finish()
    await ended(1)
    expect(await chat.compact('c1')).toEqual({ ok: true })
    expect(await chat.send('c1', input('요약 뒤 질문'))).toEqual({ state: 'queued' })
    await until(() => llm.compacts.length === 1)
    llm.compacts[0]!.finish()
  })

  it('엔진이 아직 턴을 안 받았거나 멈추는 중이면 대기열로 (지금까지와 같다)', async () => {
    const { chat, llm } = await steering()
    llm.steerable = false
    expect(await chat.send('c1', input('아직'))).toEqual({ state: 'queued' })
    llm.steerable = true
    chat.stop('c1')
    expect(await chat.send('c1', input('멈춘 뒤'))).toEqual({ state: 'queued' })
  })

  it('답을 못 받은 끼워 넣은 말(거절·중지)은 입력창으로 되돌리지 않고 턴 끝에 unanswered 로 알린다', async () => {
    const { chat, first, of, ended } = await steering()
    await chat.send('c1', input('B 말'))
    const said = of('turn.interjected')[0]!.message
    first.finish({ declined: true, unanswered: [said.id!] })
    expect(await ended(1)).toMatchObject({ outcome: 'done', unanswered: [said.id], message: { declined: true } })
    expect(chat.queued('c1')).toBe(0)
  })

  it('보내기 직전 확장점(before-send)을 똑같이 거친다 — 맥락은 끼워 넣는 말에 실리고, 막히면 보내지 않고 입력창으로(붙잡힌 대기열) 답 없음', async () => {
    const { ctx, chat, llm, first, of, ended } = await steering()
    const seen: { text: string; first: boolean; origin: string }[] = []
    ctx.on('chat/before-send', (send) => {
      seen.push({ text: send.text, first: send.first, origin: send.origin })
      if (send.text === '막을 말') send.blocked = '막힘'
      else send.context.push('B 맥락')
    })
    await chat.send('c1', input('B 말'))
    await until(() => llm.reserved[0]?.sent !== undefined)
    expect(llm.reserved[0]!.sent).toMatchObject({ prompt: 'B 말', context: 'B 맥락' })
    await chat.send('c1', input('막을 말'))
    await until(() => llm.reserved[1]?.cancelled === true)
    expect(llm.reserved[1]!.sent).toBeUndefined()
    expect(of('queue.changed').at(-1)).toMatchObject({ items: ['막을 말'], held: true })
    expect(seen).toEqual([{ text: 'B 말', first: false, origin: 'user' }, { text: '막을 말', first: false, origin: 'user' }])
    first.finish()
    expect((await ended(1)).unanswered).toEqual([of('turn.interjected')[1]!.message.id])
  })

  it('첨부도 같은 길로 읽어 실린다 — 글 파일은 본문에, 칩은 말풍선에, 그 메시지 id 로 적어 둔다', async () => {
    const { ctx, chat, llm, stored, of } = await steering()
    const read: string[][] = []
    ctx.on('chat/attachments-read', (paths) => void read.push(paths))
    const file = path.join(root, 'notes.md')
    await fs.writeFile(file, '# 메모')
    chat.allowAttachments([file])
    await chat.send('c1', input('이것도 봐', { project: root, attachments: [{ kind: 'file', path: file, name: 'notes.md', size: 6 }] }))
    const said = of('turn.interjected')[0]!.message
    expect(said).toMatchObject({ text: '이것도 봐', attachments: [{ kind: 'file', name: 'notes.md', size: 6 }] })
    await until(() => llm.reserved[0]?.sent !== undefined)
    expect(llm.reserved[0]!.sent!.prompt).toContain('notes.md')
    expect(read).toEqual([[file]])
    expect((await stored('c1'))?.attachments).toEqual({ [said.id!]: [{ kind: 'file', name: 'notes.md', size: 6 }] })
  })

  it('고르지 않은 첨부면 보내지 않는다 — 그 말은 답 없음', async () => {
    const { chat, llm, first, ended } = await steering()
    await chat.send('c1', input('몰래', { project: root, attachments: [{ kind: 'file', path: '/etc/passwd', name: 'passwd', size: 1 }] }))
    await until(() => llm.reserved[0]?.cancelled === true)
    first.finish()
    expect((await ended(1)).unanswered).toEqual([llm.reserved[0]!.messageId])
  })
})
