// 턴 중 진행 줄 (생각·도구·글·지시문) — opencode 이벤트를 화면이 그리는 중립 모양(TurnItem)으로 바꾼다. 화면은 opencode 이벤트
// 이름을 모른다. opencode 형식을 아는 것은 이 파일과 llm.ts 뿐이다 — 엔진을 바꾸면 이것도 바꾼다.
//
// 레거시 경로 실측 (2026-10-02, opencode 1.18.18, _workspace/01w_legacy_migration.md 1절 — 이슈 #13 L1):
// - 이벤트는 `GET /event?directory=` 의 `{type, properties}`. 한 프롬프트가 만든 assistant 메시지는 모두 `info.parentID = 그 user messageID` 다
//   → TurnScope 가 그것으로 이 턴 메시지를 가린다 (같은 세션에 다른 클라이언트가 보낸 턴·자식 세션은 섞이지 않는다)
// - 글·생각: `message.part.updated{part:{type:"text"|"reasoning", id, messageID, text, time:{start,end?}}}` 가 시작(빈 글)과 끝(완성본, time.end)에
//   오고, 그 사이 `message.part.delta{messageID, partID, field, delta}` 가 온다. ⚠️ delta 의 field 는 생각에서도 "text" 다 → partID → 종류 표로 가른다
// - 사용자 메시지의 글도 text part.updated 로 온다(에코) → assistant 메시지 것만 줄로 만든다
// - 도구: 같은 part id 를 덮어쓴다 — pending{input:{}} → running{input, time.start} → (bash) running{metadata.output: 누적 출력} 여러 번 →
//   completed{output, metadata, time} | error{error(문자열)}
// - 줄 순서는 처음 나타난 순서다 (Map 삽입 순서)
// - 파일을 바꾼 도구의 diffs 는 state.metadata 에서 (toolDiffs.ts — 경로는 세션 폴더 기준 상대로)
// 자동 요약 (이슈 #20 L2 실측, 가짜 LLM — 한도를 넘은 스텝 뒤·게이트웨이의 한도 초과 오류 뒤 둘 다 같은 모양):
//   user(파트 `compaction{auto, overflow}`) → assistant(parentID = 그 user, agent "compaction", **summary:true**, 요약 글이 진행 이벤트로 흐른다)
//   → user(합성 "Continue…" 글, metadata.compaction_continue — 게이트웨이 오류였으면 그 앞 user 의 복사본일 수 있다) → session.compacted
//   → 그 user 에 대한 답 → idle. 요약이 실패하면 summary 답이 error(ContextOverflowError) 로 끝나고 이어지는 user 없이 idle
//   → TurnScope 는 이 턴 안에서 opencode 가 만든 요약 user 와 그 뒤 user 하나를 이 턴 것으로 받는다 (그 답이 이 턴 답이다)
// 하위 작업 (task 도구, 이슈 #31 실측 2026-10-02 opencode 1.18.18 — 가짜 LLM `[calls:…]` 로 한 응답에 task 2~3개):
// - 한 메시지의 task 들은 **동시에** 돈다(각 자식 bash sleep 3 이 같은 0.1초 안에 시작·끝, 3/3). 자식마다 세션 하나 — `session.created{info.parentID = 부모}`,
//   제목 "<description> (@<agent> subagent)". 부모 task 파트는 pending{input:{}} → running{input:{subagent_type, description, prompt},
//   metadata:{parentSessionId, sessionId(자식), model}, time.start} → completed{output "<task id=…><task_result>…"} | error("Task cancelled" 등)
// - 자식 이벤트는 같은 /event?directory= 에 자식 sessionID 로 온다 — 모양은 부모와 같다(user 에코 → assistant → 파트, 자식 session.idle 도 온다)
//   → TurnTracker.child 가 자식마다 따로 진행 줄을 쌓아 그 task 의 subtask 줄 안에 넣는다. 부모 턴 끝은 부모 sessionID 의 idle 만 본다(llm.ts)
// - 자식 토큰은 부모 턴 합계에 넣지 않는다 (dsh ui-subagent 처럼 자식 줄에 따로 — 부모 컨텍스트 % 가 자식 대화로 부풀지 않게)

import path from 'node:path'
import { toolDiffs } from './toolDiffs.ts'
import { skillSource } from '../../shared/skills.ts'
import type { TurnItem, Subtask, ToolSkill, McpToolRef, TodoItem, PresentedFile } from '../../shared/contract.ts'

