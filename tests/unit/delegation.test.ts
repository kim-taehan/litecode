import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatOptions, ChatResult } from '../../src/services/llm.ts'
import { ChatService } from '../../src/services/chat.ts'
import { DelegationService } from '../../src/services/delegation.ts'
import { SessionsService } from '../../src/services/sessions.ts'
import { ProjectsService } from '../../src/services/projects.ts'
import { MAX_SENDS_PER_TURN, MESSAGE_MAX, QUEUE_LIMIT, projectId, wrapInstruction } from '../../shared/delegation.ts'
import type { QueuedSend } from '../../shared/chat.ts'

// 프로젝트 간 지시의 단일 결정지 (src/services/delegation.ts, #55·#341) — "받을 대화" 골라내기(targets)와 보내기 전 자격(send).
// 세션 도구(send_to_project)와 화면(Projects 탭)이 공유한다. ctx.chat·ctx.sessions·ctx.projects 는 진짜(임시 파일), llm·providers 는 가짜
// (llm 은 folderProblem 만 사용)

interface Turn {
  directory: string
  prompt: string
  providerId: string
  modelId: string
  mode?: string
  messageId?: string
  sessionId: string
  finish(result?: Partial<ChatResult>): void
}

class FakeLlm extends Service {
  turns: Turn[] = []
  blocked = new Map<string, string>()
  private ids = 0
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
  newMessageId(): string {
    return `msg_${++this.ids}`
  }
  /** 끼워 넣기 자리 — 이 가짜는 주지 않는다 (돌고 있는 턴에 보낸 글은 대기열로 간다) */
  reserve(): undefined {
    return undefined
  }
  async folderProblem(directory: string): Promise<string | undefined> {
    return this.blocked.get(directory)
  }
  async chat({ directory, prompt, sessionId, onSession, messageId, mode }: ChatOptions): Promise<ChatResult> {
    const id = sessionId ?? `ses_${this.turns.length + 1}`
    if (!sessionId) await onSession?.(id)
    return new Promise<ChatResult>((resolve) => {
      this.turns.push({
        directory, prompt, providerId: '', modelId: '', mode, messageId, sessionId: id,
        finish: (result = {}) => resolve({ ok: true, sessionId: id, text: '', ...result }),
      })
    })
  }
}

class FakeProviders extends Service {
  constructor(ctx: Context) {
    super(ctx, 'providers')
  }
  get(id: string) {
    return id === 'gw' ? { models: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3', thinkingOff: true }] } : undefined
  }
}

let root: string
/** 보내는 프로젝트 */
let project: string
/** 받을 프로젝트 두 개 */
let backend: string
let tokens: string
const MODEL = { providerId: 'gw', modelId: 'm1' }
/** 보내는 대화 */
const A = 'aaaaaaaa-0000-4000-8000-000000000001'
/** order-backend 의 대화 둘 */
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const D = 'dddddddd-0000-4000-8000-000000000004'
/** design-tokens 의 대화 */
const C = 'cccccccc-0000-4000-8000-000000000003'

type Extra = Pick<QueuedSend, 'mode' | 'model'> & { project?: string }

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-delegation-')))
  project = path.join(root, 'shop-web')
  backend = path.join(root, 'order-backend')
  tokens = path.join(root, 'design-tokens')
  for (const dir of [project, backend, tokens]) await fs.mkdir(dir)
})

