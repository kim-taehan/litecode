import { Context, Service } from 'cordis'
import { Agent } from 'undici'
import { normalizeBaseURL } from '../providers.ts'
import { MODE_AGENT, type EngineConnection, type EngineMcp } from '../engine.ts'
import { DEFAULT_MODE, type Mode } from '../../../shared/modes.ts'
import { messageTokens } from '../turnUsage.ts'
import { openPty, type TerminalEvents, type TerminalHandle } from '../opencodePty.ts'
import { mcpToolOf, sanitizeMcpName, TurnScope, TurnTracker, type McpToolRef, type McpToolResolver, type TurnItem } from '../turnProgress.ts'
import { awaitCaller, findCaller, ToolCalls, type ToolCaller } from '../toolCalls.ts'
import { instructionsNote, projectInstructions, TODO_SYNC_RULE } from '../instructions.ts'
import { carryOver, previousHistory, readPreviousMessages } from '../migrate.ts'
import { historyMessages, interruptedError, modeOf } from '../history.ts'
import { realDirectory } from '../projectPath.ts'
import { describeEnginePlugins, findEnginePlugins } from '../enginePlugins.ts'
import { tr } from '../../i18n.ts'
import '../engine.ts'
import type { Attention, AttentionAnswer, AttentionTarget, History } from '../../../shared/contract.ts'
import { CALLER_WAIT_MS, STREAM_IDLE_TIMEOUT_MS } from './limits.ts'
import { abort, at, createSession, dropUnfinishedCompactions, engineMessages, subtaskMessages, waitForAgent, waitForModel } from './engineApi.ts'
import { ascendingId, mergeHidden, promptParts, promptTools, sessionTitle } from './prompt.ts'
import { follow } from './follow.ts'
import { replyAttention, watchAttention, type AttentionHost, type AttentionRequest } from './attention.ts'
import type { ChatImage, ChatOptions, ChatResult, EngineCommand, EngineMessage, EngineSkill, FileEntry, Interjection, LlmConfig, McpStatus, RunningTurn } from './types.ts'

export class LlmService extends Service {
  static readonly inject = ['providers', 'engine']

  /** 답을 기다리는 턴 수 — DB 정리는 0 일 때만 돈다 (정리 잠금이 길면 그 사이 opencode 쓰기가 실패한다, 01_probe) */
  private turns = 0
  private purgeWanted = false
  /** 턴이 도는 세션 — addContext 가 막는다 */
  private busy = new Set<string>()
  /** 기다리는 요청 id → 요청한 세션(하위 작업이면 자식)·그 요청을 기다리는 턴의 세션·폴더·종류·도구 호출 (reply 가 쓴다). 턴이 끝나면 지운다 */
  private requests = new Map<string, AttentionRequest>()
  /** 대화(턴의 엔진 세션) → [항상 허용]한 폴더 밖 접근 패턴 (allowKey). 그 대화의 같은 요청은 카드 없이 once 로 답한다 (이슈 #242). 저장하지 않는다 */
  private allowed = new Map<string, Set<string>>()
  /** 턴이 도는 세션 → 앱이 거절한 도구 호출 id. 그 도구가 error 로 끝나고 idle 이 오면 거절로 끝난 턴이다 */
  private declined = new Map<string, Set<string>>()
  /** 턴이 도는 세션 → 그 턴의 대기 목록 (reply 가 답한 요청을 바로 뺀다) */
  private watchers = new Map<string, { answered(requestId: string): void }>()
  /** 도는 턴의 진행 줄과 폴더 — stopSubtask 가 하위 작업 줄 id 로 그 자식 세션을 찾는다. calls 는 그 턴의 도구 호출 장부 (callerOf·승인 기록).
   *  턴이 끝나면 지운다 */
  private running = new Set<RunningTurn>()
  /** 폴더(realpath) → 마지막으로 본 그 인스턴스의 MCP 서버 이름 — 도구 이름 `<서버>_<도구>` 를 가른다 (mcpTool) */
  private mcpServers = new Map<string, string[]>()
  /** 폴더(realpath) → 모델에 안 보일 MCP 도구 (서버 → MCP 서버가 준 도구 이름들, 이슈 #164). ctx.mcp 가 매 턴 전(llm/before-turn)에 바꾼다 */
  private hiddenMcpTools = new Map<string, Readonly<Record<string, readonly string[]>>>()
  /** gateTools 로 받았지만 아직 엔진에 못 넘긴 매처 — 도는 턴이 없어지면 넘긴다 */
  private gateWanted?: readonly string[]
  /** 엔진을 다시 띄워 달라는 요청(reloadWhenIdle)이 밀려 있다 */
  private reloadWanted = false

  /** /event 를 여는 dispatcher. 전역 fetch(undici) 기본 bodyTimeout·headersTimeout 은 300초다 — 레거시 /event 는 heartbeat 가 10초마다 오므로
   *  무바이트 한도를 STREAM_IDLE_TIMEOUT_MS 로 줄여 죽은 연결을 30초 안에 알아챈다(이슈 #20). 시험은 더 짧게 줄 수 있다 (01q).
   *  끊김 감지는 엔진 생존(conn.closed)으로도 한다.
   *  undici 는 Electron 33 메인의 Node 20.18.3 내장(6.21.1)과 같은 버전을 쓴다 */
  private streamDispatcher: Agent

  constructor(ctx: Context, config: LlmConfig = {}) {
    super(ctx, 'llm')
    const timeout = config.streamTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS
    this.streamDispatcher = new Agent({ bodyTimeout: timeout, headersTimeout: timeout })
    ctx.effect(() => () => void this.streamDispatcher.close().catch(() => {}))
  }

