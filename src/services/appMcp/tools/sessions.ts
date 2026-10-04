import type { Context } from 'cordis'
import { randomUUID } from 'node:crypto'
import { realDirectory } from '../../llm.ts'
import { APP_MCP_NAME } from '../../mcp.ts'
import type { AppMcpTool } from '../rpc.ts'
import { DEFAULT_MODE } from '../../../../shared/modes.ts'
import {
  LIST_MAX,
  LIST_TOOL,
  MAX_SENDS_PER_TURN,
  MESSAGE_MAX,
  originOfConversation,
  QUEUE_LIMIT,
  READ_CLIP,
  READ_TOOL,
  READ_TURNS_MAX,
  resolveShortId,
  SEND_TOOL,
  shortIds,
  START_TITLE_MAX,
  START_TOOL,
  WAIT_SECONDS_MAX,
  wrapInstruction,
} from '../../../../shared/delegation.ts'
import type { Conversation, HistoryMessage } from '../../../../shared/contract.ts'
import '../../appMcp.ts'
import '../../chat.ts'
import '../../sessions.ts'
import '../../providers.ts'

// 세션 도구 넷 (이슈 #55 — 설계·실측 _workspace/01z_desktop_mcp.md 3-3·3-4·3-5): AI 가 같은 프로젝트의 다른 대화를 보고(list·read) 지시를
// 보낸다(send·start). 범위는 호출이 온 주소의 프로젝트(URL 의 프로젝트 키 → directory) 하나다 — 다른 프로젝트의 대화는 목록에도 없다.
//
// 보내기 둘은 세 겹으로 지킨다:
// 1. 엔진 권한 — 모든 모드에서 ask 라 보낼 때마다 승인 카드가 뜬다 (engine.ts 의 규칙. 계획 모드·하위 작업에는 도구가 없다)
// 2. 부른 대화 — 호출 요청에는 "누가 불렀나" 가 없어 ctx.llm.callerOf 로 그 폴더의 도는 턴에서 찾는다. 못 찾으면(앱이 돌린 턴이 아니다) 거절,
//    하위 작업이 불렀으면 거절
// 3. 앱 확인 — 사용자가 **앱의 승인 카드에서** 허용한 호출만 보낸다 (caller.approved). 엔진 비밀번호를 쥔 폴더 코드가 엔진 API 로 스스로
//    허용한 호출은 기록이 없어 거절된다
// 그리고 깊이 1(지시를 받아 도는 턴은 다시 지시하지 못한다)·한 턴에 보내기 5번·받는 대화 대기열 5개.
//
// 받는 쪽: 쉬면 그 자리에서 턴이 되고 돌고 있으면 대기열에 들어간다 (ctx.chat.send — 출처가 다른 것끼리는 합치지 않는다). 결과는 기다리지 않고
// 곧바로 "받았다" 만 돌려준다 — 답은 read_session 으로 읽는다. 끝나도 보낸 대화 맥락에 자동으로 넣지 않는다(연쇄가 된다).
// 설명·결과 글은 모델이 읽는다 — 화면 언어와 무관하게 영어. 대화 제목·본문은 원문 그대로

const UNKNOWN = 'Unknown session. Use an id from list_sessions.'
const NO_CALLER = 'Could not tell which conversation made this call. Call the tool again.'

/** read_session 이 글 하나를 자른다 */
export function clip(text: string, max = READ_CLIP): string {
  return text.length > max ? `${text.slice(0, max)}…[truncated ${text.length - max} chars]` : text
}

