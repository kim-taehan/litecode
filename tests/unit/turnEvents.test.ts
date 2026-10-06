import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Context, Service } from 'cordis'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { ascendingId, finishedTool, interruptedError, LlmService, STREAM_IDLE_TIMEOUT_MS, type Attention, type PreTool, type PreToolDecision, type ToolDone, type TurnInfo } from '../../src/services/llm.ts'
import type { TurnItem } from '../../src/services/turnProgress.ts'
import { setMainLanguage, tr } from '../../src/i18n.ts'
import { translate } from '../../shared/i18n/index.ts'

// ctx.llm 의 턴 수명 Cordis 이벤트 ('llm/turn-started'·'llm/turn-ended') — 알림 플러그인이 받아 쓸 계약 — 과 레거시 경로 계약(이슈 #13 L1).
// opencode 는 이 시험에 필요한 엔드포인트만 흉내 낸 HTTP 서버다. 모양은 01w 실측 그대로: prompt_async 204, GET /event?directory= 의
// {type, properties}(server.connected 가 바로 온다), 답 메시지의 parentID = 보낸 messageID, 끝은 session.idle, 중지는 abort → session.error
// (MessageAbortedError) → idle 두 번. 승인·질문은 permission.asked·question.asked + GET /permission·/question?directory=(폴더 전부)

type Ending = 'done' | 'failed' | 'cut' | 'reject' | 'hold' | 'permission' | 'question' | 'silent' | 'heartbeat' | 'noidle' | 'compactloop' | 'overflow' | 'huge' | 'retry' | 'mcpask' | 'mcpgate' | 'twoasks' | 'webask' | 'webchild' | 'globchild' | 'grepchild'

/** 'mcpask' 턴이 묻는 앱 MCP 도구 호출의 인자 (이슈 #55) */
const MCP_ARGS = { session: 'c-1a2b3c4d', message: 'fix the tests' }
/** 'mcpask' 에서 허용 뒤 도구가 끝나기까지 — 그 사이에 MCP 호출이 앱 서버에 닿는다 */
const MCP_CALL_MS = 250

/** 'webask'·'webchild' 턴이 가져오려는 주소 */
const WEB_URL = 'http://127.0.0.1:9/doc'
/** 'globchild'·'grepchild' 턴의 하위 작업이 부르는 검색 인자 (01ai — 요청 metadata 에 그대로 실린다) */
const GLOB_ARGS = { pattern: '*.txt' }
const GREP_ARGS = { pattern: 'needle', path: 'src', include: '*.ts' }
/** 정본 목록이 깨졌을 때의 응답 (01ai 실측 — 인자에 빠진 선택 항목이 있는 webfetch·glob·grep 요청이 하나라도 대기 중이면 그 폴더 목록 전체가 400) */
const BROKEN_LIST = { name: 'BadRequest', data: { message: 'Expected JSON value, got undefined\n  at [0]["metadata"]["timeout"]', kind: 'Body' } }

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
/** 신규 세대 기록(레거시 전환 전에 쌓인 대화, GET /api/session/{id}/message). 비어 있지 않으면 레거시 기록(GET /session/{id}/message)도
 *  흉내 낸다 — 받은 prompt_async 의 user 메시지가 쌓인다 (#21 이어 쓰기) */
