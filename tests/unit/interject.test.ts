import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Context, Service } from 'cordis'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { LlmService, type Attention, type ChatResult } from '../../src/services/llm.ts'
import type { TurnItem } from '../../src/services/turnProgress.ts'
import { setMainLanguage } from '../../src/i18n.ts'

// 도는 턴에 끼워 넣기 (이슈 #250) — ctx.llm.reserve 로 자리를 잡고 send 로 보낸다. 가짜 opencode 는 실측 모양(_workspace/01ar_interject_probe.md)을
// 시험이 한 줄씩 흘린다: 도는 세션에 또 보낸 prompt_async 는 204 즉시, 끼워 넣은 user(B)의 message.updated 가 오고, 그 뒤 답은 parentID = B,
// idle 은 합쳐 맨 끝 한 번. A 의 idle 과 엇갈려 늦게 닿은 B 는 새 루프·자기 idle 을 받는다(실측 H)

const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'litecode-interject-')))
const PROXY = 'http://proxy.invalid/v1'
const AGENTS = ['build', 'plan', 'litecode-ask', 'litecode-full'].map((id) => ({ id, mode: 'primary' }))
const A = 'msg_A'
const B = 'msg_B'

let server: http.Server | undefined
let closer: AbortController
/** 받은 prompt_async 본문 (순서대로) */
let prompts: Record<string, unknown>[] = []
/** 받은 abort 수 */
let aborts = 0
/** 정본 승인 목록 */
let permissions: unknown[] = []
/** 이벤트 한 줄을 흘린다 (sessionID 는 ses_1) */
let emit: (type: string, properties: Record<string, unknown>) => void = () => {}
/** 첫 prompt_async 응답을 이만큼 늦춘다 (엔진이 받기 전) */
let firstPromptDelay = 0

afterEach(() => {
  server?.closeAllConnections()
  server?.close()
})

afterAll(() => fs.rmSync(directory, { recursive: true, force: true }))

const user = (id: string) => emit('message.updated', { info: { id, sessionID: 'ses_1', role: 'user', time: { created: 1 } } })
const assistant = (id: string, parentID: string) => emit('message.updated', { info: { id, sessionID: 'ses_1', role: 'assistant', parentID, time: { created: 2 } } })
const part = (messageID: string, p: Record<string, unknown>) => emit('message.part.updated', { part: { sessionID: 'ses_1', messageID, ...p }, time: Date.now() })
const idle = () => {
  emit('session.status', { status: { type: 'idle' } })
  emit('session.idle', {})
}