// 화면에 실리는 타입의 정의는 shared/contract.ts 에 있다 (모바일 앱과 같이 쓴다 — 이슈 #42). 여기서는 다시 내보내기만 한다
export type { TurnItem, Subtask, ToolSkill, McpToolRef } from '../../shared/contract.ts'

type Props = Record<string, unknown>

/** 엔진 도구 이름 → MCP 서버·도구 (MCP 가 아니면 undefined) */
export type McpToolResolver = (name: string) => McpToolRef | undefined

/** 밑줄이 든 내장 도구 — MCP 도구(`<서버>_<도구>`)로 읽으면 안 된다. list/read_mcp_* 는 MCP 리소스를 읽는 내장 도구다 (01u 실측 2) */
const BUILTIN_UNDERSCORE_TOOLS = new Set([
  'apply_patch',
  'list_mcp_resources',
  'read_mcp_resource',
  'list_mcp_resource_templates',
  'plan_enter',
  'plan_exit',
  // 권한 이름 (승인 카드의 action 도 같은 함수로 가른다)
  'external_directory',
  'doom_loop',
])

/** opencode 가 MCP 도구 이름을 만들 때 서버·도구 이름의 [A-Za-z0-9_-] 밖 글자를 `_` 로 바꾼다 (#28 실측: 서버 rem-1 + 도구 remote-dash.tool → rem-1_remote-dash_tool) */
export function sanitizeMcpName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_')
}

/** MCP 도구 이름 `<서버>_<도구>` 를 가른다. servers(그 폴더에 붙은 서버 이름)가 맞으면 그것을(가장 긴 것부터 — 서버 이름에도 `_` 가 있을 수 있다),
 *  아니면(서버를 지웠거나 아직 모름) 첫 `_` 에서 가른다. 내장 도구는 MCP 가 아니다 */
export function mcpToolOf(name: string, servers: readonly string[] = []): McpToolRef | undefined {
  if (!name.includes('_') || BUILTIN_UNDERSCORE_TOOLS.has(name)) return undefined
  const match = [...servers].sort((a, b) => b.length - a.length).find((server) => name.startsWith(`${sanitizeMcpName(server)}_`))
  if (match) return { server: match, tool: name.slice(sanitizeMcpName(match).length + 1) }
  const cut = name.indexOf('_')
  return cut > 0 && cut < name.length - 1 ? { server: name.slice(0, cut), tool: name.slice(cut + 1) } : undefined
}

/** 레거시 메시지 파트 중 우리가 읽는 필드 (01w 실측) */
export interface EnginePart {
  id?: string
  sessionID?: string
  messageID?: string
  type: string
  text?: string
  synthetic?: boolean
  time?: { start?: number; end?: number }
  /** tool */
  tool?: string
  callID?: string
  state?: {
    status?: string
    input?: unknown
    output?: string
    error?: string
    /** bash: output(실시간 누적)·exit. edit: filediff. write: filepath·exists. apply_patch: files (toolDiffs.ts) */
    metadata?: { output?: unknown; exit?: unknown; [key: string]: unknown }
    time?: { start?: number; end?: number }
  }
  /** step-finish */
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  reason?: string
  /** compaction 파트 (자동 요약을 시작한 user 메시지) */
  auto?: boolean
  overflow?: boolean
  /** file 파트 (user 메시지의 첨부 — 01y). url 은 data: 통째(이미지 한 장에 수 MB)이거나 file:// */
  mime?: string
  filename?: string
  url?: string
}

/** 레거시 메시지 정보 중 우리가 읽는 필드 */
export interface EngineMessageInfo {
  id: string
  sessionID?: string
  role: 'user' | 'assistant'
  parentID?: string
  agent?: string
  /** assistant 의 summary:true 는 자동 요약 답이다 (user 는 {diffs} 객체) */
  summary?: unknown
  time?: { created?: number; completed?: number }
  error?: { name?: string; data?: { message?: string; statusCode?: number } }
  /** user: 그 프롬프트에 실은 system (앱이 넣는 프로젝트 지시문 — instructions.ts) */
  system?: string
  /** assistant: 그 스텝의 토큰 (step-finish 와 같은 값) */
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
}

