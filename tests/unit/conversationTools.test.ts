import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatService } from '../../src/services/chat.ts'
import { DelegationService } from '../../src/services/delegation.ts'
import { SessionsService } from '../../src/services/sessions.ts'
import { ProjectsService } from '../../src/services/projects.ts'
import type { AppMcpTool } from '../../src/services/appMcp/rpc.ts'
import { ConversationTools } from '../../src/services/appMcp/tools/conversation.ts'
import type { ChatOptions, ChatResult } from '../../src/services/llm.ts'
import type { ToolCaller } from '../../src/services/toolCalls.ts'
import { setMainLanguage, tr } from '../../src/i18n.ts'
import { MESSAGE_MAX, MAX_SENDS_PER_TURN, NEW_CONVERSATION_TOOL } from '../../shared/delegation.ts'
import { TITLE_MAX } from '../../shared/chat.ts'
import type { Attention, Conversation } from '../../shared/contract.ts'
import type { ChatEventMap, QueuedSend } from '../../shared/chat.ts'

// new_conversation (이슈 #415) — 질문이 바뀌면 **이 프로젝트의 새 대화**로 이어 가는 도구. 제목은 모델이 직접 준다(보내고 나서
// 이름 바꾸기로 세운다 — 자동 제목·통째 저장이 덮지 못한다), 모델·모드는 부른 대화가 쓰는 것(쓸 수 없으면 그 프로젝트에서 최신 것).
// 자격은 보내기 도구와 같은 겹: 본 세션의 턴·앱의 승인 카드 허용·지시를 받아 도는 턴 불가·하위 작업 불가·한 턴 수.
// ctx.chat·ctx.sessions·ctx.projects·ctx.delegation 은 진짜(임시 파일), ctx.llm 은 가짜다: 턴을 쥐고 있다가 시험이 끝내고,
// callerOf 는 시험이 정한 "부른 대화" 를 준다. ctx.appMcp 는 등록된 도구를 모으기만 한다

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
  reserve(): undefined {
    return undefined
  }
  async chat({ providerId, modelId, directory, prompt, sessionId, onSession, messageId, mode, onAttention, stop }: ChatOptions): Promise<ChatResult> {
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
/** 부르는 대화의 프로젝트 (shop-web) */
let project: string
const MODEL = { providerId: 'gw', modelId: 'm1' }
/** 부르는 대화 (shop-web) */
const A = 'aaaaaaaa-0000-4000-8000-000000000001'
/** 같은 프로젝트의 옛 대화 (모델·모드 되받기) */
const E = 'eeeeeeee-0000-4000-8000-000000000005'

beforeEach(async () => {
  setMainLanguage('ko')
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-conversationtools-')))
  project = path.join(root, 'shop-web')
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

type Extra = Pick<QueuedSend, 'mode' | 'model' | 'origin'> & { project?: string }

async function start() {
  const ctx = new Context()
  ctx.plugin(FakeLlm)
  ctx.plugin(FakeProviders)
  ctx.plugin(FakeAppMcp)
  ctx.plugin(SessionsService, { file: path.join(root, 'sessions.json') })
  ctx.plugin(ProjectsService, { file: path.join(root, 'projects.json') })
  ctx.plugin(ChatService)
  ctx.plugin(DelegationService)
  ctx.plugin(ConversationTools)
  const ready = await new Promise<Context>((resolve) => ctx.inject(['chat', 'sessions', 'projects', 'llm', 'appMcp', 'delegation'], resolve))
  await ready.projects.open(project)
  const llm = ready.llm as unknown as FakeLlm
  const tools = (ready.appMcp as unknown as FakeAppMcp).tools
  await until(() => tools.size === 1)
  const started: ChatEventMap['turn.started'][] = []
  ctx.on('chat/turn-started', (data) => void started.push(data))
  const call = (args: Record<string, unknown> = {}, directory = project) => tools.get(NEW_CONVERSATION_TOOL)!.run(args, { directory })
  const stored = async (id: string) => (await ready.sessions.list()).find((entry) => entry.id === id)
  /** 사람이 그 대화에 보낸다 — 엔진에 닿은 그 턴을 준다 (모델·모드·출처를 주면 extra) */
  const say = async (cid: string, text: string, extra: Extra = {}): Promise<Turn> => {
    const before = llm.turns.length
    await ready.chat.send(cid, { text, project, model: MODEL, mode: 'build', ...extra })
    await until(() => llm.turns.length > before)
    return llm.turns.at(-1)!
  }
  /** 그 턴이 이 도구를 부른 것으로 — approved 는 앱의 승인 카드에서 허용한 것 */
  const calledBy = (turn: Turn, caller: Partial<ToolCaller> = {}) =>
    llm.callers.set(NEW_CONVERSATION_TOOL, { sessionId: turn.sessionId, callId: `call_${Math.random()}`, child: false, approved: true, ...caller })
  const finishTurn = async (cid: string, turn: Turn): Promise<void> => {
    turn.finish()
    await until(() => !ready.chat.turnOf(cid))
  }
  return { ctx, chat: ready.chat, sessions: ready.sessions, llm, call, stored, say, calledBy, finishTurn, started }
}

/** 부르는 대화 A (제목 '주문 화면', 모델 m1, 모드 build) 의 도는 턴을 두고, 그것을 (caller 로 수정해서) 이 도구가 부른 것으로 둔다 */
async function stage(caller: Partial<ToolCaller> = {}) {
  const base = await start()
  const turn = await base.say(A, '주문 화면')
  base.calledBy(turn, caller)
  return { ...base, turn }
}

/** 결과 글의 짧은 id(c-…)로 만든 대화를 찾는다 */
async function createdOf(result: string, sessions: SessionsService): Promise<Conversation | undefined> {
  const match = /\(c-([0-9a-f]+)\)/.exec(result)
  if (!match) throw new Error(`no short id in: ${result}`)
  const all = await sessions.list()
  return all.find((entry) => entry.id.replaceAll('-', '').startsWith(match[1]!))
}

describe('new_conversation', () => {
  it('도구가 하나만 등록되고 인자는 title·message', async () => {
    const { ctx } = await start()
    const tools = (ctx.appMcp as unknown as FakeAppMcp).tools
    expect([...tools.keys()]).toEqual([NEW_CONVERSATION_TOOL])
    const tool = tools.get(NEW_CONVERSATION_TOOL)!
    expect(tool.inputSchema).toEqual({
      type: 'object',
      properties: {
        title: { type: 'string', description: `The new conversation's title, given by you. At most ${TITLE_MAX} characters.` },
        message: { type: 'string', description: `The first message of the new conversation. Self-contained, at most ${MESSAGE_MAX} characters.` },
      },
      required: ['title', 'message'],
    })
  })

  it('새 대화를 이 프로젝트에 만든다 — 제목은 모델이 준 것 그대로(renamed), 모델·모드는 부른 대화가 쓰는 것, 첫 메시지는 감싸고 출처를 남긴다', async () => {
    const { call, sessions, stored, started, llm } = await stage()
    const beforeEngine = llm.turns.length
    const result = await call({ title: 'API 문서', message: 'API 문서를 써 줘' })
    await until(() => llm.turns.length > beforeEngine) // 새 대화의 턴이 엔진(가짜)에 닿을 때까지
    expect(result).toMatch(/^Started a new conversation "API 문서" \(c-[0-9a-f]+\)/)
    const createdEvents = started.filter((entry) => entry.cid !== A)
    expect(createdEvents).toHaveLength(1)
    const conversation = await stored(createdEvents[0]!.cid)
    expect(conversation).toMatchObject({ project, title: 'API 문서', model: MODEL, mode: 'build' })
    expect(conversation?.renamed).toBe(true) // 자동 제목·통째 저장이 제목을 덮지 못한다
    const toEngine = llm.turns.at(-1)!
    expect(toEngine.prompt).toBe('<message-from-conversation project="shop-web" title="주문 화면">\nAPI 문서를 써 줘\n</message-from-conversation>')
    expect(toEngine.directory).toBe(project)
    expect(toEngine.modelId).toBe('m1')
    expect(toEngine.mode).toBe('build')
    // 새 대화의 내 말에 출처가 남는다 (다른 대화에서 온 지시)
    expect(createdEvents[0]!.message.origin).toEqual({ conversationId: A, title: '주문 화면', project: 'shop-web' })
    // 결과 글의 짧은 id 가 실제 대화와 맞는다
    expect(result).toContain(`(c-${createdEvents[0]!.cid.replaceAll('-', '').slice(0, 8)})`)
    expect(await createdOf(result, sessions)).toMatchObject({ id: createdEvents[0]!.cid })
  })

  it('부른 대화가 안 가려지면 안 만든다', async () => {
    const { call, say } = await start()
    await say(A, '주문 화면')
    await expect(call({ title: 'x', message: 'y' })).rejects.toThrow('Could not tell which conversation made this call.')
  })

  it('앱의 승인 카드에서 허용한 호출만 받는다', async () => {
    const { call } = await stage({ approved: false })
    await expect(call({ title: 'x', message: 'y' })).rejects.toThrow('not approved by the user')
  })

  it('하위 작업(자식)은 안 만든다', async () => {
    const { call } = await stage({ child: true })
    await expect(call({ title: 'x', message: 'y' })).rejects.toThrow('sub-task')
  })

  it('다른 대화의 지시로 도는 턴은 다시 안 만든다 (깊이 1)', async () => {
    const { call, ctx, say, calledBy } = await start()
    const turn = await say(A, '주문 화면', { origin: `session:${E}` })
    calledBy(turn)
    await expect(call({ title: 'x', message: 'y' })).rejects.toThrow('cannot start a further one')
    expect((await ctx.sessions.list())).toHaveLength(1)
  })

  it('인자 — title·message 없이는 안 되고, message 가 길면 안 된다. title 은 80자까지', async () => {
    const { call, sessions } = await stage()
    await expect(call({ title: '  ', message: 'y' })).rejects.toThrow('title is required.')
    await expect(call({ title: 'x', message: '' })).rejects.toThrow('message is required.')
    await expect(call({ title: 'x', message: 'x'.repeat(MESSAGE_MAX + 1) })).rejects.toThrow('message is too long')
    const result = await call({ title: '가'.repeat(TITLE_MAX + 20), message: 'y' })
    expect((await createdOf(result, sessions))?.title).toBe('가'.repeat(TITLE_MAX))
  })

  it('부른 대화의 모델이 사라졌으면 그 프로젝트에서 최신의 쓸 수 있는 대화 모델·모드를 쓴다', async () => {
    const { call, sessions, say, calledBy, finishTurn } = await start()
    const eTurn = await say(E, '구글 로그인', { model: { providerId: 'gw', modelId: 'm1' }, mode: 'ask' })
    await finishTurn(E, eTurn)
    const turn = await say(A, '주문 화면', { model: { providerId: 'gw', modelId: 'gone' } })
    calledBy(turn)
    const result = await call({ title: '로그인 고치기', message: '로그인 화면을 고쳐 줘' })
    expect(result).toContain('new conversation "로그인 고치기"')
    expect(await createdOf(result, sessions)).toMatchObject({ model: { providerId: 'gw', modelId: 'm1' }, mode: 'ask' })
  })

  it('쓸 수 있는 모델을 가진 대화가 없으면 안 만든다', async () => {
    const { call, ctx, say, calledBy } = await start()
    const turn = await say(A, '주문 화면', { model: { providerId: 'gw', modelId: 'gone' } })
    calledBy(turn)
    await expect(call({ title: 'x', message: 'y' })).rejects.toThrow('no conversation in this project with a usable model')
    expect((await ctx.sessions.list())).toHaveLength(1)
  })

  it('한 턴에 만들 수 있는 새 대화 수는 보내기와 함께 5', async () => {
    const { call, sessions } = await stage()
    for (let i = 1; i <= MAX_SENDS_PER_TURN; i++) await expect(call({ title: `새 대화 ${i}`, message: `질문 ${i}` })).resolves.toContain('new conversation')
    await expect(call({ title: `새 대화 ${MAX_SENDS_PER_TURN + 1}`, message: '더' })).rejects.toThrow(`the limit is ${MAX_SENDS_PER_TURN}`)
    expect((await sessions.list())).toHaveLength(MAX_SENDS_PER_TURN + 1)
  })
})

describe('new_conversation — 도구가 등록되지 않은 곳에서는', () => {
  it('도구의 설명이 목적(질문 바뀌면 새 대화)·시점(그 턴 첫 행동·먼저 질문 금지)·message 규격(진행·결정·파일·브랜치)을 말한다', async () => {
    const { ctx } = await start()
    const tool = (ctx.appMcp as unknown as FakeAppMcp).tools.get(NEW_CONVERSATION_TOOL)!
    expect(tool.description).toMatch(/new conversation in this project/)
    expect(tool.description).toMatch(/as the very first action of that turn/)
    expect(tool.description).toMatch(/do not call any other tool before this one/)
    expect(tool.description).toMatch(/not even a clarifying question/)
    expect(tool.description).toMatch(/should we start a new conversation\?/)
    expect(tool.description).toMatch(/if the user rejects it, continue the new topic here/)
    expect(tool.description).toMatch(/approval card/)
    expect(tool.description).toMatch(/self-contained/)
    expect(tool.description).toMatch(/the progress so far, the decisions taken/)
    expect(tool.description).toMatch(/the files involved and the current branch/)
  })
})
