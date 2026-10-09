import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Context, Service } from 'cordis'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LlmService, MODEL_STALL_TIMEOUT_MS, type ChatResult } from '../../src/services/llm.ts'
import type { TurnItem } from '../../src/services/turnProgress.ts'
import { setMainLanguage, tr } from '../../src/i18n.ts'

// 모델 무응답 한도 (이슈 #264) — 게이트웨이가 요청을 받고 답하지 않으면 엔진은 이 턴 이벤트를 하나도 안 보낸다(heartbeat 만 10초마다).
// 가짜 opencode 는 interject.test.ts 와 같은 모양으로 시험이 이벤트를 한 줄씩 흘리고, 시계는 가짜(shouldAdvanceTime — HTTP 는 진짜로 돈다)

const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'litecode-modelstall-')))
const PROXY = 'http://proxy.invalid/v1'
const AGENTS = ['build', 'plan', 'litecode-ask', 'litecode-full'].map((id) => ({ id, mode: 'primary' }))
const A = 'msg_A'
const STALLED = tr('error.modelStalled', { seconds: MODEL_STALL_TIMEOUT_MS / 1000 })

let server: http.Server | undefined
let closer: AbortController
/** 받은 abort 수 */
let aborts = 0
let emit: (type: string, properties: Record<string, unknown>) => void = () => {}

beforeEach(() => void vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] }))

afterEach(() => {
  vi.useRealTimers()
  server?.closeAllConnections()
  server?.close()
})

afterAll(() => fs.rmSync(directory, { recursive: true, force: true }))

const user = (id: string) => emit('message.updated', { info: { id, sessionID: 'ses_1', role: 'user', time: { created: 1 } } })
const assistant = (id: string, parentID: string) => emit('message.updated', { info: { id, sessionID: 'ses_1', role: 'assistant', parentID, time: { created: 2 } } })
const part = (messageID: string, p: Record<string, unknown>) => emit('message.part.updated', { part: { sessionID: 'ses_1', messageID, ...p }, time: Date.now() })
const heartbeat = () => emit('server.heartbeat', {})
const idle = () => {
  emit('session.status', { status: { type: 'idle' } })
  emit('session.idle', {})
}