/** 이 턴(내가 보낸 user 메시지)에 속한 이벤트를 가린다. 답 메시지는 message.updated 의 parentID 로 배운다 — 답의 파트보다 먼저 온다 (01w 실측).
 *  자동 요약: 이 턴 안에서 opencode 가 만든 요약 user(compaction 파트)와 그 뒤 user 하나(Continue·복사본)도 이 턴의 user 로 받는다 —
 *  그 user 들의 답도 이 턴 답이다. 요약 답(summary:true)은 'summary' 로 따로 준다 (글을 답으로 그리면 안 된다) */
export class TurnScope {
  /** 내 user 메시지와 이 턴 것으로 받은 user 메시지 */
  private readonly users = new Set<string>()
  private readonly assistants = new Set<string>()
  private readonly summaries = new Set<string>()
  /** 이 턴 중 본, 아직 이 턴 것인지 모르는 user 메시지 (요약 user 는 message.updated 뒤에 compaction 파트가 와야 안다) */
  private readonly strangers = new Set<string>()
  /** 내 user 메시지를 봤다 — 그 전의 user 는 앞 턴 것이다 */
  private started = false
  /** 요약 user 를 받았다 — 다음 user 메시지가 그 이음(Continue·복사본)이다. 요약이 실패하면 이음이 없다 */
  private awaitingContinuation = false

  constructor(
    readonly sessionId: string,
    readonly userMessageId: string,
  ) {
    this.users.add(userMessageId)
  }

  /** 이 턴의 user 메시지 이벤트면 'user', 답이면 'assistant', 요약 답이면 'summary', 아니면 undefined */
  of(type: string, props: Props): 'user' | 'assistant' | 'summary' | undefined {
    if (type === 'message.updated') {
      const info = props['info'] as EngineMessageInfo | undefined
      if (!info || info.sessionID !== this.sessionId) return undefined
      if (info.role === 'user') {
        if (info.id === this.userMessageId) this.started = true
        if (this.users.has(info.id)) return 'user'
        if (this.started && this.awaitingContinuation) {
          this.awaitingContinuation = false
          this.users.add(info.id)
          return 'user'
        }
        if (this.started) this.strangers.add(info.id)
        return undefined
      }
      if (info.parentID !== undefined && this.users.has(info.parentID) && !this.summaries.has(info.id) && !this.assistants.has(info.id)) {
        ;(info.summary === true ? this.summaries : this.assistants).add(info.id)
      }
      if (this.summaries.has(info.id)) {
        if (info.error) this.awaitingContinuation = false // 요약 실패 — 이음 없이 끝난다
        return 'summary'
      }
      return this.assistants.has(info.id) ? 'assistant' : undefined
    }
    const part = type === 'message.part.updated' ? (props['part'] as EnginePart | undefined) : undefined
    const messageId = part ? part.messageID : type === 'message.part.delta' ? props['messageID'] : undefined
    if (typeof messageId !== 'string' || props['sessionID'] !== this.sessionId) return undefined
    if (part?.type === 'compaction' && this.strangers.delete(messageId)) {
      this.users.add(messageId)
      this.awaitingContinuation = true
    }
    if (this.users.has(messageId)) return 'user'
    if (this.summaries.has(messageId)) return 'summary'
    return this.assistants.has(messageId) ? 'assistant' : undefined
  }

  /** 이 턴의 답 메시지인가 (승인·질문 요청의 tool.messageID 를 가린다) */
  owns(messageId: string | undefined): boolean {
    return messageId !== undefined && this.assistants.has(messageId)
  }
}

/** 한 턴의 진행 줄을 쥐고, 이 턴 답 메시지의 이벤트 하나마다 바뀐 줄을 준다 (없으면 undefined). 걸러 넣는 것은 TurnScope */
export class TurnTracker {
  private readonly items = new Map<string, TurnItem>()
  /** partID → 줄 id (delta 는 partID 만 싣는다) */
  private readonly ids = new Map<string, string>()
  /** 재시도 줄 순번 — 한 번 다시 보내고 나서 또 재시도하면 새 줄 */
  private retries = 0
  /** 이 턴의 하위 작업 자식 세션 → 그 진행 줄. taskId 는 그 자식을 띄운 task 줄 (task 파트의 metadata.sessionId 로 잇는다) */
  private readonly children = new Map<string, { taskId?: string; tracker: TurnTracker; assistants: Set<string>; tokens: number }>()

