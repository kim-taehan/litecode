import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Context, Service } from 'cordis'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { LlmService, type Attention } from '../../src/services/llm.ts'
import { tr } from '../../src/i18n.ts'
import { translate } from '../../shared/i18n/index.ts'

vi.mock('../../renderer/settingsStore.ts', () => ({ useT: () => (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('ko', key, vars) }))

// "프로젝트 폴더 밖 접근" 카드의 [항상 허용] (이슈 #242). 엔진에는 늘 once 만 간다 — 엔진의 always 는 그 폴더의 모든 대화에 걸린다(01z 1-3).
// 앱이 기억한다: 그 대화(엔진 세션) + 그 패턴의 external_directory 요청은 카드 없이 once, 이미 떠 있는 같은 패턴 카드도 함께 푼다.
// opencode 는 승인에 필요한 것만 흉내 낸 HTTP 서버다 (모양은 turnEvents.test.ts 의 가짜와 같다 — 01w 실측). 세션은 POST /session 마다 ses_1, ses_2 …

const PROXY = 'http://proxy.invalid/v1'
const AGENTS = ['build', 'plan', 'litecode-ask', 'litecode-full'].map((id) => ({ id, mode: 'primary' }))
/** 작업 폴더 — 이 파일이 만든다. 끝나면 이 경로만 지운다 */
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'litecode-allowalways-')))
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }))

interface Ask {
  id: string
  permission: string
  patterns: string[]
}

let server: http.Server | undefined
let closer: AbortController
/** 다음 턴이 차례로 낼 승인 묶음 — 한 묶음이 다 풀리면 다음 묶음, 다 끝나면 답하고 idle */
let script: Ask[][] = []
/** 엔진이 받은 승인 답 (`<요청 id> <본문>`) */
let replies: string[] = []

afterEach(() => {
  server?.closeAllConnections()
  server?.close()
})

