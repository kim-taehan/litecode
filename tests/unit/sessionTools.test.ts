import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatService } from '../../src/services/chat.ts'
import { SessionsService } from '../../src/services/sessions.ts'
import { APP_MCP_NAME } from '../../src/services/mcp.ts'
import type { AppMcpTool } from '../../src/services/appMcp/rpc.ts'
import { agoText, clip, lastTurns, sessionLine, SessionTools } from '../../src/services/appMcp/tools/sessions.ts'
import type { ChatResult } from '../../src/services/llm.ts'
import type { ToolCaller } from '../../src/services/toolCalls.ts'
import { setMainLanguage, tr } from '../../src/i18n.ts'
import { attentionTarget, DELEGATION_SERVER, MAX_SENDS_PER_TURN, QUEUE_LIMIT, resolveShortId, shortIds, widerMode, wrapInstruction } from '../../shared/delegation.ts'
import type { Attention, Conversation, History, HistoryMessage, TurnItem } from '../../shared/contract.ts'
import type { ChatEventMap, QueuedSend } from '../../shared/chat.ts'

// 세션 도구 넷 (이슈 #55, 01z 3-3·3-4) — list_sessions·read_session·send_to_session·start_session.
// ctx.chat·ctx.sessions 는 진짜(임시 파일), ctx.llm 은 가짜다: 턴을 쥐고 있다가 시험이 끝내고, callerOf 는 시험이 정한 "부른 대화" 를 준다
// (진짜 찾기·승인 기록은 toolCalls.test.ts·turnEvents.test.ts). ctx.appMcp 는 등록된 도구를 모으기만 한다

interface Turn {
  directory: string
  prompt: string
  providerId: string
  modelId: string
  mode?: string
  messageId?: string
  sessionId: string
  attention(requests: Attention[]): void
  finish(result?: Partial<ChatResult>): void
}