  /** root: 세션 폴더(realpath) — 바꾼 파일 경로를 그 기준 상대로 보인다. mcp: 도구 이름 → MCP 서버·도구 */
  constructor(
    private readonly root = '',
    private readonly mcp?: McpToolResolver,
  ) {}

  /** 이 턴이 띄운 자식 세션을 안다 (session.created 의 parentID 또는 task 파트의 metadata.sessionId) — 그 뒤로 child 가 그 이벤트를 받는다 */
  adoptChild(sessionId: string): void {
    if (!this.children.has(sessionId)) this.children.set(sessionId, { tracker: new TurnTracker(this.root, this.mcp), assistants: new Set(), tokens: 0 })
  }

  isChild(sessionId: unknown): boolean {
    return typeof sessionId === 'string' && this.children.has(sessionId)
  }

  /** 그 자식 세션을 띄운 하위 작업 줄 (승인·질문 카드가 어느 하위 작업인지 보일 때) */
  subtaskOf(sessionId: string): Subtask | undefined {
    const taskId = this.children.get(sessionId)?.taskId
    const item = taskId === undefined ? undefined : this.items.get(taskId)
    return item?.kind === 'subtask' ? item : undefined
  }

  /** 그 하위 작업 줄이 도는 자식 세션 (이 턴의 줄이 아니거나 자식을 아직 모르면 undefined) — 하위 작업 하나만 멈출 때 (#32) */
  childSession(subtaskId: string): string | undefined {
    for (const [sessionId, child] of this.children) if (child.taskId === subtaskId) return sessionId
    return undefined
  }

  /** 자식 세션의 이벤트 하나 → 바뀐 하위 작업 줄 (없으면 undefined). 자식의 user 에코는 버리고 assistant 파트만 쌓는다 (부모와 같은 규칙) */
  child(type: string, props: Props): TurnItem | undefined {
    const info = props['info'] as EngineMessageInfo | undefined
    const part = props['part'] as EnginePart | undefined
    const child = this.children.get(String(props['sessionID'] ?? info?.sessionID ?? part?.sessionID))
    if (!child) return undefined
    if (type === 'message.updated') {
      if (info?.role === 'assistant') child.assistants.add(info.id)
      return undefined
    }
    const messageId = part ? part.messageID : props['messageID']
    if (typeof messageId !== 'string' || !child.assistants.has(messageId)) return undefined
    if (part?.type === 'step-finish') {
      child.tokens += tokenTotal(part.tokens)
      return this.refreshSubtask(child)
    }
    return child.tracker.observe(type, props) ? this.refreshSubtask(child) : undefined
  }

  private refreshSubtask(child: { taskId?: string; tracker: TurnTracker; tokens: number }): TurnItem | undefined {
    const task = child.taskId === undefined ? undefined : this.items.get(child.taskId)
    if (task?.kind !== 'subtask') return undefined
    const item: Subtask = { ...task, items: child.tracker.list(), ...(child.tokens > 0 && { tokens: child.tokens }) }
    this.items.set(item.id, item)
    return item
  }

  /** 지금까지의 줄 (처음 나타난 순서) */
  list(): TurnItem[] {
    return [...this.items.values()]
  }

  observe(type: string, props: Props): TurnItem | undefined {
    if (type === 'message.part.updated') {
      const part = props['part'] as EnginePart
      let item = partItem(part, false, this.root, this.mcp)
      if (!item) return undefined
      if (item.kind === 'subtask') {
        // task 파트가 자식을 알려 준다 — 자식 줄을 이 줄에 잇고, 이미 쌓인 자식 줄을 싣는다 (파트 갱신이 자식 줄을 지우지 않게)
        const sessionId = part.state?.metadata?.['sessionId']
        if (typeof sessionId === 'string') {
          this.adoptChild(sessionId)
          this.children.get(sessionId)!.taskId = item.id
        }
        const child = [...this.children.values()].find((entry) => entry.taskId === item!.id)
        if (child) item = { ...item, items: child.tracker.list(), ...(child.tokens > 0 && { tokens: child.tokens }) }
      }
      this.ids.set(part.id ?? '', item.id)
      const previous = this.items.get(item.id)
      if (previous && (previous.kind === 'think' || previous.kind === 'text') && previous.done) return undefined
      if (previous && JSON.stringify(previous) === JSON.stringify(item)) return undefined
      // 시작(빈 글)이 조각보다 늦게 와도 쌓인 조각을 지우지 않는다
      if (previous && (item.kind === 'think' || item.kind === 'text') && !item.done && item.text === '' && previous.kind === item.kind) return undefined
      this.items.set(item.id, item)
      return item
    }
    if (type === 'message.part.delta') {
      const id = this.ids.get(String(props['partID']))
      const previous = id ? this.items.get(id) : undefined
      if (!previous || (previous.kind !== 'think' && previous.kind !== 'text') || previous.done) return undefined
      const item: TurnItem = { ...previous, text: previous.text + String(props['delta'] ?? '') }
      this.items.set(item.id, item)
      return item
    }
    return undefined
  }

