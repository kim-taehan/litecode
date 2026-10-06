import type { Context } from 'cordis'
import path from 'node:path'
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
  projectId,
  QUEUE_LIMIT,
  READ_CLIP,
  READ_TOOL,
  READ_TURNS_MAX,
  SEND_TOOL,
  shortIds,
  WAIT_SECONDS_MAX,
  wrapInstruction,
} from '../../../../shared/delegation.ts'
import type { AttentionTarget, Conversation, HistoryMessage, Project } from '../../../../shared/contract.ts'
import '../../appMcp.ts'
import '../../chat.ts'
import '../../sessions.ts'
import '../../projects.ts'
import '../../providers.ts'

// 세션 도구 셋 (이슈 #55·#137 — 설계·실측 _workspace/01z_desktop_mcp.md 3-3·3-4·3-5): AI 가 **다른 프로젝트**를 보고(list·read) 지시를 보낸다(send).
// 대상은 등록된 프로젝트(ctx.projects) 가운데 호출이 온 주소의 프로젝트(URL 의 프로젝트 키 → directory)가 아닌 것, 그 각각에서 **사용자가 마지막에
// 보던 대화 하나**다 (사용자 결정 2026-10-06, ctx.sessions.lastViewed). 같은 프로젝트의 대화는 목록에도 없고, 새 대화를 만드는 도구도 없다.
// 대상에서 빠지는 프로젝트: 폴더가 없어졌다 · 마지막에 보던 대화가 없거나 지워졌다(다른 대화로 대신하지 않는다) · 엔진에 넘길 수 없는 폴더(#101)
//
// 보내기·읽기는 세 겹으로 지킨다:
// 1. 엔진 권한 — ask 라 부를 때마다 승인 카드가 뜬다 (engine.ts 의 규칙. 계획 모드에는 보내기가 없고, 하위 작업에는 둘 다 없다)
// 2. 부른 대화 — 호출 요청에는 "누가 불렀나" 가 없어 ctx.llm.callerOf 로 그 폴더의 도는 턴에서 찾는다. 못 찾으면(앱이 돌린 턴이 아니다) 거절,
//    하위 작업이 불렀으면 거절
// 3. 앱 확인 — 사용자가 **앱의 승인 카드에서** 허용한 호출만 받는다 (caller.approved). 엔진 비밀번호를 쥔 폴더 코드가 엔진 API 로 스스로
//    허용한 호출은 기록이 없어 거절된다
// 그리고 보내기는 깊이 1(지시를 받아 도는 턴은 다시 지시하지 못한다)·한 턴에 5번·받는 대화 대기열 5개.
//
// 받는 쪽: 받는 대화는 **자기 프로젝트 폴더·자기 모델·자기 모드**로 움직인다 — 보내는 쪽 권한이 넘어가지 않는다. 쉬면 그 자리에서 턴이 되고 돌고
// 있으면 대기열에 들어간다 (ctx.chat.send — 출처가 다른 것끼리는 합치지 않는다). 결과는 기다리지 않고 곧바로 "받았다" 만 돌려준다 — 답은
// read_project 로 읽는다. 끝나도 보낸 대화 맥락에 자동으로 넣지 않는다(연쇄가 된다).
// 설명·결과 글은 모델이 읽는다 — 화면 언어와 무관하게 영어. 프로젝트 이름·대화 제목·본문은 원문 그대로
//
// 받을 프로젝트는 사용자가 고른다 (이슈 #67): 승인 카드에서 고른 프로젝트의 대화가 허용 기록에 실려 온다(caller.target — 화면 → ctx.chat.reply →
// ctx.llm.reply → 장부). 있으면 도구 인자(AI 가 고른 프로젝트) 대신 그것으로 보낸다. 화면이 보낸 값이라 자격(다른 프로젝트의 마지막에 보던 대화·
// 모델 있음·대기열 상한)을 여기서 다시 본다. 대상이 바뀌었으면 결과 글이 실제 대상과 그 id 를 말한다 — 모델이 read_project 를 바뀐 프로젝트에
// 부르게. 결과 글에는 받은 대화의 짧은 id(c-…)도 실린다 — 화면의 진행 줄이 그 대화를 가리킨다 (renderer/delegationView.ts 가 이 글을 읽는다)

