import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Context, Service } from 'cordis'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { ascendingId, interruptedError, LlmService, STREAM_IDLE_TIMEOUT_MS, type Attention, type TurnInfo } from '../../src/services/llm.ts'
import type { TurnItem } from '../../src/services/turnProgress.ts'
import { setMainLanguage, tr } from '../../src/i18n.ts'
import { translate } from '../../shared/i18n/index.ts'

// ctx.llm 의 턴 수명 Cordis 이벤트 ('llm/turn-started'·'llm/turn-ended') — 알림 플러그인이 받아 쓸 계약 — 과 레거시 경로 계약(이슈 #13 L1).
// opencode 는 이 시험에 필요한 엔드포인트만 흉내 낸 HTTP 서버다. 모양은 01w 실측 그대로: prompt_async 204, GET /event?directory= 의
// {type, properties}(server.connected 가 바로 온다), 답 메시지의 parentID = 보낸 messageID, 끝은 session.idle, 중지는 abort → session.error
// (MessageAbortedError) → idle 두 번. 승인·질문은 permission.asked·question.asked + GET /permission·/question?directory=(폴더 전부)

type Ending = 'done' | 'failed' | 'cut' | 'reject' | 'hold' | 'permission' | 'question' | 'silent' | 'heartbeat' | 'noidle' | 'compactloop' | 'overflow' | 'huge' | 'retry'

/** 'silent' 턴이 끝 이벤트까지 /event 에 아무것도 안 보내는 시간 */
const SILENT_MS = 1_500

const PROXY = 'http://proxy.invalid/v1'
/** 작업 폴더 — AGENTS.md 시험용으로 이 파일이 만든다. 끝나면 이 경로만 지운다 */
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'litecode-turnevents-')))
const A = 'msg_a1'
let server: http.Server | undefined
let closer: AbortController
/** 받은 prompt_async 본문 */
let prompts: Record<string, unknown>[] = []
/** hold 턴을 끝낸다 (엔진이 끝난 것처럼) */
let release: () => void = () => {}
/** 받은 POST (경로 본문 — 쿼리는 뺀다) */
let calls: string[] = []
/** 받은 모든 요청의 URL (쿼리 포함) — 레거시 호출의 ?directory= 를 본다 */
let urls: string[] = []
const AGENTS = ['build', 'plan', 'litecode-ask', 'litecode-full'].map((id) => ({ id, mode: 'primary' }))

afterEach(() => {
  server?.closeAllConnections()
  server?.close()
})

afterAll(() => fs.rmSync(directory, { recursive: true, force: true }))