  /** 자동 요약 줄 — 요약 user 메시지 하나에 하나 (그 user 의 compaction 파트가 오면 running, 요약 답이 끝나면 done, 오류면 failed) */
  compaction(userMessageId: string, status: Extract<TurnItem, { kind: 'compaction' }>['status']): TurnItem | undefined {
    const id = `${userMessageId}:compaction`
    const previous = this.items.get(id)
    if (previous?.kind === 'compaction' && (previous.status === status || previous.status !== 'running')) return undefined
    const item: TurnItem = { kind: 'compaction', id, status }
    this.items.set(id, item)
    return item
  }

  /** 엔진 상태(session.status) — retry 면 재시도 줄을 세우거나 고치고, 다시 busy 면 그 줄을 끝낸다 */
  status(status: { type?: string; attempt?: number; message?: string } | undefined): TurnItem | undefined {
    const id = `retry:${this.retries}`
    const previous = this.items.get(id)
    if (status?.type === 'retry') {
      const item: TurnItem = { kind: 'retry', id, attempt: status.attempt ?? 1, message: status.message ?? '', status: 'waiting' }
      this.items.set(id, item)
      return item
    }
    if (previous?.kind !== 'retry' || previous.status !== 'waiting') return undefined
    const item: TurnItem = { ...previous, status: 'done' }
    this.items.set(id, item)
    this.retries++
    return item
  }

  /** 이 턴 답의 글 — 글 줄을 나타난 순서대로 잇는다 (도구 결과·생각은 빼고) */
  text(): string {
    return [...this.items.values()].map((item) => (item.kind === 'text' ? item.text : '')).join('')
  }
}

/** opencode 1.18.18 이 부모 중지로 취소한 task 의 오류 글 */
const TASK_CANCELLED = 'Task cancelled'

/** 스텝 토큰 합 — 하위 작업 줄에 보이는 값 (dsh ui-subagent: 네 갈래를 더한다) */
function tokenTotal(tokens: EnginePart['tokens']): number {
  return (tokens?.input ?? 0) + (tokens?.output ?? 0) + (tokens?.reasoning ?? 0) + (tokens?.cache?.read ?? 0) + (tokens?.cache?.write ?? 0)
}

/** 기록의 task 파트가 띄운 자식 세션 id 들 (metadata.sessionId) — 다시 열기·추론 과정 탭이 자식 기록을 이어 읽는다 */
export function subtaskSessions(raw: readonly { parts: readonly EnginePart[] }[]): string[] {
  return raw.flatMap(({ parts }) =>
    parts.flatMap((part) => {
      const sessionId = part.type === 'tool' && part.tool === 'task' ? part.state?.metadata?.['sessionId'] : undefined
      return typeof sessionId === 'string' ? [sessionId] : []
    }),
  )
}

/** 자식 세션 기록 → 하위 작업 줄 안의 줄들과 토큰 합 (자식의 user·요약 답은 줄이 아니다) */
function childRecord(raw: readonly { info: EngineMessageInfo; parts: readonly EnginePart[] }[], root: string, mcp?: McpToolResolver): { items: TurnItem[]; tokens: number } {
  const steps = raw.filter(({ info }) => info.role === 'assistant' && info.summary !== true)
  return {
    items: steps.flatMap(({ parts }) => parts.flatMap((part) => partItem(part, true, root, mcp) ?? [])),
    tokens: steps.reduce((sum, { info }) => sum + tokenTotal(info.tokens), 0),
  }
}