  /** directory 는 새 세션의 작업 디렉터리(절대 경로). 이어가는 세션(sessionId)은 만들 때 정한 폴더를 따른다 — 이어갈 때도 그 세션의 폴더를 넘긴다
   *  (모델·주소 확인과 모든 레거시 호출의 ?directory= 에 쓴다). 모델·모드는 매 프롬프트에 싣는다 — 대화 중에 바꾸면 다음 턴부터 그것으로 돈다.
   *  onSession 은 새 세션을 만든 직후, 프롬프트를 보내기 전에 불린다 — 답을 기다리는 중에 앱이 꺼져도 그 대화를 다시 열 수 있게.
   *  messageId(newMessageId)를 주면 이 입력의 엔진 메시지 id 가 그것이 된다 — history 의 id 로 돌아온다. 안 주면 새로 만든다.
   *  onProgress 는 턴 중 진행 줄(생각·도구·글)이 바뀔 때마다 불린다 — 화면의 실시간 진행 표시용. 턴 끝은 여전히 반환값이 정본이다.
   *  onAttention 은 턴이 기다리는 승인·질문 목록이 바뀔 때마다 (빈 목록 = 더 기다리는 것 없음) — 화면의 카드. 답은 reply.
   *  stop 이 걸리면 사용자가 멈춘 것이다 — 보내기 전이면 안 보내고, 받아들여진 뒤면 opencode 턴도 멈추고(abort) "중단됨" 으로 끝낸다.
   *  세션이 아직 없을 때(첫 턴)도 멈출 수 있게 세션 id 가 아니라 신호로 받는다.
   *  images 는 이 입력에 붙일 이미지 — 글 뒤에 file 파트(data: URI)로 싣는다 (promptParts). 그 모델이 이미지를 받는지는 부르는 쪽이 본다.
   *  context 는 이 턴에만 실을 맥락 글 — 프로젝트 지시문 뒤에 붙여 system 으로 보낸다 (그 요청에만 실린다, 01w 3-1) */
  async chat({
    providerId,
    modelId,
    directory,
    prompt,
    sessionId,
    onSession,
    messageId,
    onProgress,
    mode = DEFAULT_MODE,
    onAttention,
    stop,
    images = [],
    context,
    hideMcpTools,
    stallTimeoutMs,
  }: ChatOptions): Promise<ChatResult> {
    this.turns++
    /** busy: 이 턴이 쥔 세션(addContext 를 막는다), sessionId: 받아들여진 턴의 세션 — 그때만 turn-started/ended 를 낸다 */
    const admitted: { busy?: string; sessionId?: string } = {}
    try {
      const result = await this.turn(providerId, modelId, directory, prompt, sessionId, onSession, messageId, onProgress, admitted, mode, onAttention, stop, images, context, hideMcpTools, stallTimeoutMs)
      const interrupted = !result.ok && !!result.interrupted
      if (admitted.sessionId) {
        this.ctx.emit('llm/turn-ended', {
          sessionId: admitted.sessionId,
          directory,
          outcome: result.ok ? 'done' : interrupted ? 'interrupted' : 'failed',
          ...(result.error !== undefined && { error: result.error }),
        })
      }
      return result
    } finally {
      if (admitted.busy) this.busy.delete(admitted.busy)
      this.turns--
      this.purgeIfIdle()
      this.gateIfIdle()
      this.reloadIfIdle()
    }
  }

  /** 도는 턴에 사용자 말 하나를 끼워 넣을 자리를 잡는다 (이슈 #250). turnMessageId 는 그 턴을 시작한 chat 의 messageId, messageId 는 끼워 넣을
   *  말의 id(newMessageId). 엔진이 그 턴을 아직 안 받았거나(보내기 전 — 먼저 보내면 끼워 넣은 말이 턴의 시작이 된다) 이미 끝났으면 undefined —
   *  부른 쪽이 대기열로 보낸다. 자리를 잡은 순간부터 그 턴은 이 말을 본 뒤의 idle 에서만 끝난다 (Interjection.send·cancel).
   *  실측 01ar (opencode 1.18.18 레거시, docs/opencode-protocol.md): 도는 세션에 prompt_async 를 또 보내면 204 즉시, 도는 스텝이 끝난 직후의
   *  다음 모델 호출에 실린다. 그 뒤 스텝은 마지막 user 의 agent·system·tools 를 쓴다 — 그래서 도는 턴과 같은 값을 싣는다 */
  reserve(turnMessageId: string, messageId: string): Interjection | undefined {
    for (const live of this.running) if (live.turnMessageId === turnMessageId) return live.reserve?.(messageId)
    return undefined
  }

  /** 그 엔진 세션의 도는 턴에 모델만 볼 알림 한 줄을 끼워 넣는다 (이슈 #284, ctx.repeatGuard) — 끼워 넣기(reserve)와 같은 길이지만 글을 synthetic 으로
   *  싣는다: 엔진은 다음 모델 호출에 user 맥락으로 싣고(migrate.ts 의 합성 글과 같은 필드, 01w 1/1), 진행 줄·다시 연 기록(historyMessages)·
   *  추론 과정은 합성 글뿐인 user 를 건너뛴다 — 사람이 친 말로 남지 않는다. 도는 턴이 없거나 끼울 수 없으면(엔진이 아직 안 받음·끝남) false */
  async remind(sessionId: string, text: string): Promise<boolean> {
    for (const live of this.running) {
      if (live.sessionId !== sessionId) continue
      const messageId = this.newMessageId()
      const slot = live.reserve?.(messageId)
      if (!slot) return false
      live.reminders.add(messageId)
      return slot.send({ prompt: text, synthetic: true })
    }
    return false
  }

  /** 실행 전에 판정('llm/pre-tool')을 받을 도구를 정한다 (이슈 #102 2단계). matchers 는 도구 이름의 `|` 나열·정규식(shared/hooks.ts matchesTool),
   *  빈 글자는 모든 도구, 빈 배열은 "없음". 엔진은 그 도구들의 실행 전에 승인을 묻게 되고(ctx.engine.setGate), 묻는 호출마다 'llm/pre-tool' 이 나간다.
   *  대상이 실제로 달라지면 엔진을 다시 띄워야 한다 — **도는 턴이 있으면 다 끝난 뒤로 미룬다**(재시작은 도는 턴을 끊는다). 그 사이의 턴은 옛 대상으로 돈다 */
  gateTools(matchers: readonly string[]): void {
    this.gateWanted = [...matchers]
    this.gateIfIdle()
  }

  private gateIfIdle(): void {
    if (this.turns > 0 || !this.gateWanted) return
    const matchers = this.gateWanted
    this.gateWanted = undefined
    this.ctx.engine.setGate(matchers)
  }

  /** 엔진이 띄울 때만 읽는 것(스킬 목록 — 폴더별로 기억해 다시 띄워야 바뀐다)이 바뀌었다 — 엔진을 다시 띄운다 (이슈 #145: 대화로 만든 스킬).
   *  **도는 턴이 있으면 다 끝난 뒤로 미룬다**(재시작은 도는 턴을 끊는다 — 이 요청은 도는 턴 안의 도구가 한다) */
  reloadWhenIdle(): void {
    this.reloadWanted = true
    this.reloadIfIdle()
  }

  private reloadIfIdle(): void {
    if (this.turns > 0 || !this.reloadWanted) return
    this.reloadWanted = false
    void this.ctx.engine.restart().catch((error: unknown) => console.error('[llm] 스킬 변경 후 엔진 재시작 실패', (error as Error).message))
  }