/** ending: 프롬프트 뒤 /event 를 어떻게 끝낼지 (cut: 끝 이벤트 없이 엔진이 끝남, reject: 프롬프트를 500 으로 거절, noidle: 메시지 없이 session.error 만) */
async function fakeOpencode(ending: Ending): Promise<string> {
  let events: http.ServerResponse | undefined
  let agentLists = 0
  let busy = false
  calls = []
  urls = []
  const pending: { permission: unknown[]; question: unknown[] } = { permission: [], question: [] }
  const emit = (type: string, properties: Record<string, unknown>) => events?.write(`data: ${JSON.stringify({ type, properties: { sessionID: 'ses_1', ...properties } })}\n\n`)
  const part = (p: Record<string, unknown>) => emit('message.part.updated', { part: { sessionID: 'ses_1', messageID: A, ...p }, time: Date.now() })
  const answer = (text: string) => {
    part({ type: 'text', id: 'prt_t', text, time: { start: 1, end: 2 } })
    part({ type: 'step-finish', id: 'prt_f', reason: 'stop', tokens: { input: 700, output: 50, reasoning: 0, cache: { read: 300, write: 0 } } })
  }
  const idle = () => {
    busy = false
    emit('session.status', { status: { type: 'idle' } })
    emit('session.idle', {})
  }
  server = http.createServer((req, res) => {
    const url = req.url ?? ''
    urls.push(url)
    const route = url.split('?')[0]!
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      if (req.method === 'POST') calls.push(`${route} ${raw}`.trim())
    })
    if (route === '/api/model') return void res.end(JSON.stringify({ data: [{ id: 'm', providerID: 'p', api: { url: PROXY } }] }))
    if (route === '/api/agent') return void res.end(JSON.stringify({ data: agentLists++ === 0 ? [] : AGENTS }))
    if (route === '/event') {
      events = res
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      return void res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`)
    }
    if (req.method === 'POST' && route === '/session') return void req.on('end', () => res.end(JSON.stringify({ id: 'ses_1', title: 'x' })))
    if (route === '/session/status') return void res.end(JSON.stringify(busy ? { ses_1: { type: 'busy' } } : {}))
    if (route === '/session/ses_1/message') return void res.end('[]')
    if (route === '/permission' || route === '/question') return void res.end(JSON.stringify(pending[route === '/permission' ? 'permission' : 'question']))
    // 답: once·답하기는 도구가 이어서 끝나고 턴이 끝난다. 거절은 도구 error 뒤 곧바로 idle (01w)
    const answered = /^\/(permission|question)\/(\w+)\/(reply|reject)$/.exec(route)
    if (answered) {
      return void req.on('end', () => {
        const kind = answered[1] as 'permission' | 'question'
        pending[kind] = []
        res.end('true')
        const rejected = answered[3] === 'reject' || (JSON.parse(raw || '{}') as { reply?: string }).reply === 'reject'
        emit(`${kind}.${rejected && kind === 'question' ? 'rejected' : 'replied'}`, { requestID: answered[2] })
        if (rejected) {
          part({ type: 'tool', id: 'prt_b', tool: 'bash', callID: 'call_1', state: { status: 'error', input: {}, error: 'The user rejected permission to use this specific tool call.' } })
          return idle()
        }
        part({ type: 'tool', id: 'prt_b', tool: 'bash', callID: 'call_1', state: { status: 'completed', input: {}, output: 'ok' } })
        answer('done')
        idle()
      })
    }
    // 중지: 200 true → session.error(MessageAbortedError) → idle 두 번 (01w 8회)
    if (route === '/session/ses_1/abort') {
      return void req.on('end', () => {
        res.end('true')
        emit('session.error', { error: { name: 'MessageAbortedError', data: { message: 'The operation was aborted.' } } })
        idle()
        idle()
      })
    }
    if (route === '/session/ses_1/prompt_async') {
      return void req.on('end', () => {
        const body = JSON.parse(raw) as { messageID: string; noReply?: boolean }
        prompts.push(body)
        if (ending === 'reject') return void res.writeHead(500).end()
        res.writeHead(204).end()
        if (body.noReply) return
        busy = ending !== 'noidle'
        setTimeout(() => {
          if (ending === 'noidle') return void emit('session.error', { error: { name: 'UnknownError', data: { message: 'Agent not found: "x"' } } })
          // 앞 턴을 멈춘 뒤 늦게 온 것들 — 이 턴 user 메시지 전이라 끝·실패로 보면 안 된다
          emit('session.error', { error: { name: 'MessageAbortedError', data: { message: 'The operation was aborted.' } } })
          idle()
          emit('message.updated', { info: { id: body.messageID, sessionID: 'ses_1', role: 'user', time: { created: Date.now() } } })
          emit('session.status', { status: { type: 'busy' } })
          emit('message.updated', { info: { id: A, sessionID: 'ses_1', role: 'assistant', parentID: body.messageID, time: { created: Date.now() } } })
          // 같은 세션에 다른 클라이언트가 보낸 턴의 답 — 섞이면 안 된다
          emit('message.updated', { info: { id: 'msg_other', sessionID: 'ses_1', role: 'assistant', parentID: 'msg_someone_else' } })
          emit('message.part.updated', { part: { sessionID: 'ses_1', messageID: 'msg_other', type: 'text', id: 'prt_o', text: 'NOT MINE', time: { start: 1, end: 2 } } })
          if (ending === 'done') {
            answer('echo: hi')
            idle()
          }
          if (ending === 'failed') {
            emit('message.updated', { info: { id: A, sessionID: 'ses_1', role: 'assistant', parentID: body.messageID, error: { name: 'APIError', data: { message: 'boom' } } } })
            emit('session.error', { error: { name: 'APIError', data: { message: 'boom' } } })
            idle()
          }
          if (ending === 'silent') setTimeout(() => (answer('late'), idle()), SILENT_MS)
          if (ending === 'heartbeat') {
            // 레거시 /event 는 10초마다 heartbeat — 조용한 턴에도 바이트가 온다 (여기선 100ms 마다)
            const beat = setInterval(() => events?.write(`data: ${JSON.stringify({ type: 'server.heartbeat', properties: {} })}\n\n`), 100)
            setTimeout(() => (clearInterval(beat), answer('late'), idle()), SILENT_MS)
          }
          // 게이트웨이 한도 초과(이슈 #20 L2 실측 순서): session.error(ContextOverflowError) → 요약 user(compaction 파트) → 요약 답(summary) →
          // 이음 user(합성 Continue) → 그 답 → idle. huge 는 요약도 넘쳐 요약 답이 error 로 끝나고 idle
          if (ending === 'overflow' || ending === 'huge') {
            emit('session.error', { error: { name: 'ContextOverflowError', data: { message: "This model's maximum context length is 8000 tokens." } } })
            emit('message.updated', { info: { id: A, sessionID: 'ses_1', role: 'assistant', parentID: body.messageID, time: { created: 1, completed: 2 } } })
            emit('message.updated', { info: { id: 'msg_c', sessionID: 'ses_1', role: 'user', time: { created: 3 } } })
            emit('message.part.updated', { part: { sessionID: 'ses_1', messageID: 'msg_c', id: 'prt_c', type: 'compaction', auto: true, overflow: true } })
            emit('message.updated', { info: { id: 'msg_sum', sessionID: 'ses_1', role: 'assistant', parentID: 'msg_c', summary: true, agent: 'compaction', time: { created: 4 } } })
            emit('message.part.updated', { part: { sessionID: 'ses_1', messageID: 'msg_sum', id: 'prt_s', type: 'text', text: '## Objective', time: { start: 4, end: 5 } } })
            if (ending === 'huge') {
              emit('session.error', { error: { name: 'ContextOverflowError', data: { message: "This model's maximum context length is 8000 tokens." } } })
              const error = { name: 'ContextOverflowError', data: { message: 'Session too large to compact - context exceeds model limit even after stripping media' } }
              emit('message.updated', { info: { id: 'msg_sum', sessionID: 'ses_1', role: 'assistant', parentID: 'msg_c', summary: true, time: { created: 4, completed: 5 }, error } })
              return idle()
            }
            emit('message.updated', { info: { id: 'msg_sum', sessionID: 'ses_1', role: 'assistant', parentID: 'msg_c', summary: true, agent: 'compaction', time: { created: 4, completed: 5 } } })
            emit('message.updated', { info: { id: 'msg_k', sessionID: 'ses_1', role: 'user', time: { created: 6 } } })
            emit('message.part.updated', { part: { sessionID: 'ses_1', messageID: 'msg_k', id: 'prt_k', type: 'text', text: 'Continue if you have next steps', synthetic: true } })
            emit('session.compacted', {})
            emit('message.updated', { info: { id: 'msg_after', sessionID: 'ses_1', role: 'assistant', parentID: 'msg_k', time: { created: 7 } } })
            emit('message.part.updated', { part: { sessionID: 'ses_1', messageID: 'msg_after', type: 'text', id: 'prt_after', text: 'echo: continued', time: { start: 7, end: 8 } } })
            idle()
          }
          // 게이트웨이 500: session.status retry(몇 번째·사유) → 다시 보낼 때 busy → 답
          if (ending === 'retry') {
            emit('session.status', { status: { type: 'retry', attempt: 1, message: 'Internal Server Error', next: Date.now() + 2000 } })
            setTimeout(() => {
              emit('session.status', { status: { type: 'busy' } })
              answer('echo: hi')
              idle()
            }, 100)
          }
          if (ending === 'compactloop') for (let i = 0; i < 10; i++) emit('session.compacted', {}) // 한도가 작아 요약 → Continue → 다시 넘침 (idle 없음)
          if (ending === 'permission' || ending === 'question') {
            part({ type: 'tool', id: 'prt_b', tool: ending === 'question' ? 'question' : 'bash', callID: 'call_1', state: { status: 'running', input: {} } })
            const tool = { messageID: A, callID: 'call_1' }
            if (ending === 'permission') pending.permission = [{ id: 'per_old', sessionID: 'ses_1', permission: 'bash', patterns: ['old'], tool: { messageID: 'msg_stopped', callID: 'c0' } }, { id: 'per_1', sessionID: 'ses_1', permission: 'bash', patterns: ['ls'], metadata: {}, always: ['ls *'], tool }]
            else pending.question = [{ id: 'que_1', sessionID: 'ses_1', questions: [{ question: 'Which DB?', header: 'DB', options: [{ label: 'SQLite' }] }], tool }]
            emit(`${ending}.asked`, { id: ending === 'permission' ? 'per_1' : 'que_1' })
          }
          if (ending === 'cut') {
            closer.abort(new Error('engine exited')) // 엔진이 끝나면 closed 가 먼저 걸리고 소켓이 닫힌다
            events?.destroy()
          }
          release = () => {
            closer.abort(new Error('engine exited'))
            events?.destroy()
          }
        }, 20)
      })
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function start(url: string, config?: ConstructorParameters<typeof LlmService>[1]): Promise<{ llm: LlmService; seen: string[] }> {
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
  ctx.on('llm/attention', (info) => void seen.push(`attention ${show(info)} ${info.kind}: ${info.title}`))
  ctx.on('llm/attention-resolved', (info) => void seen.push(`resolved ${show(info)}`))
  ctx.plugin(FakeProviders)
  ctx.plugin(FakeEngine)
  ctx.plugin(LlmService, config)
  return new Promise((resolve) => ctx.inject(['llm'], (ready) => resolve({ llm: ready.llm, seen })))
}

describe("ctx.llm 턴 수명 이벤트", () => {
  it('끝까지 간 턴: started 한 번 → ended done 한 번. 답은 이 턴 답 메시지(parentID)의 글만 — 다른 클라이언트 답·앞 턴의 늦은 idle·중지 오류는 섞이지 않는다', async () => {
    const { llm, seen } = await start(await fakeOpencode('done'))
    expect(await llm.chat('p', 'm', directory, 'hi')).toMatchObject({ ok: true, text: 'echo: hi', usage: { steps: 1, tokens: { input: 700 } } })
    expect(seen).toEqual([`started ses_1@${directory}`, `ended ses_1@${directory} done`])
  })

  it('실패한 턴(assistant error·session.error 뒤 idle): ended failed 와 사유', async () => {
    const { llm, seen } = await start(await fakeOpencode('failed'))
    expect((await llm.chat('p', 'm', directory, 'hi')).interrupted).toBeUndefined()
    expect(seen).toEqual([`started ses_1@${directory}`, `ended ses_1@${directory} failed (boom)`])
  })

  it('session.error 만 오고 idle 이 없으면(없는 에이전트 — 01w) 상태를 물어 실패로 끝낸다', async () => {
    const { llm } = await start(await fakeOpencode('noidle'))
    expect(await llm.chat('p', 'm', directory, 'hi')).toMatchObject({ ok: false, error: 'Agent not found: "x"' })
  })

  it('한 턴에 자동 요약이 끝없이 돌면(한도가 작은 모델 — 01w) 몇 번 뒤 멈추고(abort) 한도 초과 안내로 끝낸다', async () => {
    const { llm } = await start(await fakeOpencode('compactloop'))
    expect(await llm.chat('p', 'm', directory, 'hi')).toMatchObject({ ok: false, error: tr('error.contextOverflow') })
    await expect.poll(() => calls).toContain('/session/ses_1/abort')
  })

  it('엔진이 끝나 끊긴 턴: ended interrupted', async () => {
    const { llm, seen } = await start(await fakeOpencode('cut'))
    expect(await llm.chat('p', 'm', directory, 'hi')).toMatchObject({ error: interruptedError(), interrupted: true })
    expect(seen).toEqual([`started ses_1@${directory}`, `ended ses_1@${directory} interrupted (${interruptedError()})`])
  })

  it('영어에서도 끊긴 턴은 interrupted — 판정이 한국어 문구("중단됨")에 기대지 않는다', async () => {
    setMainLanguage('en')
    try {
      const { llm, seen } = await start(await fakeOpencode('cut'))
      expect(await llm.chat('p', 'm', directory, 'hi')).toMatchObject({ error: translate('en', 'error.interrupted'), interrupted: true })
      expect(seen.at(-1)).toMatch(/ interrupted \(Interrupted — /)
    } finally {
      setMainLanguage('ko')
    }
  })

  it('받아들여지기 전에 거절된 턴(프롬프트 500·없는 폴더)은 둘 다 안 나간다', async () => {
    const { llm, seen } = await start(await fakeOpencode('reject'))
    expect((await llm.chat('p', 'm', directory, 'hi')).ok).toBe(false)
    expect((await llm.chat('p', 'm', `${directory}/litecode-no-such-dir`, 'hi')).ok).toBe(false)
    expect(seen).toEqual([])
  })
})

describe('ctx.llm 자동 요약·재시도 (이슈 #20 L2)', () => {
  it('게이트웨이 한도 초과 → opencode 가 요약해 이어 간 턴은 성공이다 — 요약 줄(running → done), 답은 이음(Continue)의 답, 요약 글은 답이 아니다', async () => {
    const { llm, seen } = await start(await fakeOpencode('overflow'))
    const items: TurnItem[] = []
    const result = await llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, (item) => items.push(item))
    expect(result).toMatchObject({ ok: true, text: 'echo: continued' })
    expect(items.filter((item) => item.kind === 'compaction')).toEqual([
      { kind: 'compaction', id: 'msg_c:compaction', status: 'running' },
      { kind: 'compaction', id: 'msg_c:compaction', status: 'done' },
    ])
    expect(items.some((item) => item.kind === 'text' && item.text.includes('Objective'))).toBe(false)
    expect(seen.at(-1)).toBe(`ended ses_1@${directory} done`)
  })

  it('요약도 한도를 넘으면(요약 답 ContextOverflowError) "새 대화로" 안내로 실패 — 요약 줄은 failed', async () => {
    const { llm } = await start(await fakeOpencode('huge'))
    const items: TurnItem[] = []
    expect(await llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, (item) => items.push(item))).toMatchObject({ ok: false, error: tr('error.contextOverflow') })
    expect(items.filter((item) => item.kind === 'compaction').at(-1)).toMatchObject({ status: 'failed' })
  })

  it('재시도(session.status retry) → 진행 줄 "재시도" waiting(몇 번째·사유), 다시 보내면 done. 턴은 그대로 끝난다', async () => {
    const { llm } = await start(await fakeOpencode('retry'))
    const items: TurnItem[] = []
    expect(await llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, (item) => items.push(item))).toMatchObject({ ok: true, text: 'echo: hi' })
    expect(items.filter((item) => item.kind === 'retry')).toEqual([
      { kind: 'retry', id: 'retry:0', attempt: 1, message: 'Internal Server Error', status: 'waiting' },
      { kind: 'retry', id: 'retry:0', attempt: 1, message: 'Internal Server Error', status: 'done' },
    ])
  })
})

describe('레거시 경로 계약 (이슈 #13)', () => {
  it('세션은 POST /session 에 모델·제목(제목 LLM 호출을 막는다)을 싣고, 프롬프트는 prompt_async 에 messageID·모델·모드 에이전트를 매번 싣는다', async () => {
    const { llm } = await start(await fakeOpencode('done'))
    await llm.chat('p', 'm', directory, '첫 줄\n둘째 줄', undefined, undefined, undefined, undefined, 'plan')
    expect(JSON.parse(calls.find((call) => call.startsWith('/session '))!.slice('/session '.length))).toEqual({ model: { providerID: 'p', id: 'm' }, title: '첫 줄' })
    expect(prompts[0]).toMatchObject({ model: { providerID: 'p', modelID: 'm' }, agent: 'plan', parts: [{ type: 'text', text: '첫 줄\n둘째 줄' }] })
    expect(prompts[0]!['messageID']).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)

    await llm.chat('p', 'm', directory, 'again', 'ses_1') // 이어가는 턴 — 모드를 안 주면 기본(build) 에이전트를 싣는다
    expect(prompts[1]).toMatchObject({ agent: 'build', model: { providerID: 'p', modelID: 'm' } })
    expect(prompts[1]!['messageID']).not.toBe(prompts[0]!['messageID'])
  })

  it('모든 레거시 호출에 ?directory=<작업 폴더> 를 붙인다 (빠지면 다른 인스턴스로 간다 — 01w)', async () => {
    const { llm } = await start(await fakeOpencode('permission'))
    await llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, 'ask', (requests) => void (requests[0] && llm.reply('ses_1', requests[0].id, 'once')))
    const legacy = urls.filter((url) => !url.startsWith('/api/'))
    expect(legacy.length).toBeGreaterThan(4)
    for (const url of legacy) expect(url, url).toContain(`directory=${encodeURIComponent(directory)}`)
  })

  it('프로젝트 AGENTS.md 를 매 턴 system 으로 싣는다 (opencode 와 같은 "Instructions from:" 모양). 없으면 system 을 안 싣는다', async () => {
    const { llm } = await start(await fakeOpencode('done'))
    await llm.chat('p', 'm', directory, 'no instructions')
    expect(prompts[0]).not.toHaveProperty('system')
    fs.writeFileSync(path.join(directory, 'AGENTS.md'), '# 규칙\n한국어로 답한다\n')
    try {
      await llm.chat('p', 'm', directory, 'with instructions', 'ses_1')
      await llm.chat('p', 'm', directory, 'every turn', 'ses_1')
      for (const prompt of prompts.slice(1)) expect(prompt['system']).toBe(`Instructions from: ${path.join(directory, 'AGENTS.md')}\n# 규칙\n한국어로 답한다\n`)
    } finally {
      fs.rmSync(path.join(directory, 'AGENTS.md'))
    }
  })

  it('새 메시지 id 는 opencode 형식으로 시간 순 정렬된다 — 같은 ms 안에서도 순번으로', () => {
    const ids = [ascendingId('msg', 1_790_919_809_202), ascendingId('msg', 1_790_919_809_202), ascendingId('msg', 1_790_919_809_203)]
    expect(ids[0]!.slice(0, 16)).toBe('msg_0fb2398b2001') // opencode 가 만든 msg_0fb2398b20010dJ8a8bQ1z0neE 와 같은 머리 (01w 기록)
    expect([...ids].sort()).toEqual(ids)
  })
})

