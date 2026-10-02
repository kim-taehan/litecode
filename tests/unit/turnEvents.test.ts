import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import { Context, Service } from 'cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { interruptedError, LlmService, type Attention, type TurnInfo } from '../../src/services/llm.ts'
import { setMainLanguage, tr } from '../../src/i18n.ts'
import { translate } from '../../shared/i18n/index.ts'

// ctx.llm 의 턴 수명 Cordis 이벤트 ('llm/turn-started'·'llm/turn-ended') — 알림 플러그인이 받아 쓸 계약.
// 받아들여진 턴마다 정확히 한 번씩, outcome 이 맞는지만 고정한다. opencode 는 이 시험에 필요한 엔드포인트만 흉내 낸 HTTP 서버다
// (모양은 실측 그대로: prompt 응답의 admittedSeq, 세션 SSE 의 session.next.* 프레임)

// 승인·질문 (01f 1-c·1-d, 01i 2-a~2-c): 요청은 세션 SSE 에 없고 전역 /api/event(permission.v2.* · question.v2.*, seq 없음) + 세션별 목록에 있다.
// 거절은 그 도구의 tool.failed 하나로 끝나고 step.* 가 없다. 모드(에이전트) 목록은 지연 로드 — 첫 /api/agent 는 빈 목록

type Ending = 'done' | 'failed' | 'cut' | 'reject' | 'hold' | 'permission' | 'question' | 'silent'

/** 'silent' 턴이 끝 이벤트까지 세션 SSE 에 아무것도 안 보내는 시간 — LLM 스트림·도구 실행·승인 대기 동안 세션 SSE 는 0바이트다 (01q) */
const SILENT_MS = 1_500

const PROXY = 'http://proxy.invalid/v1'
const directory = os.tmpdir()
let server: http.Server | undefined
let closer: AbortController
/** 받은 prompt 본문 */
let prompts: unknown[] = []
/** hold 턴을 끝낸다 (엔진이 끝난 것처럼) */
let release: () => void = () => {}
/** 받은 요청 (메서드 경로 본문) — 세션 생성·에이전트 전환·답 보내기를 본다 */
let calls: string[] = []
/** 세션의 지금 에이전트 (GET /api/session/ses_1) — 없으면 build */
let sessionAgent: string | undefined
const AGENTS = ['build', 'plan', 'litecode-ask', 'litecode-full'].map((id) => ({ id, mode: 'primary' }))

afterEach(() => {
  server?.closeAllConnections()
  server?.close()
})