async function fakeOpencode(): Promise<string> {
  let events: http.ServerResponse | undefined
  prompts = []
  aborts = 0
  permissions = []
  emit = (type, properties) => events?.write(`data: ${JSON.stringify({ type, properties: { sessionID: 'ses_1', ...properties } })}\n\n`)
  server = http.createServer((req, res) => {
    const route = (req.url ?? '').split('?')[0]!
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    if (route === '/api/model') return void res.end(JSON.stringify({ data: [{ id: 'm', providerID: 'p', api: { url: PROXY } }] }))
    if (route === '/api/agent') return void res.end(JSON.stringify({ data: AGENTS }))
    if (route === '/event') {
      events = res
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      return void res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`)
    }
    if (req.method === 'POST' && route === '/session') return void req.on('end', () => res.end(JSON.stringify({ id: 'ses_1', title: 'x' })))
    if (route === '/session/status') return void res.end('{}')
    if (route === '/session/ses_1/message') return void res.end('[]')
    if (route === '/permission') return void res.end(JSON.stringify(permissions))
    if (route === '/question') return void res.end('[]')
    if (route === '/session/ses_1/prompt_async') {
      return void req.on('end', () => {
        prompts.push(JSON.parse(raw) as Record<string, unknown>)
        const delay = prompts.length === 1 ? firstPromptDelay : 0
        setTimeout(() => res.writeHead(204).end(), delay)
      })
    }
    if (route === '/session/ses_1/abort') {
      return void req.on('end', () => {
        aborts++
        res.end('true')
        emit('session.error', { error: { name: 'MessageAbortedError', data: { message: 'The operation was aborted.' } } })
        idle()
        idle()
      })
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}

async function start(): Promise<{ llm: LlmService; started: () => boolean }> {
  setMainLanguage('ko')
  const url = await fakeOpencode()
  closer = new AbortController()
  class FakeProviders extends Service {
    constructor(ctx: Context) {
      super(ctx, 'providers')
    }
    get(id: string) {
      return id === 'p' ? { id } : undefined
    }
  }
  class FakeEngine extends Service {
    constructor(ctx: Context) {
      super(ctx, 'engine')
    }
    async connection() {
      return { url, headers: {}, closed: closer.signal, providerBaseURL: () => PROXY, gated: () => false }
    }
    async purgeDeleted() {}
    async restart() {
      return this.connection()
    }
    setGate() {}
  }
  const ctx = new Context()
  let admitted = false
  ctx.on('llm/turn-started', () => void (admitted = true))
  ctx.plugin(FakeProviders)
  ctx.plugin(FakeEngine)
  ctx.plugin(LlmService)
  const llm = await new Promise<LlmService>((resolve) => ctx.inject(['llm'], (ready) => resolve(ready.llm)))
  return { llm, started: () => admitted }
}

async function until(done: () => boolean, what = '조건'): Promise<void> {
  for (let tries = 0; tries < 400 && !done(); tries++) await new Promise((resolve) => setTimeout(resolve, 5))
  if (!done()) throw new Error(`기다렸지만 오지 않았다: ${what}`)
}

/** A 턴을 보내고 엔진이 받아 첫 스텝(도구 하나가 도는 중)까지 흘린다 */
async function turnA(llm: LlmService, started: () => boolean, extra: { mode?: 'plan' | 'build'; context?: string } = {}) {
  const items: TurnItem[] = []
  const cards: Attention[][] = []
  let result: ChatResult | undefined
  void llm
    .chat({ providerId: 'p', modelId: 'm', directory, prompt: 'A 일', messageId: A, onProgress: (item) => void items.push(item), onAttention: (requests) => void cards.push(requests), ...extra })
    .then((done) => (result = done))
  await until(started, 'A 턴 받아들임')
  user(A)
  assistant('msg_a1', A)
  part('msg_a1', { type: 'tool', id: 'prt_tool', tool: 'bash', callID: 'call_1', state: { status: 'running', input: { command: 'sleep 3' } } })
  await until(() => items.some((item) => item.id === 'msg_a1:prt_tool'), 'A 의 도구 줄')
  return { items, cards, result: () => result }
}

describe('ctx.llm — 도는 턴에 끼워 넣기 (이슈 #250)', () => {
  it('끼워 넣은 말은 도는 턴과 같은 model·agent·system·tools 로 간다 — 이미지 첨부·이 말의 맥락도 실린다', async () => {
    const { llm, started } = await start()
    await turnA(llm, started, { mode: 'plan', context: 'A 맥락' })
    const slot = llm.reserve(A, B)!
    expect(slot).toBeDefined()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(await slot.send({ prompt: 'B 말', images: [{ mime: 'image/png', filename: 'b.png', data: png }], context: 'B 맥락' })).toBe(true)
    expect(prompts).toHaveLength(2)
    const [first, second] = prompts as [Record<string, unknown>, Record<string, unknown>]
    expect(second.messageID).toBe(B)
    expect(second.model).toEqual(first.model)
    expect(second.agent).toBe('plan')
    expect(second.agent).toEqual(first.agent)
    expect(second.tools).toEqual(first.tools)
    expect(second.system).toBe(`${first.system as string}\n\nB 맥락`)
    expect(second.parts).toEqual([
      { type: 'text', text: 'B 말' },
      { type: 'file', mime: 'image/png', filename: 'b.png', url: `data:image/png;base64,${png.toString('base64')}` },
    ])
    idle()
  })

  it('끼워 넣은 뒤의 답·진행 줄·승인 카드가 이 턴 것이다 — 끝은 B 를 본 뒤의 idle 한 번', async () => {
    const { llm, started } = await start()
    const a = await turnA(llm, started)
    expect(await llm.reserve(A, B)!.send({ prompt: 'B 말' })).toBe(true)
    user(B) // 엔진이 받자마자 저장한다
    part('msg_a1', { type: 'tool', id: 'prt_tool', tool: 'bash', callID: 'call_1', state: { status: 'completed', input: { command: 'sleep 3' }, output: 'ok', time: { start: 1, end: 2 } } })
    assistant('msg_a2', B) // 다음 스텝은 B 에 답한다
    part('msg_a2', { type: 'tool', id: 'prt_ask', tool: 'bash', callID: 'call_2', state: { status: 'running', input: { command: 'ls' } } })
    permissions = [{ id: 'per_2', sessionID: 'ses_1', permission: 'bash', patterns: ['ls'], metadata: {}, always: ['ls *'], tool: { messageID: 'msg_a2', callID: 'call_2' } }]
    emit('permission.asked', { id: 'per_2', permission: 'bash', patterns: ['ls'], metadata: {}, always: ['ls *'], tool: { messageID: 'msg_a2', callID: 'call_2' } })
    await until(() => a.cards.some((requests) => requests.some((request) => request.id === 'per_2')), 'B 뒤의 승인 카드')
    permissions = []
    emit('permission.replied', { requestID: 'per_2' })
    part('msg_a2', { type: 'tool', id: 'prt_ask', tool: 'bash', callID: 'call_2', state: { status: 'completed', input: { command: 'ls' }, output: 'x', time: { start: 2, end: 3 } } })
    part('msg_a2', { type: 'text', id: 'prt_answer', text: 'B 에 답함', time: { start: 3, end: 4 } })
    await until(() => a.items.some((item) => item.id === 'msg_a2:prt_answer'), 'B 의 답 줄')
    expect(a.result()).toBeUndefined()
    idle()
    await until(() => a.result() !== undefined, '턴 끝')
    expect(a.result()).toMatchObject({ ok: true, text: 'B 에 답함' })
    expect(a.result()!.unanswered).toBeUndefined()
    expect(a.items.filter((item) => item.id === 'msg_a1:prt_tool').at(-1)).toMatchObject({ status: 'done' })
  })

  it('A 의 idle 이 B 보다 먼저 와도(엇갈림, 실측 H) 끝내지 않고 B 의 새 루프 idle 까지 따라간다', async () => {
    const { llm, started } = await start()
    const a = await turnA(llm, started)
    const slot = llm.reserve(A, B)!
    idle() // A 가 막 끝났다 — B 는 아직 엔진에 안 닿았다
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(a.result()).toBeUndefined()
    expect(await slot.send({ prompt: 'B 말' })).toBe(true)
    user(B)
    assistant('msg_b1', B)
    part('msg_b1', { type: 'text', id: 'prt_b', text: 'B 답', time: { start: 1, end: 2 } })
    idle()
    await until(() => a.result() !== undefined, '턴 끝')
    expect(a.result()).toMatchObject({ ok: true })
    expect(a.items.some((item) => item.id === 'msg_b1:prt_b')).toBe(true)
  })

  it('자리를 잡았다가 보내지 않으면(cancel) 기다리던 idle 로 끝낸다 — 그 말은 답 없음', async () => {
    const { llm, started } = await start()
    const a = await turnA(llm, started)
    const slot = llm.reserve(A, B)!
    idle()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(a.result()).toBeUndefined()
    slot.cancel()
    await until(() => a.result() !== undefined, '턴 끝')
    expect(a.result()).toMatchObject({ ok: true, unanswered: [B] })
    expect(prompts).toHaveLength(1)
  })

  it('B 를 봤지만 B 에 답한 메시지 없이 끝나면(승인 거절 등) unanswered 에 B', async () => {
    const { llm, started } = await start()
    const a = await turnA(llm, started)
    expect(await llm.reserve(A, B)!.send({ prompt: 'B 말' })).toBe(true)
    user(B)
    part('msg_a1', { type: 'tool', id: 'prt_tool', tool: 'bash', callID: 'call_1', state: { status: 'error', input: { command: 'sleep 3' }, error: 'rejected', time: { start: 1, end: 2 } } })
    idle()
    await until(() => a.result() !== undefined, '턴 끝')
    expect(a.result()!.unanswered).toEqual([B])
  })

  it('멈춘 턴에는 보내지 않는다 — 잡아 둔 자리의 send 는 false, 엔진에 두 번째 프롬프트가 안 간다', async () => {
    const { llm, started } = await start()
    const stop = new AbortController()
    let result: ChatResult | undefined
    void llm.chat({ providerId: 'p', modelId: 'm', directory, prompt: 'A 일', messageId: A, stop: stop.signal }).then((done) => (result = done))
    await until(started, 'A 턴 받아들임')
    user(A)
    const slot = llm.reserve(A, B)!
    stop.abort()
    expect(await slot.send({ prompt: 'B 말' })).toBe(false)
    await until(() => result !== undefined, '턴 끝')
    expect(result).toMatchObject({ ok: false, interrupted: true, unanswered: [B] })
    expect(prompts).toHaveLength(1)
  })

  it('자리가 없다 — 모르는 턴, 엔진이 아직 받지 않은 턴, 끝난 턴', async () => {
    firstPromptDelay = 150
    try {
      const { llm } = await start()
      expect(llm.reserve('msg_none', B)).toBeUndefined()
      let result: ChatResult | undefined
      void llm.chat({ providerId: 'p', modelId: 'm', directory, prompt: 'A 일', messageId: A }).then((done) => (result = done))
      await until(() => prompts.length === 1, 'A 프롬프트 도착')
      expect(llm.reserve(A, B)).toBeUndefined() // 204 가 아직 안 왔다 — 먼저 보내면 B 가 턴의 시작이 된다
      await new Promise((resolve) => setTimeout(resolve, 200))
      user(A)
      idle()
      await until(() => result !== undefined, '턴 끝')
      expect(llm.reserve(A, 'msg_C')).toBeUndefined()
    } finally {
      firstPromptDelay = 0
    }
  })
})
