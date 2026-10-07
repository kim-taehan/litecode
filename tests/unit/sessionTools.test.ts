import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatService } from '../../src/services/chat.ts'
import { SessionsService } from '../../src/services/sessions.ts'
import { ProjectsService } from '../../src/services/projects.ts'
import { APP_MCP_NAME } from '../../src/services/mcp.ts'
import type { AppMcpTool } from '../../src/services/appMcp/rpc.ts'
import { agoText, clip, lastTurns, projectLine, SessionTools } from '../../src/services/appMcp/tools/sessions.ts'
import type { ChatOptions, ChatResult } from '../../src/services/llm.ts'
import type { ToolCaller } from '../../src/services/toolCalls.ts'
import { setMainLanguage, tr } from '../../src/i18n.ts'
import { attentionTarget, DELEGATION_SERVER, MAX_SENDS_PER_TURN, projectId, QUEUE_LIMIT, shortIds, widerMode, wrapInstruction } from '../../shared/delegation.ts'
import type { Attention, Conversation, History, HistoryMessage } from '../../shared/contract.ts'
import type { ChatEventMap, QueuedSend } from '../../shared/chat.ts'

// 세션 도구 셋 (이슈 #55·#137, 01z 3-3·3-4) — list_projects·read_project·send_to_project. 대상은 다른 프로젝트 각각에서 사용자가 마지막에 보던 대화 하나.
// ctx.projects 도 진짜다(임시 파일) — 프로젝트 셋: 보내는 shop-web, 받는 order-backend·design-tokens.
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
  /** 엔진에 넘길 수 없는 폴더 (realpath → 사유) — engineFolder 문 흉내 */
  blocked = new Map<string, string>()
  async folderProblem(directory: string): Promise<string | undefined> {
    return this.blocked.get(directory)
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
/** 보내는 프로젝트 */
let project: string
let backend: string
let tokens: string
const MODEL = { providerId: 'gw', modelId: 'm1' }
/** 보내는 대화 (shop-web) */
const A = 'aaaaaaaa-0000-4000-8000-000000000001'
/** order-backend 의 대화 둘 */
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const D = 'dddddddd-0000-4000-8000-000000000004'
/** design-tokens 의 대화 */
const C = 'cccccccc-0000-4000-8000-000000000003'

beforeEach(async () => {
  setMainLanguage('ko')
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-sessiontools-')))
  project = path.join(root, 'shop-web')
  backend = path.join(root, 'order-backend')
  tokens = path.join(root, 'design-tokens')
  for (const dir of [project, backend, tokens]) await fs.mkdir(dir)
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

type Extra = Pick<QueuedSend, 'mode' | 'model'> & { project?: string }

async function start() {
  const ctx = new Context()
  ctx.plugin(FakeLlm)
  ctx.plugin(FakeProviders)
  ctx.plugin(FakeAppMcp)
  ctx.plugin(SessionsService, { file: path.join(root, 'sessions.json') })
  ctx.plugin(ProjectsService, { file: path.join(root, 'projects.json') })
  ctx.plugin(ChatService)
  ctx.plugin(SessionTools)
  const ready = await new Promise<Context>((resolve) => ctx.inject(['chat', 'sessions', 'projects', 'llm', 'appMcp'], resolve))
  for (const dir of [tokens, backend, project]) await ready.projects.open(dir)
  const llm = ready.llm as unknown as FakeLlm
  const tools = (ready.appMcp as unknown as FakeAppMcp).tools
  await until(() => tools.size === 3)
  const started: ChatEventMap['turn.started'][] = []
  const queues: ChatEventMap['queue.changed'][] = []
  ctx.on('chat/turn-started', (data) => void started.push(data))
  ctx.on('chat/queue-changed', (data) => void queues.push(data))
  const call = (name: string, args: Record<string, unknown> = {}, directory = project) => tools.get(name)!.run(args, { directory })
  const stored = async (id: string) => (await ready.sessions.list()).find((entry) => entry.id === id)
  /** 사람이 그 대화에 보낸다 — 엔진에 닿은 그 턴을 준다. 다른 프로젝트의 대화면 extra.project */
  const say = async (cid: string, text: string, extra: Extra = {}): Promise<Turn> => {
    const before = llm.turns.length
    await ready.chat.send(cid, { text, project, model: MODEL, mode: 'build', ...extra })
    await until(() => llm.turns.length > before)
    return llm.turns.at(-1)!
  }
  /** 그 턴이 부른 것으로 — 앱에서 허용한 호출 */
  const calledBy = (tool: string, turn: Turn, caller: Partial<ToolCaller> = {}) =>
    llm.callers.set(tool, { sessionId: turn.sessionId, callId: `call_${Math.random()}`, child: false, approved: true, ...caller })
  /** 끝난 대화 하나 (쉬는 중) */
  const idle = async (cid: string, text: string, extra: Extra = {}): Promise<void> => {
    const turn = await say(cid, text, extra)
    llm.answers.set(turn, `answer to ${text}`)
    turn.finish()
    await until(() => !ready.chat.turnOf(cid))
  }
  /** 사용자가 그 대화를 열어 봤다 — 그 프로젝트의 받을 대화가 된다 */
  const view = (cid: string) => ready.sessions.noteViewed(cid)
  /** order-backend 에 쉬는 대화 B 를 두고(사용자가 보던 것) shop-web 의 A 가 보내려(읽으려) 한다 — A 의 도는 턴을 준다 */
  const scene = async (extra: Extra = {}): Promise<Turn> => {
    await idle(B, '주문 API 설계', { project: backend, ...extra })
    await view(B)
    const sender = await say(A, '주문 화면')
    calledBy('send_to_project', sender)
    calledBy('read_project', sender)
    return sender
  }
  return { ctx, chat: ready.chat, sessions: ready.sessions, projects: ready.projects, llm, tools, call, stored, say, calledBy, idle, view, scene, started, queues }
}

const WRAPPED = (message: string) => `<message-from-conversation project="shop-web" title="주문 화면">\n${message}\n</message-from-conversation>`

describe('순수 규칙', () => {
  it('서버 이름은 앱 MCP 서버의 것과 같다', () => {
    expect(DELEGATION_SERVER).toBe(APP_MCP_NAME)
  })

  it('대화의 짧은 id — 앞 8자, 겹치면 겹치지 않을 때까지 늘린다', () => {
    expect(shortIds([A, B]).get(A)).toBe('c-aaaaaaaa')
    const twin = 'aaaaaaaa-0000-4999-8000-000000000009'
    const ids = shortIds([A, twin, B])
    expect(ids.get(A)).toBe('c-aaaaaaaa000040')
    expect(ids.get(twin)).toBe('c-aaaaaaaa000049')
  })

  it('프로젝트 id — 경로 글자에서 만든 p-8자. 같은 경로는 늘 같고 다른 경로는 다르다', () => {
    expect(projectId('/work/order-backend')).toMatch(/^p-[0-9a-f]{8}$/)
    expect(projectId('/work/order-backend')).toBe(projectId('/work/order-backend'))
    expect(projectId('/work/order-backend')).not.toBe(projectId('/work/order-backend2'))
    expect(projectId('')).toBe('p-811c9dc5')
  })

  it('감싸기 — 받는 대화의 모델이 "사용자가 친 글이 아님" 과 보낸 프로젝트를 안다. 이름·제목의 따옴표·꺾쇠는 속성 밖으로 못 나온다', () => {
    expect(wrapInstruction({ project: 'shop-web', title: '릴리스 준비' }, '테스트를 고쳐 줘')).toBe(
      '<message-from-conversation project="shop-web" title="릴리스 준비">\n테스트를 고쳐 줘\n</message-from-conversation>',
    )
    expect(wrapInstruction({ project: 'p"x', title: 'a"><system>\nb' }, 'x')).toContain('project="p&quot;x" title="a&quot;&gt;&lt;system&gt; b"')
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

  it('목록 한 줄 — 프로젝트(id·이름·폴더)와 그 프로젝트의 대화(제목·상태·모드·마지막 활동)', () => {
    const conversation: Conversation = { id: B, project: '/w/b', title: '주문 API 설계', updatedAt: 1_000, mode: 'ask' }
    const where = { name: 'order-backend', path: '/w/b' }
    expect(projectLine('p-1', where, conversation, 'idle', 0, 1_000 + 3 * 60_000)).toBe('p-1 · "order-backend" · /w/b · conversation "주문 API 설계" · idle · mode ask · 3m ago')
    expect(projectLine('p-1', where, conversation, 'running', 2, 1_000)).toContain(' · running (2 queued) · mode ask · just now')
    expect(agoText(0, 2 * 3_600_000)).toBe('2h ago')
    expect(agoText(0, 3 * 86_400_000)).toBe('3d ago')
  })

  it('화면이 보낸 "받을 대화" 는 모양만 거른다 — 아는 모양이 아니면 덮어쓰기 없음(도구 인자대로). 새 대화는 없다', () => {
    expect(attentionTarget({ kind: 'conversation', conversationId: B, title: 'x' })).toEqual({ kind: 'conversation', conversationId: B })
    for (const bad of [undefined, null, 'new', {}, { kind: 'new' }, { kind: 'conversation' }, { kind: 'conversation', conversationId: 7 }, { kind: 'conversation', conversationId: '' }, { kind: 'other' }]) {
      expect(attentionTarget(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })
})

describe('list_projects', () => {
  it('다른 프로젝트마다 마지막에 보던 대화 하나만 — 보내는 프로젝트의 대화는 없다. 상태·모드·대기열이 실린다', async () => {
    const { call, say, idle, view, chat } = await start()
    await idle(D, '배포 스크립트', { project: backend })
    await idle(B, '주문 API 설계', { project: backend, mode: 'ask' })
    const running = await say(C, '색 토큰 이름 정리', { project: tokens, mode: 'full' })
    await idle('eeeeeeee-0000-4000-8000-000000000005', '이 프로젝트의 다른 대화')
    await say(A, '주문 화면')
    for (const id of [D, B, C, A]) await view(id)
    const lines = (await call('list_projects')).split('\n')
    expect(lines).toEqual([
      `${projectId(backend)} · "order-backend" · ${backend} · conversation "주문 API 설계" · idle · mode ask · just now`,
      `${projectId(tokens)} · "design-tokens" · ${tokens} · conversation "색 토큰 이름 정리" · running · mode full · just now`,
    ])
    // 승인·질문을 기다리는 대화, 대기열
    running.attention([{ kind: 'permission', id: 'per_1', sessionId: running.sessionId, action: 'bash', resources: ['ls'] }])
    await chat.send(C, { text: '하나 더', project: tokens, model: MODEL })
    expect(await call('list_projects')).toContain('conversation "색 토큰 이름 정리" · waiting for the user (1 queued)')
    // 사용자가 그 프로젝트에서 다른 대화를 보면 그 대화로 바뀐다
    await view(D)
    expect(await call('list_projects')).toContain('conversation "배포 스크립트"')
    // 호출이 온 프로젝트가 다르면 그 프로젝트가 빠진다
    const fromBackend = await call('list_projects', {}, backend)
    expect(fromBackend).toContain('"shop-web"')
    expect(fromBackend).not.toContain('"order-backend"')
  })

  it('본 대화가 없는 프로젝트·마지막에 보던 대화가 지워진 프로젝트·폴더가 없어진 프로젝트·목록에서 뺀 프로젝트·엔진에 넘길 수 없는 폴더는 없다', async () => {
    const { call, idle, view, sessions, projects, llm } = await start()
    await idle(B, '주문 API 설계', { project: backend })
    await idle(D, '배포 스크립트', { project: backend })
    await idle(C, '색 토큰 이름 정리', { project: tokens })
    const NONE = /^No other project can receive an instruction\./
    expect(await call('list_projects')).toMatch(NONE) // 저장된 대화가 있어도 본 적이 없다
    await view(B)
    await view(C)
    expect((await call('list_projects')).split('\n')).toHaveLength(2)
    // 지워지면 다른 대화(D)로 대신하지 않는다
    await sessions.remove(B)
    const afterRemove = await call('list_projects')
    expect(afterRemove).not.toContain('order-backend')
    expect(afterRemove).toContain('design-tokens')
    llm.blocked.set(tokens, '플러그인 파일이 있다')
    expect(await call('list_projects')).toMatch(NONE)
    llm.blocked.clear()
    await projects.remove(tokens)
    expect(await call('list_projects')).toMatch(NONE)
    await projects.open(tokens)
    await view(D)
    expect((await call('list_projects')).split('\n')).toHaveLength(2)
    await fs.rm(backend, { recursive: true })
    const afterGone = await call('list_projects')
    expect(afterGone).not.toContain('order-backend')
    expect(afterGone).toContain('design-tokens')
  })
})

describe('send_to_project', () => {
  it('승인 뒤 받는 프로젝트의 그 대화가 쉬면 그 자리에서 턴이 된다 — 그 대화의 폴더·모델·모드로. LLM 엔 감싼 글, 말풍선엔 본문과 출처', async () => {
    const { call, scene, llm, started, stored, sessions } = await start()
    await scene({ mode: 'ask', model: { providerId: 'gw', modelId: 'm2' } })
    const args = { project: projectId(backend), message: '주문 조회 응답을 표로 정리해 줘' }
    const before = llm.turns.length
    expect(await call('send_to_project', args)).toBe(`Accepted. "order-backend" (${projectId(backend)}) started working on it in its conversation "주문 API 설계" (c-bbbbbbbb).`)
    await until(() => llm.turns.length > before)
    const received = llm.turns.at(-1)!
    expect(received.prompt).toBe(WRAPPED('주문 조회 응답을 표로 정리해 줘'))
    // 받는 대화 자기 폴더·모델·모드 그대로 — 보낸 쪽(shop-web·m1·build)의 것이 아니다
    expect(received).toMatchObject({ directory: backend, sessionId: 'ses_1', modelId: 'm2', mode: 'ask' })
    expect(llm.asked.at(-1)).toMatchObject({ directory: project, server: 'litecode', tool: 'send_to_project', args })
    const event = started.at(-1)!
    expect(event).toMatchObject({ cid: B, origin: `session:${A}`, conversation: { project: backend } })
    expect(event.message).toMatchObject({ text: '주문 조회 응답을 표로 정리해 줘', origin: { conversationId: A, title: '주문 화면', project: 'shop-web' } })
    // 다시 열어도 본문만 + 출처 — 보낸 대화가 지워져도 적어 둔 제목·프로젝트로
    await sessions.remove(A)
    const reopened = (await sessions.history(B)).messages.at(-1)!
    expect(reopened).toMatchObject({ role: 'user', text: '주문 조회 응답을 표로 정리해 줘', origin: { conversationId: A, title: '주문 화면', project: 'shop-web' } })
    expect(await stored(B)).toMatchObject({ title: '주문 API 설계', project: backend, mode: 'ask' })
  })

  it('받는 대화가 돌고 있으면 대기열에 — 사람 글과 합치지 않고 차례로 한 턴씩. 대기열 줄에 보낸 대화가 실린다', async () => {
    const { call, say, view, calledBy, llm, chat, queues, started } = await start()
    const busy = await say(B, '주문 API 설계', { project: backend })
    await view(B)
    const sender = await say(A, '주문 화면')
    await chat.send(B, { text: '그리고 CHANGELOG 도', project: backend, model: MODEL })
    calledBy('send_to_project', sender)
    expect(await call('send_to_project', { project: projectId(backend), message: '커버리지도 알려 줘' })).toBe(
      `Accepted and queued — "order-backend" (${projectId(backend)}) is busy (2 ahead). It will run in its conversation "주문 API 설계" (c-bbbbbbbb).`,
    )
    expect(queues.at(-1)).toMatchObject({ cid: B, items: ['그리고 CHANGELOG 도', '커버리지도 알려 줘'], sources: [null, { conversationId: A, title: '주문 화면', project: 'shop-web' }] })
    busy.finish()
    await until(() => llm.turns.length === 3)
    expect(llm.turns[2]!.prompt).toBe('그리고 CHANGELOG 도') // 사람 글만
    expect(started.at(-1)).toMatchObject({ cid: B, origin: 'user' })
    llm.turns[2]!.finish()
    await until(() => llm.turns.length === 4)
    expect(llm.turns[3]).toMatchObject({ prompt: WRAPPED('커버리지도 알려 줘'), directory: backend })
    expect(started.at(-1)).toMatchObject({ cid: B, origin: `session:${A}` })
  })

  it('"빼기" — 대기열의 다른 대화 줄 하나만 뺀다. 사람이 친 줄은 못 뺀다(되돌리기)', async () => {
    const { call, say, view, calledBy, chat, queues } = await start()
    await say(B, '주문 API 설계', { project: backend })
    await view(B)
    const sender = await say(A, '주문 화면')
    await chat.send(B, { text: '사람 글', project: backend, model: MODEL })
    calledBy('send_to_project', sender)
    await call('send_to_project', { project: projectId(backend), message: '지시' })
    expect(chat.dropQueued(B, 0)).toBe(false)
    expect(chat.dropQueued(B, 1)).toBe(true)
    expect(queues.at(-1)).toMatchObject({ cid: B, items: ['사람 글'], sources: [null] })
    expect(chat.dropQueued(B, 5)).toBe(false)
  })

  it('앱에서 허용한 기록이 없는 호출·부른 대화를 못 찾은 호출·하위 작업의 호출은 거절 — 아무것도 보내지 않는다', async () => {
    const { call, scene, calledBy, llm } = await start()
    const sender = await scene()
    const args = { project: projectId(backend), message: '지시' }
    const turns = llm.turns.length
    llm.callers.delete('send_to_project')
    await expect(call('send_to_project', args)).rejects.toThrow(/Could not tell which conversation/)
    calledBy('send_to_project', sender, { approved: false })
    await expect(call('send_to_project', args)).rejects.toThrow(/not approved by the user in litecode\. Nothing was sent\./)
    calledBy('send_to_project', sender, { child: true })
    await expect(call('send_to_project', args)).rejects.toThrow(/Sub-tasks cannot reach other projects/)
    // 앱이 모르는 세션(폴더 코드가 엔진에 직접 만든 세션)
    calledBy('send_to_project', sender, { sessionId: 'ses_unknown' })
    await expect(call('send_to_project', args)).rejects.toThrow(/Could not tell which conversation/)
    expect(llm.turns.length).toBe(turns)
  })

  it('보내는 프로젝트 자신·모르는 프로젝트·본 대화가 없는 프로젝트는 거절. 글이 없거나 너무 길어도, 받는 대화를 쓸 수 없어도', async () => {
    const { call, scene, idle, view, sessions, llm, chat } = await start()
    await idle(C, '색 토큰 이름 정리', { project: tokens }) // 본 적 없는 프로젝트
    await scene()
    await view(A)
    const turns = llm.turns.length
    const UNKNOWN = 'Unknown project. Use an id from list_projects.'
    await expect(call('send_to_project', { project: projectId(project), message: 'x' })).rejects.toThrow(UNKNOWN)
    await expect(call('send_to_project', { project: projectId(tokens), message: 'x' })).rejects.toThrow(UNKNOWN)
    await expect(call('send_to_project', { project: 'order-backend', message: 'x' })).rejects.toThrow(UNKNOWN)
    await expect(call('send_to_project', { project: 'c-bbbbbbbb', message: 'x' })).rejects.toThrow(UNKNOWN)
    await expect(call('send_to_project', { message: 'x' })).rejects.toThrow(UNKNOWN)
    await expect(call('send_to_project', { project: projectId(backend), message: '  ' })).rejects.toThrow('message is required.')
    await expect(call('send_to_project', { project: projectId(backend), message: 'x'.repeat(20_001) })).rejects.toThrow(/too long/)
    // 엔진에 넘길 수 없는 폴더 (#101) — 읽을 수 있는 사유로
    llm.blocked.set(backend, '플러그인 파일이 있다')
    await expect(call('send_to_project', { project: projectId(backend), message: 'x' })).rejects.toThrow('Target project cannot be used (플러그인 파일이 있다).')
    llm.blocked.clear()
    // 모델이 설정에서 사라진 대화
    await sessions.patch(B, () => ({ model: { providerId: 'gone', modelId: 'm1' } }))
    await expect(call('send_to_project', { project: projectId(backend), message: 'x' })).rejects.toThrow('Target conversation has no usable model.')
    await sessions.remove(B)
    await expect(call('send_to_project', { project: projectId(backend), message: 'x' })).rejects.toThrow(UNKNOWN)
    expect(llm.turns.length).toBe(turns)
    expect(chat.countSend(A, 1)).toBe(true) // 하나도 안 셌다
  })

  it('깊이 1 — 지시를 받아 도는 턴은 다시 지시하지 못한다. 그 대화에 사람이 직접 친 턴은 보낼 수 있다', async () => {
    const { call, scene, idle, view, say, calledBy, llm, chat } = await start()
    await idle(C, '색 토큰 이름 정리', { project: tokens })
    await view(C)
    await scene()
    await view(A)
    await call('send_to_project', { project: projectId(backend), message: '지시' })
    await until(() => llm.turns.at(-1)!.prompt.includes('지시'))
    const delegated = llm.turns.at(-1)!
    // order-backend 의 그 턴이 design-tokens 나 shop-web 으로 다시 보내려 한다
    calledBy('send_to_project', delegated)
    await expect(call('send_to_project', { project: projectId(tokens), message: '더' }, backend)).rejects.toThrow('This turn was started by another conversation and cannot delegate further.')
    await expect(call('send_to_project', { project: projectId(project), message: '더' }, backend)).rejects.toThrow('cannot delegate further')
    // 그 턴이 끝난 뒤 사람이 그 대화에 직접 친 턴은 새 지시를 보낼 수 있다 (순환이 아니다 — 승인 카드를 다시 거친다)
    delegated.finish()
    await until(() => !chat.turnOf(B))
    const direct = await say(B, '사람이 직접', { project: backend })
    calledBy('send_to_project', direct)
    expect(await call('send_to_project', { project: projectId(tokens), message: '사람이 시킨 것' }, backend)).toMatch(/^Accepted\. "design-tokens"/)
  })

  it(`한 턴에 보내기 ${MAX_SENDS_PER_TURN}번 — 다음 턴엔 다시 보낼 수 있다`, async () => {
    const { call, scene, say, calledBy, chat } = await start()
    const sender = await scene()
    const args = { project: projectId(backend), message: 'x' }
    for (let n = 0; n < MAX_SENDS_PER_TURN; n++) await call('send_to_project', args)
    await expect(call('send_to_project', args)).rejects.toThrow(`Too many instructions sent in this turn (the limit is ${MAX_SENDS_PER_TURN}).`)
    sender.finish()
    await until(() => !chat.turnOf(A))
    chat.dropQueued(B, 0) // 다음 보내기가 대기열 상한에 걸리지 않게
    const next = await say(A, '다음 턴')
    calledBy('send_to_project', next)
    expect(await call('send_to_project', args)).toMatch(/^Accepted/)
  })

  it(`받는 대화의 대기열 상한 ${QUEUE_LIMIT} — 넘으면 거절하고 횟수도 세지 않는다`, async () => {
    const { call, say, view, calledBy, chat } = await start()
    await say(B, '주문 API 설계', { project: backend })
    await view(B)
    const sender = await say(A, '주문 화면')
    for (let n = 0; n < QUEUE_LIMIT; n++) await chat.send(B, { text: `사람 ${n}`, project: backend, model: MODEL })
    calledBy('send_to_project', sender)
    await expect(call('send_to_project', { project: projectId(backend), message: 'x' })).rejects.toThrow(/^Target queue is full/)
    expect(chat.queued(B)).toBe(QUEUE_LIMIT)
    expect(chat.countSend(A, 1)).toBe(true) // 아직 하나도 안 셌다
  })

  it('보낸 대화를 멈춰도 받는 대화는 계속 돈다. 받는 대화가 지워지면 대기열의 지시도 사라진다', async () => {
    const { call, say, view, calledBy, chat, sessions, llm } = await start()
    const busy = await say(B, '주문 API 설계', { project: backend })
    await view(B)
    const sender = await say(A, '주문 화면')
    calledBy('send_to_project', sender)
    await call('send_to_project', { project: projectId(backend), message: '지시' })
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

  it('받는 대화의 턴을 사람이 멈추면: 사람 글은 붙잡혀 입력창으로 돌아가고, 다른 프로젝트의 지시는 그 뒤에 차례대로 간다', async () => {
    const { call, say, view, calledBy, chat, llm } = await start()
    await say(B, '주문 API 설계', { project: backend })
    await view(B)
    const sender = await say(A, '주문 화면')
    await chat.send(B, { text: '사람 글', project: backend, model: MODEL })
    calledBy('send_to_project', sender)
    await call('send_to_project', { project: projectId(backend), message: '지시' })
    chat.stop(B)
    await until(() => !chat.turnOf(B))
    expect(chat.queued(B)).toBe(2) // 붙잡혔다
    expect(chat.takeQueue(B)).toMatchObject({ text: '사람 글' })
    await until(() => llm.turns.at(-1)!.prompt.includes('지시'))
    expect(chat.turnOf(B)).toMatchObject({ origin: `session:${A}` })
  })

  it('사람 글 없이 다른 프로젝트의 지시만 쌓였으면 멈춰도 붙잡지 않는다 — 멈춘 턴 뒤에 간다', async () => {
    const { call, say, view, calledBy, chat, llm, queues } = await start()
    await say(B, '주문 API 설계', { project: backend })
    await view(B)
    const sender = await say(A, '주문 화면')
    calledBy('send_to_project', sender)
    await call('send_to_project', { project: projectId(backend), message: '지시' })
    chat.stop(B)
    expect(queues.at(-1)!.held).toBe(false)
    await until(() => llm.turns.at(-1)!.prompt.includes('지시'))
  })
})

// 이슈 #67 — 받을 곳은 사용자가 고른다: 승인 카드에서 고른 프로젝트의 대화가 허용 기록(caller.target)에 실려 온다. 도구는 인자 대신 그것으로 보내고
// 자격을 다시 본다. 결과 글이 실제 대상을 말한다
describe('받을 프로젝트 고르기 (이슈 #67·#137)', () => {
  const pick = (conversationId: string) => ({ target: { kind: 'conversation' as const, conversationId } })

  it('AI 가 고른 프로젝트를 그대로 고르면 기존 결과 글 그대로다 (바뀐 것이 아니다)', async () => {
    const { call, scene, calledBy } = await start()
    const sender = await scene()
    calledBy('send_to_project', sender, pick(B))
    expect(await call('send_to_project', { project: projectId(backend), message: '지시' })).toMatch(/^Accepted\. "order-backend" \(p-[0-9a-f]{8}\) started working on it/)
  })

  it('사용자가 카드에서 다른 프로젝트로 바꾸면 그리로 가고, AI 가 고른 곳에는 아무것도 안 간다. 결과 글이 실제 대상과 그 id 를 말한다', async () => {
    const { call, scene, idle, view, calledBy, llm, chat, started, sessions } = await start()
    await idle(C, '색 토큰 이름 정리', { project: tokens, mode: 'full' })
    await view(C)
    const sender = await scene()
    calledBy('send_to_project', sender, pick(C))
    const before = llm.turns.length
    expect(await call('send_to_project', { project: projectId(backend), message: '토큰 이름을 알려 줘' })).toBe(
      `Accepted. The user chose a different project: "design-tokens" (id ${projectId(tokens)}). It runs in its conversation "색 토큰 이름 정리" (c-cccccccc). Use this project id with read_project.`,
    )
    await until(() => llm.turns.length > before)
    expect(llm.turns.at(-1)).toMatchObject({ directory: tokens, sessionId: 'ses_1', mode: 'full', prompt: WRAPPED('토큰 이름을 알려 줘') }) // 그 대화 자기 폴더·모드
    expect(started.at(-1)).toMatchObject({ cid: C, origin: `session:${A}`, message: { origin: { conversationId: A, title: '주문 화면', project: 'shop-web' } } })
    expect(chat.turnOf(B)).toBeUndefined()
    expect(chat.queued(B)).toBe(0)
    expect((await sessions.history(C)).messages.at(-1)).toMatchObject({ text: '토큰 이름을 알려 줘', origin: { conversationId: A } })
  })

  it('고른 프로젝트의 대화가 돌고 있으면 대기열에 — 결과 글이 그렇다고 말한다. AI 가 준 id 가 틀렸어도 사용자가 고른 프로젝트로 간다', async () => {
    const { call, say, view, calledBy, chat } = await start()
    await say(C, '색 토큰 이름 정리', { project: tokens })
    await view(C)
    const sender = await say(A, '주문 화면')
    calledBy('send_to_project', sender, pick(C))
    expect(await call('send_to_project', { project: 'p-zzzzzzzz', message: '지시' })).toBe(
      `Accepted. The user chose a different project: "design-tokens" (id ${projectId(tokens)}). It is busy, so the instruction is queued (1 ahead). It runs in its conversation "색 토큰 이름 정리" (c-cccccccc). Use this project id with read_project.`,
    )
    expect(chat.queued(C)).toBe(1)
  })

  it('고른 대상에도 자격을 다시 본다 — 이 프로젝트의 대화·마지막에 보던 것이 아닌 대화·지워진 대화·없는 id·모델 없음·대기열 상한. 거절되면 아무것도 안 가고 횟수도 안 센다', async () => {
    const { call, scene, idle, say, view, calledBy, llm, chat, sessions } = await start()
    await idle(D, '배포 스크립트', { project: backend })
    const busy = await say(C, '색 토큰 이름 정리', { project: tokens })
    await view(C)
    const sender = await scene()
    await view(A)
    const args = { project: projectId(backend), message: '지시' }
    const turns = llm.turns.length
    const GONE = /The project the user chose is not available/
    const rejected = async (target: string, reason: RegExp | string) => {
      calledBy('send_to_project', sender, pick(target))
      await expect(call('send_to_project', args)).rejects.toThrow(reason)
    }
    await rejected(A, GONE) // 보내는 프로젝트 자신
    await rejected(D, GONE) // 그 프로젝트의 대화지만 마지막에 보던 것이 아니다
    await rejected('no-such-conversation', GONE) // 화면이 조작된 값을 보냈다
    for (let n = 0; n < QUEUE_LIMIT; n++) await chat.send(C, { text: `사람 ${n}`, project: tokens, model: MODEL })
    await rejected(C, /^Target queue is full/)
    await sessions.patch(B, () => ({ model: { providerId: 'gone', modelId: 'm1' } }))
    await rejected(B, 'Target conversation has no usable model.')
    await sessions.remove(B)
    await rejected(B, GONE)
    expect(llm.turns.length).toBe(turns)
    expect(await sessions.list()).toHaveLength(3) // A·C·D — 새 대화가 생기지 않았다
    expect(chat.queued(C)).toBe(QUEUE_LIMIT)
    expect(chat.countSend(A, 1)).toBe(true) // 하나도 안 셌다
    busy.finish()
  })

  it('고른 대상이 있어도 허용 기록·깊이 1 은 그대로 본다', async () => {
    const { call, scene, idle, view, calledBy, llm } = await start()
    await idle(C, '색 토큰 이름 정리', { project: tokens })
    await view(C)
    const sender = await scene()
    calledBy('send_to_project', sender, { approved: false, ...pick(C) })
    await expect(call('send_to_project', { project: projectId(backend), message: '지시' })).rejects.toThrow(/not approved by the user/)
    calledBy('send_to_project', sender, pick(B))
    await call('send_to_project', { project: projectId(backend), message: '지시' })
    await until(() => llm.turns.at(-1)!.prompt.includes('지시'))
    calledBy('send_to_project', llm.turns.at(-1)!, pick(C))
    await expect(call('send_to_project', { project: projectId(tokens), message: '더' }, backend)).rejects.toThrow('cannot delegate further')
  })
})

describe('read_project', () => {
  it('쉬는 대화 — 어느 대화인지, 상태와 마지막 요청·답. 다른 프로젝트가 보낸 지시는 본문만 보인다. turns 로 여러 턴(최대 5)', async () => {
    const { call, scene, llm, chat } = await start()
    await scene()
    const id = projectId(backend)
    await call('send_to_project', { project: id, message: '전부 고쳐 줘' })
    await until(() => llm.turns.at(-1)!.prompt.includes('전부 고쳐 줘'))
    const HEAD = 'conversation: "주문 API 설계" (c-bbbbbbbb)'
    expect(await call('read_project', { project: id })).toBe(`${HEAD}\nstate: running — call again later`)
    llm.answers.set(llm.turns.at(-1)!, '3개 고쳤습니다')
    llm.turns.at(-1)!.finish()
    await until(() => !chat.turnOf(B))
    expect(await call('read_project', { project: id })).toBe(`${HEAD}\nstate: idle\nuser: 전부 고쳐 줘\nanswer: 3개 고쳤습니다`)
    expect(await call('read_project', { project: id, turns: 99 })).toBe(`${HEAD}\nstate: idle\nuser: 주문 API 설계\nanswer: answer to 주문 API 설계\n\nuser: 전부 고쳐 줘\nanswer: 3개 고쳤습니다`)
    expect(llm.asked.at(-1)).toMatchObject({ directory: project, server: 'litecode', tool: 'read_project' })
  })

  it('읽기도 앱에서 허용한 호출만 — 허용 기록이 없거나 하위 작업이 불렀으면 아무것도 읽지 않는다', async () => {
    const { call, scene, calledBy, llm } = await start()
    const sender = await scene()
    const args = { project: projectId(backend) }
    calledBy('read_project', sender, { approved: false })
    await expect(call('read_project', args)).rejects.toThrow(/not approved by the user in litecode\. Nothing was read\./)
    calledBy('read_project', sender, { child: true })
    await expect(call('read_project', args)).rejects.toThrow(/Sub-tasks cannot reach other projects/)
    llm.callers.delete('read_project')
    await expect(call('read_project', args)).rejects.toThrow(/Could not tell which conversation/)
  })

  it('이 프로젝트 자신·모르는 프로젝트·엔진에 넘길 수 없는 폴더는 못 읽는다', async () => {
    const { call, scene, view, llm } = await start()
    await scene()
    await view(A)
    await expect(call('read_project', { project: projectId(project) })).rejects.toThrow('Unknown project.')
    await expect(call('read_project', { project: 'c-bbbbbbbb' })).rejects.toThrow('Unknown project.')
    llm.blocked.set(backend, '플러그인 파일이 있다')
    await expect(call('read_project', { project: projectId(backend) })).rejects.toThrow('Target project cannot be used (플러그인 파일이 있다).')
  })

  it('wait_seconds — 도는 턴이 끝나면 곧바로 답을 준다', async () => {
    const { call, say, view, calledBy, llm } = await start()
    const turn = await say(B, '오래 걸리는 일', { project: backend })
    await view(B)
    calledBy('read_project', await say(A, '주문 화면'))
    const reading = call('read_project', { project: projectId(backend), wait_seconds: 30 })
    setTimeout(() => {
      llm.answers.set(turn, '끝')
      turn.finish()
    }, 40)
    const started = Date.now()
    expect(await reading).toBe('conversation: "오래 걸리는 일" (c-bbbbbbbb)\nstate: idle\nuser: 오래 걸리는 일\nanswer: 끝')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('wait — 기한까지 안 끝나면 아직 도는 중이라고 한다. 턴 끝에 대기열의 다음 것이 바로 돌면 계속 기다린다', async () => {
    const { say, chat, llm } = await start()
    const turn = await say(B, '오래 걸리는 일', { project: backend })
    expect(await chat.waitIdle(B, 40)).toBe(false)
    await chat.send(B, { text: '다음 것', project: backend, model: MODEL })
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
    const { call, say, view, calledBy, chat } = await start()
    await say(B, '오래 걸리는 일', { project: backend })
    await view(B)
    calledBy('read_project', await say(A, '주문 화면'))
    const waited: number[] = []
    const original = chat.waitIdle.bind(chat)
    chat.waitIdle = (cid, ms) => {
      waited.push(ms)
      return original(cid, 1)
    }
    const id = projectId(backend)
    await call('read_project', { project: id, wait_seconds: 600 })
    await call('read_project', { project: id, wait_seconds: -3 })
    await call('read_project', { project: id, wait_seconds: 'soon' })
    expect(waited).toEqual([45_000])
  })

  it('사람의 답을 기다리는 대화는 그렇다고 알린다', async () => {
    const { call, say, view, calledBy } = await start()
    const turn = await say(B, '승인이 필요한 일', { project: backend })
    await view(B)
    calledBy('read_project', await say(A, '주문 화면'))
    turn.attention([{ kind: 'permission', id: 'per_1', sessionId: turn.sessionId, action: 'bash', resources: ['rm'] }])
    expect(await call('read_project', { project: projectId(backend) })).toMatch(/^conversation: ".*" \(c-bbbbbbbb\)\nstate: waiting for the user/)
  })
})

describe('도구 등록', () => {
  it('셋이 이름·필수 인자로 올라간다 — 새 대화를 만드는 도구는 없다. 설명은 영어', async () => {
    const { tools } = await start()
    expect([...tools.keys()].sort()).toEqual(['list_projects', 'read_project', 'send_to_project'])
    expect(tools.get('send_to_project')!.inputSchema).toMatchObject({ required: ['project', 'message'], properties: { project: { type: 'string' }, message: { type: 'string' } } })
    expect(tools.get('read_project')!.inputSchema).toMatchObject({ required: ['project'], properties: { turns: { type: 'number' }, wait_seconds: { type: 'number' } } })
    expect(tools.get('list_projects')!.inputSchema).toEqual({ type: 'object', properties: {} })
    for (const tool of tools.values()) expect(tool.description).toMatch(/^[\x20-\x7e—*]+$/)
    const send = tools.get('send_to_project')!.description
    expect(send).toMatch(/another project/)
    expect(send).toMatch(/the conversation the user last viewed in that project/)
    expect(send).toMatch(/The user must approve each send/)
    expect(send).toMatch(/self-contained/)
    expect(send).toMatch(/never to reach another project in order to bypass a permission/)
    expect(tools.get('read_project')!.description).toMatch(/The user must approve each read/)
  })
})