/** ending: 프롬프트 뒤 세션 SSE 를 어떻게 끝낼지 (cut: 끝 이벤트 없이 엔진이 끝남, reject: 프롬프트를 500 으로 거절) */
async function fakeOpencode(ending: Ending): Promise<string> {
  let events: http.ServerResponse | undefined
  let global: http.ServerResponse | undefined
  let agentLists = 0
  calls = []
  sessionAgent = undefined
  const pending: { permission: unknown[]; question: unknown[] } = { permission: [], question: [] }
  const frame = (seq: number, type: string, data: Record<string, unknown>) =>
    events?.write(`data: ${JSON.stringify({ type: `session.next.${type}`, durable: { seq }, data: { sessionID: 'ses_1', ...data } })}\n\n`)
  const announce = (type: string, data: Record<string, unknown>) => global?.write(`data: ${JSON.stringify({ type, data: { sessionID: 'ses_1', ...data } })}\n\n`)
  server = http.createServer((req, res) => {
    const url = req.url ?? ''
    let raw = ''
    req.on('data', (part) => (raw += part))
    req.on('end', () => {
      if (req.method === 'POST' && !url.endsWith('/prompt')) calls.push(`${url} ${raw}`.trim())
    })
    if (url.startsWith('/api/model')) return void res.end(JSON.stringify({ data: [{ id: 'm', providerID: 'p', api: { url: PROXY } }] }))
    if (url.startsWith('/api/agent')) return void res.end(JSON.stringify({ data: agentLists++ === 0 ? [] : AGENTS }))
    if (url === '/api/event') {
      global = res
      return void res.writeHead(200, { 'content-type': 'text/event-stream' })
    }
    if (req.method === 'POST' && url === '/api/session') {
      return void req.on('end', () => {
        sessionAgent = (JSON.parse(raw) as { agent?: string }).agent
        res.end(JSON.stringify({ data: { id: 'ses_1' } }))
      })
    }
    if (url === '/api/session/ses_1') return void res.end(JSON.stringify({ data: { model: { providerID: 'p', id: 'm' }, ...(sessionAgent && { agent: sessionAgent }) } }))
    if (url === '/api/session/ses_1/agent') {
      return void req.on('end', () => {
        sessionAgent = (JSON.parse(raw) as { agent: string }).agent
        res.writeHead(204).end()
      })
    }
    if (url === '/api/session/ses_1/permission' || url === '/api/session/ses_1/question') {
      return void res.end(JSON.stringify({ data: pending[url.endsWith('permission') ? 'permission' : 'question'] }))
    }
    // 답: once·답하기는 도구가 이어서 끝나고 턴이 끝난다. 거절은 tool.failed 하나로 끝 (01f 1-d, 01i 2-c)
    const answered = /^\/api\/session\/ses_1\/(permission|question)\/(\w+)\/(reply|reject)$/.exec(url)
    if (answered) {
      return void req.on('end', () => {
        const kind = answered[1] as 'permission' | 'question'
        pending[kind] = []
        res.writeHead(204).end()
        const rejected = answered[3] === 'reject' || (JSON.parse(raw || '{}') as { reply?: string }).reply === 'reject'
        announce(`${kind}.v2.${rejected && kind === 'question' ? 'rejected' : 'replied'}`, { requestID: answered[2] })
        if (rejected) return void frame(4, 'tool.failed', { callID: 'call_1', error: { message: 'Tool execution interrupted' } })
        frame(4, 'tool.success', { callID: 'call_1' })
        frame(5, 'step.ended', { finish: 'stop' })
      })
    }
    // 승인·질문 대기 중 interrupt 는 tool.failed + step.ended(tool-calls) 로 끝난다 — 끝 판정으로는 "계속" 이다 (01f 1-d, 01i 2-d)
    if (url === '/api/session/ses_1/interrupt') {
      return void req.on('end', () => {
        res.writeHead(204).end()
        if (ending !== 'permission') return
        frame(4, 'tool.failed', { callID: 'call_1', error: { message: 'Tool execution interrupted' } })
        frame(5, 'step.ended', { finish: 'tool-calls' })
      })
    }
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
        if (ending === 'silent') setTimeout(() => frame(3, 'step.ended', { finish: 'stop' }), SILENT_MS)
        if (ending === 'permission' || ending === 'question') {
          frame(3, 'tool.called', { callID: 'call_1', tool: ending === 'question' ? 'question' : 'bash' })
          if (ending === 'permission') pending.permission = [{ id: 'per_1', sessionID: 'ses_1', action: 'bash', resources: ['ls'], source: { callID: 'call_1' } }]
          else pending.question = [{ id: 'que_1', sessionID: 'ses_1', questions: [{ question: 'Which DB?', header: 'DB', options: [{ label: 'SQLite' }] }], tool: { callID: 'call_1' } }]
          announce(`${ending}.v2.asked`, { id: ending === 'permission' ? 'per_1' : 'que_1' })
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
      return
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

describe('ctx.llm 승인·질문 (라운드 A)', () => {
  /** 카드가 받는 목록을 적고, 처음 보이는 요청에 answer 로 답한다 */
  function answering(llm: LlmService, answer: Parameters<LlmService['reply']>[2]) {
    const shown: Attention[][] = []
    const onAttention = (requests: Attention[]) => {
      shown.push(requests)
      if (requests[0]) void llm.reply('ses_1', requests[0].id, answer)
    }
    return { shown, onAttention }
  }

  it('권한 요청 → 카드 목록·attention 이벤트, 한 번 허용하면 목록이 비고 resolved, 턴은 끝까지 간다', async () => {
    const { llm, seen } = await start(await fakeOpencode('permission'))
    const { shown, onAttention } = answering(llm, 'once')
    const result = await llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, 'build', onAttention)
    expect(result).toMatchObject({ ok: true })
    expect(result.declined).toBeUndefined()
    expect(shown).toEqual([[{ kind: 'permission', id: 'per_1', sessionId: 'ses_1', action: 'bash', resources: ['ls'] }], []])
    expect(calls).toContain('/api/session/ses_1/permission/per_1/reply {"reply":"once"}')
    expect(seen).toEqual([
      `started ses_1@${directory}`,
      `attention ses_1@${directory} permission: bash ls`,
      `resolved ses_1@${directory}`,
      `ended ses_1@${directory} done`,
    ])
  })

  it('권한 거절 → tool.failed 하나로 끝나는 턴을 실패가 아닌 "거절함" 으로 끝낸다 (step.* 없음)', async () => {
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
    expect(calls).toContain('/api/session/ses_1/question/que_1/reply {"answers":[["SQLite"]]}')
    expect(answered.seen).toContain(`attention ses_1@${directory} question: Which DB?`)

    server?.closeAllConnections()
    server?.close()
    const rejected = await start(await fakeOpencode('question'))
    const result = await rejected.llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, 'build', answering(rejected.llm, 'reject').onAttention)
    expect(result).toMatchObject({ ok: true, declined: true })
    expect(calls).toContain('/api/session/ses_1/question/que_1/reject')
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
    expect(calls.filter((call) => call.includes('/question/'))).toEqual(['/api/session/ses_1/question/que_1/reject'])
  })
})

describe('ctx.llm 모드 = opencode 에이전트 (라운드 A)', () => {
  it('새 세션은 그 모드의 에이전트로 만든다 — 에이전트 목록이 비어 있으면(지연 로드) 나올 때까지 기다린다', async () => {
    const { llm } = await start(await fakeOpencode('done'))
    expect((await llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, 'plan')).ok).toBe(true)
    expect(calls.find((call) => call.startsWith('/api/session '))).toContain('"agent":"plan"')
  })

  it('이어가는 세션은 모드가 다를 때만 에이전트를 바꾼다 (POST /api/session/{id}/agent)', async () => {
    const { llm } = await start(await fakeOpencode('done'))
    await llm.chat('p', 'm', directory, 'hi')
    expect(sessionAgent).toBe('build')
    await llm.chat('p', 'm', directory, 'hi', 'ses_1', undefined, undefined, undefined, 'build').catch(() => {})
    expect(calls.filter((call) => call.startsWith('/api/session/ses_1/agent'))).toEqual([])
    await llm.chat('p', 'm', directory, 'hi', 'ses_1', undefined, undefined, undefined, 'ask').catch(() => {})
    expect(calls.filter((call) => call.startsWith('/api/session/ses_1/agent'))).toEqual(['/api/session/ses_1/agent {"agent":"litecode-ask"}'])
  })
})

describe('ctx.llm 사용자 멈춤 (이슈 #3)', () => {
  it('도는 턴을 멈추면 opencode 턴도 멈추고(POST /interrupt) "중단됨" 으로 끝난다 — turn-ended interrupted', async () => {
    const { llm, seen } = await start(await fakeOpencode('hold'))
    const stop = new AbortController()
    const turn = llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, undefined, undefined, stop.signal)
    await expect.poll(() => seen.length).toBe(1) // started — 프롬프트가 받아들여졌다
    stop.abort()
    expect(await turn).toMatchObject({ ok: false, interrupted: true, error: tr('error.stopped'), sessionId: 'ses_1' })
    expect(calls).toContain('/api/session/ses_1/interrupt {}')
    expect(seen.at(-1)).toBe(`ended ses_1@${directory} interrupted (${tr('error.stopped')})`)
  })

  it('보내기 전에 멈추면 프롬프트를 보내지 않는다 — interrupt·턴 이벤트도 없다', async () => {
    const { llm, seen } = await start(await fakeOpencode('done'))
    const stop = new AbortController()
    stop.abort()
    expect(await llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, undefined, undefined, stop.signal)).toMatchObject({
      ok: false,
      interrupted: true,
      error: tr('error.stopped'),
    })
    expect(prompts).toEqual([])
    expect(calls.filter((call) => call.includes('/interrupt'))).toEqual([])
    expect(seen).toEqual([])
  })

  it('승인 대기 중 멈추면 — interrupt 뒤 오는 step.ended(tool-calls) 를 기다리지 않고 "중단됨" 으로 끝난다', async () => {
    const { llm } = await start(await fakeOpencode('permission'))
    const stop = new AbortController()
    const shown: Attention[][] = []
    const turn = llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, 'build', (requests) => {
      shown.push(requests)
      if (requests[0]) stop.abort()
    }, stop.signal)
    expect(await turn).toMatchObject({ ok: false, interrupted: true, error: tr('error.stopped') })
    expect(shown[0]?.[0]).toMatchObject({ kind: 'permission' })
    expect(calls).toContain('/api/session/ses_1/interrupt {}')
    await expect(llm.reply('ses_1', 'per_1', 'once')).rejects.toThrow() // 끝난 턴의 카드는 더 답할 수 없다
  })
})