/** 기록에서 자식 세션 id → 그 메시지 (asc) */
export type SubtaskHistory = ReadonlyMap<string, readonly { info: EngineMessageInfo; parts: readonly EnginePart[] }[]>

/** 파트 하나 → 진행 줄 (줄이 아닌 파트면 undefined). done 이면 끝난 기록이다 (다시 열기). root 는 세션 폴더 (diff 경로 기준).
 *  children 은 끝난 기록의 자식 세션 메시지 — task 줄 안에 그 자식의 줄을 넣는다 */
function partItem(part: EnginePart, done: boolean, root: string, mcp: McpToolResolver = mcpToolOf, children?: SubtaskHistory): TurnItem | undefined {
  const id = `${part.messageID ?? ''}:${part.id ?? ''}`
  if (part.type === 'reasoning' || part.type === 'text') {
    if (part.synthetic) return undefined
    return { kind: part.type === 'reasoning' ? 'think' : 'text', id, text: part.text ?? '', done: done || part.time?.end !== undefined }
  }
  if (part.type !== 'tool') return undefined
  const state = part.state ?? {}
  const status = state.status === 'error' ? 'error' : state.status === 'completed' ? 'done' : state.status === 'pending' ? 'preparing' : 'running'
  if (part.tool === 'task') {
    const input = (state.input ?? {}) as { subagent_type?: unknown; description?: unknown }
    const item: Subtask = {
      kind: 'subtask',
      id,
      agent: typeof input.subagent_type === 'string' ? input.subagent_type : '',
      description: typeof input.description === 'string' ? input.description : '',
      // 부모를 멈추면 opencode 가 진행 중 task 를 "Task cancelled" 오류로 끝낸다 (#31 실측 — 자식도 MessageAbortedError) — 실패가 아니라 중단이다
      status: status === 'error' && state.error === TASK_CANCELLED ? 'stopped' : status,
      items: [],
    }
    if (state.time?.start !== undefined) item.startedAt = state.time.start
    if (state.time?.end !== undefined) item.endedAt = state.time.end
    if (item.status === 'error') item.error = state.error || '알 수 없는 오류'
    const sessionId = state.metadata?.['sessionId']
    const record = typeof sessionId === 'string' ? children?.get(sessionId) : undefined
    if (record) {
      const { items, tokens } = childRecord(record, root, mcp)
      item.items = items
      if (tokens > 0) item.tokens = tokens
    }
    return item
  }
  const item: Extract<TurnItem, { kind: 'tool' }> = { kind: 'tool', id, name: part.tool ?? '', status }
  const ref = mcp(item.name)
  if (ref) item.mcp = ref
  const input = state.input
  if (input !== undefined && input !== '' && !(typeof input === 'object' && input !== null && Object.keys(input).length === 0)) {
    item.input = JSON.stringify(input)
    item.summary = toolSummary(input)
  }
  if (status === 'done') {
    item.result = state.output ?? ''
    const diffs = toolDiffs(item.name, input, state.metadata, root)
    if (diffs) item.diffs = diffs
    const todos = item.name === 'todowrite' ? todoItems(state.metadata?.['todos']) : undefined
    if (todos) item.todos = todos
    const presented = item.name === PRESENT_TOOL ? presentedFiles(input, root) : undefined
    if (presented) item.presented = presented
  }
  else if (status === 'running' && typeof state.metadata?.output === 'string' && state.metadata.output !== '') item.result = state.metadata.output // bash 실시간 출력
  if (status === 'error') item.error = state.error || '알 수 없는 오류'
  // skill 도구 (레거시 실측 2026-10-02): input {name}, 끝나면 metadata {name, dir, truncated}, output 은 `<skill_content name=…>본문…</skill_content>`
  const skillName = item.name === 'skill' && input && typeof input === 'object' ? (input as { name?: unknown }).name : undefined
  if (typeof skillName === 'string' && skillName) {
    const dir = state.metadata?.['dir']
    item.skill = { name: skillName, ...(typeof dir === 'string' && { source: skillSource(dir) }) }
    item.summary = skillName
  }
  return item
}

