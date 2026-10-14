import type { Context } from 'cordis'
import { realDirectory } from '../../projectPath.ts'
import { APP_MCP_NAME } from '../../mcp.ts'
import type { AppMcpTool } from '../rpc.ts'
import { DEFAULT_MODE } from '../../../../shared/modes.ts'
import {
  LIST_MAX,
  LIST_TOOL,
  MESSAGE_MAX,
  READ_CLIP,
  READ_TOOL,
  READ_TURNS_MAX,
  SEND_TOOL,
  WAIT_SECONDS_MAX,
  shortIds,
} from '../../../../shared/delegation.ts'
import type { AttentionTarget, Conversation, HistoryMessage, Project } from '../../../../shared/contract.ts'
import type { DelegationTarget } from '../../delegation.ts'
import '../../appMcp.ts'
import '../../chat.ts'
import '../../delegation.ts'
import '../../sessions.ts'
import '../../projects.ts'
import '../../providers.ts'

// 세션 도구 셋 (이슈 #55·#137 — 설계·실측 _workspace/01z_desktop_mcp.md 3-3·3-4·3-5): AI 가 **다른 프로젝트**를 보고(list·read) 지시를 보낸다(send).
// 대상은 등록된 프로젝트(ctx.projects) 가운데 호출이 온 주소의 프로젝트(URL 의 프로젝트 키 → directory)가 아닌 것, 그 각각에서 **사용자가 마지막에
// 보던 대화**다 (사용자 결정 2026-10-06, ctx.sessions.lastViewed) — 그게 목록·기본 대상의 기준. 같은 프로젝트의 대화는 목록에도 없고, 새 대화를
// 만들 **도구**도 없다. **받는 대화는 사용자가 고른다**(#348, 선택지가 넓어진 것 #351) — 승인 카드가 각 프로젝트(보내는 프로젝트 포함)의
// 대화 목록과 **새 대화** 줄을 보여 주므로, 고른 것은 다른 대화·이 프로젝트의 대화·새 대화(new-conversation)가 될 수 있다. 고른 것이 허용
// 기록(caller.target)에 실려 오면 그 대상(등록된 프로젝트인지는 includeSelf 대상 목록)으로 이쪽에서 다시 보고 보낸다 — 새 대화면
// ctx.delegation.send(newConversation) 가 그 프로젝트의 대화 모델·모드로 만든다. read_project 도 결과의 짧은 id(c-…)로 그 받은 대화를
// 지정해 읽을 수 있다 (이 프로젝트로 간 것은 읽을 수 없다 — 그 목록엔 이 프로젝트가 없으므로).
// 대상에서 빠지는 프로젝트: 폴더가 없어졌다 · 마지막에 보던 대화가 없거나 지워졌다(다른 대화로 대신하지 않는다) · 엔진에 넘길 수 없는 폴더(#101)
//
// 보내기는 세 겹으로, 읽기는 두 겹으로 지킨다:
// 1. 엔진 권한 — 보내기: ask 라 부를 때마다 승인 카드가 뜬다 (engine.ts 의 규칙. 계획 모드에는 없고, 하위 작업에는 없다). 읽기: 모드 에이전트에는
//    allow(카드 없음) — "읽기도 매번 승인해야 되니?" 에 안 된다고(사용자 결정 2026-10-06). 매번 묻기 모드만 와일드카드 ask 로 묻는다
// 2. 부른 대화 — 호출 요청에는 "누가 불렀나" 가 없어 ctx.llm.callerOf 로 그 폴더의 도는 턴에서 찾는다. 못 찾으면(앱이 돌린 턴이 아니다) 거절,
//    하위 작업이 부른 거면 거절
// 3. 앱 확인(보내기만) — 사용자가 **앱의 승인 카드에서** 허용한 호출만 받는다 (caller.approved). 엔진 비밀번호를 쥔 폴더 코드가 엔진 API 로 스스로
//    허용한 호출은 기록이 없어 거절된다. 읽기는 카드가 없으니 이 요소를 뗐다(#342 — 카드 없이 allow 인 모드에서 승인이 기록될 일이 없어 읽기가
//    영원히 거부되던 것)
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

/** 다른 프로젝트 하나와 그 프로젝트에서 마지막에 보던 대화 — 대상·자격의 단일 결정지는 ctx.delegation (화면의 Projects 탭과 공유, #341) */
type Target = DelegationTarget