/** 마지막 활동이 얼마나 전인가 (영어, 모델용) */
export function agoText(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

export type SessionState = 'idle' | 'running' | 'waiting for the user'

/** list_sessions 의 한 줄 */
export function sessionLine(short: string, conversation: Conversation, state: SessionState, queued: number, now: number, self: boolean): string {
  const shown = queued > 0 ? `${state} (${queued} queued)` : state
  return `${short} · "${conversation.title}" · ${shown} · mode ${conversation.mode ?? DEFAULT_MODE} · ${agoText(conversation.updatedAt, now)}${self ? ' (this conversation)' : ''}`
}

/** 말풍선 목록의 마지막 count 턴 — 요청(내 말)과 그 답. 도구 출력은 없다 (답의 글만) */
export function lastTurns(messages: readonly HistoryMessage[], count: number): string {
  const turns: { user: string; answer?: string }[] = []
  for (const message of messages) {
    if (message.role === 'user') turns.push({ user: message.text })
    else if (turns.length > 0) turns[turns.length - 1]!.answer = message.error ? `[${message.interrupted ? 'interrupted' : 'failed'}: ${message.error}]` : message.text
  }
  return turns
    .slice(-count)
    .map((turn) => `user: ${clip(turn.user)}\nanswer: ${turn.answer === undefined ? '(no answer yet)' : clip(turn.answer)}`)
    .join('\n\n')
}

function text(args: Record<string, unknown>, name: string, max: number): string {
  const value = args[name]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`)
  if (value.length > max) throw new Error(`${name} is too long (${value.length} characters, the limit is ${max}).`)
  return value
}

/** 0 이상 max 이하의 정수로 — 못 쓰는 값은 fallback */
function bounded(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback
}

export function SessionTools(ctx: Context): void {
  /** 그 프로젝트(realpath)의 대화 — 저장된 project 는 사용자가 고른 경로 그대로라 realpath 로 맞춰 본다 */
  async function inProject(directory: string): Promise<Conversation[]> {
    const all = await ctx.sessions.list()
    const real = new Map<string, string | undefined>()
    for (const project of new Set(all.map((entry) => entry.project))) real.set(project, project === directory ? directory : await realDirectory(project))
    return all.filter((entry) => real.get(entry.project) === directory)
  }

  function stateOf(id: string): SessionState {
    const turn = ctx.chat.turnOf(id)
    return !turn ? 'idle' : turn.waiting ? 'waiting for the user' : 'running'
  }

  function target(conversations: readonly Conversation[], short: unknown): Conversation {
    const id = typeof short === 'string' ? resolveShortId(conversations.map((entry) => entry.id), short) : undefined
    const found = conversations.find((entry) => entry.id === id)
    if (!found) throw new Error(UNKNOWN)
    return found
  }

  /** 보내기 도구를 부른 대화 — 자격(본 세션·앱에서 허용·깊이 1·턴당 횟수)을 다 보고 준다. 안 되면 그 사유를 던진다 (모델이 읽는다) */
  async function sender(directory: string, tool: string, args: Record<string, unknown>, conversations: readonly Conversation[]): Promise<Conversation> {
    const caller = await ctx.llm.callerOf(directory, { server: APP_MCP_NAME, tool }, args)
    if (!caller) throw new Error(NO_CALLER)
    if (caller.child) throw new Error('Sub-tasks cannot send instructions to other conversations.')
    if (!caller.approved) throw new Error('This call was not approved by the user in litecode. Nothing was sent.')
    const found = conversations.find((entry) => entry.engineSessionId === caller.sessionId)
    const turn = found && ctx.chat.turnOf(found.id)
    if (!found || !turn) throw new Error(NO_CALLER)
    if (turn.origin !== 'user') throw new Error('This turn was started by another conversation and cannot delegate further.')
    return found
  }

  function count(senderId: string): void {
    if (!ctx.chat.countSend(senderId, MAX_SENDS_PER_TURN)) throw new Error(`Too many instructions sent in this turn (the limit is ${MAX_SENDS_PER_TURN}).`)
  }

  const list: AppMcpTool = {
    name: LIST_TOOL,
    description:
      'List the conversations of this project in litecode: id, title, state (idle / running / waiting for the user), mode and last activity. Use before sending an instruction to another conversation or reading its result.',
    inputSchema: { type: 'object', properties: {} },
    async run(args, { directory }) {
      const conversations = await inProject(directory)
      if (conversations.length === 0) return 'No conversations in this project yet.'
      // 부른 대화 표시는 덤이다 — 못 찾아도 목록은 준다 (짧게만 기다린다)
      const caller = await ctx.llm.callerOf(directory, { server: APP_MCP_NAME, tool: LIST_TOOL }, args, 300)
      const ids = shortIds(conversations.map((entry) => entry.id))
      const now = Date.now()
      return [...conversations]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, LIST_MAX)
        .map((entry) => sessionLine(ids.get(entry.id)!, entry, stateOf(entry.id), ctx.chat.queued(entry.id), now, !!caller && !caller.child && entry.engineSessionId === caller.sessionId))
        .join('\n')
    },
  }

  const read: AppMcpTool = {
    name: READ_TOOL,
    description:
      'Read what another conversation of this project said: its state and the last user request and final answer. Does not include tool output. Use after send_to_session to collect the result; pass wait_seconds to wait for a running turn to finish instead of calling repeatedly.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Conversation id from list_sessions (c-…).' },
        turns: { type: 'number', description: `How many of the last turns to return. Default 1, at most ${READ_TURNS_MAX}.` },
        wait_seconds: { type: 'number', description: `Wait up to this many seconds for a running turn to finish (0-${WAIT_SECONDS_MAX}). Default 0.` },
      },
      required: ['session'],
    },
    async run(args, { directory }) {
      const conversation = target(await inProject(directory), args['session'])
      const wait = bounded(args['wait_seconds'], 0, 0, WAIT_SECONDS_MAX)
      if (wait > 0) await ctx.chat.waitIdle(conversation.id, wait * 1000)
      const state = stateOf(conversation.id)
      if (state === 'running') return 'state: running — call again later'
      if (state === 'waiting for the user') return 'state: waiting for the user — it is blocked on an approval or a question in that conversation. Call again later.'
      const history = await ctx.sessions.history(conversation.id)
      if (history.missingFolder) throw new Error('Target conversation cannot be used (its project folder is missing).')
      if (history.error) throw new Error(`Target conversation cannot be used (${history.error}).`)
      const turns = lastTurns(history.messages, bounded(args['turns'], 1, 1, READ_TURNS_MAX))
      return turns ? `state: idle\n${turns}` : 'state: idle\n(no messages yet)'
    },
  }

  const send: AppMcpTool = {
    name: SEND_TOOL,
    description:
      'Send an instruction to **another existing conversation** of this project. The user must approve each send. It returns as soon as the instruction is accepted — it does not wait for the answer; use read_session later. The other conversation has its own history and does not see this one, so the message must be self-contained. Do not use it for work you can do yourself, and never to reach a conversation in order to bypass a permission.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Conversation id from list_sessions (c-…).' },
        message: { type: 'string', description: `The instruction. Self-contained, at most ${MESSAGE_MAX} characters.` },
      },
      required: ['session', 'message'],
    },
    async run(args, { directory }) {
      const conversations = await inProject(directory)
      const from = await sender(directory, SEND_TOOL, args, conversations)
      const message = text(args, 'message', MESSAGE_MAX)
      const to = target(conversations, args['session'])
      if (to.id === from.id) throw new Error('Cannot send to this conversation itself.')
      if (!(await realDirectory(to.project))) throw new Error('Target conversation cannot be used (its project folder is missing).')
      if (!to.model || !ctx.providers.get(to.model.providerId)?.models.some((model) => model.id === to.model!.modelId)) throw new Error('Target conversation has no usable model.')
      const waiting = ctx.chat.queued(to.id)
      if (waiting >= QUEUE_LIMIT) throw new Error(`Target queue is full (${waiting} waiting). Use read_session to check on it and try again later.`)
      count(from.id)
      const ids = shortIds(conversations.map((entry) => entry.id))
      const ahead = waiting + (ctx.chat.turnOf(to.id) ? 1 : 0)
      const result = await ctx.chat.send(to.id, {
        text: wrapInstruction({ id: ids.get(from.id)!, title: from.title }, message),
        display: message,
        origin: originOfConversation(from.id),
        from: { conversationId: from.id, title: from.title },
      })
      const name = `"${to.title}" (${ids.get(to.id)})`
      return result.state === 'sent' ? `Accepted. ${name} started working on it.` : `Accepted and queued — ${name} is busy (${Math.max(1, ahead)} ahead).`
    },
  }

  const start: AppMcpTool = {
    name: START_TOOL,
    description:
      "Start a **new conversation** in this project with a first instruction. Same rules as send_to_session: the user must approve it, it returns as soon as the instruction is accepted, and the message must be self-contained. The new conversation uses this conversation's model and mode.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: `Short title for the new conversation, at most ${START_TITLE_MAX} characters.` },
        message: { type: 'string', description: `The first instruction. Self-contained, at most ${MESSAGE_MAX} characters.` },
      },
      required: ['title', 'message'],
    },
    async run(args, { directory }) {
      const conversations = await inProject(directory)
      const from = await sender(directory, START_TOOL, args, conversations)
      const title = text(args, 'title', START_TITLE_MAX).trim()
      const message = text(args, 'message', MESSAGE_MAX)
      count(from.id)
      const id = randomUUID()
      const ids = shortIds([...conversations.map((entry) => entry.id), id])
      // 보낸 대화의 모델·모드를 물려받는다 — 권한이 오르지 않는다
      await ctx.chat.send(id, {
        text: wrapInstruction({ id: ids.get(from.id)!, title: from.title }, message),
        display: message,
        title,
        project: from.project,
        model: from.model,
        mode: from.mode,
        origin: originOfConversation(from.id),
        from: { conversationId: from.id, title: from.title },
      })
      return `Started "${title}" (${ids.get(id)}). Use read_session to collect the result.`
    },
  }

  for (const tool of [list, read, send, start]) ctx.effect(() => ctx.appMcp.register(tool))
}
SessionTools.inject = ['appMcp', 'chat', 'llm', 'sessions', 'providers']