describe('ctx.llm.addContext (`!` 카드의 "AI 에게 보내기")', () => {
  it('턴이 쉬면 noReply 로 넣는다 — 정한 메시지 id 그대로, 턴 이벤트는 없다', async () => {
    const { llm, seen } = await start(await fakeOpencode('done'))
    expect(await llm.addContext('p', 'm', directory, '$ ls', 'msg_0fb2398b2001aaaaaaaaaaaaaa')).toEqual({ ok: true, sessionId: 'ses_1' })
    expect(prompts).toEqual([{ messageID: 'msg_0fb2398b2001aaaaaaaaaaaaaa', noReply: true, model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text', text: '$ ls' }] }])
    expect(seen).toEqual([])
  })

  it('그 세션의 턴이 도는 중이면 거절한다 (돌고 있는 턴이 그 입력에 이어 답한다 — 01w)', async () => {
    const { llm } = await start(await fakeOpencode('hold'))
    const turn = llm.chat('p', 'm', directory, 'hi')
    await expect.poll(() => prompts.length).toBe(1)
    expect(await llm.addContext('p', 'm', directory, '$ ls', 'msg_y', 'ses_1')).toMatchObject({ ok: false })
    expect(prompts).toHaveLength(1)
    release()
    await turn
  })
})

describe('ctx.llm 승인·질문 (레거시 /permission·/question)', () => {
  /** 카드가 받는 목록을 적고, 처음 보이는 요청에 answer 로 답한다 */
  function answering(llm: LlmService, answer: Parameters<LlmService['reply']>[2]) {
    const shown: Attention[][] = []
    const onAttention = (requests: Attention[]) => {
      shown.push(requests)
      if (requests[0]) void llm.reply('ses_1', requests[0].id, answer)
    }
    return { shown, onAttention }
  }

  it('권한 요청 → 이 턴 것만 카드 목록(멈춘 턴의 남은 요청은 빼고)·attention 이벤트, 한 번 허용하면 목록이 비고 resolved, 턴은 끝까지 간다', async () => {
    const { llm, seen } = await start(await fakeOpencode('permission'))
    const { shown, onAttention } = answering(llm, 'once')
    const result = await llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, 'build', onAttention)
    expect(result).toMatchObject({ ok: true, text: 'done' })
    expect(result.declined).toBeUndefined()
    expect(shown).toEqual([[{ kind: 'permission', id: 'per_1', sessionId: 'ses_1', action: 'bash', resources: ['ls'] }], []])
    expect(calls).toContain('/permission/per_1/reply {"reply":"once"}')
    expect(seen).toEqual([
      `started ses_1@${directory}`,
      `attention ses_1@${directory} permission: bash ls`,
      `resolved ses_1@${directory}`,
      `ended ses_1@${directory} done`,
    ])
  })

  it('권한 거절 → 도구 error 뒤 idle 로 끝나는 턴을 실패가 아닌 "거절함" 으로 끝낸다', async () => {
    const { llm, seen } = await start(await fakeOpencode('permission'))
    const result = await llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, 'build', answering(llm, 'reject').onAttention)
    expect(result).toMatchObject({ ok: true, declined: true })
    expect(seen.at(-1)).toBe(`ended ses_1@${directory} done`)
  })

  it('질문 → 고른 답을 질문 순서대로 보낸다. 거절도 턴이 끝난다', async () => {
    const answered = await start(await fakeOpencode('question'))
    const { shown, onAttention } = answering(answered.llm, [['SQLite']])
    expect(await answered.llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, 'build', onAttention)).toMatchObject({ ok: true })
    expect(shown[0]).toEqual([{ kind: 'question', id: 'que_1', sessionId: 'ses_1', questions: [{ question: 'Which DB?', header: 'DB', options: [{ label: 'SQLite' }] }] }])
    expect(calls).toContain('/question/que_1/reply {"answers":[["SQLite"]]}')
    expect(answered.seen).toContain(`attention ses_1@${directory} question: Which DB?`)

    server?.closeAllConnections()
    server?.close()
    const rejected = await start(await fakeOpencode('question'))
    const result = await rejected.llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, 'build', answering(rejected.llm, 'reject').onAttention)
    expect(result).toMatchObject({ ok: true, declined: true })
    expect(calls).toContain('/question/que_1/reject {}')
  })

  it('빈 답·모르는 요청·권한에 질문 답은 보내지 않고 던진다 (opencode 는 빈 답도 받는다 — 01i 2-b)', async () => {
    const { llm } = await start(await fakeOpencode('question'))
    const errors: string[] = []
    const turn = llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, 'build', (requests) => {
      if (!requests[0]) return
      void (async () => {
        for (const answer of [[], [[]], [['  ']]] as string[][][]) await llm.reply('ses_1', 'que_1', answer).catch((error: Error) => errors.push(error.message))
        await llm.reply('ses_1', 'que_nope', [['x']]).catch((error: Error) => errors.push(error.message))
        await llm.reply('ses_1', 'que_1', 'once').catch((error: Error) => errors.push(error.message))
        await llm.reply('ses_1', 'que_1', 'reject')
      })()
    })
    expect(await turn).toMatchObject({ ok: true, declined: true })
    expect(errors).toHaveLength(5)
    expect(calls.filter((call) => call.includes('/question/'))).toEqual(['/question/que_1/reject {}'])
  })
})