describe('ctx.llm 세션 SSE 무바이트 구간 (01q)', () => {
  // undici 기본 bodyTimeout·headersTimeout 은 300초 — 그 이상 조용하면(긴 생각·도구·승인 대기) 앱 쪽에서 끊긴다.
  // 300초를 기다릴 수 없어 타임아웃을 주입해 같은 길을 짧게 돈다

  it('조용한 구간이 타임아웃보다 길면 끊긴다 — 주입한 타임아웃이 세션 SSE fetch 에 닿는다', async () => {
    const { llm } = await start(await fakeOpencode('silent'), { streamTimeoutMs: 300 })
    expect(await llm.chat('p', 'm', directory, 'hi')).toMatchObject({ ok: false, interrupted: true })
  })

  it('기본(타임아웃 없음)이면 조용한 구간을 지나 끝까지 받는다', async () => {
    const { llm } = await start(await fakeOpencode('silent'))
    expect(await llm.chat('p', 'm', directory, 'hi')).toMatchObject({ ok: true })
  })

  it('엔진이 살아 있는데 끝 이벤트 없이 끊기면 opencode 턴도 멈춘다 (POST /interrupt) — 안 그러면 다음 턴이 이 턴의 답을 받는다', async () => {
    const { llm } = await start(await fakeOpencode('silent'), { streamTimeoutMs: 300 })
    await llm.chat('p', 'm', directory, 'hi')
    expect(calls).toContain('/api/session/ses_1/interrupt {}')
  })

  it('엔진이 끝나 끊긴 턴은 interrupt 를 보내지 않는다 (보낼 곳이 없다)', async () => {
    const { llm } = await start(await fakeOpencode('cut'))
    await llm.chat('p', 'm', directory, 'hi')
    expect(calls.filter((call) => call.includes('/interrupt'))).toEqual([])
  })
})