const UNKNOWN = 'Unknown project. Use an id from list_projects.'
const NO_CALLER = 'Could not tell which conversation made this call. Call the tool again.'

/** read_project 가 글 하나를 자른다 */
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

/** list_projects 의 한 줄 — 프로젝트(id·이름·폴더)와 그 프로젝트에서 마지막에 보던 대화(제목·상태·모드·마지막 활동) */
export function projectLine(id: string, project: Pick<Project, 'name' | 'path'>, conversation: Conversation, state: SessionState, queued: number, now: number): string {
  const shown = queued > 0 ? `${state} (${queued} queued)` : state
  return `${id} · "${project.name}" · ${project.path} · conversation "${conversation.title}" · ${shown} · mode ${conversation.mode ?? DEFAULT_MODE} · ${agoText(conversation.updatedAt, now)}`
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

/** 다른 프로젝트 하나와 그 프로젝트에서 마지막에 보던 대화 */
interface Target {
  /** 모델에게 보이는 프로젝트 id (p-…) */
  id: string
  project: Project
  conversation: Conversation
  /** 엔진에 넘길 수 없는 폴더면 그 사유 (#101) — 목록에는 없고, 보내거나 읽으면 이 사유로 거절한다 */
  problem?: string
}

export function SessionTools(ctx: Context): void {
  /** 그 프로젝트(realpath)의 대화 — 저장된 project 는 사용자가 고른 경로 그대로라 realpath 로 맞춰 본다 */
  async function inProject(directory: string): Promise<Conversation[]> {
    const all = await ctx.sessions.list()
    const real = new Map<string, string | undefined>()
    for (const project of new Set(all.map((entry) => entry.project))) real.set(project, project === directory ? directory : await realDirectory(project))
    return all.filter((entry) => real.get(entry.project) === directory)
  }

  /** 보내는 프로젝트(directory, realpath)가 아닌 등록된 프로젝트와 그 각각의 마지막에 보던 대화 — 폴더가 없어졌거나 그 대화가 없으면(본 적 없다·
   *  지워졌다) 빠진다. 경로는 realpath 로 맞춰 본다 (inProject 와 같은 이유) */
  async function others(directory: string): Promise<Target[]> {
    const all = await ctx.sessions.list()
    const viewed = new Map<string, string>()
    for (const [project, id] of Object.entries(await ctx.sessions.lastViewed())) {
      const real = await realDirectory(project)
      if (real) viewed.set(real, id)
    }
    const targets: Target[] = []
    for (const project of await ctx.projects.list()) {
      const real = await realDirectory(project.path)
      if (!real || real === directory) continue
      const conversation = all.find((entry) => entry.id === viewed.get(real))
      if (!conversation) continue
      const problem = await ctx.llm.folderProblem(real)
      targets.push({ id: projectId(project.path), project, conversation, ...(problem && { problem }) })
    }
    return targets
  }

  function pick(targets: readonly Target[], id: unknown): Target | undefined {
    return typeof id === 'string' ? targets.find((entry) => entry.id === id.trim()) : undefined
  }

  /** 쓸 수 있는 대상만 — 없으면 missing 을, 엔진에 넘길 수 없는 폴더면 그 사유를 던진다 */
  function usable(target: Target | undefined, missing: string): Target {
    if (!target) throw new Error(missing)
    if (target.problem) throw new Error(`Target project cannot be used (${target.problem}).`)
    return target
  }

  function stateOf(id: string): SessionState {
    const turn = ctx.chat.turnOf(id)
    return !turn ? 'idle' : turn.waiting ? 'waiting for the user' : 'running'
  }

  /** 그 대화의 짧은 id (c-…) — 저장된 대화 전부를 한 묶음으로 (화면도 같은 묶음으로 푼다) */
  async function shortOf(id: string): Promise<string> {
    return shortIds((await ctx.sessions.list()).map((entry) => entry.id)).get(id) ?? id
  }

  /** 보내기·읽기 도구를 부른 호출 — 본 세션이 불렀고 사용자가 앱에서 허용했어야 한다. 안 되면 그 사유를 던진다 (모델이 읽는다) */
  async function approved(directory: string, tool: string, args: Record<string, unknown>, refused: string) {
    const caller = await ctx.llm.callerOf(directory, { server: APP_MCP_NAME, tool }, args)
    if (!caller) throw new Error(NO_CALLER)
    if (caller.child) throw new Error('Sub-tasks cannot reach other projects.')
    if (!caller.approved) throw new Error(`This call was not approved by the user in litecode. ${refused}`)
    return caller
  }

  /** 보내기 도구를 부른 대화 — 자격(본 세션·앱에서 허용·깊이 1)을 다 보고 준다. chosen 은 허용하며 사용자가 고른 받을 대화 (없으면 도구 인자대로) */
  async function sender(directory: string, args: Record<string, unknown>): Promise<{ from: Conversation; chosen?: Extract<AttentionTarget, { kind: 'conversation' }> }> {
    const caller = await approved(directory, SEND_TOOL, args, 'Nothing was sent.')
    const found = (await inProject(directory)).find((entry) => entry.engineSessionId === caller.sessionId)
    const turn = found && ctx.chat.turnOf(found.id)
    if (!found || !turn) throw new Error(NO_CALLER)
    if (turn.origin.startsWith('session:')) throw new Error('This turn was started by another conversation and cannot delegate further.')
    return { from: found, ...(caller.target?.kind === 'conversation' && { chosen: caller.target }) }
  }

  /** 보내는 프로젝트의 이름 — 받는 대화의 딱지·감싼 글에 보인다. 목록에서 빠진 폴더면 폴더 이름 */
  async function nameOf(directory: string): Promise<string> {
    for (const project of await ctx.projects.list()) if ((await realDirectory(project.path)) === directory) return project.name
    return path.basename(directory)
  }

  /** 그 프로젝트의 마지막에 보던 대화에 보낸다 — 자격을 보고(모델·대기열 상한) 쉬면 턴으로, 돌고 있으면 대기열로. 받는 대화의 폴더·모델·모드는
   *  그 대화에 저장된 것 그대로다 (ctx.chat 이 저장된 대화에서 읽는다). redirected: 사용자가 AI 와 다른 프로젝트를 골랐다 */
  async function sendTo(directory: string, from: Conversation, target: Target, message: string, redirected: boolean): Promise<string> {
    const to = target.conversation
    if (!to.model || !ctx.providers.get(to.model.providerId)?.models.some((model) => model.id === to.model!.modelId)) throw new Error('Target conversation has no usable model.')
    const waiting = ctx.chat.queued(to.id)
    if (waiting >= QUEUE_LIMIT) throw new Error(`Target queue is full (${waiting} waiting). Use read_project to check on it and try again later.`)
    if (!ctx.chat.countSend(from.id, MAX_SENDS_PER_TURN)) throw new Error(`Too many instructions sent in this turn (the limit is ${MAX_SENDS_PER_TURN}).`)
    const ahead = Math.max(1, waiting + (ctx.chat.turnOf(to.id) ? 1 : 0))
    const project = await nameOf(directory)
    const result = await ctx.chat.send(to.id, {
      text: wrapInstruction({ project, title: from.title }, message),
      display: message,
      origin: originOfConversation(from.id),
      from: { conversationId: from.id, title: from.title, project },
    })
    const where = `its conversation "${to.title}" (${await shortOf(to.id)})`
    if (redirected) {
      const note = result.state === 'sent' ? '' : ` It is busy, so the instruction is queued (${ahead} ahead).`
      return `Accepted. The user chose a different project: "${target.project.name}" (id ${target.id}).${note} It runs in ${where}. Use this project id with read_project.`
    }
    const name = `"${target.project.name}" (${target.id})`
    return result.state === 'sent' ? `Accepted. ${name} started working on it in ${where}.` : `Accepted and queued — ${name} is busy (${ahead} ahead). It will run in ${where}.`
  }

  const list: AppMcpTool = {
    name: LIST_TOOL,
    description:
      'List the other litecode projects that can receive an instruction: id, name, folder, and the conversation the user last viewed there (title, state, mode, last activity). Use before send_to_project or read_project.',
    inputSchema: { type: 'object', properties: {} },
    async run(_args, { directory }) {
      const targets = (await others(directory)).filter((entry) => !entry.problem)
      if (targets.length === 0) return 'No other project can receive an instruction. Only projects where the user has viewed a conversation are listed; this project is never listed.'
      const now = Date.now()
      return targets
        .slice(0, LIST_MAX)
        .map((entry) => projectLine(entry.id, entry.project, entry.conversation, stateOf(entry.conversation.id), ctx.chat.queued(entry.conversation.id), now))
        .join('\n')
    },
  }

  const read: AppMcpTool = {
    name: READ_TOOL,
    description:
      'Read the state, last request and final answer (no tool output) of the conversation the user last viewed in another project. The user must approve each read. Use after send_to_project; pass wait_seconds instead of calling repeatedly.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project id from list_projects (p-…).' },
        turns: { type: 'number', description: `Last turns to return (1-${READ_TURNS_MAX}, default 1).` },
        wait_seconds: { type: 'number', description: `Seconds to wait for a running turn to finish (0-${WAIT_SECONDS_MAX}).` },
      },
      required: ['project'],
    },
    async run(args, { directory }) {
      await approved(directory, READ_TOOL, args, 'Nothing was read.')
      const { conversation } = usable(pick(await others(directory), args['project']), UNKNOWN)
      const wait = bounded(args['wait_seconds'], 0, 0, WAIT_SECONDS_MAX)
      if (wait > 0) await ctx.chat.waitIdle(conversation.id, wait * 1000)
      // 어느 대화를 읽었나 — 보낸 뒤 사용자가 그 프로젝트에서 다른 대화를 봤으면 받은 대화(보내기 결과의 c-…)와 다를 수 있다
      const head = `conversation: "${conversation.title}" (${await shortOf(conversation.id)})`
      const state = stateOf(conversation.id)
      if (state === 'running') return `${head}\nstate: running — call again later`
      if (state === 'waiting for the user') return `${head}\nstate: waiting for the user — it is blocked on an approval or a question in that conversation. Call again later.`
      const history = await ctx.sessions.history(conversation.id)
      if (history.missingFolder) throw new Error('Target project cannot be used (its folder is missing).')
      if (history.error) throw new Error(`Target project cannot be used (${history.error}).`)
      const turns = lastTurns(history.messages, bounded(args['turns'], 1, 1, READ_TURNS_MAX))
      return `${head}\nstate: idle\n${turns || '(no messages yet)'}`
    },
  }

  const send: AppMcpTool = {
    name: SEND_TOOL,
    description:
      'Send an instruction to **another project** in litecode. It goes to the conversation the user last viewed in that project, which runs in its own folder and mode — this conversation\'s permissions do not carry over. The user must approve each send and may pick a different project. Returns once accepted, without the answer — use read_project later. That conversation does not see this one, so the message must be self-contained. Do not use it for work you can do yourself, and never to reach another project in order to bypass a permission.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project id from list_projects (p-…).' },
        message: { type: 'string', description: `The instruction. Self-contained, at most ${MESSAGE_MAX} characters.` },
      },
      required: ['project', 'message'],
    },
    async run(args, { directory }) {
      const { from, chosen } = await sender(directory, args)
      const message = text(args, 'message', MESSAGE_MAX)
      const targets = await others(directory)
      const asked = pick(targets, args['project'])
      if (!chosen) return sendTo(directory, from, usable(asked, UNKNOWN), message, false)
      // 화면이 보낸 대화 id 라 다른 프로젝트의 마지막에 보던 대화일 때만 (지워졌거나 이 프로젝트의 대화·그사이 다른 대화를 봤으면 거절).
      // AI 가 고른 것과 같은 프로젝트면 바뀐 것이 아니다 (AI 가 준 id 가 틀렸어도 사용자가 고른 프로젝트로 간다)
      const to = usable(
        targets.find((entry) => entry.conversation.id === chosen.conversationId),
        'The project the user chose is not available (its conversation was deleted or is no longer the one last viewed there). Nothing was sent.',
      )
      return sendTo(directory, from, to, message, to !== asked)
    },
  }

  for (const tool of [list, read, send]) ctx.effect(() => ctx.appMcp.register(tool))
}
SessionTools.inject = ['appMcp', 'chat', 'llm', 'sessions', 'projects', 'providers']