describe('ctx.llm 모드 = opencode 에이전트', () => {
  it('보내기 전에 그 모드의 에이전트가 목록에 있는지 본다 — 목록이 비어 있으면(지연 로드) 나올 때까지 기다린다', async () => {
    const { llm } = await start(await fakeOpencode('done'))
    expect((await llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, 'ask')).ok).toBe(true)
    expect(prompts[0]).toMatchObject({ agent: 'litecode-ask' })
  })
})

describe('ctx.llm 사용자 멈춤 (이슈 #3)', () => {
  it('도는 턴을 멈추면 opencode 턴도 멈추고(POST /session/{id}/abort) "중단됨" 으로 끝난다 — turn-ended interrupted', async () => {
    const { llm, seen } = await start(await fakeOpencode('hold'))
    const stop = new AbortController()
    const turn = llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, undefined, undefined, stop.signal)
    await expect.poll(() => seen.length).toBe(1) // started — 프롬프트가 받아들여졌다
    stop.abort()
    expect(await turn).toMatchObject({ ok: false, interrupted: true, error: tr('error.stopped'), sessionId: 'ses_1' })
    expect(calls).toContain('/session/ses_1/abort')
    expect(seen.at(-1)).toBe(`ended ses_1@${directory} interrupted (${tr('error.stopped')})`)
  })

  it('보내기 전에 멈추면 프롬프트를 보내지 않는다 — abort·턴 이벤트도 없다', async () => {
    const { llm, seen } = await start(await fakeOpencode('done'))
    const stop = new AbortController()
    stop.abort()
    expect(await llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, undefined, undefined, stop.signal)).toMatchObject({
      ok: false,
      interrupted: true,
      error: tr('error.stopped'),
    })
    expect(prompts).toEqual([])
    expect(calls.filter((call) => call.includes('/abort'))).toEqual([])
    expect(seen).toEqual([])
  })

  it('승인 대기 중 멈추면 idle 을 기다리지 않고 "중단됨" 으로 끝난다 — 끝난 턴의 카드는 더 답할 수 없다', async () => {
    const { llm } = await start(await fakeOpencode('permission'))
    const stop = new AbortController()
    const shown: Attention[][] = []
    const turn = llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, 'build', (requests) => {
      shown.push(requests)
      if (requests[0]) stop.abort()
    }, stop.signal)
    expect(await turn).toMatchObject({ ok: false, interrupted: true, error: tr('error.stopped') })
    expect(shown[0]?.[0]).toMatchObject({ kind: 'permission' })
    expect(calls).toContain('/session/ses_1/abort')
    await expect(llm.reply('ses_1', 'per_1', 'once')).rejects.toThrow()
  })
})

