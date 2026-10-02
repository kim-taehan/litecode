import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import { Context, Service } from 'cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { INTERRUPTED, LlmService, type TurnInfo } from '../../src/services/llm.ts'

// ctx.llm 의 턴 수명 Cordis 이벤트 ('llm/turn-started'·'llm/turn-ended') — 알림 플러그인이 받아 쓸 계약.
// 받아들여진 턴마다 정확히 한 번씩, outcome 이 맞는지만 고정한다. opencode 는 이 시험에 필요한 엔드포인트만 흉내 낸 HTTP 서버다
// (모양은 실측 그대로: prompt 응답의 admittedSeq, 세션 SSE 의 session.next.* 프레임)

type Ending = 'done' | 'failed' | 'cut' | 'reject' | 'hold'

const PROXY = 'http://proxy.invalid/v1'
const directory = os.tmpdir()
let server: http.Server | undefined
let closer: AbortController
/** 받은 prompt 본문 */
let prompts: unknown[] = []
/** hold 턴을 끝낸다 (엔진이 끝난 것처럼) */
let release: () => void = () => {}

afterEach(() => {
  server?.closeAllConnections()
  server?.close()
})

/** ending: 프롬프트 뒤 세션 SSE 를 어떻게 끝낼지 (cut: 끝 이벤트 없이 엔진이 끝남, reject: 프롬프트를 500 으로 거절) */
async function fakeOpencode(ending: Ending): Promise<string> {
  let events: http.ServerResponse | undefined
  const frame = (seq: number, type: string, data: Record<string, unknown>) =>
    events?.write(`data: ${JSON.stringify({ type: `session.next.${type}`, durable: { seq }, data: { sessionID: 'ses_1', ...data } })}\n\n`)
  server = http.createServer((req, res) => {
    const url = req.url ?? ''
    if (url.startsWith('/api/model')) return void res.end(JSON.stringify({ data: [{ id: 'm', providerID: 'p', api: { url: PROXY } }] }))
    if (req.method === 'POST' && url === '/api/session') return void res.end(JSON.stringify({ data: { id: 'ses_1' } }))
    if (url === '/api/session/ses_1/event') {
      events = res
      return void res.writeHead(200, { 'content-type': 'text/event-stream' })
    }
    if (url === '/api/session/ses_1/prompt') {
      let raw = ''
      req.on('data', (part) => (raw += part))
      req.on('end', () => prompts.push(JSON.parse(raw)))
      if (ending === 'reject') return void res.writeHead(500).end()
      res.end(JSON.stringify({ data: { admittedSeq: 1 } }))
      setTimeout(() => {
        frame(1, 'prompt.admitted', {})
        frame(2, 'prompted', {})
        if (ending === 'done') frame(3, 'step.ended', { finish: 'stop' })
        if (ending === 'failed') frame(3, 'step.failed', { error: { message: 'boom' } })
        if (ending === 'cut') {
          closer.abort(new Error('engine exited')) // 엔진이 끝나면 closed 가 먼저 걸리고 소켓이 닫힌다
          events?.destroy()
        }
        release = () => {
          closer.abort(new Error('engine exited'))
          events?.destroy()
        }
      }, 20)
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function start(url: string): Promise<{ llm: LlmService; seen: string[] }> {
  closer = new AbortController()
  prompts = []
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
      return { url, headers: {}, closed: closer.signal, providerBaseURL: () => PROXY }
    }
    async purgeDeleted() {}
  }
  const ctx = new Context()
  const seen: string[] = []
  const show = (info: TurnInfo & { outcome?: string; error?: string }) => `${info.sessionId}@${info.directory}${info.outcome ? ` ${info.outcome}` : ''}${info.error ? ` (${info.error})` : ''}`
  ctx.on('llm/turn-started', (info) => void seen.push(`started ${show(info)}`))
  ctx.on('llm/turn-ended', (info) => void seen.push(`ended ${show(info)}`))
  ctx.plugin(FakeProviders)
  ctx.plugin(FakeEngine)
  ctx.plugin(LlmService)
  return new Promise((resolve) => ctx.inject(['llm'], (ready) => resolve({ llm: ready.llm, seen })))
}

describe("ctx.llm 턴 수명 이벤트", () => {
  it('끝까지 간 턴: started 한 번 → ended done 한 번', async () => {
    const { llm, seen } = await start(await fakeOpencode('done'))
    expect((await llm.chat('p', 'm', directory, 'hi')).ok).toBe(true)
    expect(seen).toEqual([`started ses_1@${directory}`, `ended ses_1@${directory} done`])
  })

  it('실패한 턴(step.failed): ended failed 와 사유', async () => {
    const { llm, seen } = await start(await fakeOpencode('failed'))
    expect((await llm.chat('p', 'm', directory, 'hi')).interrupted).toBeUndefined()
    expect(seen).toEqual([`started ses_1@${directory}`, `ended ses_1@${directory} failed (boom)`])
  })

  it('엔진이 끝나 끊긴 턴: ended interrupted', async () => {
    const { llm, seen } = await start(await fakeOpencode('cut'))
    expect(await llm.chat('p', 'm', directory, 'hi')).toMatchObject({ error: INTERRUPTED, interrupted: true })
    expect(seen).toEqual([`started ses_1@${directory}`, `ended ses_1@${directory} interrupted (${INTERRUPTED})`])
  })

  it('받아들여지기 전에 거절된 턴(프롬프트 500·없는 폴더)은 둘 다 안 나간다', async () => {
    const { llm, seen } = await start(await fakeOpencode('reject'))
    expect((await llm.chat('p', 'm', directory, 'hi')).ok).toBe(false)
    expect((await llm.chat('p', 'm', `${directory}/litecode-no-such-dir`, 'hi')).ok).toBe(false)
    expect(seen).toEqual([])
  })
})

describe('ctx.llm.addContext (`!` 카드의 "AI 에게 보내기")', () => {
  it('턴이 쉬면 resume:false 로 넣는다 — 정한 메시지 id 그대로, 턴 이벤트는 없다', async () => {
    const { llm, seen } = await start(await fakeOpencode('done'))
    expect(await llm.addContext('p', 'm', directory, '$ ls', 'msg_litecode_x')).toEqual({ ok: true, sessionId: 'ses_1' })
    expect(prompts).toEqual([{ id: 'msg_litecode_x', prompt: { text: '$ ls' }, resume: false }])
    expect(seen).toEqual([])
  })

  it('그 세션의 턴이 도는 중이면 거절한다 (끼어들거나 새 턴이 돈다 — 01h)', async () => {
    const { llm } = await start(await fakeOpencode('hold'))
    const turn = llm.chat('p', 'm', directory, 'hi')
    await expect.poll(() => prompts.length).toBe(1)
    expect(await llm.addContext('p', 'm', directory, '$ ls', 'msg_litecode_y', 'ses_1')).toMatchObject({ ok: false })
    expect(prompts).toHaveLength(1)
    release()
    await turn
  })
})