  /** 세션을 쓸 준비 — 매 턴 보내기 전에 그 폴더 카탈로그로 모델·주소를 보고, 모드를 주면 그 에이전트가 있는지 보고, 세션이 없으면 만든다.
   *  이어가는 세션도 directory(그 대화의 프로젝트)로 본다. workdir 은 realpath — 레거시 호출의 ?directory= 로 쓴다 */
  private async prepare(
    conn: EngineConnection,
    providerId: string,
    modelId: string,
    directory: string,
    sessionId: string | undefined,
    title: string,
    onSession?: (sessionId: string) => Promise<void>,
    mode?: Mode,
  ): Promise<{ id: string; workdir: string } | { error: string }> {
    const folder = await this.engineFolder(directory)
    if ('error' in folder) return { error: folder.error }
    const { workdir } = folder
    const model = await waitForModel(conn, providerId, modelId, workdir)
    if (!model) return { error: tr('error.noModel', { provider: providerId, model: modelId }) }
    // 세션 폴더의 opencode.json 은 우리 provider 의 baseURL 까지 덮는다 — 그러면 프롬프트(와 프록시 토큰)가 그 주소로 간다 (01_probe Q4, 신규 세대).
    // 레거시는 CONFIG_DIR 을 맨 마지막에 합쳐 우리 주소로 보냈다(01w 4변형) — 그래도 카탈로그엔 덮인 주소가 보이므로 이 검사는 안전 쪽으로 남긴다.
    // 우리가 적은 주소는 키 프록시 주소다 (engine.ts)
    if (normalizeBaseURL(model.api?.url ?? '') !== normalizeBaseURL(conn.providerBaseURL(providerId))) {
      return { error: tr('error.baseUrlOverridden', { url: String(model.api?.url) }) }
    }
    const agent = mode && MODE_AGENT[mode]
    if (agent && !(await waitForAgent(conn, agent, workdir))) return { error: tr('error.noAgent', { agent }) }
    // MCP 서버 붙이기 (ctx.mcp, 이슈 #28) — 동적 추가는 그 폴더 인스턴스에만 있고 재시작하면 사라져서 매 턴 확인한다. 못 붙여도 턴은 보낸다
    await this.ctx.parallel('llm/before-turn', workdir).catch((error: unknown) => console.error('[llm] MCP 준비 실패', (error as Error).message))
    if (sessionId) return { id: sessionId, workdir }
    const id = await createSession(conn, providerId, modelId, workdir, title)
    await onSession?.(id)
    return { id, workdir }
  }