describe('ctx.llm /event 무바이트 구간 (01q)', () => {
  it('조용한 구간이 타임아웃보다 길면 끊긴다 — 주입한 타임아웃이 /event fetch 에 닿는다', async () => {
    const { llm } = await start(await fakeOpencode('silent'), { streamTimeoutMs: 300 })
    expect(await llm.chat('p', 'm', directory, 'hi')).toMatchObject({ ok: false, interrupted: true })
  })

  it('heartbeat 가 오면 조용한 턴이 타임아웃보다 길어도 끊기지 않는다 — 무바이트 한도는 죽은 연결만 잡는다', async () => {
    const { llm } = await start(await fakeOpencode('heartbeat'), { streamTimeoutMs: 300 })
    expect(await llm.chat('p', 'm', directory, 'hi')).toMatchObject({ ok: true, text: 'late' })
  })

  it(`기본 한도(${STREAM_IDLE_TIMEOUT_MS}ms — heartbeat 세 번)면 그보다 짧은 조용한 구간을 지나 끝까지 받는다`, async () => {
    const { llm } = await start(await fakeOpencode('silent'))
    expect(await llm.chat('p', 'm', directory, 'hi')).toMatchObject({ ok: true, text: 'late' })
  })

  it('엔진이 살아 있는데 끝 이벤트 없이 끊기면 opencode 턴도 멈춘다 (abort) — 재생이 없어 끝을 다시 받을 길이 없다', async () => {
    const { llm } = await start(await fakeOpencode('silent'), { streamTimeoutMs: 300 })
    await llm.chat('p', 'm', directory, 'hi')
    expect(calls).toContain('/session/ses_1/abort')
  })

  it('엔진이 끝나 끊긴 턴은 abort 를 보내지 않는다 (보낼 곳이 없다)', async () => {
    const { llm } = await start(await fakeOpencode('cut'))
    await llm.chat('p', 'm', directory, 'hi')
    expect(calls.filter((call) => call.includes('/abort'))).toEqual([])
  })
})