export function SessionTools(ctx: Context): void {
  /** 그 프로젝트(realpath)의 대화 — 저장된 project 는 사용자가 고른 경로 그대로라 realpath 로 맞춰 본다 */
  async function inProject(directory: string): Promise<Conversation[]> {
    const all = await ctx.sessions.list()
    const real = new Map<string, string | undefined>()
    for (const project of new Set(all.map((entry) => entry.project))) real.set(project, project === directory ? directory : await realDirectory(project))
    return all.filter((entry) => real.get(entry.project) === directory)
  }

  /** 보내는 프로젝트가 아닌 등록된 프로젝트와 그 각각의 마지막에 보던 대화 — ctx.delegation 에서 (화면의 Projects 탭과 같은 규칙) */
  function others(directory: string): Promise<Target[]> {
    return ctx.delegation.targets(directory)
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

  /** 등록 대상(보내는 프로젝트 포함, #351)의 realpath → 대상 (사용자가 고른 대화가 그 프로젝트의 것인지 보는 것, #348) */
  async function targetByRealpath(directory: string): Promise<Map<string, Target>> {
    const map = new Map<string, Target>()
    for (const target of await ctx.delegation.targets(directory, true)) {
      const real = await realDirectory(target.project.path)
      if (real) map.set(real, target)
    }
    return map
  }

  /** 보내기·읽기 도구를 부른 호출 — 본 세션이(하는 중인 턴이) 부른 것인지만 본다. 안 되면 그 사유를 던진다 (모델이 읽는다) */
  async function caller(directory: string, tool: string, args: Record<string, unknown>) {
    const found = await ctx.llm.callerOf(directory, { server: APP_MCP_NAME, tool }, args)
    if (!found) throw new Error(NO_CALLER)
    if (found.child) throw new Error('Sub-tasks cannot reach other projects.')
    return found
  }

  /** 보내기 도구를 부른 호출 — 위 확인에 사용자가 앱의 승인 카드에서 허용했음(caller.approved)이 더해진다 */
  async function approved(directory: string, tool: string, args: Record<string, unknown>, refused: string) {
    const found = await caller(directory, tool, args)
    if (!found.approved) throw new Error(`This call was not approved by the user in litecode. ${refused}`)
    return found
  }

  /** 보내기 도구를 부른 대화 — 자격(본 세션·앱에서 허용·깊이 1)을 다 보고 준다. chosen 은 허용하며 사용자가 고른 받을 곳(없는 대화·새 대화,
   *  #348·#351 — 없으면 도구 인자대로) */
  async function sender(directory: string, args: Record<string, unknown>): Promise<{ from: Conversation; chosen?: Extract<AttentionTarget, { kind: 'conversation' | 'new-conversation' }> }> {
    const caller = await approved(directory, SEND_TOOL, args, 'Nothing was sent.')
    const found = (await inProject(directory)).find((entry) => entry.engineSessionId === caller.sessionId)
    const turn = found && ctx.chat.turnOf(found.id)
    if (!found || !turn) throw new Error(NO_CALLER)
    if (turn.origin.startsWith('session:')) throw new Error('This turn was started by another conversation and cannot delegate further.')
    const target = caller.target
    const chosen = target?.kind === 'conversation' || target?.kind === 'new-conversation' ? target : undefined
    return { from: found, ...(chosen && { chosen }) }
  }

  /** 그 프로젝트에 보낸다 — 자격(대상·모델·대기열·한 턴 수)과 전송은 ctx.delegation 에서, 결과 **글**은 여기서.
   *  conversationId: 사용자가 카드에서 고른 대화 (없으면 대상의 마지막에 보던 대화). fresh: 새 대화에 보내는 것 (#351). redirected: 사용자가
   *  AI 와 다른 프로젝트를 골랐다 (같은 프로젝트의 다른 대화·새 대화는 redirect 가 아니다 — 결과 글의 `conversation "…" (c-…)` 가 실제
   *  받은 대화를 말하니까). 이 프로젝트(보내는 쪽)로 우회하면 read_project 로 읽을 수 없으니(목록에 이 프로젝트가 없음) 그렇게 말하지 않는다 */
  async function sendTo(directory: string, from: Conversation, target: Target, message: string, redirected: boolean, conversationId?: string, fresh = false): Promise<string> {
    const sent = await ctx.delegation.send({ directory, from: { id: from.id, title: from.title }, targetId: target.id, ...(conversationId && { conversationId }), ...(fresh && { newConversation: true }), message, count: true })
    const name = `"${target.project.name}" (${target.id})`
    const where = `${fresh ? 'a new conversation' : 'its conversation'} "${sent.conversationTitle}" (${sent.shortId})`
    if (redirected) {
      const note = sent.state === 'sent' ? '' : ` It is busy, so the instruction is queued (${sent.ahead} ahead).`
      if ((await realDirectory(target.project.path)) === (await realDirectory(directory))) {
        return `Accepted. The user chose a conversation in this project: "${target.project.name}" (id ${target.id}).${note} It runs in ${where}.`
      }
      return `Accepted. The user chose a different project: "${target.project.name}" (id ${target.id}).${note} It runs in ${where}. Use this project id with read_project.`
    }
    return sent.state === 'sent' ? `Accepted. ${name} started working on it in ${where}.` : `Accepted and queued — ${name} is busy (${sent.ahead} ahead). It will run in ${where}.`
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
      const shown = targets.slice(0, LIST_MAX)
      // (#353) — 잘린 것이 있으면 조용히 하지 않는다: 목록 뒤에 남은 개수를 알려 준다
      const rest = targets.length - shown.length
      const lines = shown.map((entry) => projectLine(entry.id, entry.project, entry.conversation, stateOf(entry.conversation.id), ctx.chat.queued(entry.conversation.id), now)).join('\n')
      return rest > 0 ? `${lines}\n… and ${rest} more not listed.` : lines
    },
  }

  const read: AppMcpTool = {
    name: READ_TOOL,
    description:
      'Read the state, last request and final answer (no tool output) of a conversation in another project. By default it reads the conversation the user last viewed there; pass `conversation` (a short id like c-xxxxxxxx or a full id, from the send or read result) to read the conversation that received the instruction. No approval is needed. Use after send_to_project; pass wait_seconds instead of calling repeatedly.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project id from list_projects (p-…).' },
        conversation: { type: 'string', description: 'Conversation to read: full id or short id (c-…) from the send or read result. Defaults to the conversation last viewed in that project.' },
        turns: { type: 'number', description: `Last turns to return (1-${READ_TURNS_MAX}, default 1).` },
        wait_seconds: { type: 'number', description: `Seconds to wait for a running turn to finish (0-${WAIT_SECONDS_MAX}).` },
      },
      required: ['project'],
    },
    async run(args, { directory }) {
      await caller(directory, READ_TOOL, args)
      const target = usable(pick(await others(directory), args['project']), UNKNOWN)
      let conversation = target.conversation
      const wanted = typeof args['conversation'] === 'string' ? args['conversation'].trim() : ''
      if (wanted) {
        // 그 프로젝트의 대화인가 — 짧은 id(c-… , 보낸 결과를 읽은 것)와 풀 id 둘 다
        const rows = await inProject((await realDirectory(target.project.path)) ?? target.project.path)
        const ids = shortIds(rows.map((entry) => entry.id))
        const row = rows.find((entry) => entry.id === wanted || ids.get(entry.id) === wanted)
        if (!row) throw new Error('No such conversation in that project. Use the full id or the short id (c-…) from the send result.')
        conversation = row
      }
      const wait = bounded(args['wait_seconds'], 0, 0, WAIT_SECONDS_MAX)
      if (wait > 0) await ctx.chat.waitIdle(conversation.id, wait * 1000)
      // 어느 대화를 읽었나 — 보낸 뒤 사용자가 그 프로젝트에서 다른 대화를 봤으면 받은 대화(보내기 결과의 c-…)와 다를 수 있다
      const head = `conversation: "${conversation.title}" (${await ctx.delegation.shortOf(conversation.id)})`
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
      'Send an instruction to **another project** in litecode. It goes to a conversation in that project, which runs in its own folder and mode — this conversation\'s permissions do not carry over. The user must approve each send; the approval card lists each project and its conversations, and the user picks the project and the conversation (or a new conversation — this project\'s own conversations are options too; read_project cannot read this project). Returns once accepted, without the answer — it names the receiving conversation (title, short id like c-xxxxxxxx), which you pass to read_project\'s `conversation` parameter to check on it. That conversation does not see this one, so the message must be self-contained. Do not use it for work you can do yourself, and never to reach another project in order to bypass a permission.',
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
      // AI 가 고른 프로젝트는 목록 기준(다른 프로젝트)으로만 본다 — 이 프로젝트의 id 를 직접 달아 보내는 것은 못 된다
      const asked = pick(await others(directory), args['project'])
      if (!chosen) return sendTo(directory, from, usable(asked, UNKNOWN), message, false)
      if (chosen.kind === 'new-conversation') {
        // 새 대화 (카드, #351) — 그 프로젝트가 등록 대상(이 프로젝트 포함)인지 본다
        const to = usable(pick(await ctx.delegation.targets(directory, true), chosen.projectId), 'The project for the new conversation is not available. Nothing was sent.')
        const redirected = !asked || to.id !== asked.id
        return sendTo(directory, from, to, message, redirected, undefined, true)
      }
      // 화면이 고른 대화 (카드, #348·#351) — 다른 프로젝트의 대화면 그 프로젝트가 실제 대상이고, **이 프로젝트의 대화도** 허용된다.
      // 지워진 대화·등록된 프로젝트가 아니면 거절. AI 가 고른 프로젝트의 대화(같은 프로젝트의 다른 대화 포함)면 바뀐 것이 아니다
      // (AI 가 준 id 가 틀렸어도 사용자가 고른 쪽으로 간다)
      const picked = (await ctx.sessions.list()).find((entry) => entry.id === chosen.conversationId)
      if (!picked) throw new Error('The conversation the user chose no longer exists. Nothing was sent.')
      const to = usable((await targetByRealpath(directory)).get(await realDirectory(picked.project) ?? ''), 'The project of the conversation the user chose is not available. Nothing was sent.')
      const redirected = !asked || to.id !== asked.id
      return sendTo(directory, from, to, message, redirected, chosen.conversationId)
    },
  }

  for (const tool of [list, read, send]) ctx.effect(() => ctx.appMcp.register(tool))
}
SessionTools.inject = ['appMcp', 'chat', 'llm', 'sessions', 'projects', 'providers', 'delegation']