  /** 대화 맥락에만 넣는다 — LLM 을 돌리지 않고 입력만 저장해 다음 턴에 실린다(레거시 `noReply`, 01w). `!` 카드의 "AI 에게 보내기".
   *  **그 세션의 턴이 도는 중이면 거절한다**: 그때 넣으면 진행 중 턴이 그 입력에 이어서 답한다 (루프가 최신 user 를 본다 — 01w, 신규 세대도 01h).
   *  세션이 없으면 만든다(onSession). messageId 는 newMessageId — 다시 열 때 이 입력을 가려낸다 */
  async addContext(
    providerId: string,
    modelId: string,
    directory: string,
    text: string,
    messageId: string,
    sessionId?: string,
    onSession?: (sessionId: string) => Promise<void>,
  ): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
    if (sessionId && this.busy.has(sessionId)) return { ok: false, sessionId, error: tr('error.contextBusy') }
    if (!this.ctx.providers.get(providerId)) return { ok: false, sessionId, error: tr('error.noProvider', { id: providerId }) }
    let id = sessionId
    try {
      const conn = await this.ctx.engine.connection()
      const ready = await this.prepare(conn, providerId, modelId, directory, sessionId, sessionTitle(text), onSession)
      if ('error' in ready) return { ok: false, sessionId, error: ready.error }
      id = ready.id
      if (this.busy.has(id)) return { ok: false, sessionId: id, error: tr('error.contextBusy') }
      if (sessionId) await carryOver(conn, id, ready.workdir, { providerID: providerId, modelID: modelId }, messageId) // 옛 대화를 먼저 (#21)
      const res = await fetch(`${conn.url}/session/${id}/prompt_async?${at(ready.workdir)}`, {
        method: 'POST',
        headers: { ...conn.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ messageID: messageId, noReply: true, model: { providerID: providerId, modelID: modelId }, parts: [{ type: 'text', text }] }),
      })
      if (!res.ok) return { ok: false, sessionId: id, error: tr('error.contextAdd', { status: res.status }) }
      return { ok: true, sessionId: id }
    } catch (error) {
      return { ok: false, sessionId: id, error: tr('error.opencodeConnect', { message: (error as Error).message }) }
    }
  }

  private async turn(
    providerId: string,
    modelId: string,
    directory: string,
    prompt: string,
    sessionId: string | undefined,
    onSession: ((sessionId: string) => Promise<void>) | undefined,
    messageId: string | undefined,
    onProgress: ((item: TurnItem) => void) | undefined,
    admittedTurn: { busy?: string; sessionId?: string },
    mode: Mode,
    onAttention: ((requests: Attention[]) => void) | undefined,
    stop: AbortSignal | undefined,
    images: readonly ChatImage[],
    context: string | undefined,
    hideMcpTools: Readonly<Record<string, readonly string[]>> = {},
    stallTimeoutMs?: number,
  ): Promise<ChatResult> {
    const provider = this.ctx.providers.get(providerId)
    if (!provider) return { ok: false, error: tr('error.noProvider', { id: providerId }) }

    let conn: EngineConnection | undefined
    let id = sessionId
    try {
      conn = await this.ctx.engine.connection()
      const ready = await this.prepare(conn, providerId, modelId, directory, id, sessionTitle(prompt || (images[0]?.filename ?? '')), onSession, mode)
      if ('error' in ready) return { ok: false, sessionId: id, error: ready.error }
      id = ready.id
      const { workdir } = ready
      if (stop?.aborted) return { ok: false, sessionId: id, error: tr('error.stopped'), interrupted: true } // 보내기 전에 멈췄다
      const turnSession = id
      this.busy.add(id) // addContext 가 이 세션을 막는다 (prompt 보내기 전부터 — 그 사이에 끼어들지 않게)
      admittedTurn.busy = id
      const declined = new Set<string>()
      const userMessageId = messageId ?? this.newMessageId()
      const instructions = await projectInstructions(workdir)
      // 할 일 동기화 규칙은 프로젝트 지시문 뒤에(뒤가 이긴다), 그 턴 맥락(context)은 그 뒤에 — 이슈 #406
      const system = [instructions, TODO_SYNC_RULE, context].filter(Boolean).join('\n\n')
      // 레거시 전환 전에 쌓인 대화면 옛 글을 이 입력 앞에 한 번 넣는다 (migrate.ts, #21). 새로 만든 세션은 옛 기록이 없다
      if (sessionId) await carryOver(conn, id, workdir, { providerID: providerId, modelID: modelId }, userMessageId)

      let admitted!: (sent: boolean) => void
      const scope = new TurnScope(id, userMessageId)
      const tracker = new TurnTracker(workdir, this.mcpTool(workdir))
      const calls = new ToolCalls()
      const live: RunningTurn = { tracker, workdir, sessionId: id, calls, turnMessageId: userMessageId, reminders: new Set() }
      this.running.add(live)
      this.declined.set(id, declined) // 아래 try 의 finally 가 거둔다 — 그 앞(지시문 읽기·옛 글 넣기)이 던져도 남지 않게 여기서 적는다
      const attention = watchAttention(this.attentionHost(), conn, id, workdir, directory, scope, tracker, onAttention, calls, mode)
      const events = follow(this.ctx, this.streamDispatcher, conn, scope, tracker, workdir, new Promise<boolean>((resolve) => (admitted = resolve)), onProgress, declined, attention.signal, stop, calls, stallTimeoutMs)
      try {
        await events.connected
        if (stop?.aborted) {
          admitted(false)
          return { ok: false, sessionId: id, error: tr('error.stopped'), interrupted: true } // 구독하는 사이에 멈췄다 — 보내지 않는다
        }
        // 개인 지시문(.local.md)이 실렸거나 지시문이 잘렸으면 진행 줄 맨 앞에 알린다 (이슈 #176 — 다시 열면 historyMessages 가 info.system 으로 같은 줄)
        const note = instructionsNote(instructions, workdir)
        if (note) onProgress?.({ kind: 'context', id: `${userMessageId}:instructions`, text: note })
        // 이 턴의 프롬프트 — 끼워 넣는 말(reserve)도 같은 model·agent·system·tools 를 싣는다 (그 뒤 스텝은 마지막 user 의 것을 쓴다, 01ar E)
        const turnFields = (messageID: string, extraSystem?: string) => {
          const joined = [system, extraSystem].filter(Boolean).join('\n\n')
          return { messageID, model: { providerID: providerId, modelID: modelId }, agent: MODE_AGENT[mode], ...(joined && { system: joined }), tools }
        }
        const tools = promptTools(mergeHidden(this.hiddenMcpTools.get(workdir) ?? {}, hideMcpTools))
        const send = await fetch(`${conn.url}/session/${id}/prompt_async?${at(workdir)}`, {
          method: 'POST',
          headers: { ...conn.headers, 'content-type': 'application/json' },
          body: JSON.stringify({ ...turnFields(userMessageId), parts: promptParts(prompt, images) }),
        }).catch((error: unknown) => {
          admitted(false)
          events.stop()
          throw error
        })
        if (!send.ok) {
          admitted(false)
          events.stop()
          return { ok: false, sessionId: id, error: tr('error.promptSend', { status: send.status }) }
        }
        admitted(true)
        admittedTurn.sessionId = id
        this.ctx.emit('llm/turn-started', { sessionId: id, directory })
        // 끼워 넣기 자리 (이슈 #250) — 엔진이 이 턴을 받은 뒤에만. 보내기 전에 이 턴 것으로 받아 두고(scope.adopt) 끝 판정이 그 말을 기다리게 한다
        const engine = conn
        live.reserve = (messageId) => {
          if (events.over()) return undefined
          scope.adopt(messageId)
          events.expect(messageId)
          let settled = false
          return {
            send: async ({ prompt: text, images: attached = [], context: extra, synthetic }) => {
              if (settled) return false
              settled = true
              const res = events.over()
                ? undefined
                : await fetch(`${engine.url}/session/${turnSession}/prompt_async?${at(workdir)}`, {
                    method: 'POST',
                    headers: { ...engine.headers, 'content-type': 'application/json' },
                    body: JSON.stringify({ ...turnFields(messageId, extra), parts: synthetic ? [{ type: 'text', text, synthetic: true }] : promptParts(text, attached) }),
                  }).catch(() => undefined)
              if (!res?.ok) {
                events.forget(messageId)
                return false
              }
              // 보내는 사이에 멈췄다 — 늦게 닿은 말은 새 루프를 돌린다(01ar H) → 그것도 멈춘다
              if (stop?.aborted) void abort(engine, turnSession, workdir)
              return true
            },
            cancel: () => {
              if (settled) return
              settled = true
              events.forget(messageId)
            },
          }
        }

        const result = await events.result
        const usage = result.usage && { ...result.usage, messageTokens: await this.messageTokens(conn, id, workdir) }
        const unanswered = scope.unanswered().filter((messageId) => !live.reminders.has(messageId))
        return {
          ok: result.ok,
          sessionId: id,
          text: result.text,
          error: result.error,
          usage,
          ...(result.interrupted && { interrupted: true }),
          ...(result.declined && { declined: true }),
          ...(unanswered.length > 0 && { unanswered }),
        }
      } finally {
        events.stop()
        attention.stop()
        this.running.delete(live)
        this.declined.delete(turnSession)
      }
    } catch (error) {
      if (conn?.closed.aborted) return { ok: false, sessionId: id, error: interruptedError(), interrupted: true }
      return { ok: false, sessionId: id, error: tr('error.opencodeConnect', { message: (error as Error).message }) }
    }
  }

  /** 손으로 부르는 요약 (/compact, 이슈 #144) — 그 세션의 지금까지 대화를 요약해 컨텍스트를 줄인다. 자동 요약과 같은 요약 줄(running → done)이
   *  onProgress 로 흐르고, 답 글은 없다. messageId 는 엔진이 만든 요약 user 메시지의 id (history 의 그 말풍선 id).
   *  실측 2026-10-06 opencode 1.18.18, 가짜 LLM (docs/opencode-protocol.md): 레거시 `POST /session/{id}/summarize?directory=` 본문
   *  `{providerID, modelID}` (둘 다 필수 — 빠지면 400. 그래서 모델이 밖으로 샐 길이 없다). 응답 200 `true` 는 요약이 끝나거나 멈춘 **뒤에** 온다 —
   *  기다리지 않고 /event 로 따라간다: 요약 user(compaction 파트 auto:false, id 는 엔진이 정한다) → 요약 답(summary:true) → session.compacted → idle.
   *  이음 user 가 없다. 빈 세션도 요약한다(LLM 을 부른다) — 부르는 쪽(ctx.chat)이 막는다.
   *  **끝나지 않은 요약은 지운다**: 멈추면(abort) 요약 답이 MessageAbortedError 로 남는데, 그 뒤 첫 프롬프트는 답 대신 요약만 돌고 끝난다(3/3 —
   *  사용자의 글이 답을 못 받는다). 요약 답·요약 user 를 지우면(DELETE /session/{id}/message/{id}) 다음 턴이 정상이다(3/3) */
  async compact(
    providerId: string,
    modelId: string,
    directory: string,
    sessionId: string,
    onProgress?: (item: TurnItem) => void,
    stop?: AbortSignal,
  ): Promise<ChatResult & { messageId?: string }> {
    if (this.busy.has(sessionId)) return { ok: false, sessionId, error: tr('compact.busy') }
    if (!this.ctx.providers.get(providerId)) return { ok: false, sessionId, error: tr('error.noProvider', { id: providerId }) }
    this.turns++
    this.busy.add(sessionId)
    let conn: EngineConnection | undefined
    try {
      conn = await this.ctx.engine.connection()
      const ready = await this.prepare(conn, providerId, modelId, directory, sessionId, '')
      if ('error' in ready) return { ok: false, sessionId, error: ready.error }
      const { workdir } = ready
      const server = conn
      let admitted!: (sent: boolean) => void
      const tracker = new TurnTracker(workdir, this.mcpTool(workdir))
      const events = follow(this.ctx, this.streamDispatcher, server, new TurnScope(sessionId), tracker, workdir, new Promise<boolean>((resolve) => (admitted = resolve)), onProgress, new Set(), () => {}, stop)
      try {
        await events.connected
        if (stop?.aborted) {
          admitted(false)
          return { ok: false, sessionId, error: tr('error.stopped'), interrupted: true }
        }
        const send = fetch(`${server.url}/session/${sessionId}/summarize?${at(workdir)}`, {
          method: 'POST',
          headers: { ...server.headers, 'content-type': 'application/json' },
          body: JSON.stringify({ providerID: providerId, modelID: modelId }),
        })
        admitted(true) // 응답은 요약이 끝나야 온다 — 멈춤이 그것을 기다리지 않게
        const refused = send.then((res) => (res.ok ? undefined : tr('error.compactSend', { status: res.status })))
        const result = await Promise.race([events.result, refused.then((error) => (error ? { ok: false, text: '', error } : events.result))])
        if (!result.ok) {
          await dropUnfinishedCompactions(server, sessionId, workdir, send).catch(() => {})
          return { ok: false, sessionId, error: result.error, ...(result.interrupted && { interrupted: true }) }
        }
        const raw = await engineMessages(server, sessionId, workdir).catch(() => [])
        const asked = [...raw].reverse().find((message) => message.info.role === 'user' && message.parts.some((part) => part.type === 'compaction'))
        return { ok: true, sessionId, text: '', ...(asked && { messageId: asked.info.id }) }
      } finally {
        events.stop()
      }
    } catch (error) {
      if (conn?.closed.aborted) return { ok: false, sessionId, error: interruptedError(), interrupted: true }
      return { ok: false, sessionId, error: tr('error.opencodeConnect', { message: (error as Error).message }) }
    } finally {
      this.busy.delete(sessionId)
      this.turns--
      this.purgeIfIdle()
      this.gateIfIdle()
      this.reloadIfIdle()
    }
  }

  /** 한 번 묻고 답 글만 받는다 (자동 대화 제목, 이슈 #215) — 대화와 무관한 **임시 세션**을 그 폴더에 만들어 보내고, 끝나면(성공·실패·멈춤) 그 세션을
   *  지운다. 턴이 아니다: 'llm/turn-*'·'llm/before-turn'(MCP 붙이기)·승인 카드('llm/attention*'·'llm/pre-tool')·통계·프로젝트 지시문이 없다.
   *  도구는 전부 끈다 — tools `{"*": false}` 는 세션 permission 을 `*` deny 하나로 바꾼다(#164 실측의 와일드카드. `*` 하나로 전부 빠지는지는 안 쟀다).
   *  모델·에이전트(기본 모드)는 늘 그렇듯 싣는다. stop 이 걸리면(부르는 쪽의 시간 초과) 엔진 턴을 멈춘다. 재시도 상한은 턴과 같다(#207 — 연결 실패는
   *  첫 재시도에서 끝난다). 모델 카탈로그·주소 확인은 안 한다 — 부르는 쪽이 방금 같은 모델로 턴을 돌렸다 */
  async askOnce({ providerId, modelId, directory, prompt, stop }: { providerId: string; modelId: string; directory: string; prompt: string; stop?: AbortSignal }): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    if (!this.ctx.providers.get(providerId)) return { ok: false, error: tr('error.noProvider', { id: providerId }) }
    this.turns++ // DB 정리·엔진 재시작이 이 요청을 끊지 않게 (끝나면 준다)
    let conn: EngineConnection | undefined
    let id: string | undefined
    try {
      conn = await this.ctx.engine.connection()
      const folder = await this.engineFolder(directory)
      if ('error' in folder) return { ok: false, error: folder.error }
      const { workdir } = folder
      if (stop?.aborted) return { ok: false, error: tr('error.stopped') }
      id = await createSession(conn, providerId, modelId, workdir, sessionTitle(prompt))
      const messageId = this.newMessageId()
      let admitted!: (sent: boolean) => void
      const tracker = new TurnTracker(workdir, this.mcpTool(workdir))
      const events = follow(this.ctx, this.streamDispatcher, conn, new TurnScope(id, messageId), tracker, workdir, new Promise<boolean>((resolve) => (admitted = resolve)), undefined, new Set(), () => {}, stop)
      try {
        await events.connected
        if (stop?.aborted) {
          admitted(false)
          return { ok: false, error: tr('error.stopped') }
        }
        const send = await fetch(`${conn.url}/session/${id}/prompt_async?${at(workdir)}`, {
          method: 'POST',
          headers: { ...conn.headers, 'content-type': 'application/json' },
          body: JSON.stringify({ messageID: messageId, model: { providerID: providerId, modelID: modelId }, agent: MODE_AGENT[DEFAULT_MODE], tools: { '*': false }, parts: promptParts(prompt) }),
        }).catch((error: unknown) => {
          admitted(false)
          throw error
        })
        if (!send.ok) {
          admitted(false)
          return { ok: false, error: tr('error.promptSend', { status: send.status }) }
        }
        admitted(true)
        const result = await events.result
        return result.ok ? { ok: true, text: result.text } : { ok: false, error: result.error ?? '' }
      } finally {
        events.stop()
      }
    } catch (error) {
      if (conn?.closed.aborted) return { ok: false, error: interruptedError() }
      return { ok: false, error: tr('error.opencodeConnect', { message: (error as Error).message }) }
    } finally {
      // 임시 세션은 늘 지운다 — 못 지우면 엔진 DB 에만 남는다 (대화 목록엔 처음부터 없다)
      if (id) await this.deleteSession(id).catch((error: unknown) => console.warn('[llm] 임시 세션 지우기 실패', (error as Error).message))
      this.turns--
      this.purgeIfIdle()
      this.gateIfIdle()
      this.reloadIfIdle()
    }
  }

  /** chat·addContext 에 넘길 새 메시지 id — opencode 형식(`msg_` + 시각·순번 12자리 hex + 무작위 14자)이라 시간 순으로 정렬된다.
   *  opencode 는 메시지를 id 순으로 다루므로(01w 9절) 앱이 정한 id 도 그 순서를 지켜야 한다. `/` 명령처럼 보낸 본문과 보일 글이 다를 때,
   *  앱이 이 id 로 보일 글을 따로 적어 둔다 (01d "말풍선 문제"). 같은 id 를 두 번 보내면 조용히 합쳐지므로 매번 새로 만든다 */
  newMessageId(): string {
    return ascendingId('msg')
  }

  // 입력 트리거용 목록 (01d). 쿼리 이름은 모두 `location[directory]` — 틀리면 서버 cwd 기준으로 조용히 온다. 폴더는 chat 과 같은
  // realDirectory 를 거친다(없는 경로를 opencode 에 넘기면 그 경로가 재시작 전까지 500 이 된다 — 01c Q5)

  /** 퍼지 검색 (opencode 기본 상한 50). 새 파일은 몇 초 뒤에야 잡힌다 */
  async findFiles(directory: string, query: string, limit: number, signal?: AbortSignal): Promise<FileEntry[]> {
    return this.engineGet<FileEntry[]>('/api/fs/find', directory, { query, limit: String(limit) }, signal)
  }

  /** 폴더 바로 아래 (rel 은 프로젝트 기준 상대 경로, 빈 글자면 맨 위). 숨김·무시 파일도 다 온다. 폴더 밖은 opencode 가 500 */
  async listDirectory(directory: string, rel: string, signal?: AbortSignal): Promise<FileEntry[]> {
    return this.engineGet<FileEntry[]>('/api/fs/list', directory, rel ? { path: rel } : {}, signal)
  }

  /** 그 폴더의 명령. 새 폴더의 첫 호출은 빈 배열이라(0.1~0.3초 뒤 채워진다, 01d) 비면 잠깐 뒤 한 번 더 묻는다. 캐시하지 않는다 */
  async listCommands(directory: string): Promise<EngineCommand[]> {
    const first = await this.engineGet<EngineCommand[]>('/api/command', directory)
    if (first.length > 0) return first
    await new Promise((resolve) => setTimeout(resolve, 300))
    return this.engineGet<EngineCommand[]>('/api/command', directory)
  }

  /** 그 폴더에서 모델에게 보이는 스킬 (이슈 #7). 레거시 GET /skill?directory= — 채팅이 레거시라 LLM 요청의 `<available_skills>` 와 같은 출처다.
   *  신규 세대 /api/skill 은 프로젝트 설정 차단 플래그를 안 따라 레거시가 안 싣는 스킬까지 준다(실측) — 쓰지 않는다. 숨긴(deny) 내장 스킬도 목록엔 남는다 */
  async listSkills(directory: string): Promise<EngineSkill[]> {
    const workdir = await this.openFolder(directory)
    const conn = await this.ctx.engine.connection()
    const res = await fetch(`${conn.url}/skill?${at(workdir)}`, { headers: conn.headers })
    if (!res.ok) throw new Error(tr('error.engineRoute', { route: '/skill', status: res.status }))
    return (await res.json()) as EngineSkill[]
  }

  /** 그 폴더에서 셸 하나를 띄워 붙는다 (opencode pty — opencodePty.ts) */
  async openTerminal(directory: string, on: TerminalEvents): Promise<TerminalHandle> {
    const workdir = await this.openFolder(directory)
    return openPty(await this.ctx.engine.connection(), workdir, on)
  }

  private async engineGet<T>(route: string, directory: string, params: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
    const workdir = await this.openFolder(directory)
    const conn = await this.ctx.engine.connection()
    const query = new URLSearchParams({ 'location[directory]': workdir, ...params })
    const res = await fetch(`${conn.url}${route}?${query}`, { headers: conn.headers, signal })
    if (!res.ok) throw new Error(tr('error.engineRoute', { route, status: res.status }))
    return ((await res.json()) as { data: T }).data
  }

  /** 지난 대화의 말풍선. directory 는 그 세션의 작업 폴더 — 없으면 opencode 에 묻지 않는다: 폴더가 없어진 세션은 내용 요청이
    *  500 이고, 한 번 실패한 경로는 폴더를 되살려도 opencode 를 재시작할 때까지 계속 500 이다 (01c Q5). 재시택 뒤에도 내용은
    *  그대로 온다 — 이벤트 재생 대신 조립된 메시지 목록을 쓴다. 돌고 있는지는 GET /session/status (돌고 있는 세션만 실린다 — 01w).
    *  hidden 은 말풍선으로 안 그릴 엔진 메시지 id — addContext 로 넣은 `!` 카드 본문 (카드는 앱이 따로 그린다).
    *  query { limit, offset }: 전체 메시지(오래된 것부터)에서 offset 이 다음 페이를 가리키고, limit 개의 페이를 준다.
    *  더 이전이 있으면 more=true — 화면이 스크롤 최상단에서 자동으로 offset += limit 으로 다음 페이를 불러온다.
    *  페이는 user 턴 경계에서 자른다 — 턴 중간을 잘리지 않는다.
    *  hidden(카드가 싣는 `!` 본문)은 말풍선에서 안 보인다 — 페이 계산에도 안 쓴다. */
  async history(directory: string, sessionId: string, hidden: ReadonlySet<string> = new Set(), query?: { limit?: number; offset?: number }): Promise<History> {
    const folder = await this.engineFolder(directory)
    if ('error' in folder) return folder.missing ? { missingFolder: true, messages: [] } : { error: folder.error, messages: [] }
    const { workdir } = folder
    try {
      const conn = await this.ctx.engine.connection()
      const limit = query?.limit
      const offset = query?.offset ?? 0
      const pageSize = limit && limit > 0 ? limit : undefined
      // 전체 메시지를 한 번에 받아 페이 slicing 을 정확히 한다 (엔진 API 가 limit 만 지원하고 offset/페이지링 을 안 해줌)
      const allRaw = await engineMessages(conn, sessionId, workdir)
      const all = allRaw.filter((message) => !hidden.has(message.info.id))
      const status = await fetch(`${conn.url}/session/status?${at(workdir)}`, { headers: conn.headers })
      if (!status.ok) throw new Error(tr('error.historyLoad', { message: `HTTP ${status.status}` }))
      const running = sessionId in ((await status.json()) as Record<string, unknown>)
      // 레거시 전환 전에 쌓은 기록(신규 세대)이 먼저다 — 그 뒤에 레거시로 이어 쓴 기록 (migrate.ts, #21)
      const previous = (await readPreviousMessages(conn, sessionId)).filter((message) => !message.id || !hidden.has(message.id))
      // 페이: 전체(오래된 것부터)에서 offset ~ offset+limit 을 슬라이스, user 턴 경계에서 맞춘다
      let visible = all
      let more = false
      if (pageSize !== undefined) {
        const start = offset
        const end = offset + pageSize
        visible = all.slice(start, end)
        const remaining = all.length - end
        more = remaining > 0
        // 턴 경계: 페이 첫 메시지가 user 가 아니면 그 앞 user 로 맞춰서 페이를 자른다
        if (more && visible.length > 0) {
          const boundary = visible.findIndex((message) => message.info.role === 'user')
          if (boundary > 0) visible = visible.slice(boundary)
        }
      }
      const children = await subtaskMessages(conn, visible, workdir)
      return { messages: [...previousHistory(previous, modeOf), ...historyMessages(visible, running, workdir, this.mcpTool(workdir), children)], ...(more && { more: true }) }
    } catch (error) {
      return { error: tr('error.historyLoad', { message: (error as Error).message }), messages: [] }
    }
   }

  /** 레거시 기록 그대로 (오래된 것부터) — Trajectory 탭이 읽는다. workdir 는 realDirectory 를 거친 세션 폴더 (?directory= 에 쓴다) */
  async readMessages(workdir: string, sessionId: string): Promise<EngineMessage[]> {
    return engineMessages(await this.ctx.engine.connection(), sessionId, await this.openFolder(workdir))
  }

  /** 기록(readMessages)의 task 파트가 띄운 하위 작업(자식 세션)의 기록 — 자식 id → 메시지. Trajectory 탭이 하위 작업 묶음을 그린다 */
  async readSubtasks(workdir: string, raw: readonly EngineMessage[]): Promise<Map<string, EngineMessage[]>> {
    return subtaskMessages(await this.ctx.engine.connection(), raw, await this.openFolder(workdir))
  }

  // MCP (이슈 #28, 실측 2026-10-02 opencode 1.18.18 레거시 /mcp — 모든 호출에 평문 `?directory=`, location[directory] 는 조용히 서버 cwd 로 간다 01u):
  // - GET /mcp → {"<이름>":{status, error?}} — 그 폴더 인스턴스의 서버 (앱 CONFIG_DIR·개인 설정·동적 추가). 처음 부르면 설정의 서버를 띄운다
  // - POST /mcp {name, config} → 상태 맵 전체. **그 폴더 인스턴스에만** 붙고(다른 폴더엔 안 보인다) 파일에 안 쓴다. 같은 이름이면 바꿔 끼운다
  //   (옛 프로세스를 끄고 새로 띄운다). 연결까지 기다린다 — 기본 기한 30초, config.timeout 이 기한이다. 다음 턴 LLM 요청 tools 에 바로 실린다
  // - 넘긴 headers·environment 는 디스크(설정·로그·DB)·env·API(/config·/mcp·/provider) 어디에도 안 나온다 (grep 0) — 로컬 자식 env 에만 있다
  // - POST /mcp/{name}/disconnect → true, 상태 disabled, 프로세스 종료, 도구 빠짐. connect 로 되살린다. 지우는 API 는 없다
  // - 엔진을 다시 띄우면 동적 추가는 다 사라진다 — ctx.mcp 가 매 턴(llm/before-turn) 상태를 보고 다시 붙인다

  /** 그 폴더(realpath)의 다음 턴부터 모델에 안 보일 MCP 도구 — 서버 이름 → MCP 서버가 준 도구 이름 (이슈 #164). 부를 때마다 그 폴더 값을 통째로 바꾼다.
   *  엔진 이름(`<서버>_<도구>`)으로 바꿔 prompt_async 의 tools 에 싣는 것은 여기서 한다 (promptTools) */
  hideMcpTools(directory: string, hidden: Readonly<Record<string, readonly string[]>>): void {
    this.hiddenMcpTools.set(directory, hidden)
  }

  /** 그 폴더 인스턴스의 MCP 서버 상태 */
  async mcpStatus(directory: string): Promise<Record<string, McpStatus>> {
    const { conn, workdir } = await this.legacyTarget(directory)
    const res = await fetch(`${conn.url}/mcp?${at(workdir)}`, { headers: conn.headers, signal: AbortSignal.timeout(60_000) })
    if (!res.ok) throw new Error(tr('error.engineRoute', { route: '/mcp', status: res.status }))
    const status = (await res.json()) as Record<string, McpStatus>
    this.mcpServers.set(workdir, Object.keys(status))
    return status
  }

  /** 그 폴더 인스턴스에 서버를 붙이거나 바꿔 끼운다 (연결까지 기다린다). 비밀(헤더·env)은 opencode 메모리에만 */
  async mcpAdd(directory: string, name: string, def: EngineMcp): Promise<Record<string, McpStatus>> {
    const { conn, workdir } = await this.legacyTarget(directory)
    const res = await fetch(`${conn.url}/mcp?${at(workdir)}`, {
      method: 'POST',
      headers: { ...conn.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name, config: conn.mcpConfig(def) }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!res.ok) throw new Error(tr('error.engineRoute', { route: '/mcp', status: res.status }))
    const status = (await res.json()) as Record<string, McpStatus>
    this.mcpServers.set(workdir, Object.keys(status))
    return status
  }

  /** 그 폴더 인스턴스의 서버를 끊는다 (상태 disabled, 프로세스 종료). 엔진이 안 떠 있으면 끊을 것이 없다 — 동적으로 붙인 것은 엔진과 같이
   *  사라진다. 끊으려고 엔진을 띄우지 않는다 (앱을 끌 때 ctx.mcp 의 detachAll 이 죽은 엔진을 다시 띄웠다, #126) */
  async mcpDisconnect(directory: string, name: string): Promise<void> {
    if (!this.ctx.engine.up) return
    const { conn, workdir } = await this.legacyTarget(directory)
    const res = await fetch(`${conn.url}/mcp/${encodeURIComponent(name)}/disconnect?${at(workdir)}`, {
      method: 'POST',
      headers: conn.headers,
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(tr('error.engineRoute', { route: '/mcp', status: res.status }))
  }

  /** 끊은 서버를 다시 잇는다 (01u 실측 1: POST /mcp/{name}/connect → true — 실패해도 true 라 결과는 상태를 다시 읽어 본다) */
  async mcpConnect(directory: string, name: string): Promise<void> {
    const { conn, workdir } = await this.legacyTarget(directory)
    const res = await fetch(`${conn.url}/mcp/${encodeURIComponent(name)}/connect?${at(workdir)}`, {
      method: 'POST',
      headers: conn.headers,
      signal: AbortSignal.timeout(90_000),
    })
    if (!res.ok) throw new Error(tr('error.engineRoute', { route: '/mcp', status: res.status }))
  }

  /** 그 폴더의 도구 이름 → MCP 서버·도구 (마지막으로 본 서버 이름으로, 모르면 첫 `_` 에서 가른다) */
  mcpTool(workdir: string): McpToolResolver {
    return (name) => mcpToolOf(name, this.mcpServers.get(workdir))
  }

  /** 지금 엔진과 그 폴더(realpath) — 넘기면 안 되는 폴더는 opencode 에 넘기지 않는다 (engineFolder) */
  private async legacyTarget(directory: string): Promise<{ conn: EngineConnection; workdir: string }> {
    const workdir = await this.openFolder(directory)
    return { conn: await this.ctx.engine.connection(), workdir }
  }

  /** 엔진에 넘길 폴더(realpath) — **폴더가 엔진에 닿는 유일한 문이다.** 이 클래스에서 폴더를 받아 엔진을 부르는 메서드는 전부 여기(또는
   *  openFolder)를 먼저 지난다. 넘기지 않는 폴더:
   *  - 없는 폴더 (realDirectory — 그 경로가 엔진 재시작 전까지 500 이 된다)
   *  - 엔진이 그 폴더에서 플러그인 파일을 실행할 폴더 (이슈 #101, enginePlugins.ts — 그 폴더의 첫 `/api/*` 호출·첫 턴에 계획 모드·승인과 무관하게
   *    엔진 프로세스 안에서 돈다). 로더를 안 돌리는 레거시 호출(`/skill`·`/mcp`·기록 읽기)까지 같이 막는다 — 문을 하나로 둔다.
   *    **매 호출 본다(캐시 없음)**: 턴 중에 AI 가 만든 파일은 엔진을 다시 띄운 뒤 그 폴더의 첫 호출에 실행된다 — 그 첫 호출도 여기를 지난다.
   *    비용은 상위 폴더마다 readdir 한 번 + 있으면 작은 설정 파일 읽기 (실측 2026-10-05, 이 기계: 깊이 9 폴더에서 중앙값 0.75ms·최대 1.7ms, 깊이 4 에서 0.4ms)
   *  이미 받아들여진 턴이 쥔 workdir 로 하는 호출(구독·승인 답·중지·상태)은 다시 보지 않는다 */
  private async engineFolder(directory: string): Promise<{ workdir: string } | { error: string; missing?: true }> {
    const workdir = await realDirectory(directory)
    if (!workdir) return { error: tr('error.noWorkdir', { dir: directory }), missing: true }
    const plugins = await findEnginePlugins(workdir, this.ctx.engine.configDir)
    if (plugins.length > 0) return { error: tr('error.enginePlugins', { files: describeEnginePlugins(plugins) }) }
    return { workdir }
  }

  /** 그 폴더를 엔진에 넘길 수 없으면 그 사유 (engineFolder 문 — 없는 폴더·플러그인 파일이 있는 폴더). 다른 프로젝트의 대화에 지시를 넣기 전에
   *  세션 도구가 미리 본다 (이슈 #137) — 넣은 뒤에 알면 보낸 쪽은 "받았다" 로 알고 받는 턴만 실패한다 */
  async folderProblem(directory: string): Promise<string | undefined> {
    const folder = await this.engineFolder(directory)
    return 'error' in folder ? folder.error : undefined
  }

  /** engineFolder 의 던지는 판 */
  private async openFolder(directory: string): Promise<string> {
    const folder = await this.engineFolder(directory)
    if ('error' in folder) throw new Error(folder.error)
    return folder.workdir
  }

  /** 지운 대화의 본문을 DB 파일에서 걷어낸다 (ctx.engine.purgeDeleted). 답을 기다리는 턴이 있으면 다 끝난 뒤로 미룬다 */
  purgeDeleted(): void {
    this.purgeWanted = true
    this.purgeIfIdle()
  }

  private purgeIfIdle(): void {
    if (this.turns > 0 || !this.purgeWanted) return
    this.purgeWanted = false
    void this.ctx.engine.purgeDeleted()
  }

  /** 세션을 지운다 — 레거시 `DELETE /session/{id}` (01c Q3, 01w: 그대로). 폴더를 몰라도 지워진다(목록에서 뺀 세션만 남아 폴더가 없다).
   *  이미 없는 세션(404)은 지워진 것으로 본다. 지운 본문은 DB 의 WAL 에 남는다 (01c Q3) */
  async deleteSession(sessionId: string): Promise<void> {
    const conn = await this.ctx.engine.connection()
    const res = await fetch(`${conn.url}/session/${sessionId}`, { method: 'DELETE', headers: conn.headers })
    if (!res.ok && res.status !== 404) throw new Error(tr('error.sessionDelete', { status: res.status }))
  }

  /** 컨텍스트 중 대화 메시지 몫 (추정). 통계용이라 못 구해도 턴은 그대로 돌려준다 */
  private async messageTokens(conn: EngineConnection, sessionId: string, workdir: string): Promise<number | undefined> {
    try {
      return messageTokens(await engineMessages(conn, sessionId, workdir))
    } catch {
      return undefined
    }
  }

  /** 도는 턴의 하위 작업 하나만 멈춘다 (이슈 #32). subtaskId 는 그 하위 작업 줄(TurnItem)의 id. 도는 턴의 줄이 아니면 false.
   *  실측 2026-10-03 opencode 1.18.18 (가짜 LLM, task 2개 중 하나의 자식 세션에 abort — 3/3): 200 true, 그 자식의 bash 는 죽고(파일 안 생김),
   *  부모의 그 task 파트는 곧바로 error "Task cancelled"(= 줄 상태 stopped)로 끝난다. 다른 자식은 끝까지 돌고, 부모는 남은 결과로 다음 스텝을
   *  이어 턴이 ok 로 끝난다(부모 idle 한 번). 다음 턴도 정상 */
  async stopSubtask(subtaskId: string): Promise<boolean> {
    for (const { tracker, workdir } of this.running) {
      const sessionId = tracker.childSession(subtaskId)
      if (!sessionId) continue
      await abort(await this.ctx.engine.connection(), sessionId, workdir)
      return true
    }
    return false
  }

  /** 앱 MCP 서버가 받은 도구 호출을 누가 불렀나 (이슈 #55 — 요청에는 없다, 01z 1-2). 그 폴더(realpath)의 도는 턴에서 같은 도구·같은 인자로 running 인
   *  호출을 찾는다 — running 이벤트가 요청보다 1~3ms 늦을 수 있어 waitMs 까지 기다린다. 못 찾았거나(앱이 돌린 턴의 호출이 아니다) 둘 이상이라
   *  가를 수 없으면 undefined. 찾은 호출은 소진한다(같은 호출이 두 번 짝이 되지 않는다). child: 하위 작업이 불렀다. approved: 사용자가 앱의
   *  승인 카드에서 허용했다(reply) — 엔진 API 로 스스로 허용한 호출은 false 다. 도구 이름 규칙(`<서버>_<도구>`)은 엔진의 것이라 여기서 만든다 */
  callerOf(directory: string, ref: McpToolRef, args: Record<string, unknown>, waitMs = CALLER_WAIT_MS): Promise<ToolCaller | undefined> {
    const tool = `${sanitizeMcpName(ref.server)}_${sanitizeMcpName(ref.tool)}`
    return awaitCaller(() => findCaller(this.running, directory, tool, args), waitMs)
  }

  /** 카드의 답을 엔진에 보낸다 — 규칙은 llm/attention.ts 의 replyAttention 주석 */
  async reply(sessionId: string, requestId: string, answer: AttentionAnswer, target?: AttentionTarget): Promise<void> {
    return replyAttention(this.attentionHost(), sessionId, requestId, answer, target)
  }

  /** 승인·질문 처리(llm/attention.ts)에 넘기는 이 서비스의 상태 — 같은 Map·Set 을 그대로 넘긴다 */
  private attentionHost(): AttentionHost {
    return {
      ctx: this.ctx,
      requests: this.requests,
      allowed: this.allowed,
      declined: this.declined,
      watchers: this.watchers,
      running: this.running,
      mcpTool: (workdir) => this.mcpTool(workdir),
    }
  }
}