class FakeLlm extends Service {
  turns: Turn[] = []
  /** callerOf 가 줄 것 — 도구 이름별. 없으면 "못 찾음" */
  callers = new Map<string, ToolCaller | undefined>()
  asked: { directory: string; server: string; tool: string; args: unknown }[] = []
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
    _onProgress?: (item: TurnItem) => void,
    mode?: string,
    onAttention?: (requests: Attention[]) => void,
    stop?: AbortSignal,
  ): Promise<ChatResult> {
    const id = sessionId ?? `ses_${this.turns.length + 1}`
    if (!sessionId) await onSession?.(id)
    return new Promise<ChatResult>((resolve) => {
      this.turns.push({
        directory, prompt, providerId, modelId, mode, messageId, sessionId: id,
        attention: (requests) => onAttention?.(requests),
        finish: (result = {}) => resolve({ ok: true, sessionId: id, text: `echo: ${prompt}`, ...result }),
      })
      stop?.addEventListener('abort', () => resolve({ ok: false, sessionId: id, error: tr('error.stopped'), interrupted: true }))
    })
  }
  async callerOf(directory: string, ref: { server: string; tool: string }, args: unknown): Promise<ToolCaller | undefined> {
    this.asked.push({ directory, ...ref, args })
    return this.callers.get(ref.tool)
  }
  /** 엔진 기록 흉내 — 그 세션에 간 프롬프트와 끝난 답 (감싼 글 그대로, id 는 보낸 messageId) */
  async history(_directory: string, sessionId: string): Promise<History> {
    const messages: HistoryMessage[] = []
    for (const turn of this.turns.filter((entry) => entry.sessionId === sessionId)) {
      messages.push({ id: turn.messageId, role: 'user', text: turn.prompt })
      if (this.answers.has(turn)) messages.push({ role: 'assistant', text: this.answers.get(turn)! })
    }
    return { messages }
  }
  answers = new Map<Turn, string>()
  async reply(): Promise<void> {}
  async stopSubtask(): Promise<boolean> {
    return false
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

class FakeAppMcp extends Service {
  tools = new Map<string, AppMcpTool>()
  constructor(ctx: Context) {
    super(ctx, 'appMcp')
  }
  register(tool: AppMcpTool): () => void {
    this.tools.set(tool.name, tool)
    return () => void this.tools.delete(tool.name)
  }
}

let root: string
let project: string
const MODEL = { providerId: 'gw', modelId: 'm1' }
const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const C = 'cccccccc-0000-4000-8000-000000000003'

beforeEach(async () => {
  setMainLanguage('ko')
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-sessiontools-')))
  project = path.join(root, 'proj')
  await fs.mkdir(project)
})

afterEach(async () => {
  // 대화를 지운 시험은 엔진 세션 지우기(sweep)가 뒤에서 목록 파일을 한 번 더 쓴다 — 그것이 끝난 뒤에 폴더를 지운다
  await new Promise((resolve) => setTimeout(resolve, 50))
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; tries < 400 && !done(); tries++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(done()).toBe(true)
}

async function start() {
  const ctx = new Context()
  ctx.plugin(FakeLlm)
  ctx.plugin(FakeProviders)
  ctx.plugin(FakeAppMcp)
  ctx.plugin(SessionsService, { file: path.join(root, 'sessions.json') })
  ctx.plugin(ChatService)
  ctx.plugin(SessionTools)
  const ready = await new Promise<Context>((resolve) => ctx.inject(['chat', 'sessions', 'llm', 'appMcp'], resolve))
  const llm = ready.llm as unknown as FakeLlm
  const tools = (ready.appMcp as unknown as FakeAppMcp).tools
  await until(() => tools.size === 4)
  const started: ChatEventMap['turn.started'][] = []
  const queues: ChatEventMap['queue.changed'][] = []
  ctx.on('chat/turn-started', (data) => void started.push(data))
  ctx.on('chat/queue-changed', (data) => void queues.push(data))
  const call = (name: string, args: Record<string, unknown> = {}, directory = project) => tools.get(name)!.run(args, { directory })
  const stored = async (id: string) => (await ready.sessions.list()).find((entry) => entry.id === id)
  /** 사람이 그 대화에 보낸다 — 엔진에 닿은 그 턴을 준다 */
  const say = async (cid: string, text: string, extra: Pick<QueuedSend, 'mode' | 'model'> = {}): Promise<Turn> => {
    const before = llm.turns.length
    await ready.chat.send(cid, { text, project, model: MODEL, mode: 'build', ...extra })
    await until(() => llm.turns.length > before)
    return llm.turns.at(-1)!
  }
  /** 그 턴이 부른 것으로 — 앱에서 허용한 호출 */
  const calledBy = (tool: string, turn: Turn, caller: Partial<ToolCaller> = {}) =>
    llm.callers.set(tool, { sessionId: turn.sessionId, callId: `call_${Math.random()}`, child: false, approved: true, ...caller })
  /** 끝난 대화 하나 (쉬는 중) */
  const idle = async (cid: string, text: string, extra: Pick<QueuedSend, 'mode' | 'model'> = {}): Promise<void> => {
    const turn = await say(cid, text, extra)
    llm.answers.set(turn, `answer to ${text}`)
    turn.finish()
    await until(() => !ready.chat.turnOf(cid))
  }
  return { ctx, chat: ready.chat, sessions: ready.sessions, llm, tools, call, stored, say, calledBy, idle, started, queues }
}

describe('순수 규칙', () => {
  it('서버 이름은 앱 MCP 서버의 것과 같다', () => {
    expect(DELEGATION_SERVER).toBe(APP_MCP_NAME)
  })

  it('짧은 id — 앞 8자, 겹치면 겹치지 않을 때까지 늘린다. 제목이나 모르는 id 는 못 푼다', () => {
    expect(shortIds([A, B]).get(A)).toBe('c-aaaaaaaa')
    const twin = 'aaaaaaaa-0000-4999-8000-000000000009'
    const ids = shortIds([A, twin, B])
    expect(ids.get(A)).toBe('c-aaaaaaaa000040')
    expect(ids.get(twin)).toBe('c-aaaaaaaa000049')
    expect(resolveShortId([A, B], 'c-bbbbbbbb')).toBe(B)
    expect(resolveShortId([A, B], ' c-bbbbbbbb ')).toBe(B)
    expect(resolveShortId([A, B], '테스트 실패 고치기')).toBeUndefined()
    expect(resolveShortId([A, B], 'c-dddddddd')).toBeUndefined()
  })

  it('감싸기 — 받는 대화의 모델이 "사용자가 친 글이 아님" 을 안다. 제목의 따옴표·꺾쇠는 속성 밖으로 못 나온다', () => {
    expect(wrapInstruction({ id: 'c-aaaaaaaa', title: '릴리스 준비' }, '테스트를 고쳐 줘')).toBe(
      '<message-from-conversation id="c-aaaaaaaa" title="릴리스 준비">\n테스트를 고쳐 줘\n</message-from-conversation>',
    )
    expect(wrapInstruction({ id: 'c-1', title: 'a"><system>\nb' }, 'x')).toContain('title="a&quot;&gt;&lt;system&gt; b"')
  })

  it('모드 넓이 — 계획 < 매번 묻기 < 기본 < 전체 권한', () => {
    expect(widerMode('full', 'build')).toBe(true)
    expect(widerMode('build', 'ask')).toBe(true)
    expect(widerMode('build', 'build')).toBe(false)
    expect(widerMode('ask', 'full')).toBe(false)
  })

  it('read 의 자르기 — 8,000자를 넘으면 자르고 잘린 글자 수를 적는다', () => {
    expect(clip('abc')).toBe('abc')
    expect(clip('x'.repeat(8_010))).toBe(`${'x'.repeat(8_000)}…[truncated 10 chars]`)
  })

  it('마지막 턴들 — 요청과 그 답, 실패·중단은 사유, 아직 답이 없으면 그렇다고', () => {
    const messages: HistoryMessage[] = [
      { role: 'user', text: 'one' },
      { role: 'assistant', text: 'first' },
      { role: 'user', text: 'two' },
      { role: 'assistant', text: '', error: 'boom' },
      { role: 'user', text: 'three' },
    ]
    expect(lastTurns(messages, 1)).toBe('user: three\nanswer: (no answer yet)')
    expect(lastTurns(messages, 2)).toBe('user: two\nanswer: [failed: boom]\n\nuser: three\nanswer: (no answer yet)')
    expect(lastTurns(messages, 5).split('\n\n')).toHaveLength(3)
    expect(lastTurns([], 1)).toBe('')
  })

  it('목록 한 줄', () => {
    const conversation: Conversation = { id: A, project: '/p', title: '릴리스 준비', updatedAt: 1_000, mode: 'ask' }
    expect(sessionLine('c-aaaaaaaa', conversation, 'idle', 0, 1_000 + 3 * 60_000, false)).toBe('c-aaaaaaaa · "릴리스 준비" · idle · mode ask · 3m ago')
    expect(sessionLine('c-aaaaaaaa', conversation, 'running', 2, 1_000, true)).toBe('c-aaaaaaaa · "릴리스 준비" · running (2 queued) · mode ask · just now (this conversation)')
    expect(agoText(0, 2 * 3_600_000)).toBe('2h ago')
    expect(agoText(0, 3 * 86_400_000)).toBe('3d ago')
  })
})

describe('list_sessions', () => {
  it('같은 프로젝트의 대화만 — 제목·상태·모드·마지막 활동, 부른 대화 표시. 다른 프로젝트의 대화는 없다', async () => {
    const { call, say, idle, calledBy, llm, sessions } = await start()
    const other = path.join(root, 'other')
    await fs.mkdir(other)
    await sessions.save({ id: C, project: other, title: '다른 프로젝트', updatedAt: Date.now(), model: MODEL })
    await idle(B, '테스트 실패 고치기', { mode: 'ask' })
    const turn = await say(A, '릴리스 준비')
    calledBy('list_sessions', turn)
    const lines = (await call('list_sessions')).split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^c-aaaaaaaa · "릴리스 준비" · running · mode build · just now \(this conversation\)$/)
    expect(lines[1]).toMatch(/^c-bbbbbbbb · "테스트 실패 고치기" · idle · mode ask · just now$/)
    expect(llm.asked.at(-1)).toMatchObject({ directory: project, server: 'litecode', tool: 'list_sessions' })
    // 승인·질문을 기다리는 대화
    turn.attention([{ kind: 'permission', id: 'per_1', sessionId: turn.sessionId, action: 'bash', resources: ['ls'] }])
    expect(await call('list_sessions')).toContain('"릴리스 준비" · waiting for the user')
    // 부른 대화를 못 찾아도 목록은 준다
    llm.callers.delete('list_sessions')
    expect(await call('list_sessions')).not.toContain('(this conversation)')
  })

  it('대화가 없는 프로젝트', async () => {
    const { call } = await start()
    expect(await call('list_sessions')).toBe('No conversations in this project yet.')
  })
})

describe('send_to_session', () => {
  it('대상이 쉬면 그 자리에서 턴이 된다 — LLM 엔 감싼 글, 말풍선엔 본문과 출처, 대상의 모델·모드로. 결과는 곧바로 "받았다"', async () => {
    const { call, say, idle, calledBy, llm, started, stored, sessions } = await start()
    await idle(B, '테스트 실패 고치기', { mode: 'full', model: { providerId: 'gw', modelId: 'm2' } })
    const sender = await say(A, '릴리스 준비')
    const args = { session: 'c-bbbbbbbb', message: '깨진 테스트를 전부 고쳐 줘' }
    calledBy('send_to_session', sender)
    const before = llm.turns.length
    expect(await call('send_to_session', args)).toBe('Accepted. "테스트 실패 고치기" (c-bbbbbbbb) started working on it.')
    await until(() => llm.turns.length > before)
    const received = llm.turns.at(-1)!
    expect(received.prompt).toBe('<message-from-conversation id="c-aaaaaaaa" title="릴리스 준비">\n깨진 테스트를 전부 고쳐 줘\n</message-from-conversation>')
    expect(received).toMatchObject({ sessionId: 'ses_1', modelId: 'm2', mode: 'full' }) // 받는 대화 자기 모델·모드 그대로
    expect(llm.asked.at(-1)).toMatchObject({ directory: project, server: 'litecode', tool: 'send_to_session', args })
    const event = started.at(-1)!
    expect(event).toMatchObject({ cid: B, origin: `session:${A}` })
    expect(event.message).toMatchObject({ text: '깨진 테스트를 전부 고쳐 줘', origin: { conversationId: A, title: '릴리스 준비' } })
    // 다시 열어도 본문만 + 출처 — 보낸 대화가 지워져도 적어 둔 제목으로
    await sessions.remove(A)
    const reopened = (await sessions.history(B)).messages.at(-1)!
    expect(reopened).toMatchObject({ role: 'user', text: '깨진 테스트를 전부 고쳐 줘', origin: { conversationId: A, title: '릴리스 준비' } })
    expect((await stored(B))!.title).toBe('테스트 실패 고치기') // 제목은 그대로
  })

  it('대상이 돌고 있으면 대기열에 — 사람 글과 합치지 않고 차례로 한 턴씩. 대기열 줄에 보낸 대화가 실린다', async () => {
    const { call, say, calledBy, llm, chat, queues, started } = await start()
    const busy = await say(B, '테스트 실패 고치기')
    const sender = await say(A, '릴리스 준비')
    await chat.send(B, { text: '그리고 CHANGELOG 도', project, model: MODEL })
    calledBy('send_to_session', sender)
    expect(await call('send_to_session', { session: 'c-bbbbbbbb', message: '커버리지도 알려 줘' })).toBe('Accepted and queued — "테스트 실패 고치기" (c-bbbbbbbb) is busy (2 ahead).')
    expect(queues.at(-1)).toMatchObject({ cid: B, items: ['그리고 CHANGELOG 도', '커버리지도 알려 줘'], sources: [null, { conversationId: A, title: '릴리스 준비' }] })
    busy.finish()
    await until(() => llm.turns.length === 3)
    expect(llm.turns[2]!.prompt).toBe('그리고 CHANGELOG 도') // 사람 글만
    expect(started.at(-1)).toMatchObject({ cid: B, origin: 'user' })
    llm.turns[2]!.finish()
    await until(() => llm.turns.length === 4)
    expect(llm.turns[3]!.prompt).toContain('<message-from-conversation id="c-aaaaaaaa"')
    expect(llm.turns[3]!.prompt).toContain('커버리지도 알려 줘')
    expect(started.at(-1)).toMatchObject({ cid: B, origin: `session:${A}` })
  })

  it('"빼기" — 대기열의 다른 대화 줄 하나만 뺀다. 사람이 친 줄은 못 뺀다(되돌리기)', async () => {
    const { call, say, calledBy, chat, queues } = await start()
    await say(B, '테스트 실패 고치기')
    const sender = await say(A, '릴리스 준비')
    await chat.send(B, { text: '사람 글', project, model: MODEL })
    calledBy('send_to_session', sender)
    await call('send_to_session', { session: 'c-bbbbbbbb', message: '지시' })
    expect(chat.dropQueued(B, 0)).toBe(false)
    expect(chat.dropQueued(B, 1)).toBe(true)
    expect(queues.at(-1)).toMatchObject({ cid: B, items: ['사람 글'], sources: [null] })
    expect(chat.dropQueued(B, 5)).toBe(false)
  })

  it('앱에서 허용한 기록이 없는 호출·부른 대화를 못 찾은 호출·하위 작업의 호출은 거절 — 아무것도 보내지 않는다', async () => {
    const { call, say, idle, calledBy, llm } = await start()
    await idle(B, '테스트 실패 고치기')
    const sender = await say(A, '릴리스 준비')
    const args = { session: 'c-bbbbbbbb', message: '지시' }
    const turns = llm.turns.length
    await expect(call('send_to_session', args)).rejects.toThrow(/Could not tell which conversation/)
    calledBy('send_to_session', sender, { approved: false })
    await expect(call('send_to_session', args)).rejects.toThrow(/not approved by the user/)
    calledBy('send_to_session', sender, { child: true })
    await expect(call('send_to_session', args)).rejects.toThrow(/Sub-tasks cannot send/)
    // 앱이 모르는 세션(폴더 코드가 엔진에 직접 만든 세션)
    calledBy('send_to_session', sender, { sessionId: 'ses_unknown' })
    await expect(call('send_to_session', args)).rejects.toThrow(/Could not tell which conversation/)
    expect(llm.turns.length).toBe(turns)
  })

  it('자기 자신·모르는 id·다른 프로젝트·지워진 대화·쓸 수 없는 대화', async () => {
    const { call, say, idle, calledBy, sessions } = await start()
    const other = path.join(root, 'other')
    await fs.mkdir(other)
    await sessions.save({ id: C, project: other, title: '다른 프로젝트', updatedAt: Date.now(), model: MODEL })
    await idle(B, '테스트 실패 고치기')
    const sender = await say(A, '릴리스 준비')
    calledBy('send_to_session', sender)
    await expect(call('send_to_session', { session: 'c-aaaaaaaa', message: 'x' })).rejects.toThrow('Cannot send to this conversation itself.')
    await expect(call('send_to_session', { session: 'c-cccccccc', message: 'x' })).rejects.toThrow('Unknown session. Use an id from list_sessions.')
    await expect(call('send_to_session', { session: '테스트 실패 고치기', message: 'x' })).rejects.toThrow('Unknown session.')
    await expect(call('send_to_session', { session: 'c-bbbbbbbb', message: '  ' })).rejects.toThrow('message is required.')
    await expect(call('send_to_session', { session: 'c-bbbbbbbb', message: 'x'.repeat(20_001) })).rejects.toThrow(/too long/)
    // 모델이 설정에서 사라진 대화
    await sessions.patch(B, () => ({ model: { providerId: 'gone', modelId: 'm1' } }))
    await expect(call('send_to_session', { session: 'c-bbbbbbbb', message: 'x' })).rejects.toThrow('Target conversation has no usable model.')
    await sessions.remove(B)
    await expect(call('send_to_session', { session: 'c-bbbbbbbb', message: 'x' })).rejects.toThrow('Unknown session.')
  })

  it('깊이 1 — 지시를 받아 도는 턴(대기열에서 나온 것 포함)은 다시 지시하지 못한다. 그 대화에 사람이 직접 친 턴은 보낼 수 있다', async () => {
    const { call, say, idle, calledBy, llm, chat } = await start()
    await idle(B, '테스트 실패 고치기')
    await idle(C, '문서 정리')
    const sender = await say(A, '릴리스 준비')
    calledBy('send_to_session', sender)
    await call('send_to_session', { session: 'c-bbbbbbbb', message: '지시' })
    await until(() => llm.turns.at(-1)!.prompt.includes('지시'))
    const delegated = llm.turns.at(-1)!
    // B 의 그 턴이 A 나 C 로 다시 보내려 한다
    calledBy('send_to_session', delegated)
    calledBy('start_session', delegated)
    await expect(call('send_to_session', { session: 'c-cccccccc', message: '더' })).rejects.toThrow('This turn was started by another conversation and cannot delegate further.')
    await expect(call('start_session', { title: '새 대화', message: '더' })).rejects.toThrow('cannot delegate further')
    // 그 턴이 끝난 뒤 사람이 B 에 직접 친 턴은 새 지시를 보낼 수 있다 (순환이 아니다 — 승인 카드를 다시 거친다)
    delegated.finish()
    await until(() => !chat.turnOf(B))
    const direct = await say(B, '사람이 직접')
    calledBy('send_to_session', direct)
    expect(await call('send_to_session', { session: 'c-cccccccc', message: '사람이 시킨 것' })).toMatch(/^Accepted\./)
  })

  it(`한 턴에 보내기 ${MAX_SENDS_PER_TURN}번 (send·start 합쳐) — 다음 턴엔 다시 보낼 수 있다`, async () => {
    const { call, say, idle, calledBy, chat } = await start()
    await idle(B, '테스트 실패 고치기')
    const sender = await say(A, '릴리스 준비')
    calledBy('send_to_session', sender)
    calledBy('start_session', sender)
    for (let n = 0; n < MAX_SENDS_PER_TURN - 1; n++) await call('start_session', { title: `새 대화 ${n}`, message: 'x' })
    await call('send_to_session', { session: 'c-bbbbbbbb', message: 'x' })
    await expect(call('send_to_session', { session: 'c-bbbbbbbb', message: 'y' })).rejects.toThrow(`Too many instructions sent in this turn (the limit is ${MAX_SENDS_PER_TURN}).`)
    await expect(call('start_session', { title: '하나 더', message: 'x' })).rejects.toThrow(/Too many instructions/)
    sender.finish()
    await until(() => !chat.turnOf(A))
    const next = await say(A, '다음 턴')
    calledBy('send_to_session', next)
    expect(await call('send_to_session', { session: 'c-bbbbbbbb', message: 'z' })).toMatch(/^Accepted/)
  })

  it(`받는 대화의 대기열 상한 ${QUEUE_LIMIT} — 넘으면 거절하고 횟수도 세지 않는다`, async () => {
    const { call, say, calledBy, chat } = await start()
    await say(B, '테스트 실패 고치기')
    const sender = await say(A, '릴리스 준비')
    for (let n = 0; n < QUEUE_LIMIT; n++) await chat.send(B, { text: `사람 ${n}`, project, model: MODEL })
    calledBy('send_to_session', sender)
    await expect(call('send_to_session', { session: 'c-bbbbbbbb', message: 'x' })).rejects.toThrow(/^Target queue is full/)
    expect(chat.queued(B)).toBe(QUEUE_LIMIT)
    expect(chat.countSend(A, 1)).toBe(true) // 아직 하나도 안 셌다
  })

  it('보낸 대화를 멈춰도 받는 대화는 계속 돈다. 받는 대화가 지워지면 대기열의 지시도 사라진다', async () => {
    const { call, say, calledBy, chat, sessions, llm } = await start()
    const busy = await say(B, '테스트 실패 고치기')
    const sender = await say(A, '릴리스 준비')
    calledBy('send_to_session', sender)
    await call('send_to_session', { session: 'c-bbbbbbbb', message: '지시' })
    expect(chat.queued(B)).toBe(1)
    chat.stop(A)
    await until(() => !chat.turnOf(A))
    expect(chat.turnOf(B)).toMatchObject({ origin: 'user' })
    expect(chat.queued(B)).toBe(1) // 대기열의 지시는 남는다
    await sessions.remove(B)
    expect(chat.queued(B)).toBe(0)
    const turns = llm.turns.length
    busy.finish()
    await until(() => !chat.turnOf(B))
    expect(llm.turns.length).toBe(turns) // 지워진 대화로는 아무것도 안 간다
  })

  it('받는 대화의 턴을 사람이 멈추면: 사람 글은 붙잡혀 입력창으로 돌아가고, 다른 대화의 지시는 그 뒤에 차례대로 간다', async () => {
    const { call, say, calledBy, chat, llm } = await start()
    await say(B, '테스트 실패 고치기')
    const sender = await say(A, '릴리스 준비')
    await chat.send(B, { text: '사람 글', project, model: MODEL })
    calledBy('send_to_session', sender)
    await call('send_to_session', { session: 'c-bbbbbbbb', message: '지시' })
    chat.stop(B)
    await until(() => !chat.turnOf(B))
    expect(chat.queued(B)).toBe(2) // 붙잡혔다
    expect(chat.takeQueue(B)).toMatchObject({ text: '사람 글' })
    await until(() => llm.turns.at(-1)!.prompt.includes('지시'))
    expect(chat.turnOf(B)).toMatchObject({ origin: `session:${A}` })
  })

  it('사람 글 없이 다른 대화의 지시만 쌓였으면 멈춰도 붙잡지 않는다 — 멈춘 턴 뒤에 간다', async () => {
    const { call, say, calledBy, chat, llm, queues } = await start()
    await say(B, '테스트 실패 고치기')
    const sender = await say(A, '릴리스 준비')
    calledBy('send_to_session', sender)
    await call('send_to_session', { session: 'c-bbbbbbbb', message: '지시' })
    chat.stop(B)
    expect(queues.at(-1)!.held).toBe(false)
    await until(() => llm.turns.at(-1)!.prompt.includes('지시'))
  })
})

describe('start_session', () => {
  it('새 대화를 만들어 첫 지시를 보낸다 — 보낸 대화의 모델·모드를 물려받고, 제목은 인자, 화면이 모르는 대화의 turn.started 가 목록 정보와 함께 나간다', async () => {
    const { call, say, calledBy, llm, started, sessions } = await start()
    const sender = await say(A, '릴리스 준비', { mode: 'ask', model: { providerId: 'gw', modelId: 'm2' } })
    calledBy('start_session', sender)
    const result = await call('start_session', { title: 'README 정리', message: 'README 의 설치 절차를 고쳐 줘' })
    const created = (await sessions.list()).find((entry) => entry.title === 'README 정리')!
    expect(created).toMatchObject({ project, mode: 'ask', model: { providerId: 'gw', modelId: 'm2' } })
    expect(result).toBe(`Started "README 정리" (c-${created.id.replaceAll('-', '').slice(0, 8)}). Use read_session to collect the result.`)
    await until(() => llm.turns.length === 2)
    expect(llm.turns[1]).toMatchObject({ directory: project, modelId: 'm2', mode: 'ask' })
    expect(llm.turns[1]!.prompt).toBe('<message-from-conversation id="c-aaaaaaaa" title="릴리스 준비">\nREADME 의 설치 절차를 고쳐 줘\n</message-from-conversation>')
    const event = started.at(-1)!
    expect(event).toMatchObject({ cid: created.id, origin: `session:${A}`, conversation: { id: created.id, title: 'README 정리', project } })
    expect(event.message).toMatchObject({ text: 'README 의 설치 절차를 고쳐 줘', origin: { conversationId: A, title: '릴리스 준비' } })
  })

  it('제목·글이 없거나 제목이 60자를 넘으면 거절 — 대화를 만들지 않는다', async () => {
    const { call, say, calledBy, sessions } = await start()
    const sender = await say(A, '릴리스 준비')
    calledBy('start_session', sender)
    await expect(call('start_session', { title: '', message: 'x' })).rejects.toThrow('title is required.')
    await expect(call('start_session', { title: 'x'.repeat(61), message: 'x' })).rejects.toThrow(/title is too long/)
    await expect(call('start_session', { title: '제목' })).rejects.toThrow('message is required.')
    expect(await sessions.list()).toHaveLength(1)
  })

  it('허용 기록이 없으면 만들지 않는다', async () => {
    const { call, say, calledBy, sessions } = await start()
    const sender = await say(A, '릴리스 준비')
    calledBy('start_session', sender, { approved: false })
    await expect(call('start_session', { title: '제목', message: 'x' })).rejects.toThrow(/not approved/)
    expect(await sessions.list()).toHaveLength(1)
  })
})

// 이슈 #67 — 받을 대화는 사용자가 고른다: 승인 카드에서 고른 대상이 허용 기록(caller.target)에 실려 온다. 도구는 인자 대신 그것으로 보내고
// 자격을 다시 본다. 결과 글이 실제 대상을 말한다
describe('받을 대화 고르기 (이슈 #67)', () => {
  const pick = (conversationId: string) => ({ target: { kind: 'conversation' as const, conversationId } })
  const NEW = { target: { kind: 'new' as const } }

  it('모양만 거른다 — 아는 모양이 아니면 덮어쓰기 없음(도구 인자대로)', () => {
    expect(attentionTarget({ kind: 'new', extra: 1 })).toEqual({ kind: 'new' })
    expect(attentionTarget({ kind: 'conversation', conversationId: B, title: 'x' })).toEqual({ kind: 'conversation', conversationId: B })
    for (const bad of [undefined, null, 'new', {}, { kind: 'conversation' }, { kind: 'conversation', conversationId: 7 }, { kind: 'conversation', conversationId: '' }, { kind: 'other' }]) {
      expect(attentionTarget(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })

  it('AI 가 고른 대화를 그대로 고르면 기존 결과 글 그대로다 (바뀐 것이 아니다)', async () => {
    const { call, say, idle, calledBy } = await start()
    await idle(B, '테스트 실패 고치기')
    const sender = await say(A, '릴리스 준비')
    calledBy('send_to_session', sender, pick(B))
    expect(await call('send_to_session', { session: 'c-bbbbbbbb', message: '지시' })).toBe('Accepted. "테스트 실패 고치기" (c-bbbbbbbb) started working on it.')
  })

  it('기존 → 다른 기존: 고른 대화로 가고, AI 가 고른 대화에는 아무것도 안 간다. 결과 글이 실제 대상과 그 id 를 말한다', async () => {
    const { call, say, idle, calledBy, llm, chat, started, sessions } = await start()
    await idle(B, '테스트 실패 고치기')
    await idle(C, '문서 정리', { mode: 'full' })
    const sender = await say(A, '릴리스 준비')
    calledBy('send_to_session', sender, pick(C))
    const before = llm.turns.length
    expect(await call('send_to_session', { session: 'c-bbbbbbbb', message: '깨진 테스트를 고쳐 줘' })).toBe(
      'Accepted. The user chose a different conversation: "문서 정리" (id c-cccccccc). Use this id with read_session.',
    )
    await until(() => llm.turns.length > before)
    expect(llm.turns.at(-1)).toMatchObject({ sessionId: 'ses_2', mode: 'full' }) // C 의 세션·C 자기 모드
    expect(llm.turns.at(-1)!.prompt).toContain('깨진 테스트를 고쳐 줘')
    expect(started.at(-1)).toMatchObject({ cid: C, origin: `session:${A}`, message: { origin: { conversationId: A, title: '릴리스 준비' } } })
    expect(chat.turnOf(B)).toBeUndefined()
    expect(chat.queued(B)).toBe(0)
    expect((await sessions.history(C)).messages.at(-1)).toMatchObject({ text: '깨진 테스트를 고쳐 줘', origin: { conversationId: A } })
  })

  it('고른 대화가 돌고 있으면 대기열에 — 결과 글이 그렇다고 말한다. AI 가 준 id 가 틀렸어도 사용자가 고른 대화로 간다', async () => {
    const { call, say, calledBy, chat } = await start()
    await say(C, '문서 정리')
    const sender = await say(A, '릴리스 준비')
    calledBy('send_to_session', sender, pick(C))
    expect(await call('send_to_session', { session: 'c-zzzzzzzz', message: '지시' })).toBe(
      'Accepted. The user chose a different conversation: "문서 정리" (id c-cccccccc). It is busy, so the instruction is queued (1 ahead). Use this id with read_session.',
    )
    expect(chat.queued(C)).toBe(1)
  })

  it('기존 → 새 대화: 보낸 대화의 모드·모델로 새 대화가 생기고 제목은 보낼 글의 첫 줄. 결과 글에 새 id', async () => {
    const { call, say, idle, calledBy, llm, chat, sessions, started } = await start()
    await idle(B, '테스트 실패 고치기')
    const sender = await say(A, '릴리스 준비', { mode: 'ask', model: { providerId: 'gw', modelId: 'm2' } })
    calledBy('send_to_session', sender, NEW)
    const result = await call('send_to_session', { session: 'c-bbbbbbbb', message: 'README 를 고쳐 줘\n설치 절차부터' })
    const created = (await sessions.list()).find((entry) => entry.title === 'README 를 고쳐 줘')!
    expect(created).toMatchObject({ project, mode: 'ask', model: { providerId: 'gw', modelId: 'm2' } })
    expect(result).toBe(`Accepted. The user chose to start a new conversation instead: "README 를 고쳐 줘" (id c-${created.id.replaceAll('-', '').slice(0, 8)}). Use this id with read_session.`)
    await until(() => llm.turns.at(-1)!.prompt.includes('설치 절차부터'))
    expect(started.at(-1)).toMatchObject({ cid: created.id, origin: `session:${A}` })
    expect(chat.turnOf(B)).toBeUndefined()
  })

  it('새 대화 → 기존: 고른 대화로 가고 새 대화는 안 생긴다. title 인자는 버린다(없어도 된다)', async () => {
    const { call, say, idle, calledBy, llm, sessions, stored } = await start()
    await idle(B, '테스트 실패 고치기')
    const sender = await say(A, '릴리스 준비')
    calledBy('start_session', sender, pick(B))
    const before = llm.turns.length
    expect(await call('start_session', { title: 'README 정리', message: '지시' })).toBe('Accepted. The user chose a different conversation: "테스트 실패 고치기" (id c-bbbbbbbb). Use this id with read_session.')
    await until(() => llm.turns.length > before)
    expect(llm.turns.at(-1)!.sessionId).toBe('ses_1')
    expect(await sessions.list()).toHaveLength(2)
    expect((await stored(B))!.title).toBe('테스트 실패 고치기')
    calledBy('start_session', await say(C, '또 다른 대화'), pick(B))
    expect(await call('start_session', { message: '제목 없이' })).toMatch(/^Accepted\. The user chose a different conversation: "테스트 실패 고치기"/)
  })

  it('새 대화를 그대로 고르면(start_session + 새 대화) 기존 결과 글 그대로', async () => {
    const { call, say, calledBy } = await start()
    const sender = await say(A, '릴리스 준비')
    calledBy('start_session', sender, NEW)
    expect(await call('start_session', { title: 'README 정리', message: '지시' })).toMatch(/^Started "README 정리" \(c-[0-9a-f]{8}\)\. Use read_session/)
  })

  it('고른 대상에도 자격을 다시 본다 — 자기 자신·다른 프로젝트·지워진 대화·없는 id·모델 없음·대기열 상한. 거절되면 아무것도 안 가고 횟수도 안 센다', async () => {
    const { call, say, idle, calledBy, llm, chat, sessions } = await start()
    const other = path.join(root, 'other')
    await fs.mkdir(other)
    const OTHER = 'dddddddd-0000-4000-8000-000000000004'
    await sessions.save({ id: OTHER, project: other, title: '다른 프로젝트', updatedAt: Date.now(), model: MODEL })
    await idle(B, '테스트 실패 고치기')
    const busy = await say(C, '문서 정리')
    const sender = await say(A, '릴리스 준비')
    const args = { session: 'c-bbbbbbbb', message: '지시' }
    const turns = llm.turns.length
    const rejected = async (target: string, reason: RegExp | string) => {
      calledBy('send_to_session', sender, pick(target))
      await expect(call('send_to_session', args)).rejects.toThrow(reason)
    }
    await rejected(A, 'Cannot send to this conversation itself.')
    await rejected(OTHER, /The conversation the user chose is not available/)
    await rejected('no-such-conversation', /The conversation the user chose is not available/) // 화면이 조작된 값을 보냈다
    for (let n = 0; n < QUEUE_LIMIT; n++) await chat.send(C, { text: `사람 ${n}`, project, model: MODEL })
    await rejected(C, /^Target queue is full/)
    await sessions.patch(B, () => ({ model: { providerId: 'gone', modelId: 'm1' } }))
    await rejected(B, 'Target conversation has no usable model.')
    await sessions.remove(B)
    await rejected(B, /The conversation the user chose is not available/)
    // start_session 에서 기존 대화로 바꿨을 때도 같다
    calledBy('start_session', sender, pick(A))
    await expect(call('start_session', { title: '제목', message: '지시' })).rejects.toThrow('Cannot send to this conversation itself.')
    expect(llm.turns.length).toBe(turns)
    expect(await sessions.list()).toHaveLength(3) // A·C·다른 프로젝트 — 새 대화가 생기지 않았다
    expect(chat.queued(C)).toBe(QUEUE_LIMIT)
    expect(chat.countSend(A, 1)).toBe(true) // 하나도 안 셌다
    busy.finish()
  })

  it('고른 대상이 있어도 허용 기록·깊이 1·턴당 횟수는 그대로 본다', async () => {
    const { call, say, idle, calledBy, llm } = await start()
    await idle(B, '테스트 실패 고치기')
    await idle(C, '문서 정리')
    const sender = await say(A, '릴리스 준비')
    calledBy('send_to_session', sender, { approved: false, ...pick(C) })
    await expect(call('send_to_session', { session: 'c-bbbbbbbb', message: '지시' })).rejects.toThrow(/not approved by the user/)
    calledBy('send_to_session', sender, pick(B))
    await call('send_to_session', { session: 'c-bbbbbbbb', message: '지시' })
    await until(() => llm.turns.at(-1)!.prompt.includes('지시'))
    calledBy('send_to_session', llm.turns.at(-1)!, pick(C))
    await expect(call('send_to_session', { session: 'c-aaaaaaaa', message: '더' })).rejects.toThrow('cannot delegate further')
  })
})

describe('read_session', () => {
  it('쉬는 대화 — 상태와 마지막 요청·답. 다른 대화가 보낸 지시는 본문만 보인다. turns 로 여러 턴(최대 5)', async () => {
    const { call, say, idle, calledBy, llm, chat } = await start()
    await idle(B, '날짜 테스트가 왜 깨지나')
    const sender = await say(A, '릴리스 준비')
    calledBy('send_to_session', sender)
    await call('send_to_session', { session: 'c-bbbbbbbb', message: '전부 고쳐 줘' })
    await until(() => llm.turns.at(-1)!.prompt.includes('전부 고쳐 줘'))
    expect(await call('read_session', { session: 'c-bbbbbbbb' })).toBe('state: running — call again later')
    llm.answers.set(llm.turns.at(-1)!, '3개 고쳤습니다')
    llm.turns.at(-1)!.finish()
    await until(() => !chat.turnOf(B))
    expect(await call('read_session', { session: 'c-bbbbbbbb' })).toBe('state: idle\nuser: 전부 고쳐 줘\nanswer: 3개 고쳤습니다')
    expect(await call('read_session', { session: 'c-bbbbbbbb', turns: 99 })).toBe(
      'state: idle\nuser: 날짜 테스트가 왜 깨지나\nanswer: answer to 날짜 테스트가 왜 깨지나\n\nuser: 전부 고쳐 줘\nanswer: 3개 고쳤습니다',
    )
    await expect(call('read_session', { session: 'c-zzzzzzzz' })).rejects.toThrow('Unknown session.')
  })

  it('wait_seconds — 도는 턴이 끝나면 곧바로 답을 준다', async () => {
    const { call, say, llm } = await start()
    const turn = await say(B, '오래 걸리는 일')
    const reading = call('read_session', { session: 'c-bbbbbbbb', wait_seconds: 30 })
    setTimeout(() => {
      llm.answers.set(turn, '끝')
      turn.finish()
    }, 40)
    const started = Date.now()
    expect(await reading).toBe('state: idle\nuser: 오래 걸리는 일\nanswer: 끝')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('wait — 기한까지 안 끝나면 아직 도는 중이라고 한다. 턴 끝에 대기열의 다음 것이 바로 돌면 계속 기다린다', async () => {
    const { say, chat, llm } = await start()
    const turn = await say(B, '오래 걸리는 일')
    expect(await chat.waitIdle(B, 40)).toBe(false)
    await chat.send(B, { text: '다음 것', project, model: MODEL })
    const waiting = chat.waitIdle(B, 2_000)
    turn.finish()
    await until(() => llm.turns.length === 2)
    let settled = false
    void waiting.then(() => (settled = true))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(settled).toBe(false) // 다음 턴이 돌고 있다
    llm.turns[1]!.finish()
    expect(await waiting).toBe(true)
    expect(await chat.waitIdle(B, 10)).toBe(true) // 쉬는 대화는 바로
  })

  it('wait_seconds 는 45초로 깎인다 — MCP 호출 기한(60초) 안', async () => {
    const { call, say, chat } = await start()
    await say(B, '오래 걸리는 일')
    const waited: number[] = []
    const original = chat.waitIdle.bind(chat)
    chat.waitIdle = (cid, ms) => {
      waited.push(ms)
      return original(cid, 1)
    }
    await call('read_session', { session: 'c-bbbbbbbb', wait_seconds: 600 })
    await call('read_session', { session: 'c-bbbbbbbb', wait_seconds: -3 })
    await call('read_session', { session: 'c-bbbbbbbb', wait_seconds: 'soon' })
    expect(waited).toEqual([45_000])
  })

  it('사람의 답을 기다리는 대화는 그렇다고 알린다', async () => {
    const { call, say } = await start()
    const turn = await say(B, '승인이 필요한 일')
    turn.attention([{ kind: 'permission', id: 'per_1', sessionId: turn.sessionId, action: 'bash', resources: ['rm'] }])
    expect(await call('read_session', { session: 'c-bbbbbbbb' })).toMatch(/^state: waiting for the user/)
  })
})

describe('도구 등록', () => {
  it('넷이 설계 명세의 이름·필수 인자로 올라간다 — 설명은 영어', async () => {
    const { tools } = await start()
    expect([...tools.keys()].sort()).toEqual(['list_sessions', 'read_session', 'send_to_session', 'start_session'])
    expect(tools.get('send_to_session')!.inputSchema).toMatchObject({ required: ['session', 'message'], properties: { session: { type: 'string' }, message: { type: 'string' } } })
    expect(tools.get('start_session')!.inputSchema).toMatchObject({ required: ['title', 'message'] })
    expect(tools.get('read_session')!.inputSchema).toMatchObject({ required: ['session'], properties: { turns: { type: 'number' }, wait_seconds: { type: 'number' } } })
    expect(tools.get('list_sessions')!.inputSchema).toEqual({ type: 'object', properties: {} })
    for (const tool of tools.values()) expect(tool.description).toMatch(/^[\x20-\x7e—*]+$/)
    expect(tools.get('send_to_session')!.description).toMatch(/The user must approve each send/)
  })
})
