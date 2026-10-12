import type { Context } from 'cordis'
import path from 'node:path'
import type { EngineConnection } from '../engine.ts'
import { DEFAULT_MODE, modePermission, type Mode } from '../../../shared/modes.ts'
import { GIT_WRITE_TOOLS } from '../../../shared/git.ts'
import type { McpToolResolver, TurnScope, TurnTracker } from '../turnProgress.ts'
import type { ToolCalls } from '../toolCalls.ts'
import { tr } from '../../i18n.ts'
import { at } from './engineApi.ts'
import { PRE_TOOL_WAIT_MS } from './limits.ts'
import type { PreToolDecision, RunningTurn } from './types.ts'
import type { Attention, AttentionSubtask, AttentionQuestion, AttentionAnswer, AttentionTarget } from '../../../shared/contract.ts'

/** 승인·질문 처리가 LlmService 와 같이 쓰는 상태 (LlmService 가 쥔다 — 필드의 뜻은 거기 주석) */
export interface AttentionHost {
  ctx: Context
  requests: Map<string, AttentionRequest>
  allowed: Map<string, Set<string>>
  declined: Map<string, Set<string>>
  watchers: Map<string, { answered(requestId: string): void }>
  running: Set<RunningTurn>
  mcpTool(workdir: string): McpToolResolver
}

/** 기다리는 요청 하나 (LlmService.requests 의 값) */
export type AttentionRequest = { sessionId: string; turn: string; directory: string; kind: Attention['kind']; callID?: string; action?: string; resources?: string[] }

/** 승인·질문 대기 목록을 지켜본다. refresh 마다 정본 목록(GET /permission·/question?directory= — 그 폴더 전부)을 다시 읽어 이 턴 답 메시지의
 *  요청만 남기고, 바뀌었으면 onAttention 을 부르고 새 요청마다 'llm/attention', 다 풀렸으면 'llm/attention-resolved' 를 낸다.
 *  중지한 턴의 요청이 목록에 남아 있어도(01w) 그 턴의 답 메시지가 아니라 안 보인다. 읽기는 한 줄로 세운다(뒤늦은 응답이 새 목록을 덮지 않게).
 *  **권한 목록은 못 읽을 수 있다** (이슈 #107, 실측 01ai 2026-10-05, 1.18.18 각 3/3): 요청의 metadata 에 빠진 선택 인자가 있으면(webfetch 의 timeout,
 *  glob·grep 의 path) GET /permission 이 400(`Expected JSON value, got undefined at [n]["metadata"][…]`)이다 — 그 요청 하나가 그 폴더 목록 전체를,
 *  멈춘 턴이 남긴 요청이면 엔진을 다시 띄울 때까지 깨뜨린다. `permission.asked` 이벤트는 요청 전체를 싣고 오고 답(POST …/reply)은 정상이라,
 *  signal 이 이 턴의 이벤트로 본 요청을 기억해 두고(풀림 `permission.replied`·답하면 지운다) 목록에 없거나 목록을 못 읽은 요청은 그것으로 만든다.
 *  목록을 읽었으면 목록이 정본이다(같은 요청은 목록 것). 질문 목록(GET /question)은 같은 약점이 없었다(3/3) — 폴백 없이 못 읽으면 있던 카드를 둔다 */
