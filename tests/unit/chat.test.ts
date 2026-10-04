import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatService } from '../../src/services/chat.ts'
import { SessionsService } from '../../src/services/sessions.ts'
import type { ChatImage, ChatResult } from '../../src/services/llm.ts'
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

class FakeLlm extends Service {
  calls: Call[] = []
  replies: unknown[][] = []
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
  async chat(
    providerId: string,
    modelId: string,
    directory: string,
    prompt: string,
    sessionId?: string,
    onSession?: (sessionId: string) => Promise<void>,
    messageId?: string,
    onProgress?: (item: TurnItem) => void,
    mode?: string,
    onAttention?: (requests: Attention[]) => void,
    stop?: AbortSignal,
    images: readonly ChatImage[] = [],
  ): Promise<ChatResult> {
    const id = sessionId ?? `ses_${this.calls.length + 1}`
    if (!sessionId) await onSession?.(id)
    this.peak = Math.max(this.peak, ++this.open)
    return new Promise<ChatResult>((resolve) => {
      const end = (result: ChatResult) => {
        this.open--
        resolve(result)
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
  return { chat: ready.chat, sessions: ready.sessions, llm, events, names, of, turn, ended, stored }
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

  it('새 대화에 제목을 주면 그 제목으로 만든다 (start_session) — 있는 대화의 제목은 안 바꾼다', async () => {
    const { chat, turn, stored } = await start()
    await chat.send('c1', input('첫 지시', { title: 'README 정리' }))
    const first = await turn(1)
    expect((await stored('c1'))!.title).toBe('README 정리')
    first.finish()
    await chat.send('c1', input('둘째', { title: '다른 제목' }))
    await turn(2)
    expect((await stored('c1'))!.title).toBe('README 정리')
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
    expect(of('queue.changed').at(-1)).toMatchObject({ items: ['a.md', '둘 다 봐'], attachments: [{ kind: 'file', name: 'a.md', size: 1 }, { kind: 'file', name: 'b.md', size: 1 }] })
    first.finish()
    const second = await turn(2)
    expect(second.prompt.indexOf('a.md')).toBeGreaterThan(-1)
    expect(second.prompt.indexOf('a.md')).toBeLessThan(second.prompt.indexOf('b.md'))
    expect(of('turn.started')[1]!.message).toMatchObject({ text: '둘 다 봐', attachments: [{ name: 'a.md' }, { name: 'b.md' }] })
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
    expect(await chat.stopSubtask('sub_1')).toBe(true)
    expect(await chat.stopSubtask('nope')).toBe(false)
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

    await chat.send('c1', input('둘째 질문', { title: '다른 제목' }))
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