let previous: unknown[] = []
/** 가짜 엔진이 도구 실행 전 게이트를 걸어 둔 권한 이름 (EngineConnection.gated — 이슈 #102 2단계) */
let gatedPermissions: string[] = []
/** 가짜 엔진이 받은 게이트 대상 (EngineService.setGate — 받으면 다시 띄울 수 있다) */
let engineGates: string[][] = []
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
  const legacy: unknown[] = []
  const pending: { permission: unknown[]; question: unknown[] } = { permission: [], question: [] }
  /** 허용 뒤에 이어서 올 승인 요청 ('twoasks') */
  const followUp: unknown[] = []
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
    if (route === '/session/ses_1/message') return void res.end(JSON.stringify(legacy))
    if (route === '/api/session/ses_1/message') return void res.end(JSON.stringify({ data: previous, cursor: { next: null } }))
    // 'webask'·'webchild': 정본 목록 GET /permission 이 응답 검증에 실패한다 — 답한 뒤에도(멈춘 턴의 요청이 남은 폴더처럼) 계속 (01ai)
    if (route === '/permission' && (ending === 'webask' || ending === 'webchild' || ending === 'globchild' || ending === 'grepchild')) return void res.writeHead(400).end(JSON.stringify(BROKEN_LIST))
    if (route === '/permission' || route === '/question') return void res.end(JSON.stringify(pending[route === '/permission' ? 'permission' : 'question']))
    // 답: once·답하기는 도구가 이어서 끝나고 턴이 끝난다. 거절은 도구 error 뒤 곧바로 idle (01w)
    const answered = /^\/(permission|question)\/(\w+)\/(reply|reject)$/.exec(route)
    if (answered) {
      return void req.on('end', () => {
        const kind = answered[1] as 'permission' | 'question'
        pending[kind] = []
        res.end('true')
        // 'twoasks': 폴더 밖 경로를 허용하면 같은 호출이 자기 권한(bash)을 이어서 묻는다
        const next = (JSON.parse(raw || '{}') as { reply?: string }).reply === 'once' ? followUp.shift() : undefined
        if (next) {
          pending.permission = [next]
          emit('permission.replied', { requestID: answered[2] })
          return void emit('permission.asked', { id: (next as { id: string }).id })
        }
        const body = JSON.parse(raw || '{}') as { reply?: string; message?: string }
        const rejected = answered[3] === 'reject' || body.reply === 'reject'
        emit(`${kind}.${rejected && kind === 'question' ? 'rejected' : 'replied'}`, { requestID: answered[2] })
        // 사유를 실은 거절(01af §4, 3/3): 도구는 고정 문구 + 사유의 오류로 끝나고 모델이 그 글을 받아 턴이 이어진다
        if (rejected && body.message) {
          part({ type: 'tool', id: 'prt_b', tool: 'bash', callID: 'call_1', state: { status: 'error', input: {}, error: `The user rejected permission to use this specific tool call with the following feedback: ${body.message}` } })
          answer('went on')
          return idle()
        }
        if (rejected) {
          part({ type: 'tool', id: 'prt_b', tool: 'bash', callID: 'call_1', state: { status: 'error', input: {}, error: 'The user rejected permission to use this specific tool call.' } })
          return idle()
        }
        const finish = () => {
          part({ type: 'tool', id: 'prt_b', tool: 'bash', callID: 'call_1', state: { status: 'completed', input: {}, output: 'ok' } })
          answer('done')
          idle()
        }
        if (ending === 'mcpask' || ending === 'mcpgate' || ending === 'webask' || ending === 'webchild' || ending === 'globchild' || ending === 'grepchild') setTimeout(finish, MCP_CALL_MS)
        else finish()
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
        if (previous.length > 0) legacy.push({ info: { id: body.messageID, role: 'user' }, parts: [] })
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
            // 아직 답이 없으면 같은 폴더의 승인 신호가 한 번 더 온다 (목록을 다시 읽게 한다)
            // (실제 엔진처럼 요청 전체를 싣는다 — 목록과 이벤트 양쪽에 있어도 카드는 하나다, 이슈 #107)
            if (ending === 'permission') setTimeout(() => pending.permission.length > 0 && emit('permission.asked', { id: 'per_1', permission: 'bash', patterns: ['ls'], metadata: {}, always: ['ls *'], tool }), 40)
          }
          // 한 bash 호출이 두 번 묻는다: 폴더 밖 경로(external_directory) → 허용하면 bash 자신의 권한 (이슈 #102 2단계)
          if (ending === 'twoasks') {
            const tool = { messageID: A, callID: 'call_1' }
            part({ type: 'tool', id: 'prt_b', tool: 'bash', callID: 'call_1', state: { status: 'running', input: { command: 'ls /etc' } } })
            pending.permission = [{ id: 'per_0', sessionID: 'ses_1', permission: 'external_directory', patterns: ['/etc/*'], tool }]
            followUp.push({ id: 'per_1', sessionID: 'ses_1', permission: 'bash', patterns: ['ls /etc'], tool })
            emit('permission.asked', { id: 'per_0' })
          }
          // 사용자 MCP 서버의 도구 — 기본 모드는 원래 묻지 않는다. 묻는 것은 게이트 때문이다 (이슈 #102 2단계)
          if (ending === 'mcpgate') {
            part({ type: 'tool', id: 'prt_b', tool: 'github_search', callID: 'call_1', state: { status: 'running', input: MCP_ARGS } })
            pending.permission = [{ id: 'per_1', sessionID: 'ses_1', permission: 'github_search', patterns: ['*'], metadata: {}, always: ['*'], tool: { messageID: A, callID: 'call_1' } }]
            emit('permission.asked', { id: 'per_1' })
          }
          // 앱 MCP 도구의 승인 (01z 1-3): 묻는 이벤트에는 인자가 없고, 그 순간 그 callID 의 파트가 running + input 이다
          if (ending === 'mcpask') {
            part({ type: 'tool', id: 'prt_b', tool: 'litecode_send_to_project', callID: 'call_1', state: { status: 'running', input: MCP_ARGS } })
            pending.permission = [{ id: 'per_1', sessionID: 'ses_1', permission: 'litecode_send_to_project', patterns: ['*'], metadata: {}, always: ['*'], tool: { messageID: A, callID: 'call_1' } }]
            emit('permission.asked', { id: 'per_1' })
          }
          // 매번 묻기의 웹 가져오기 (이슈 #107, 01ai): permission.asked 는 요청 전체를 싣고 오지만 정본 목록은 400 이다
          if (ending === 'webask' || ending === 'webchild') {
            const child = ending === 'webchild'
            const request = { permission: 'webfetch', patterns: [WEB_URL], metadata: { url: WEB_URL, format: 'text' }, always: ['*'] }
            // 같은 폴더의 다른 대화가 묻는 것 — 이 턴의 카드가 아니다
            emit('permission.asked', { id: 'per_other', sessionID: 'ses_other', ...request, tool: { messageID: 'msg_x', callID: 'call_x' } })
            if (child) {
              emit('session.created', { info: { id: 'ses_c', parentID: 'ses_1' } })
              emit('permission.asked', { id: 'per_c', sessionID: 'ses_c', ...request, tool: { messageID: 'msg_c1', callID: 'call_c' } })
            } else {
              part({ type: 'tool', id: 'prt_b', tool: 'webfetch', callID: 'call_1', state: { status: 'running', input: { url: WEB_URL, format: 'text' } } })
              emit('permission.asked', { id: 'per_w', ...request, tool: { messageID: A, callID: 'call_1' } })
            }
          }
          // 하위 작업의 검색 (게이트를 건 glob·grep, 01ai): 요청의 metadata 가 인자 그대로다 — path 를 뺀 호출은 정본 목록이 400
          if (ending === 'globchild' || ending === 'grepchild') {
            const request = ending === 'globchild' ? { permission: 'glob', patterns: ['*.txt'], metadata: GLOB_ARGS } : { permission: 'grep', patterns: ['needle'], metadata: GREP_ARGS }
            emit('session.created', { info: { id: 'ses_c', parentID: 'ses_1' } })
            emit('permission.asked', { id: 'per_c', sessionID: 'ses_c', ...request, always: ['*'], tool: { messageID: 'msg_c1', callID: 'call_c' } })
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

async function start(url: string, config?: ConstructorParameters<typeof LlmService>[1]): Promise<{ llm: LlmService; seen: string[]; ctx: Context }> {
  closer = new AbortController()
  prompts = []
  gatedPermissions = []
  engineGates = []
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
      return { url, headers: {}, closed: closer.signal, providerBaseURL: () => PROXY, gated: (permission: string) => gatedPermissions.includes(permission) }
    }
    async purgeDeleted() {}
    setGate(matchers: readonly string[]) {
      engineGates.push([...matchers])
    }
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
  return new Promise((resolve) => ctx.inject(['llm'], (ready) => resolve({ llm: ready.llm, seen, ctx })))
}

describe("ctx.llm 턴 수명 이벤트", () => {
  it('끝까지 간 턴: started 한 번 → ended done 한 번. 답은 이 턴 답 메시지(parentID)의 글만 — 다른 클라이언트 답·앞 턴의 늦은 idle·중지 오류는 섞이지 않는다', async () => {
    const { llm, seen } = await start(await fakeOpencode('done'))
    expect(await llm.chat('p', 'm', directory, 'hi')).toMatchObject({ ok: true, text: 'echo: hi', usage: { steps: 1, tokens: { input: 700 } } })
    expect(seen).toEqual([`started ses_1@${directory}`, `ended ses_1@${directory} done`])
  })

  // 첨부 (이슈 #44, 01y 1절): 이미지는 text 파트 뒤에 {type:"file", mime, filename, url:"data:<mime>;base64,…"} — file:// 로 넘기지 않는다
  it('이미지를 붙인 턴: parts 는 text 뒤 file(data: URI), 턴은 평소대로 끝난다', async () => {
    const { llm, seen } = await start(await fakeOpencode('done'))
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const images = [
      { mime: 'image/png' as const, filename: '오류 화면.png', data: png },
      { mime: 'image/jpeg' as const, filename: 'b.jpg', data: Buffer.from([0xff, 0xd8, 0xff]) },
    ]
    expect(await llm.chat('p', 'm', directory, 'look', undefined, undefined, undefined, undefined, undefined, undefined, undefined, images)).toMatchObject({ ok: true, text: 'echo: hi' })
    expect(prompts[0]!.parts).toEqual([
      { type: 'text', text: 'look' },
      { type: 'file', mime: 'image/png', filename: '오류 화면.png', url: `data:image/png;base64,${png.toString('base64')}` },
      { type: 'file', mime: 'image/jpeg', filename: 'b.jpg', url: 'data:image/jpeg;base64,/9j/' },
    ])
    expect(seen).toEqual([`started ses_1@${directory}`, `ended ses_1@${directory} done`])
  })

  it('글 없이 이미지만 보내면 text 파트를 싣지 않는다 (01y 2절 "글 없이 이미지만"), 첨부가 없으면 text 파트 하나 그대로', async () => {
    const { llm } = await start(await fakeOpencode('done'))
    const images = [{ mime: 'image/png' as const, filename: 'a.png', data: Buffer.from([1, 2, 3]) }]
    await llm.chat('p', 'm', directory, '', undefined, undefined, undefined, undefined, undefined, undefined, undefined, images)
    await llm.chat('p', 'm', directory, 'hi', 'ses_1')
    expect(prompts.map((body) => body.parts)).toEqual([
      [{ type: 'file', mime: 'image/png', filename: 'a.png', url: 'data:image/png;base64,AQID' }],
      [{ type: 'text', text: 'hi' }],
    ])
  })

  // 01y 함정 2·착지 제안 6: 깨진 이미지 등은 user 메시지·idle 없이 session.error 하나만 온다 — file 파트 턴에서도 상태를 물어 실패로 끝낸다
  it('file 파트 턴에 session.error 만 오고 idle 이 없어도 실패로 끝난다 (끝 신호 없는 거절)', async () => {
    const { llm } = await start(await fakeOpencode('noidle'))
    const images = [{ mime: 'image/png' as const, filename: 'broken.png', data: Buffer.from('x') }]
    expect(await llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, undefined, undefined, undefined, images)).toMatchObject({ ok: false })
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

  // 이슈 #102 — 그 턴에만 실을 맥락(훅의 stdout)은 지시문 뒤에 붙어 system 으로 간다
  it('chat 의 context 는 그 턴의 system 에 실린다 — 지시문이 있으면 그 뒤에, 다음 턴에는 남지 않는다', async () => {
    const { llm } = await start(await fakeOpencode('done'))
    const turn = (context?: string) => llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, 'build', undefined, undefined, [], context)
    await turn('branch: main')
    expect(prompts[0]!['system']).toBe('branch: main')
    fs.writeFileSync(path.join(directory, 'AGENTS.md'), 'rules\n')
    try {
      await turn('branch: main')
      await turn()
      expect(prompts[1]!['system']).toBe(`Instructions from: ${path.join(directory, 'AGENTS.md')}\nrules\n\n\nbranch: main`)
      expect(prompts[2]!['system']).toBe(`Instructions from: ${path.join(directory, 'AGENTS.md')}\nrules\n`)
    } finally {
      fs.rmSync(path.join(directory, 'AGENTS.md'))
    }
  })

  it('finishedTool: 끝난 도구 파트만 — 파일 도구는 인자 filePath(상대면 세션 폴더 기준), apply_patch 는 결과의 첫 파일', () => {
    const part = (state: object, tool = 'edit') => ({ type: 'tool', tool, callID: 'c', state })
    expect(finishedTool(part({ status: 'running', input: {} }), '/w')).toBeUndefined()
    expect(finishedTool({ type: 'text', text: 'x' }, '/w')).toBeUndefined()
    expect(finishedTool(part({ status: 'completed', input: { filePath: 'src/a.ts' }, output: 'ok' }), '/w')).toEqual({ tool: 'edit', input: { filePath: 'src/a.ts' }, output: 'ok', file: '/w/src/a.ts' })
    expect(finishedTool(part({ status: 'completed', input: { filePath: '/abs/a.ts' }, output: '' }, 'write'), '/w')?.file).toBe('/abs/a.ts')
    expect(finishedTool(part({ status: 'completed', input: { patchText: '…' }, output: '', metadata: { files: [{ filePath: '/w/b.ts' }] } }, 'apply_patch'), '/w')?.file).toBe('/w/b.ts')
    expect(finishedTool(part({ status: 'error', input: { command: 'x' }, error: 'boom' }, 'bash'), '/w')).toEqual({ tool: 'bash', input: { command: 'x' }, error: 'boom' })
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

  // 이슈 #102 — 끝난 도구 호출마다 중립 이벤트 하나 (ctx.hooks 의 "도구 실행 후" 가 듣는다)
  it("도구 호출이 끝나면 'llm/tool-done' 을 호출마다 한 번 낸다 — 도구 이름·인자·결과, 폴더는 realpath", async () => {
    const { llm, ctx } = await start(await fakeOpencode('permission'))
    const done: ToolDone[] = []
    ctx.on('llm/tool-done', (info) => void done.push(info))
    const { onAttention } = answering(llm, 'once')
    await llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, 'build', onAttention)
    expect(done).toEqual([{ sessionId: 'ses_1', directory, tool: 'bash', input: {}, output: 'ok', child: false }])
  })

  it("거절돼 실패한 도구도 'llm/tool-done' 으로 온다 — output 없이 error", async () => {
    const { llm, ctx } = await start(await fakeOpencode('permission'))
    const done: ToolDone[] = []
    ctx.on('llm/tool-done', (info) => void done.push(info))
    const { onAttention } = answering(llm, 'reject')
    await llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, 'build', onAttention)
    expect(done).toEqual([{ sessionId: 'ses_1', directory, tool: 'bash', input: {}, error: 'The user rejected permission to use this specific tool call.', child: false }])
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

// 이슈 #107 (실측 01ai, opencode 1.18.18): 승인 요청의 metadata 에 빠진 선택 인자(webfetch 의 timeout, glob·grep 의 path)가 있으면 정본 목록
// GET /permission 이 400 이다 — 그 요청이 대기 중인 동안, 그리고 멈춘 턴이 남긴 요청이 있으면 엔진을 다시 띄울 때까지, 그 폴더의 모든 요청에.
// permission.asked 이벤트는 요청 전체를 싣고 오고 답(POST …/reply)은 정상이다 → 목록을 못 읽으면 이벤트로 본 요청으로 카드를 만든다
describe('ctx.llm 승인 목록을 못 읽을 때 (이슈 #107 — permission.asked 이벤트가 폴백)', () => {
  const card = { kind: 'permission', id: 'per_w', sessionId: 'ses_1', action: 'webfetch', resources: [WEB_URL] }

  it('목록이 400 이어도 이벤트의 요청으로 카드가 뜨고(이 턴 것만), 허용은 그 id 로 가고 턴이 끝까지 간다 — 못 읽은 것은 경고로 남긴다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { llm, seen } = await start(await fakeOpencode('webask'))
    const shown: Attention[][] = []
    const result = await llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, 'ask', (requests) => {
      shown.push(requests)
      if (requests[0]) void llm.reply('ses_1', requests[0].id, 'once')
    })
    expect(result).toMatchObject({ ok: true, text: 'done' })
    expect(shown).toEqual([[card], []])
    expect(calls.filter((call) => call.startsWith('/permission/'))).toEqual(['/permission/per_w/reply {"reply":"once"}'])
    expect(seen).toEqual([`started ses_1@${directory}`, `attention ses_1@${directory} permission: webfetch ${WEB_URL}`, `resolved ses_1@${directory}`, `ended ses_1@${directory} done`])
    expect(warn.mock.calls.some((args) => String(args[0]).includes('[llm]') && args.join(' ').includes('400'))).toBe(true)
    warn.mockRestore()
  })

  it('다른 쪽이 답해 풀린 요청(permission.replied)은 기억에서 지운다 — 목록이 계속 깨져 있어도 카드가 사라진다', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const url = await fakeOpencode('webask')
    const { llm, seen } = await start(url)
    const shown: Attention[][] = []
    const result = await llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, 'ask', (requests) => {
      shown.push(requests)
      if (requests[0]) void fetch(`${url}/permission/per_w/reply?directory=${encodeURIComponent(directory)}`, { method: 'POST', body: '{"reply":"once"}' })
    })
    expect(result.ok).toBe(true)
    expect(shown).toEqual([[card], []])
    expect(seen).toContain(`resolved ses_1@${directory}`)
    vi.restoreAllMocks()
  })

  it('하위 작업(자식 세션)의 요청도 이벤트로 카드가 된다 — 답은 자식 세션의 요청으로 간다', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { llm } = await start(await fakeOpencode('webchild'))
    const shown: Attention[][] = []
    const result = await llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, 'ask', (requests) => {
      shown.push(requests)
      if (requests[0]) void llm.reply(requests[0].sessionId, requests[0].id, 'once')
    })
    expect(result.ok).toBe(true)
    expect(shown).toEqual([[{ ...card, id: 'per_c', sessionId: 'ses_c' }], []])
    expect(calls.filter((call) => call.startsWith('/permission/'))).toEqual(['/permission/per_c/reply {"reply":"once"}'])
    vi.restoreAllMocks()
  })

  it("도구 실행 전 판정('llm/pre-tool')도 이벤트의 요청으로 돈다 — 막으면 카드 없이 reject + 사유", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { llm, ctx } = await start(await fakeOpencode('webask'))
    const asked: PreTool[] = []
    ctx.on('llm/pre-tool', (info) => (asked.push(info), { deny: true, reason: '사내망만' }))
    const shown: Attention[][] = []
    const result = await llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, 'ask', (requests) => void shown.push(requests))
    expect(result).toMatchObject({ ok: true, text: 'went on' })
    expect(asked).toEqual([expect.objectContaining({ tool: 'webfetch', input: { url: WEB_URL, format: 'text' }, child: false })])
    expect(calls.filter((call) => call.startsWith('/permission/'))).toEqual(['/permission/per_w/reply {"reply":"reject","message":"사내망만"}'])
    expect(shown).toEqual([])
    vi.restoreAllMocks()
  })

  it('running 파트를 못 본 호출(하위 작업)의 판정 인자는 요청에 실린 것으로 만든다 — webfetch 는 주소·형식', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { llm, ctx } = await start(await fakeOpencode('webchild'))
    const asked: PreTool[] = []
    ctx.on('llm/pre-tool', (info) => void asked.push(info))
    await llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, 'ask', (requests) => {
      if (requests[0]) void llm.reply(requests[0].sessionId, requests[0].id, 'once')
    })
    expect(asked).toEqual([expect.objectContaining({ tool: 'webfetch', input: { url: WEB_URL, format: 'text' }, child: true })])
    vi.restoreAllMocks()
  })

  it('glob·grep 도 같다 — 판정 인자는 요청에 실린 패턴·경로이고, 게이트가 건 요청이면 훅 통과 뒤 카드 없이 once', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const [ending, tool, input] of [['globchild', 'glob', GLOB_ARGS], ['grepchild', 'grep', GREP_ARGS]] as const) {
      const { llm, ctx } = await start(await fakeOpencode(ending))
      gatedPermissions = [tool]
      const asked: PreTool[] = []
      ctx.on('llm/pre-tool', (info) => void asked.push(info))
      const shown: Attention[][] = []
      const result = await llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, 'build', (requests) => void shown.push(requests))
      expect(result.ok, tool).toBe(true)
      expect(asked, tool).toEqual([expect.objectContaining({ tool, input, child: true })])
      expect(calls.filter((call) => call.startsWith('/permission/')), tool).toEqual(['/permission/per_c/reply {"reply":"once"}'])
      expect(shown, tool).toEqual([])
    }
    vi.restoreAllMocks()
  })

  it('목록이 정상이면 목록이 정본이다 — 같은 요청이 목록과 이벤트 양쪽에 있어도 카드는 하나, 경고도 없다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { llm } = await start(await fakeOpencode('permission'))
    const shown: Attention[][] = []
    const result = await llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, 'build', (requests) => {
      shown.push(requests)
      if (requests[0]) setTimeout(() => void llm.reply('ses_1', requests[0]!.id, 'once'), 120) // 그 사이 같은 요청의 이벤트가 한 번 더 온다
    })
    expect(result.ok).toBe(true)
    expect(shown).toEqual([[{ kind: 'permission', id: 'per_1', sessionId: 'ses_1', action: 'bash', resources: ['ls'] }], []])
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('ctx.llm 부른 대화 찾기·승인 기록 (이슈 #55, 01z 1-2·1-4)', () => {
  const SEND = { server: 'litecode', tool: 'send_to_project' }

  it('승인 카드에 그 도구 호출의 인자가 실린다(callID 로 running 파트에서). 앱에서 허용한 호출은 approved 이고 한 번 쓰면 소진된다', async () => {
    const url = await fakeOpencode('mcpask')
    const { llm } = await start(url)
    const shown: Attention[][] = []
    let caller: Awaited<ReturnType<LlmService['callerOf']>>
    let again: Awaited<ReturnType<LlmService['callerOf']>>
    const result = await llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, 'build', (requests) => {
      shown.push(requests)
      if (!requests[0]) return
      void llm.reply('ses_1', requests[0].id, 'once').then(async () => {
        caller = await llm.callerOf(directory, SEND, MCP_ARGS)
        again = await llm.callerOf(directory, SEND, MCP_ARGS, 30)
      })
    })
    expect(result.ok).toBe(true)
    expect(shown[0]).toEqual([
      { kind: 'permission', id: 'per_1', sessionId: 'ses_1', action: 'litecode_send_to_project', resources: ['*'], mcp: SEND, input: JSON.stringify(MCP_ARGS) },
    ])
    expect(caller).toEqual({ sessionId: 'ses_1', callId: 'call_1', child: false, approved: true })
    expect(again).toBeUndefined()
    expect(calls).toContain('/permission/per_1/reply {"reply":"once"}') // always 는 보내지 않는다
  })

  it('허용하며 고른 받을 대화(이슈 #67)는 장부에만 적힌다 — 엔진에 가는 답은 once 그대로, callerOf 가 그 대상을 준다', async () => {
    const url = await fakeOpencode('mcpask')
    const { llm } = await start(url)
    const target = { kind: 'conversation' as const, conversationId: 'conv-b' }
    let caller: Awaited<ReturnType<LlmService['callerOf']>>
    const result = await llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, 'build', (requests) => {
      if (!requests[0]) return
      void llm.reply('ses_1', requests[0].id, 'once', target).then(async () => {
        caller = await llm.callerOf(directory, SEND, MCP_ARGS)
      })
    })
    expect(result.ok).toBe(true)
    expect(caller).toEqual({ sessionId: 'ses_1', callId: 'call_1', child: false, approved: true, target })
    expect(calls.filter((call) => call.startsWith('/permission/'))).toEqual(['/permission/per_1/reply {"reply":"once"}'])
  })

  it('엔진 API 로 스스로 허용한 호출(앱의 reply 를 안 거침)은 찾아도 approved 가 아니다. 인자가 다르면 못 찾는다', async () => {
    const url = await fakeOpencode('mcpask')
    const { llm } = await start(url)
    let caller: Awaited<ReturnType<LlmService['callerOf']>>
    let other: Awaited<ReturnType<LlmService['callerOf']>>
    const result = await llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, 'build', (requests) => {
      if (!requests[0]) return
      // 폴더 코드가 엔진 비밀번호로 직접 허용한 것처럼
      void fetch(`${url}/permission/per_1/reply?directory=${encodeURIComponent(directory)}`, { method: 'POST', body: '{"reply":"once"}' }).then(async () => {
        other = await llm.callerOf(directory, SEND, { ...MCP_ARGS, message: 'something else' }, 30)
        caller = await llm.callerOf(directory, SEND, MCP_ARGS)
      })
    })
    expect(result.ok).toBe(true)
    expect(other).toBeUndefined()
    expect(caller).toEqual({ sessionId: 'ses_1', callId: 'call_1', child: false, approved: false })
  })

  it('도는 턴이 없으면(앱이 돌린 턴의 호출이 아니다) 못 찾는다', async () => {
    const { llm } = await start(await fakeOpencode('done'))
    expect(await llm.callerOf(directory, SEND, MCP_ARGS, 30)).toBeUndefined()
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

// 도구 실행 전 판정 (이슈 #102 2단계, 01af §6-1) — 엔진이 승인을 물으면 'llm/pre-tool' 을 한 번 묻고 답한다. 듣는 쪽(ctx.hooks)은 중립 레코드만 본다
describe("ctx.llm 도구 실행 전 판정 ('llm/pre-tool')", () => {
  type Decide = (info: PreTool) => PreToolDecision | undefined
  /** 판정을 정해 두고 턴 하나를 돌린다. gated: 가짜 엔진이 게이트를 건 권한 이름. 카드가 뜨면 answerAfterMs 뒤에 허용한다 */
  async function judged(ending: Ending, decide: Decide | undefined, opts: { gated?: string[]; mode?: 'build' | 'ask' | 'full'; answerAfterMs?: number } = {}) {
    const { llm, seen, ctx } = await start(await fakeOpencode(ending))
    gatedPermissions = opts.gated ?? []
    const asked: PreTool[] = []
    if (decide) ctx.on('llm/pre-tool', (info) => (asked.push(info), decide(info)))
    const shown: Attention[][] = []
    const result = await llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, opts.mode ?? 'build', (requests) => {
      shown.push(requests)
      if (requests[0]) setTimeout(() => void llm.reply('ses_1', requests[0]!.id, 'once'), opts.answerAfterMs ?? 0)
    })
    return { llm, seen, asked, shown, result, replies: calls.filter((call) => call.startsWith('/permission/')) }
  }

  it('요청마다 한 번 묻는다 — 도구 이름·인자는 그 callID 의 running 파트에서, 세션은 턴의 세션, 폴더는 realpath', async () => {
    const { asked } = await judged('mcpgate', () => 'allow', { gated: ['github_search'] })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ sessionId: 'ses_1', directory, tool: 'github_search', input: MCP_ARGS, child: false })
  })

  it('막기 → 엔진에 reject + 사유(message) — 카드·attention 없이 턴이 이어져 끝난다 (거절로 끝난 턴이 아니다)', async () => {
    const { result, shown, seen, replies } = await judged('permission', () => ({ deny: true, reason: 'rm -rf 는 금지' }), { gated: ['bash'] })
    expect(replies).toEqual(['/permission/per_1/reply {"reply":"reject","message":"rm -rf 는 금지"}'])
    expect(result).toMatchObject({ ok: true, text: 'went on' })
    expect(result.declined).toBeUndefined()
    expect(shown).toEqual([])
    expect(seen).toEqual([`started ses_1@${directory}`, `ended ses_1@${directory} done`])
  })

  it('막기는 게이트가 안 걸린 권한의 요청에도 먹는다 (모드가 원래 묻는 호출), 사유가 비면 기본 문구를 싣는다 — message 없는 reject 는 턴을 끝낸다', async () => {
    const { replies, shown } = await judged('permission', () => ({ deny: true, reason: ' ' }), { mode: 'ask' })
    expect(replies).toEqual(['/permission/per_1/reply {"reply":"reject","message":"Blocked before running."}'])
    expect(shown).toEqual([])
  })

  it('통과 + 게이트 때문에 온 요청(모드는 원래 묻지 않는다) → 묻지 않고 once', async () => {
    const { result, shown, seen, replies } = await judged('permission', () => 'allow', { gated: ['bash'] })
    expect(replies).toEqual(['/permission/per_1/reply {"reply":"once"}'])
    expect(result).toMatchObject({ ok: true, text: 'done' })
    expect(shown).toEqual([])
    expect(seen).toEqual([`started ses_1@${directory}`, `ended ses_1@${directory} done`])
  })

  it('판정한 쪽이 없어도(그 폴더엔 맞는 훅이 없다) 게이트 때문에 온 요청은 once — 전체 권한 모드도 같다', async () => {
    expect((await judged('permission', () => undefined, { gated: ['bash'] })).replies).toEqual(['/permission/per_1/reply {"reply":"once"}'])
    const full = await judged('permission', undefined, { gated: ['bash'], mode: 'full' })
    expect(full.replies).toEqual(['/permission/per_1/reply {"reply":"once"}'])
    expect(full.shown).toEqual([])
  })

  it('통과여도 모드가 원래 묻는 호출이면 승인 카드가 뜬다 (매번 묻기의 bash) — 통과는 사전 승인이 아니다', async () => {
    const { shown, replies, seen } = await judged('permission', () => 'allow', { gated: ['bash'], mode: 'ask' })
    expect(shown[0]).toEqual([{ kind: 'permission', id: 'per_1', sessionId: 'ses_1', action: 'bash', resources: ['ls'] }])
    expect(replies).toEqual(['/permission/per_1/reply {"reply":"once"}']) // 사용자가 카드에서 누른 것 하나뿐
    expect(seen).toContain(`attention ses_1@${directory} permission: bash ls`)
  })

  it('게이트가 안 걸린 권한의 요청은 통과여도 늘 카드다 — 모드나 사용자 설정이 원래 묻는 것이다', async () => {
    const { shown, asked } = await judged('permission', () => 'allow')
    expect(asked).toHaveLength(1)
    expect(shown[0]).toMatchObject([{ kind: 'permission', id: 'per_1' }])
  })

  it("'ask' 판정 → 게이트 때문에 온 요청이어도 승인 카드", async () => {
    const { shown, result } = await judged('permission', () => 'ask', { gated: ['bash'] })
    expect(shown[0]).toMatchObject([{ kind: 'permission', id: 'per_1' }])
    expect(result).toMatchObject({ ok: true, text: 'done' })
  })

  it('판정이 던지면 승인 카드로 내려앉는다 (사람이 정한다)', async () => {
    const boom: Decide = () => {
      throw new Error('boom')
    }
    const { shown } = await judged('permission', boom, { gated: ['bash'] })
    expect(shown[0]).toMatchObject([{ kind: 'permission', id: 'per_1' }])
  })

  it('카드가 떠 있는 동안 승인 신호가 다시 와도 같은 요청을 두 번 판정하지 않는다', async () => {
    const { asked, shown, result } = await judged('permission', () => 'ask', { gated: ['bash'], answerAfterMs: 150 })
    expect(result.ok).toBe(true)
    expect(asked).toHaveLength(1)
    expect(shown).toHaveLength(2) // 카드 한 번, 답한 뒤 빈 목록 한 번
  })

  it('한 호출이 승인을 두 번 물어도(폴더 밖 경로 → 그 도구의 권한) 판정은 한 번이다 — 폴더 밖은 모드가 원래 묻는 것이라 카드, 이어진 bash 는 once', async () => {
    const { asked, shown, replies, result } = await judged('twoasks', () => 'allow', { gated: ['bash'] })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ tool: 'bash', input: { command: 'ls /etc' } })
    expect(shown[0]).toMatchObject([{ kind: 'permission', id: 'per_0', action: 'external_directory' }])
    expect(shown.flat().map((entry) => entry.id)).toEqual(['per_0'])
    expect(replies).toEqual(['/permission/per_0/reply {"reply":"once"}', '/permission/per_1/reply {"reply":"once"}'])
    expect(result).toMatchObject({ ok: true, text: 'done' })
  })

  it('gateTools: 도는 턴이 없으면 바로 엔진에 넘기고, 도는 턴이 있으면 끝난 뒤로 미룬다 (엔진을 다시 띄우면 도는 턴이 끊긴다) — 마지막 것만', async () => {
    const { llm } = await start(await fakeOpencode('permission'))
    llm.gateTools(['bash'])
    expect(engineGates).toEqual([['bash']])
    const result = await llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, 'build', (requests) => {
      if (!requests[0]) return
      llm.gateTools(['bash', 'edit'])
      llm.gateTools(['edit'])
      expect(engineGates).toEqual([['bash']]) // 턴이 도는 중 — 아직
      void llm.reply('ses_1', requests[0].id, 'once')
    })
    expect(result.ok).toBe(true)
    expect(engineGates).toEqual([['bash'], ['edit']])
  })

  it('판정 통과로 보낸 once 는 사용자 승인이 아니다 — 호출 장부에 허용으로 적히지 않는다 (앱 MCP 세션 도구가 그 기록만 받는다, #55)', async () => {
    const { llm, ctx } = await start(await fakeOpencode('mcpgate'))
    gatedPermissions = ['github_search']
    ctx.on('llm/pre-tool', () => 'allow' as const)
    const turn = llm.chat('p', 'm', directory, 'hi', undefined, undefined, undefined, undefined, 'build')
    for (let tries = 0; tries < 200 && !calls.includes('/permission/per_1/reply {"reply":"once"}'); tries++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(calls).toContain('/permission/per_1/reply {"reply":"once"}')
    expect(await llm.callerOf(directory, { server: 'github', tool: 'search' }, MCP_ARGS)).toEqual({ sessionId: 'ses_1', callId: 'call_1', child: false, approved: false })
    expect((await turn).ok).toBe(true)
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

describe('옛 대화 이어 쓰기 (이슈 #21)', () => {
  afterEach(() => {
    previous = []
  })
  const v2 = [
    { id: 'msg_old_u', type: 'user', text: 'my name is ZED', time: { created: 1 } },
    { id: 'msg_old_a', type: 'assistant', agent: 'build', time: { created: 2, completed: 3 }, content: [{ type: 'text', text: 'hi ZED' }] },
  ]

  it('신규 세대 기록만 있는 세션의 첫 레거시 턴 직전에 옛 글을 합성·noReply 로 한 번 넣고, 다음 턴엔 안 넣는다', async () => {
    previous = v2
    const { llm } = await start(await fakeOpencode('done'))
    expect(await llm.chat('p', 'm', directory, 'what is my name', 'ses_1')).toMatchObject({ ok: true })
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toMatchObject({ noReply: true, model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text', synthetic: true }] })
    const injected = (prompts[0]!['parts'] as { text: string }[])[0]!.text
    expect(injected).toContain('user: my name is ZED\nassistant: hi ZED')
    expect(String(prompts[0]!['messageID']) < String(prompts[1]!['messageID'])).toBe(true) // 옛 글이 이번 입력보다 먼저 선다
    expect(prompts[1]).toMatchObject({ parts: [{ type: 'text', text: 'what is my name' }] })

    await llm.chat('p', 'm', directory, 'again', 'ses_1')
    expect(prompts).toHaveLength(3)
    expect(prompts[2]).not.toHaveProperty('noReply')
  })

  // 전수 검사 #126: 거절 기록(declined)을 턴 준비가 던지기 전에 적어 두면 거둘 곳이 없다
  it('옛 글 넣기가 실패해 턴이 시작도 못 하면 그 세션의 거절 기록이 남지 않는다', async () => {
    previous = v2
    const { llm } = await start(await fakeOpencode('reject'))
    expect((await llm.chat('p', 'm', directory, 'hi', 'ses_1')).ok).toBe(false)
    expect((llm as unknown as { declined: Map<string, unknown> }).declined.size).toBe(0)
  })

  it('`!` 카드를 먼저 보내도(addContext) 옛 글이 그 앞에 한 번 들어간다', async () => {
    previous = v2
    const { llm } = await start(await fakeOpencode('done'))
    const id = llm.newMessageId()
    expect(await llm.addContext('p', 'm', directory, '$ ls', id, 'ses_1')).toMatchObject({ ok: true })
    expect(prompts.map((prompt) => (prompt['parts'] as { synthetic?: boolean }[])[0]!.synthetic ?? false)).toEqual([true, false])
    await llm.chat('p', 'm', directory, 'next', 'ses_1')
    expect(prompts).toHaveLength(3)
  })

  it('새 세션·신규 기록이 없는 세션엔 아무것도 넣지 않는다', async () => {
    const { llm } = await start(await fakeOpencode('done'))
    await llm.chat('p', 'm', directory, 'hi')
    await llm.chat('p', 'm', directory, 'again', 'ses_1')
    expect(prompts.filter((prompt) => prompt['noReply'])).toEqual([])
  })

  it('다시 열면 신규 기록이 먼저 말풍선이 된다', async () => {
    previous = v2
    const { llm } = await start(await fakeOpencode('done'))
    const history = await llm.history(directory, 'ses_1')
    expect(history.messages.map(({ role, text }) => `${role}:${text}`)).toEqual(['user:my name is ZED', 'assistant:hi ZED'])
  })
})