async function fakeOpencode(): Promise<string> {
  let events: http.ServerResponse | undefined
  aborts = 0
  emit = (type, properties) =>
    events?.write(`data: ${JSON.stringify({ type, properties: type === 'server.heartbeat' ? properties : { sessionID: 'ses_1', ...properties } })}\n\n`)
  server = http.createServer((req, res) => {
    const route = (req.url ?? '').split('?')[0]!
    if (route === '/api/model') return void res.end(JSON.stringify({ data: [{ id: 'm', providerID: 'p', api: { url: PROXY } }] }))
    if (route === '/api/agent') return void res.end(JSON.stringify({ data: AGENTS }))
    if (route === '/event') {
      events = res
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      return void res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`)
    }
    if (req.method === 'POST' && route === '/session') return void req.on('end', () => res.end(JSON.stringify({ id: 'ses_1', title: 'x' }))).resume()
    if (route === '/session/status') return void res.end('{}')
    if (route === '/session/ses_1/message') return void res.end('[]')
    if (route === '/permission' || route === '/question') return void res.end('[]')
    if (route === '/session/ses_1/prompt_async') return void req.on('end', () => res.writeHead(204).end()).resume()
    if (route === '/session/ses_1/abort') {
      return void req
        .on('end', () => {
          aborts++
          res.end('true')
          emit('session.error', { error: { name: 'MessageAbortedError', data: { message: 'The operation was aborted.' } } })
          idle()
          idle()
        })
        .resume()
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}

async function start(): Promise<{ llm: LlmService; ctx: Context }> {
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
  ctx.plugin(FakeProviders)
  ctx.plugin(FakeEngine)
  ctx.plugin(LlmService, { streamTimeoutMs: 0 }) // /event 무바이트 한도(undici 시계)는 이 시험의 가짜 시계와 무관하게 끈다
  return new Promise((resolve) => ctx.inject(['llm'], (ready) => resolve({ llm: ready.llm, ctx })))
}

async function until(done: () => boolean, what = '조건'): Promise<void> {
  for (let tries = 0; tries < 400 && !done(); tries++) await new Promise((resolve) => setTimeout(resolve, 5))
  if (!done()) throw new Error(`기다렸지만 오지 않았다: ${what}`)
}

/** 진행 줄 — 흘린 파트가 llm 에 닿았는지 본다 (닿기 전에 시계를 넘기면 리셋이 늦게 걸린다) */
let items: TurnItem[] = []
/** 그 파트가 진행 줄로 닿을 때까지 (status 를 주면 그 상태까지) */
const reached = (partId: string, status?: string) =>
  until(() => items.some((item) => item.id === `msg_a1:${partId}` && (!status || (item as { status?: string }).status === status)), `${partId} 진행 줄`)

/** 턴을 보내고 엔진이 받아 이 턴 user·답 메시지·첫 생각 줄이 닿은 데까지 — 그 뒤로 엔진은 조용하다 (게이트웨이가 답을 안 준다) */
async function turn({ llm, ctx }: { llm: LlmService; ctx: Context }) {
  let started = false
  items = []
  ctx.on('llm/turn-started', () => void (started = true))
  let result: ChatResult | undefined
  void llm.chat({ providerId: 'p', modelId: 'm', directory, prompt: 'hi', messageId: A, onProgress: (item) => void items.push(item) }).then((done) => (result = done))
  await until(() => started, '턴 받아들임')
  user(A)
  assistant('msg_a1', A)
  part('msg_a1', { type: 'reasoning', id: 'prt_r0', text: '시작', time: { start: 1 } })
  await reached('prt_r0')
  return () => result
}

/** 이벤트가 llm 에 닿게 진짜 시간을 조금 흘린다 (heartbeat 는 진행 줄이 없다 — 가짜 시계도 같이 가지만 한도보다 훨씬 짧다) */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

describe(`ctx.llm — 모델 무응답 ${MODEL_STALL_TIMEOUT_MS / 1000}초 (이슈 #264)`, () => {
  it('진행 이벤트 없이 한도가 지나면 엔진 턴을 멈추고(abort) 오류로 끝낸다 — heartbeat 는 진행이 아니다', async () => {
    const result = await turn(await start())
    await vi.advanceTimersByTimeAsync(MODEL_STALL_TIMEOUT_MS / 2)
    heartbeat()
    await settle()
    await vi.advanceTimersByTimeAsync(MODEL_STALL_TIMEOUT_MS / 2 - 1_000)
    expect(result()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1_000)
    await until(() => result() !== undefined, '무응답 끝')
    expect(result()).toMatchObject({ ok: false, error: STALLED })
    expect(result()!.interrupted).toBeUndefined()
    await until(() => aborts === 1, 'abort')
  })

  it('진행 이벤트(글·생각)가 오면 다시 센다', async () => {
    const result = await turn(await start())
    await vi.advanceTimersByTimeAsync(MODEL_STALL_TIMEOUT_MS - 1_000)
    part('msg_a1', { type: 'reasoning', id: 'prt_r', text: '생각', time: { start: 1 } })
    await reached('prt_r')
    await vi.advanceTimersByTimeAsync(MODEL_STALL_TIMEOUT_MS - 1_000)
    part('msg_a1', { type: 'text', id: 'prt_t', text: '답', time: { start: 2 } })
    await reached('prt_t')
    await vi.advanceTimersByTimeAsync(MODEL_STALL_TIMEOUT_MS - 1_000)
    expect(result()).toBeUndefined()
    expect(aborts).toBe(0)
    idle()
    await until(() => result() !== undefined, '턴 끝')
    expect(result()).toMatchObject({ ok: true, text: '답' })
  })

  it('도구가 running 인 동안은 세지 않는다 — 도구가 끝나면 그때부터 다시 센다', async () => {
    const result = await turn(await start())
    part('msg_a1', { type: 'tool', id: 'prt_tool', tool: 'bash', callID: 'call_1', state: { status: 'running', input: { command: 'sleep 600' } } })
    await reached('prt_tool', 'running')
    await vi.advanceTimersByTimeAsync(MODEL_STALL_TIMEOUT_MS * 3)
    expect(result()).toBeUndefined()
    expect(aborts).toBe(0)
    part('msg_a1', { type: 'tool', id: 'prt_tool', tool: 'bash', callID: 'call_1', state: { status: 'completed', input: { command: 'sleep 600' }, output: 'ok', time: { start: 1, end: 2 } } })
    await reached('prt_tool', 'done')
    await vi.advanceTimersByTimeAsync(MODEL_STALL_TIMEOUT_MS)
    await until(() => result() !== undefined, '도구 뒤 무응답 끝')
    expect(result()).toMatchObject({ ok: false, error: STALLED })
  })

  it('정상으로 끝난 턴은 타이머를 남기지 않는다 — 한도가 지나도 abort 가 없다', async () => {
    const result = await turn(await start())
    part('msg_a1', { type: 'text', id: 'prt_t', text: '답', time: { start: 1, end: 2 } })
    idle()
    await until(() => result() !== undefined, '턴 끝')
    expect(result()).toMatchObject({ ok: true })
    await vi.advanceTimersByTimeAsync(MODEL_STALL_TIMEOUT_MS * 2)
    await settle()
    expect(aborts).toBe(0)
  })
})
