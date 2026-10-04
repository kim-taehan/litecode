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
import { titleFrom } from '../../../../shared/chat.ts'
import type { AttentionTarget, Conversation, HistoryMessage } from '../../../../shared/contract.ts'
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
//
// 받을 대화는 사용자가 고른다 (이슈 #67): 승인 카드에서 고른 대상이 허용 기록에 실려 온다(caller.target — 화면 → ctx.chat.reply → ctx.llm.reply →
// 장부). 있으면 도구 인자(AI 가 고른 대상) 대신 그것으로 보낸다 — 기존 대화 ↔ 다른 기존 대화 ↔ 새 대화 어느 쪽으로든. 화면이 보낸 값이라
// 자격(같은 프로젝트·자기 자신 아님·지워지지 않음·모델 있음·대기열 상한)을 여기서 다시 본다. 대상이 바뀌었으면 결과 글이 실제 대상과 그 id 를
// 말한다 — 모델이 read_session 을 바뀐 대화에 부르게, 화면의 진행 줄이 실제 대상을 가리키게 (renderer/delegationView.ts 가 이 글을 읽는다)

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

  /** 보내기 도구를 부른 대화 — 자격(본 세션·앱에서 허용·깊이 1·턴당 횟수)을 다 보고 준다. 안 되면 그 사유를 던진다 (모델이 읽는다).
   *  chosen 은 허용하며 사용자가 고른 받을 대화 (없으면 도구 인자대로) */
  async function sender(directory: string, tool: string, args: Record<string, unknown>, conversations: readonly Conversation[]): Promise<{ from: Conversation; chosen?: AttentionTarget }> {
    const caller = await ctx.llm.callerOf(directory, { server: APP_MCP_NAME, tool }, args)
    if (!caller) throw new Error(NO_CALLER)
    if (caller.child) throw new Error('Sub-tasks cannot send instructions to other conversations.')
    if (!caller.approved) throw new Error('This call was not approved by the user in litecode. Nothing was sent.')
    const found = conversations.find((entry) => entry.engineSessionId === caller.sessionId)
    const turn = found && ctx.chat.turnOf(found.id)
    if (!found || !turn) throw new Error(NO_CALLER)
    if (turn.origin.startsWith('session:')) throw new Error('This turn was started by another conversation and cannot delegate further.')
    return { from: found, ...(caller.target && { chosen: caller.target }) }
  }

  /** 기존 대화에 보낸다 — 자격을 보고(자기 자신·폴더·모델·대기열 상한) 쉬면 턴으로, 돌고 있으면 대기열로. redirected: 사용자가 AI 와 다른 대화를 골랐다 */
  async function sendTo(conversations: readonly Conversation[], from: Conversation, to: Conversation, message: string, redirected: boolean): Promise<string> {
    if (to.id === from.id) throw new Error('Cannot send to this conversation itself.')
    if (!(await realDirectory(to.project))) throw new Error('Target conversation cannot be used (its project folder is missing).')
    if (!to.model || !ctx.providers.get(to.model.providerId)?.models.some((model) => model.id === to.model!.modelId)) throw new Error('Target conversation has no usable model.')
    const waiting = ctx.chat.queued(to.id)
    if (waiting >= QUEUE_LIMIT) throw new Error(`Target queue is full (${waiting} waiting). Use read_session to check on it and try again later.`)
    count(from.id)
    const ids = shortIds(conversations.map((entry) => entry.id))
    const ahead = Math.max(1, waiting + (ctx.chat.turnOf(to.id) ? 1 : 0))
    const result = await ctx.chat.send(to.id, {
      text: wrapInstruction({ id: ids.get(from.id)!, title: from.title }, message),
      display: message,
      origin: originOfConversation(from.id),
      from: { conversationId: from.id, title: from.title },
    })
    const short = ids.get(to.id)!
    if (redirected) {
      const note = result.state === 'sent' ? '' : ` It is busy, so the instruction is queued (${ahead} ahead).`
      return `Accepted. The user chose a different conversation: "${to.title}" (id ${short}).${note} Use this id with read_session.`
    }
    const name = `"${to.title}" (${short})`
    return result.state === 'sent' ? `Accepted. ${name} started working on it.` : `Accepted and queued — ${name} is busy (${ahead} ahead).`
  }

  /** 새 대화를 만들어 보낸다 — 보낸 대화의 모델·모드를 물려받는다(권한이 오르지 않는다). title 이 없으면 보낼 글의 첫 줄(기존 자동 제목 규칙) */
  async function startNew(conversations: readonly Conversation[], from: Conversation, message: string, title: string | undefined, redirected: boolean): Promise<string> {
    count(from.id)
    const id = randomUUID()
    const ids = shortIds([...conversations.map((entry) => entry.id), id])
    await ctx.chat.send(id, {
      text: wrapInstruction({ id: ids.get(from.id)!, title: from.title }, message),
      display: message,
      ...(title && { title }),
      project: from.project,
      model: from.model,
      mode: from.mode,
      origin: originOfConversation(from.id),
      from: { conversationId: from.id, title: from.title },
    })
    const shown = title ?? titleFrom(message)
    if (redirected) return `Accepted. The user chose to start a new conversation instead: "${shown}" (id ${ids.get(id)}). Use this id with read_session.`
    return `Started "${shown}" (${ids.get(id)}). Use read_session to collect the result.`
  }

  /** 사용자가 고른 기존 대화 — 화면이 보낸 id 라 이 프로젝트의 저장된 대화일 때만 (지워졌거나 다른 프로젝트·없는 id 면 거절) */
  function chosenConversation(conversations: readonly Conversation[], id: string): Conversation {
    const found = conversations.find((entry) => entry.id === id)
    if (!found) throw new Error('The conversation the user chose is not available (deleted or not in this project). Nothing was sent.')
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
      const { from, chosen } = await sender(directory, SEND_TOOL, args, conversations)
      const message = text(args, 'message', MESSAGE_MAX)
      // 사용자가 새 대화를 골랐다 — 제목은 보낼 글의 첫 줄
      if (chosen?.kind === 'new') return startNew(conversations, from, message, undefined, true)
      if (!chosen) return sendTo(conversations, from, target(conversations, args['session']), message, false)
      const to = chosenConversation(conversations, chosen.conversationId)
      // AI 가 고른 것과 같은 대화면 바뀐 것이 아니다 (AI 가 준 id 가 틀렸어도 사용자가 고른 대화로 간다)
      const asked = typeof args['session'] === 'string' ? resolveShortId(conversations.map((entry) => entry.id), args['session']) : undefined
      return sendTo(conversations, from, to, message, to.id !== asked)
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
      const { from, chosen } = await sender(directory, START_TOOL, args, conversations)
      const message = text(args, 'message', MESSAGE_MAX)
      // 사용자가 기존 대화를 골랐다 — 새 대화의 제목(title 인자)은 버린다
      if (chosen?.kind === 'conversation') return sendTo(conversations, from, chosenConversation(conversations, chosen.conversationId), message, true)
      return startNew(conversations, from, message, text(args, 'title', START_TITLE_MAX).trim(), false)
    },
  }

  for (const tool of [list, read, send, start]) ctx.effect(() => ctx.appMcp.register(tool))
}
SessionTools.inject = ['appMcp', 'chat', 'llm', 'sessions', 'providers']