export function watchAttention(
  host: AttentionHost,
  conn: EngineConnection,
  sessionId: string,
  workdir: string,
  directory: string,
  scope: TurnScope,
  tracker: TurnTracker,
  onAttention: ((requests: Attention[]) => void) | undefined,
  calls?: ToolCalls,
  mode: Mode = DEFAULT_MODE,
): { signal(type: string, properties: Record<string, unknown>): void; stop(): void } {
  let pending: Attention[] = []
  let stopped = false
  // 도구 실행 전 판정 (이슈 #102 2단계, 01af §6-1). 권한 요청마다 **한 번** 'llm/pre-tool' 을 묻고, 판정이 나올 때까지 그 요청은 카드로 내지 않는다:
  // - 막기 → `reject` + `message`(사유) — 모델이 사유를 받고 턴이 이어진다. message 없는 reject 는 턴을 끝낸다(01af §4) — 늘 싣는다
  // - 묻기 → 승인 카드
  // - 통과·판정 없음 → 게이트 때문에 온 요청(그 권한에 게이트가 걸려 있고 모드는 원래 묻지 않는다 — shared/modes.ts)이면 `once`, 아니면 승인 카드.
  //   게이트가 안 걸린 권한의 요청은 모드나 사용자 설정이 원래 묻는 것이라 늘 카드다
  // 여기서 보낸 once 는 **사용자 승인이 아니다** — 호출 장부의 허용 기록(calls.approve)에 적지 않는다 (앱 MCP 의 세션 도구가 그 기록만 받는다, #55).
  // 판정·답이 실패하면 카드로 내려앉는다 (사람이 정한다)
  const verdicts = new Map<string, 'judging' | 'card' | 'answered'>()
  /** 도구 호출 id → 그 호출의 판정 */
  const decisions = new Map<string, Promise<PreToolDecision | undefined>>()
  const judging = new AbortController()
  /** 목록을 바꾸고 알린다 — 새 요청마다 attention, 다 풀리면 resolved */
  const publish = (next: Attention[]): void => {
    const before = new Set(pending.map((entry) => entry.id))
    const changed = next.length !== pending.length || next.some((entry) => !before.has(entry.id))
    const resolved = pending.length > 0 && next.length === 0
    pending = next
    if (!changed) return
    onAttention?.(next)
    for (const entry of next) if (!before.has(entry.id)) host.ctx.emit('llm/attention', { sessionId, directory, kind: entry.kind, title: attentionTitle(entry) })
    if (resolved) host.ctx.emit('llm/attention-resolved', { sessionId, directory })
  }
  let chain: Promise<void> = Promise.resolve()
  type Request = { id: string; sessionID?: string; tool?: { messageID?: string; callID?: string } }
  // 이 턴 답 메시지의 요청 + 이 턴이 띄운 하위 작업(자식 세션)의 요청 — 자식은 이 턴에 생긴 세션이라 앞 턴의 남은 요청이 섞이지 않는다 (#31 실측:
  // 자식의 permission.asked 는 sessionID = 자식, tool.messageID = 자식의 답 메시지. 매번 묻기 모드의 general-ask 가 bash 를 물을 때)
  const mine = (entry: Request): boolean => (entry.sessionID === sessionId && scope.owns(entry.tool?.messageID)) || tracker.isChild(entry.sessionID)
  const warned = new Set<Attention['kind']>()
  /** 정본 목록에서 이 턴의 요청. 못 읽었으면 undefined — 삼키지 않고 적는다 (턴이 끝나며 끊긴 것은 빼고, 깨진 폴더는 신호마다 실패하니 턴마다 한 번) */
  const list = async <T extends Request>(kind: Attention['kind']): Promise<T[] | undefined> => {
    try {
      const res = await fetch(`${conn.url}/${kind}?${at(workdir)}`, { headers: conn.headers, signal: conn.closed })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`.trim())
      return ((await res.json()) as T[]).filter(mine)
    } catch (error) {
      if (!stopped && !conn.closed.aborted && !warned.has(kind)) console.warn(`[llm] 승인 대기 목록(${kind})을 못 읽었다 — ${kind === 'permission' ? '이벤트로 본 요청으로 잇는다' : '다음 신호에 다시'}:`, (error as Error).message)
      warned.add(kind)
      return undefined
    }
  }
  /** 요청한 세션과, 하위 작업이 물었으면 그 하위 작업 */
  const origin = (entry: Request): { sessionId: string; subtask?: AttentionSubtask } => {
    if (entry.sessionID === sessionId || !entry.sessionID) return { sessionId }
    const subtask = tracker.subtaskOf(entry.sessionID)
    return { sessionId: entry.sessionID, ...(subtask && { subtask: { agent: subtask.agent, description: subtask.description } }) }
  }
  type PermissionRequest = Request & { permission: string; patterns?: string[]; metadata?: Record<string, unknown> }
  /** permission.asked 이벤트로 본, 아직 안 풀린 요청 (요청 id → 이벤트 본문) — 정본 목록의 폴백 */
  const seen = new Map<string, PermissionRequest>()
  const judge = async (entry: PermissionRequest): Promise<void> => {
    let verdict: 'card' | 'answered' = 'card'
    try {
      const child = entry.sessionID !== undefined && entry.sessionID !== sessionId
      // 한 호출이 승인을 두 번 물을 수 있다 (폴더 밖 경로의 external_directory → 그 도구 자신의 권한) — 판정은 호출마다 한 번이다
      const callId = entry.tool?.callID
      const decide = async (): Promise<PreToolDecision | undefined> => {
        const call = await runningCall(calls, callId, judging.signal)
        const input = call?.input ?? requestInput(entry.permission, entry.metadata)
        const file = toolFile(input, workdir)
        return host.ctx.serial('llm/pre-tool', { sessionId, directory: workdir, tool: call?.tool || entry.permission, input, ...(file && { file }), child, signal: judging.signal })
      }
      const deciding = (callId && decisions.get(callId)) || decide()
      if (callId) decisions.set(callId, deciding)
      const decision = await deciding
      if (stopped) return
      const answer =
        typeof decision === 'object'
          ? { reply: 'reject', message: decision.reason.trim() || 'Blocked before running.' }
          : decision !== 'ask' &&
              ((conn.gated(entry.permission) && modePermission(mode, entry.permission, { resources: entry.patterns, child }) === 'allow') ||
                // 이 대화에서 [항상 허용]한 폴더 밖·git 쓰기 패턴 (이슈 #242 + 2026-10-12) — 사용자가 미리 정한 허용이지만 이 호출을 본 것은 아니라 장부에는 적지 않는다
                allowedAlready(host, sessionId, entry.permission, entry.patterns))
            ? { reply: 'once' }
            : undefined
      if (answer) {
        const res = await fetch(`${conn.url}/permission/${entry.id}/reply?${at(workdir)}`, {
          method: 'POST',
          headers: { ...conn.headers, 'content-type': 'application/json' },
          body: JSON.stringify(answer),
          signal: conn.closed,
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        verdict = 'answered'
      }
    } catch (error) {
      console.error('[llm] 도구 실행 전 판정 실패 — 승인 카드로 묻는다', (error as Error).message)
    }
    if (stopped) return
    verdicts.set(entry.id, verdict)
    if (verdict === 'card') refresh()
  }
  const read = async (): Promise<void> => {
    if (stopped) return
    const [listed, questions] = await Promise.all([list<PermissionRequest>('permission'), list<Request & { questions: AttentionQuestion[] }>('question')])
    if (stopped) return
    const known = new Set(listed?.map((entry) => entry.id))
    const asked = [...(listed ?? []), ...[...seen.values()].filter((entry) => !known.has(entry.id) && mine(entry))]
    for (const entry of asked) {
      if (verdicts.has(entry.id)) continue
      verdicts.set(entry.id, 'judging')
      void judge(entry)
    }
    const permissions = asked.filter((entry) => verdicts.get(entry.id) === 'card')
    const mcp = host.mcpTool(workdir)
    const next: Attention[] = [
      ...permissions.map((entry): Attention => {
        const ref = mcp(entry.permission)
        // 묻는 이벤트에는 인자가 없다 — 그 순간 그 callID 의 파트가 running + input 이라 이어 붙인다 (01z 1-3, 3/3). 카드가 대상·보낼 글을 그린다
        const raw = ref && entry.tool?.callID ? calls?.inputOf(entry.tool.callID) : undefined
        const input = ref && raw !== undefined ? (host.ctx.bail('llm/attention-input', ref, raw) ?? raw) : raw
        return {
          kind: 'permission',
          id: entry.id,
          ...origin(entry),
          action: entry.permission,
          resources: entry.patterns ?? [],
          ...(ref && { mcp: ref }),
          ...(input !== undefined && { input: JSON.stringify(input) }),
        }
      }),
      ...(questions?.map((entry): Attention => ({ kind: 'question', id: entry.id, ...origin(entry), questions: entry.questions })) ?? pending.filter((entry) => entry.kind === 'question')),
    ]
    for (const entry of permissions) {
      host.requests.set(entry.id, { sessionId: origin(entry).sessionId, turn: sessionId, directory: workdir, kind: 'permission', callID: entry.tool?.callID, action: entry.permission, resources: entry.patterns ?? [] })
    }
    for (const entry of questions ?? []) host.requests.set(entry.id, { sessionId: origin(entry).sessionId, turn: sessionId, directory: workdir, kind: 'question', callID: entry.tool?.callID })
    publish(next)
  }
  // 답한 요청은 목록 읽기를 기다리지 않고 바로 뺀다 — 카드가 곧장 사라지고, 답 직후 턴이 끝나도(stop) resolved 를 놓치지 않는다
  host.watchers.set(sessionId, {
    answered: (requestId) => {
      seen.delete(requestId)
      if (!stopped) publish(pending.filter((entry) => entry.id !== requestId))
    },
  })
  const refresh = (): void => {
    chain = chain.then(read).catch(() => {}) // 못 읽으면 다음 신호에 다시 — 턴 끝은 idle 이 정한다
  }
  return {
    // 이 턴(과 그 하위 작업)의 permission.*·question.* 이벤트 — 권한 요청은 적어 두고(asked) 풀리면 지운 뒤(replied) 목록을 다시 읽는다
    signal: (type, properties) => {
      if (type === 'permission.asked' && typeof properties['id'] === 'string' && typeof properties['permission'] === 'string') seen.set(properties['id'], properties as PermissionRequest)
      if (type === 'permission.replied' && typeof properties['requestID'] === 'string') seen.delete(properties['requestID'])
      refresh()
    },
    stop: () => {
      stopped = true
      judging.abort()
      host.watchers.delete(sessionId)
      for (const [id, request] of host.requests) if (request.turn === sessionId) host.requests.delete(id)
    },
  }
}

/** 카드의 답을 엔진에 보낸다 — 레거시 POST /permission/{id}/reply·/question/{id}/reply|reject (?directory= 필수 — 빠지면 404 이고 턴이 멈춘다, 01w).
 *  권한: once|reject. 질문: 질문마다 고른 답(빈 답은 막는다 — opencode 는 검증하지 않는다) 또는 reject. 거절은 그 도구 호출을 적어 둔다 —
 *  그 도구가 error 로 끝나고 오는 idle 이 거절로 끝난 턴이다. 이미 풀렸거나 모르는 요청이면 던진다.
 *  **`always` 는 보내지 않는다** — 그 폴더의 모든 세션에서 더는 묻지 않게 된다 (01z 1-3).
 *  허용(once)한 도구 호출은 그 턴의 장부에 적는다 — 앱 MCP 서버가 "사용자가 앱에서 누른 허용" 만 받게 (callerOf 의 approved, 01z 1-4).
 *  target 은 허용하며 사용자가 고른 받을 대화 (이슈 #67) — 장부에만 적는다. **엔진에는 보내지 않는다**(엔진에 가는 답은 once 그대로).
 *  always(항상 허용)는 폴더 밖 접근(external_directory, 이슈 #242)·git 쓰기 도구(2026-10-12)에만 — 엔진에는 once 로 보내고, 성공하면
 *  그 대화(request.turn) + 그 권한 + 그 패턴을 기억해 다음 요청은 카드 없이 once 로 답하고(watchAttention 의 judge),
 *  이미 떠 있는 같은 권한·패턴의 카드도 once 로 함께 푼다 */
export async function replyAttention(host: AttentionHost, sessionId: string, requestId: string, answer: AttentionAnswer, target?: AttentionTarget): Promise<void> {
  const request = host.requests.get(requestId)
  if (!request || request.sessionId !== sessionId) throw new Error(tr('error.attentionGone'))
  const always = answer === 'always'
  const valid =
    answer === 'reject' ||
    (request.kind === 'permission'
      ? answer === 'once' || (always && canAlways(request.action))
      : Array.isArray(answer) && answer.length > 0 && answer.every((entry) => Array.isArray(entry) && entry.length > 0 && entry.every((label) => typeof label === 'string' && label.trim() !== '')))
  if (!valid) throw new Error(tr('error.attentionAnswer'))
  const conn = await host.ctx.engine.connection()
  // 하위 작업의 요청을 거절하면 그 자식만 그 도구 오류로 이어 가고 부모 턴은 계속 돈다 — 부모 턴의 "거절로 끝남" 이 아니다
  const declined = answer === 'reject' && request.callID && request.sessionId === request.turn ? host.declined.get(sessionId) : undefined
  declined?.add(request.callID!) // 보내기 전에 — 도구 error 가 응답보다 먼저 올 수 있다
  const approving = (answer === 'once' || always) && request.kind === 'permission' && request.callID ? [...host.running].find((live) => live.sessionId === request.turn)?.calls : undefined
  approving?.approve(request.callID!, target) // 보내기 전에 — 허용된 도구의 MCP 호출이 응답보다 먼저 올 수 있다
  const base = `${conn.url}/${request.kind}/${requestId}`
  const query = at(request.directory)
  const json = { ...conn.headers, 'content-type': 'application/json' }
  const res =
    request.kind === 'permission'
      ? await fetch(`${base}/reply?${query}`, { method: 'POST', headers: json, body: JSON.stringify({ reply: always ? 'once' : answer }) })
      : answer === 'reject'
        ? await fetch(`${base}/reject?${query}`, { method: 'POST', headers: json, body: '{}' })
        : await fetch(`${base}/reply?${query}`, { method: 'POST', headers: json, body: JSON.stringify({ answers: answer }) })
  if (!res.ok) {
    declined?.delete(request.callID!)
    approving?.revoke(request.callID!)
    throw new Error(tr('error.attentionReply', { status: res.status }))
  }
  host.requests.delete(requestId)
  host.watchers.get(request.turn)?.answered(requestId)
  if (!always) return
  const key = rememberKey(request.action ?? '', request.resources ?? [])
  const remembered = host.allowed.get(request.turn) ?? new Set<string>()
  remembered.add(key)
  host.allowed.set(request.turn, remembered)
  // 이미 떠 있는 같은 대화·같은 권한·같은 패턴의 카드 — 하나가 실패해도 그 카드만 남는다(다시 누를 수 있다)
  const same = [...host.requests].filter(
    ([, other]) => other.turn === request.turn && other.kind === 'permission' && other.action === request.action && rememberKey(other.action ?? '', other.resources ?? []) === key,
  )
  await Promise.all(same.map(([id, other]) => replyAttention(host, other.sessionId, id, 'once').catch(() => {})))
}

/** 이 대화(턴의 엔진 세션)에서 [항상 허용]한 패턴의 요청이다 (이슈 #242 + git 쓰기 2026-10-12) */
function allowedAlready(host: AttentionHost, turn: string, permission: string, patterns: readonly string[] | undefined): boolean {
  return canAlways(permission) && !!host.allowed.get(turn)?.has(rememberKey(permission, patterns ?? []))
}

/** [항상 허용]을 받는 권한 — 폴더 밖 접근(이슈 #242) + git 쓰기 도구(2026-10-12, 전체 권한은 아예 안 묻는다).
 *  다른 권한·보내기·만들기·질문은 늘 묻는다 */
const ALLOW_ALWAYS_ACTIONS: readonly string[] = ['external_directory', ...GIT_WRITE_TOOLS.map((tool) => `litecode_${tool}`)]
const canAlways = (action: string | undefined): boolean => action !== undefined && ALLOW_ALWAYS_ACTIONS.includes(action)

/** 요청 패턴의 비교 열쇠 — 패턴 목록이 같아야 같은 요청이다 */
function allowKey(patterns: readonly string[]): string {
  return JSON.stringify([...patterns].sort())
}

/** [항상 허용] 기억 열쇠 — 같은 권한 + 같은 패턴 (2026-10-12). 권한 이름까지 넣는다 — 폴더 밖 패턴과 git 쓰기가 서로 섞이지 않게 */
function rememberKey(action: string, patterns: readonly string[]): string {
  return `${action}\u0000${allowKey(patterns)}`
}

/** 파일 하나를 다루는 도구의 인자면 그 파일 (절대 경로) — read·write·edit 의 `filePath` */
function toolFile(input: unknown, workdir: string): string | undefined {
  const file = (input as { filePath?: unknown } | undefined)?.filePath
  return typeof file === 'string' && file ? path.resolve(workdir, file) : undefined
}

/** 승인을 묻는 호출의 도구 이름·인자 — 묻는 순간 그 callID 의 파트가 running + input 이다 (01z 1-3). 이벤트가 조금 늦을 수 있어 잠깐 기다린다 */
async function runningCall(calls: ToolCalls | undefined, callId: string | undefined, signal: AbortSignal): Promise<{ tool: string; input: unknown } | undefined> {
  if (!calls || !callId) return undefined
  const deadline = Date.now() + PRE_TOOL_WAIT_MS
  while (true) {
    const call = calls.callOf(callId)
    if (call || signal.aborted || Date.now() >= deadline) return call
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** running 파트를 못 봤을 때 요청에 실린 것으로 만드는 인자 — bash 는 `metadata.command`, edit·write 는 `metadata.filepath` (01af §4),
 *  webfetch·glob·grep 은 metadata 가 인자 그대로다 (`{url, format, timeout?}` · `{pattern, path?}` · `{pattern, path?, include?}` — 01ai) */
function requestInput(permission: string, metadata: Record<string, unknown> | undefined): unknown {
  if (permission === 'bash' && typeof metadata?.['command'] === 'string') return { command: metadata['command'] }
  if (permission === 'edit' && typeof metadata?.['filepath'] === 'string') return { filePath: metadata['filepath'] }
  if (permission === 'webfetch' && typeof metadata?.['url'] === 'string') return { ...metadata }
  if ((permission === 'glob' || permission === 'grep') && typeof metadata?.['pattern'] === 'string') return { ...metadata }
  return {}
}

/** 'llm/attention' 의 짧은 설명 — 명령·파일(권한) 또는 첫 질문 */
function attentionTitle(request: Attention): string {
  return request.kind === 'permission' ? `${request.action} ${request.resources.join(', ')}`.trim() : (request.questions[0]?.question ?? '')
}