// 할 일 목록 (todowrite, 이슈 #83 실측 2026-10-05 opencode 1.18.18 — _workspace/01ae_todo.md):
// - 인자 {todos:[{content, status, priority}]} — id 없음. 호출마다 목록 전체를 보내고 엔진이 통째로 갈아 끼운다 (일부만 보내면 나머지는 사라진다 — 앱이 합치지 않는다)
// - 정본은 completed 파트의 state.metadata.todos (그 시점 목록 전체). ⚠️ running 의 input.todos 는 쓰지 않는다 — 틀린 인자도 running 에 실린 뒤
//   error 가 되고 그때 엔진 목록은 안 바뀐다 (3/3)
// - status·priority 는 엔진이 검사하지 않는 문자열이다("done"·"urgent" 가 그대로 저장된다) → 아는 넷(pending·in_progress·completed·cancelled) 밖은 pending
// - 빈 목록([])도 성공이다
const TODO_STATUS: Record<string, TodoItem['status']> = { in_progress: 'active', completed: 'done', cancelled: 'cancelled' }

/** 끝난 todowrite 파트의 metadata.todos → 중립 목록 (배열이 아니면 undefined). priority 는 버린다 — 화면에 쓸 근거가 없다 */
function todoItems(raw: unknown): TodoItem[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.map((entry: unknown) => {
    const { content, status } = (entry && typeof entry === 'object' ? entry : {}) as { content?: unknown; status?: unknown }
    return { text: typeof content === 'string' ? content : '', status: (typeof status === 'string' && TODO_STATUS[status]) || 'pending' }
  })
}

// 결과물 선언 (앱 MCP 의 present, 이슈 #91 — src/services/appMcp/tools/present.ts):
// - 엔진은 MCP 결과의 structuredContent 를 파트에 남기지 않는다 (동봉 1.18.18 바이너리 확인 — MCP SDK 의 스키마·검증 말고는 쓰는 곳이 없다. 실측은 안 했다)
//   → 받아들인 목록은 **completed 파트의 인자**에서 읽는다. 도구가 "전부 받아들였을 때만 성공" 이라(하나라도 못 쓰면 isError → 파트 error, 01z 1-5)
//   둘이 어긋나지 않는다. 결과 글은 파싱하지 않는다
// - 경로는 글자로만 푼다(세션 폴더 기준 상대) — 파일이 지금도 있는지·프로젝트 안인지는 여는 순간 메인이 다시 본다(파일 칩과 같은 길)
const PRESENT_TOOL = 'litecode_present'

/** 끝난 present 파트의 인자 → 선언한 파일 (files 가 배열이 아니면 undefined). 경로가 글이 아닌 항목은 버린다 */
function presentedFiles(input: unknown, root: string): PresentedFile[] | undefined {
  const files = input && typeof input === 'object' ? (input as { files?: unknown }).files : undefined
  if (!Array.isArray(files)) return undefined
  return files.flatMap((entry: unknown) => {
    const { path: asked, title } = (entry && typeof entry === 'object' ? entry : {}) as { path?: unknown; title?: unknown }
    if (typeof asked !== 'string' || !asked.trim()) return []
    const label = typeof title === 'string' ? title.trim() : ''
    return [{ path: projectRelative(root, asked.trim()), ...(label && { title: label }) }]
  })
}

/** 세션 폴더 기준 상대 경로 (`/` 구분, `./`·`..` 를 푼다). 글자로는 폴더 밖이면(링크를 거친 절대 경로 등) 받은 그대로 */
function projectRelative(root: string, file: string): string {
  if (!root) return file
  const rel = path.relative(root, path.resolve(root, file))
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : file
}

/** 도구 줄의 한 줄 요약 — bash 는 description(필수 인자, 01g), 없으면 command. 그 밖의 도구는 흔한 인자 하나 */
export function toolSummary(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const args = input as Record<string, unknown>
  for (const key of ['description', 'command', 'filePath', 'path', 'pattern', 'url', 'query']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim().split('\n')[0]
  }
  return undefined
}

/** assistant 메시지 하나(스텝)의 파트 → 진행 줄. 끝난 기록이라 생각·글은 done 이다. root 는 세션 폴더 (diff 경로 기준).
 *  children 을 주면 task 줄 안에 그 자식 세션의 줄을 넣는다 (subtaskSessions 로 찾아 읽은 것) */
export function messageItems(parts: readonly EnginePart[], root = '', mcp?: McpToolResolver, children?: SubtaskHistory): TurnItem[] {
  return parts.flatMap((part) => partItem(part, true, root, mcp, children) ?? [])
}