async function fakeOpencode(): Promise<string> {
  let events: http.ServerResponse | undefined
  let created = 0
  let turn: { sid: string; answer: string; pending: Ask[]; batches: Ask[][] } | undefined
  replies = []
  const emit = (sid: string, type: string, properties: Record<string, unknown>) => events?.write(`data: ${JSON.stringify({ type, properties: { sessionID: sid, ...properties } })}\n\n`)
  const request = (sid: string, answer: string, ask: Ask) => ({ ...ask, sessionID: sid, metadata: {}, always: [], tool: { messageID: answer, callID: `call_${ask.id}` } })
  const part = (sid: string, answer: string, p: Record<string, unknown>) => emit(sid, 'message.part.updated', { part: { sessionID: sid, messageID: answer, ...p }, time: Date.now() })
  const raise = (): void => {
    if (!turn) return
    const { sid, answer } = turn
    const batch = turn.batches.shift()
    if (!batch) {
      part(sid, answer, { type: 'text', id: 'prt_t', text: 'done', time: { start: 1, end: 2 } })
      part(sid, answer, { type: 'step-finish', id: 'prt_f', reason: 'stop', tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } })
      emit(sid, 'session.status', { status: { type: 'idle' } })
      emit(sid, 'session.idle', {})
      return
    }
    turn.pending = [...batch]
    for (const ask of batch) part(sid, answer, { type: 'tool', id: `prt_${ask.id}`, tool: 'bash', callID: `call_${ask.id}`, state: { status: 'running', input: { command: `ls ${ask.patterns[0]}` } } })
    for (const ask of batch) emit(sid, 'permission.asked', request(sid, answer, ask))
  }
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
    if (req.method === 'POST' && route === '/session') return void req.on('end', () => res.end(JSON.stringify({ id: `ses_${++created}`, title: 'x' })))
    if (route === '/session/status') return void res.end('{}')
    if (/^\/api\/session\/\w+\/message$/.test(route)) return void res.end(JSON.stringify({ data: [], cursor: { next: null } }))
    if (/^\/session\/\w+\/message$/.test(route)) return void res.end('[]')
    if (route === '/question') return void res.end('[]')
    if (route === '/permission') return void res.end(JSON.stringify(turn ? turn.pending.map((ask) => request(turn!.sid, turn!.answer, ask)) : []))
    const answered = /^\/permission\/(\w+)\/reply$/.exec(route)
    if (answered) {
      return void req.on('end', () => {
        const id = answered[1]!
        replies.push(`${id} ${raw}`)
        res.end('true')
        if (!turn) return
        turn.pending = turn.pending.filter((ask) => ask.id !== id)
        emit(turn.sid, 'permission.replied', { requestID: id })
        part(turn.sid, turn.answer, { type: 'tool', id: `prt_${id}`, tool: 'bash', callID: `call_${id}`, state: { status: 'completed', input: {}, output: 'ok' } })
        if (turn.pending.length === 0) setTimeout(raise, 10)
      })
    }
    const prompted = /^\/session\/(\w+)\/prompt_async$/.exec(route)
    if (prompted) {
      return void req.on('end', () => {
        const body = JSON.parse(raw) as { messageID: string }
        const sid = prompted[1]!
        res.writeHead(204).end()
        turn = { sid, answer: `msg_a_${sid}`, pending: [], batches: script }
        script = []
        setTimeout(() => {
          emit(sid, 'message.updated', { info: { id: body.messageID, sessionID: sid, role: 'user', time: { created: Date.now() } } })
          emit(sid, 'session.status', { status: { type: 'busy' } })
          emit(sid, 'message.updated', { info: { id: turn!.answer, sessionID: sid, role: 'assistant', parentID: body.messageID, time: { created: Date.now() } } })
          raise()
        }, 20)
      })
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function start(url: string): Promise<LlmService> {
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
  ctx.plugin(LlmService)
  return new Promise((resolve) => ctx.inject(['llm'], (ready) => resolve(ready.llm)))
}

const outside = (id: string, pattern: string): Ask => ({ id, permission: 'external_directory', patterns: [pattern] })
const A = '/Users/me/litecode/*'
const C = '/Users/me/other/*'

/** 한 턴을 돌린다 — onCards 는 카드 목록이 바뀔 때마다. 화면에 뜬 카드 id 를 모두 모은다 */
async function runTurn(llm: LlmService, batches: Ask[][], onCards: (cards: Attention[]) => void, sessionId?: string): Promise<{ ok: boolean; sessionId?: string; shown: Set<string> }> {
  script = batches
  const shown = new Set<string>()
  const result = await llm.chat({
    providerId: 'p',
    modelId: 'm',
    directory,
    prompt: 'hi',
    mode: 'ask',
    ...(sessionId && { sessionId }),
    onAttention: (cards) => {
      for (const card of cards) shown.add(card.id)
      onCards(cards)
    },
  })
  return { ok: result.ok, ...(result.sessionId && { sessionId: result.sessionId }), shown }
}

/** 카드가 뜨면 한 번 허용 (아직 안 누른 것만) */
const allowOnce = (llm: LlmService) => {
  const pressed = new Set<string>()
  return (cards: Attention[]): void => {
    for (const card of cards) {
      if (pressed.has(card.id)) continue
      pressed.add(card.id)
      void llm.reply(card.sessionId, card.id, 'once')
    }
  }
}

describe('항상 허용 — 폴더 밖 접근 (이슈 #242)', () => {
  it('같은 패턴 카드 둘 → 항상 허용 한 번에 둘 다 풀린다. 이후 같은 패턴은 카드 없이 once, 다른 패턴·다른 권한 이름은 그대로 카드. 엔진에 가는 답은 늘 once', async () => {
    const llm = await start(await fakeOpencode())
    const later = allowOnce(llm)
    let always = false
    const result = await runTurn(
      llm,
      [
        [outside('per_a', A), outside('per_b', A), outside('per_c', C), { id: 'per_d', permission: 'read', patterns: [A] }],
        [outside('per_e', A), outside('per_f', C)],
      ],
      (cards) => {
        const ids = cards.map((card) => card.id)
        if (!always) {
          if (!['per_a', 'per_b', 'per_c', 'per_d'].every((id) => ids.includes(id))) return
          always = true
          void llm.reply('ses_1', 'per_a', 'always').then(() => later(cards.filter((card) => card.id === 'per_c' || card.id === 'per_d')))
          return
        }
        later(cards.filter((card) => card.id !== 'per_a' && card.id !== 'per_b'))
      },
    )
    expect(result.ok).toBe(true)
    expect([...result.shown].sort()).toEqual(['per_a', 'per_b', 'per_c', 'per_d', 'per_f'])
    expect(replies.map((entry) => entry.split(' ')[0]).sort()).toEqual(['per_a', 'per_b', 'per_c', 'per_d', 'per_e', 'per_f'])
    expect(new Set(replies.map((entry) => entry.slice(entry.indexOf(' ') + 1)))).toEqual(new Set(['{"reply":"once"}']))
  })

  it('범위는 그 대화다 — 같은 대화의 다음 턴에도 이어지고, 다른 대화의 같은 패턴은 카드로 묻는다', async () => {
    const llm = await start(await fakeOpencode())
    const first = await runTurn(llm, [[outside('per_a', A)]], (cards) => {
      if (cards[0]) void llm.reply(cards[0].sessionId, cards[0].id, 'always')
    })
    expect(first).toMatchObject({ ok: true, sessionId: 'ses_1' })
    // 같은 대화의 다음 턴 — 카드 없이
    const again = await runTurn(llm, [[outside('per_b', A)]], () => {}, 'ses_1')
    expect(again.ok).toBe(true)
    expect(again.shown.size).toBe(0)
    // 다른 대화 — 카드
    const other = await runTurn(llm, [[outside('per_x', A)]], allowOnce(llm))
    expect(other).toMatchObject({ ok: true, sessionId: 'ses_2' })
    expect([...other.shown]).toEqual(['per_x'])
    expect(replies).toEqual(['per_a {"reply":"once"}', 'per_b {"reply":"once"}', 'per_x {"reply":"once"}'])
  })

  it('항상 허용은 external_directory 에만 — 다른 권한·질문에 보내면 답이 틀렸다고 던지고 엔진에 아무것도 안 간다', async () => {
    const llm = await start(await fakeOpencode())
    const errors: string[] = []
    const result = await runTurn(llm, [[{ id: 'per_d', permission: 'bash', patterns: ['ls'] }]], (cards) => {
      const card = cards[0]
      if (!card) return
      void llm
        .reply(card.sessionId, card.id, 'always')
        .catch((error: Error) => errors.push(error.message))
        .then(() => llm.reply(card.sessionId, card.id, 'once'))
    })
    expect(result.ok).toBe(true)
    expect(errors).toEqual([tr('error.attentionAnswer')])
    expect(replies).toEqual(['per_d {"reply":"once"}'])
  })
})

// 카드 화면 — [항상 허용] 은 external_directory 카드에만 (정적 마크업)
describe('승인 카드의 [항상 허용] 버튼 (이슈 #242)', async () => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { AttentionCard } = await import('../../renderer/Attention.tsx')
  const render = (request: Attention): string => renderToStaticMarkup(createElement(AttentionCard, { request, onAnswer: async () => {} }))
  const card = (action: string, extra: Partial<Extract<Attention, { kind: 'permission' }>> = {}): Attention => ({ kind: 'permission', id: 'per_1', sessionId: 'ses_1', action, resources: [A], ...extra })

  it('폴더 밖 접근 카드에는 [항상 허용] 과 한 줄 설명이 있다', () => {
    const html = render(card('external_directory'))
    expect(html).toContain('>항상 허용</button>')
    expect(html).toContain('이 대화에서 이 폴더는 다시 묻지 않습니다')
    expect(html).toContain('>한 번 허용</button>')
  })

  it('다른 권한·MCP 도구·질문 카드에는 없다', () => {
    for (const html of [
      render(card('bash')),
      render(card('edit')),
      render(card('litecode_send_to_project', { resources: ['*'], mcp: { server: 'litecode', tool: 'send_to_project' }, input: JSON.stringify({ project: 'p-1', message: 'hi' }) })),
      render(card('litecode_create', { resources: ['*'], mcp: { server: 'litecode', tool: 'create' }, input: JSON.stringify({ kind: 'hook', event: 'Stop', hook_command: 'say' }) })),
      render({ kind: 'question', id: 'que_1', sessionId: 'ses_1', questions: [{ question: 'Q?', options: [{ label: 'a' }] }] }),
    ]) {
      expect(html).not.toContain('항상 허용')
    }
  })
})