afterEach(async () => {
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
  ctx.plugin(SessionsService, { file: path.join(root, 'sessions.json') })
  ctx.plugin(ProjectsService, { file: path.join(root, 'projects.json') })
  ctx.plugin(ChatService)
  ctx.plugin(DelegationService)
  const ready = await new Promise<Context>((resolve) => ctx.inject(['chat', 'sessions', 'projects', 'llm', 'delegation'], resolve))
  for (const dir of [tokens, backend, project]) await ready.projects.open(dir)
  const llm = ready.llm as unknown as FakeLlm
  /** 사람이 보낸다 — 그 턴을 준다. 다른 프로젝트면 extra.project */
  const say = async (cid: string, text: string, extra: Extra = {}): Promise<Turn> => {
    const before = llm.turns.length
    await ready.chat.send(cid, { text, project, model: MODEL, mode: 'build', ...extra })
    await until(() => llm.turns.length > before)
    return llm.turns.at(-1)!
  }
  /** 끝난 대화 하나 (쉬는 중) */
  const idle = async (cid: string, text: string, extra: Extra = {}): Promise<void> => {
    const turn = await say(cid, text, extra)
    turn.finish()
    await until(() => !ready.chat.turnOf(cid))
  }
  return { ctx: ready, chat: ready.chat, sessions: ready.sessions, llm, say, idle, view: (cid: string) => ready.sessions.noteViewed(cid) }
}

describe('targets — 받을 대화 골라내기', () => {
  it('본 프로젝트·본 적 없는 대화는 빠지고, 나머지 프로젝트마다 마지막에 보던 대화가 온다', async () => {
    const { ctx, idle, view } = await start()
    await idle(B, '주문 API 설계', { project: backend })
    await idle(C, '색 토큰', { project: tokens })
    await idle(A, '주문 화면')
    await view(B)
    await view(A)
    const targets = await ctx.delegation.targets(project)
    expect(targets.map((target) => [target.id, target.project.path, target.conversation.id])).toEqual([[projectId(backend), backend, B]])
  })

  it('엔진에 넘길 수 없는 폴더의 프로젝트는 목록에 남고 사유를 싣는다', async () => {
    const { ctx, llm, idle, view } = await start()
    await idle(B, '주문 API 설계', { project: backend })
    await view(B)
    llm.blocked.set(backend, '플러그인 파일이 있다')
    const targets = await ctx.delegation.targets(project)
    expect(targets).toHaveLength(1)
    expect(targets[0]?.problem).toBe('플러그인 파일이 있다')
  })

  it('includeSelf(승인 카드, #351) — 보내는 프로젝트 자신도 대상에 있다 (마지막에 보던 대화 기준은 같다)', async () => {
    const { ctx, idle, view } = await start()
    await idle(B, '주문 API 설계', { project: backend })
    await idle(A, '주문 화면')
    await view(B)
    await view(A)
    const withSelf = await ctx.delegation.targets(project, true)
    expect(withSelf.map((target) => target.id)).toEqual(expect.arrayContaining([projectId(project), projectId(backend)]))
    expect(withSelf.find((target) => target.id === projectId(project))?.conversation.id).toBe(A)
  })
})

describe('send — 자격과 전송', () => {
  const send = (ctx: Awaited<ReturnType<typeof start>>['ctx'], patch: Record<string, unknown> = {}) =>
    ctx.delegation.send({ directory: project, from: { id: A, title: '주문 화면' }, targetId: projectId(backend), message: '지시', ...patch })

  it('보낸 글은 감싸서(보낸 프로젝트·대화 제목) 받고, 출처·보낸 대화가 남는다. 쉬면 sent, 짧은 id·받는 프로젝트 이름이 결과에', async () => {
    const { ctx, llm, idle, view } = await start()
    await idle(B, '주문 API 설계', { project: backend })
    await view(B)
    const before = llm.turns.length
    const sent = await send(ctx)
    expect(sent).toEqual({ state: 'sent', conversationId: B, conversationTitle: '주문 API 설계', shortId: 'c-bbbbbbbb', projectName: 'order-backend' })
    await until(() => llm.turns.length > before)
    expect(llm.turns.at(-1)?.prompt).toBe(wrapInstruction({ project: 'shop-web', title: '주문 화면' }, '지시'))
  })

  it('돌고 있으면 queued — 앞에 몇 개인지도 준다', async () => {
    const { ctx, say, view } = await start()
    const turn = await say(B, '오래 걸리는 일', { project: backend })
    await view(B)
    const sent = await send(ctx)
    expect(sent).toMatchObject({ state: 'queued', ahead: 1, conversationId: B })
    turn.finish()
  })

  it('지시 글이 없거나 상한을 넘으면, 대상이 모르거나 못 쓰면 보내기 전에 던진다', async () => {
    const { ctx, llm, idle, view } = await start()
    await idle(B, '주문 API 설계', { project: backend })
    await view(B)
    await expect(send(ctx, { message: '   ' })).rejects.toThrow('message is required.')
    await expect(send(ctx, { message: 'x'.repeat(MESSAGE_MAX + 1) })).rejects.toThrow(/too long/)
    await expect(send(ctx, { targetId: 'p-zzzzzzzz' })).rejects.toThrow('Unknown project. Use an id from list_projects.')
    llm.blocked.set(backend, '폴더 문제')
    await expect(send(ctx)).rejects.toThrow('Target project cannot be used (폴더 문제).')
  })

  it('모델이 없거나 대기열이 가득 찬 대상에는 보내지 않는다', async () => {
    const { ctx, say, sessions, idle, view } = await start()
    await idle(B, '주문 API 설계', { project: backend })
    await view(B)
    await sessions.patch(B, () => ({ model: { providerId: 'gone', modelId: 'm1' } }))
    await expect(send(ctx)).rejects.toThrow('Target conversation has no usable model.')
    // 대화는 모델을 내부 키로 가리킨다 (#497) — 사고 끔 항목(m3)을 id 로 가리키면 쓸 수 있는 모델이 아니다
    await sessions.patch(B, () => ({ model: { providerId: 'gw', modelId: 'm3' } }))
    await expect(send(ctx)).rejects.toThrow('Target conversation has no usable model.')
    await sessions.patch(B, () => ({ model: MODEL }))
    const turn = await say(B, '바쁨', { project: backend })
    for (let n = 0; n < QUEUE_LIMIT; n++) await ctx.chat.send(B, { text: `대기 ${n}`, project: backend, model: MODEL })
    await expect(send(ctx)).rejects.toThrow(`Target queue is full (${QUEUE_LIMIT} waiting).`)
    turn.finish()
  })

  it('conversationId(카드에서 고른 대화, #348) — 대상 프로젝트의 대화면 그 대화로. 다른 프로젝트의 대화·없는 id 는 거절, 같은 대화면 보통 경로', async () => {
    const { ctx, llm, idle, say, view } = await start()
    await idle(B, '주문 API 설계', { project: backend })
    await idle(D, '배포 스크립트', { project: backend })
    await idle(C, '색 토큰', { project: tokens })
    await view(B)
    const before = llm.turns.length
    const sent = await send(ctx, { conversationId: D })
    expect(sent).toEqual({ state: 'sent', conversationId: D, conversationTitle: '배포 스크립트', shortId: 'c-dddddddd', projectName: 'order-backend' })
    await until(() => llm.turns.length > before)
    expect(llm.turns.at(-1)?.prompt).toBe(wrapInstruction({ project: 'shop-web', title: '주문 화면' }, '지시'))
    // 다른 프로젝트의 대화 — 화면 조작 값을 막는 것 (프로젝트 id 와는 무관)
    await expect(send(ctx, { conversationId: C })).rejects.toThrow('The conversation the user chose belongs to a different project.')
    await expect(send(ctx, { conversationId: 'no-such' })).rejects.toThrow('The conversation the user chose no longer exists.')
    // 대상의 대화와 같으면 그냥 (conversationId 이펙트 없음)
    expect(await send(ctx, { conversationId: B })).toMatchObject({ state: 'sent', conversationId: B })
  })

  it('count(모델 경로) — 보내는 대화가 도는 중이어야 하고 한 턴에 상한까지. count 없이(화면 경로)는 세지 않는다', async () => {
    const { ctx, say, idle, view } = await start()
    await idle(B, '주문 API 설계', { project: backend })
    await view(B)
    // send 하는 동안 B 가 쉴 때 (turn.sends 는 A 의 도는 턴에만 붙는다)
    const sender = await say(A, '일의 시작')
    for (let n = 0; n < MAX_SENDS_PER_TURN; n++) await expect(send(ctx, { count: true })).resolves.toMatchObject({ conversationId: B })
    await expect(send(ctx, { count: true })).rejects.toThrow(`Too many instructions sent in this turn (the limit is ${MAX_SENDS_PER_TURN}).`)
    // 상한과 무관하게 자격은 된다 — B 는 첫 보내기가 도는 중이라 이번 것은 대기열
    expect(await send(ctx)).toMatchObject({ state: 'queued', conversationId: B })
    sender.finish()
  })
})

describe('send — 새 대화(카드에서 "새 대화", #351)와 보내는 프로젝트 자신', () => {
  const send = (ctx: Awaited<ReturnType<typeof start>>['ctx'], patch: Record<string, unknown> = {}) =>
    ctx.delegation.send({ directory: project, from: { id: A, title: '주문 화면' }, targetId: projectId(backend), message: '지시', ...patch })

  it('새 대話を 만들어 보낸다 — 그 프로젝트의 마지막에 본 대화 모델·모드, 그 대화에 지시 한 건. 결과가 받은 대화(제목·짧은 id)를 말한다', async () => {
    const { ctx, llm, idle, view } = await start()
    await idle(B, '주문 API 설계', { project: backend, mode: 'ask', model: { providerId: 'gw', modelId: 'm2' } })
    await view(B)
    const before = llm.turns.length
    const sent = await send(ctx, { newConversation: true })
    expect(sent.state).toBe('sent')
    expect(sent.conversationId).not.toBe(B)
    expect(sent.conversationTitle).toBe('지시') // 첫 메시지(보낸 글)에서 제목
    expect(sent.shortId).toMatch(/^c-[0-9a-f]{8,}$/)
    expect(sent.projectName).toBe('order-backend')
    await until(() => llm.turns.length > before)
    expect(llm.turns.at(-1)).toMatchObject({
      directory: backend,
      mode: 'ask',
      prompt: wrapInstruction({ project: 'shop-web', title: '주문 화면' }, '지시'),
    })
    // 그 프로젝트 마지막에 본 대화(B) 의 모델·모드 — 새 대화가 이은 것
    const created = (await ctx.sessions.list()).find((entry) => entry.id === sent.conversationId)
    expect(created).toMatchObject({ project: backend, title: '지시', mode: 'ask', model: { providerId: 'gw', modelId: 'm2' } })
  })

  it('마지막에 본 대화가 쓸 수 없으면 그 프로젝트에서 가장 최근의 쓸 수 있는 대화 모델·모드를 잇는다. 한 턴 상한(count)도 통하고, 쓸 수 있는 대화가 없으면 안 보낸다', async () => {
    const { ctx, llm, idle, say, view, sessions } = await start()
    await idle(B, '본 대화', { project: backend }) // 최신은 아님(MODEL/build)
    await idle(D, '다른 대화', { project: backend, mode: 'full', model: { providerId: 'gw', modelId: 'm2' } }) // 가장 최신
    await view(B)
    await sessions.patch(B, () => ({ model: { providerId: 'gone', modelId: 'm1' } }))
    const before = llm.turns.length
    const sent = await send(ctx, { newConversation: true })
    expect(sent.state).toBe('sent')
    await until(() => llm.turns.length > before)
    // B(본 대화) 는 못 쓰니 그 프로젝트에서 가장 최근의 쓸 수 있는 대화(D — m2/full) 것
    const created = (await ctx.sessions.list()).find((entry) => entry.id === sent.conversationId)
    expect(created).toMatchObject({ model: { providerId: 'gw', modelId: 'm2' }, mode: 'full' })
    // count(모델 경로) — 한 턴 상한은 여기에도 통한다
    const sender = await say(A, '일의 시작')
    for (let n = 0; n < MAX_SENDS_PER_TURN; n++) await expect(send(ctx, { newConversation: true, count: true })).resolves.toMatchObject({ state: 'sent' })
    await expect(send(ctx, { newConversation: true, count: true })).rejects.toThrow(`Too many instructions sent in this turn (the limit is ${MAX_SENDS_PER_TURN}).`)
    // 쓸 수 있는 대화가 하나도 없으면 (count 로 만든 새 대화들도 포함 — backend 의 전체 대화)
    for (const entry of (await ctx.sessions.list()).filter((candidate) => candidate.project === backend)) {
      await sessions.patch(entry.id, () => ({ model: { providerId: 'gone', modelId: 'm1' } }))
    }
    await expect(send(ctx, { newConversation: true })).rejects.toThrow('Target project has no conversation with a usable model.')
    sender.finish()
  })

  it('보내는 프로젝트 자신의 대화(또는 새 대화)도 보낼 수 있다 (카드가 self 프로젝트를 고를 때, #351)', async () => {
    const { ctx, llm, idle, view } = await start()
    await idle(A, '주문 화면')
    await view(A)
    // 같은 프로젝트의 다른 대화 — 대상이 self 라도 대화 기준은 같다
    const before = llm.turns.length
    const sent = await send(ctx, { targetId: projectId(project), conversationId: A })
    expect(sent).toMatchObject({ state: 'sent', conversationId: A, projectName: 'shop-web' })
    await until(() => llm.turns.length > before)
    expect(llm.turns.at(-1)).toMatchObject({ directory: project, prompt: wrapInstruction({ project: 'shop-web', title: '주문 화면' }, '지시') })
    // self 프로젝트의 새 대화 — 새 대화 모델·모드 = self 의 마지막에 본 대화(A) 것
    const fresh = await send(ctx, { targetId: projectId(project), newConversation: true })
    expect(fresh).toMatchObject({ state: 'sent', projectName: 'shop-web' })
    expect(fresh.conversationId).not.toBe(A)
    const created = (await ctx.sessions.list()).find((entry) => entry.id === fresh.conversationId)
    expect(created).toMatchObject({ project, model: MODEL, mode: 'build' })
  })
})
