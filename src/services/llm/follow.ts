import type { Context } from 'cordis'
import path from 'node:path'
import type { Agent } from 'undici'
import type { EngineConnection } from '../engine.ts'
import { TurnMeter } from '../turnUsage.ts'
import type { EngineMessageInfo, EnginePart, TurnItem, TurnScope, TurnTracker } from '../turnProgress.ts'
import type { ToolCalls } from '../toolCalls.ts'
import { failureText, interruptedError } from '../history.ts'
import { turnError } from '../contextOverflow.ts'
import { httpStatusOf } from '../../../shared/httpError.ts'
import { tr } from '../../i18n.ts'
import { abort, at } from './engineApi.ts'
import { CONNECT_TIMEOUT_MS, connectionRefused, KEY_STORE, MAX_COMPACTIONS_PER_TURN, MAX_RETRIES_PER_TURN, MODEL_STALL_TIMEOUT_MS, TOOL_INPUT_STALL_TIMEOUT_MS, UNREACHABLE_STATUS } from './limits.ts'
import type { EngineEvent, ToolDone, TurnOutcome } from './types.ts'

/** 그 폴더의 /event 를 구독해 이 턴(scope)의 이벤트로 진행 줄·사용량·결과를 모은다. connected 는 server.connected 를 받으면 풀린다 — 그 뒤에 보내야
 *  첫 이벤트를 놓치지 않는다(재생이 없다). result 는 턴이 끝나면(성공/실패/중단 모두) 풀린다.
 *  끝: 이 턴 user 메시지를 본 뒤의 session.idle. 이 user 메시지를 보기 전의 idle 은 앞 턴(중지 뒤 두 번째 idle 등)의 것이다.
 *  session.error 는 사유로 적어 두고 idle 을 기다린다 — 다만 없는 에이전트처럼 메시지가 생기지 않고 idle 도 없는 경우가 있어(01w) 그때 상태를 묻는다 */
export function follow(
  ctx: Context,
  streamDispatcher: Agent,
  conn: EngineConnection,
  scope: TurnScope,
  tracker: TurnTracker,
  workdir: string,
  admitted: Promise<boolean>,
  onProgress: ((item: TurnItem) => void) | undefined,
  declined: ReadonlySet<string>,
  onAttentionSignal: (type: string, properties: Record<string, unknown>) => void,
  userStop?: AbortSignal,
  calls?: ToolCalls,
): {
  connected: Promise<void>
  result: Promise<TurnOutcome>
  stop: () => void
  /** 끼워 넣을 user 메시지를 기다린다 (이슈 #250) — 그 user 를 보기 전의 idle 로는 끝내지 않는다 */
  expect(messageId: string): void
  /** 그 말을 더 기다리지 않는다 (못 보냈다) — 기다리느라 미룬 idle 이 있었으면 그때 끝낸다 */
  forget(messageId: string): void
  /** 이 턴이 끝났다 (끝 판정·멈춤·끊김) — 더 끼워 넣지 않는다 */
  over(): boolean
} {
  const sessionId = scope.sessionId
  const controller = new AbortController()
  const meter = new TurnMeter()
  let connected!: () => void
  let failConnect!: (error: unknown) => void
  const connecting = new Promise<void>((resolve, reject) => ((connected = resolve), (failConnect = reject)))
  connecting.catch(() => {})
  let seenUser = false
  let compactions = 0
  /** 게이트웨이가 한도 초과로 거절했다 — opencode 는 자동 요약으로 줄여 이어 간다. 요약이 안 돌고 끝나면 실패다 */
  let overflowed = false
  let compactionSeen = false
  let failure: EngineMessageInfo['error']
  let declinedEnd = false
  /** 끼워 넣었지만 아직 이벤트로 못 본 user 메시지 (이슈 #250) — 이것이 남아 있는 동안 온 idle 은 미룬다 (A 의 idle 과 엇갈려 늦게 닿은 말은
   *  새 루프·자기 idle 을 받는다, 01ar H 8/8) */
  const awaiting = new Set<string>()
  let idleDeferred = false
  let over = false
  /** 모델 무응답 감시 (이슈 #264) — 엔진이 프롬프트를 받은 뒤 이 턴의 이벤트마다 다시 건다. running 인 도구 호출이 있으면 걸지 않는다.
   *  모델이 도구 인자를 만드는 중(pending)이면 더 긴 한도 — 그동안 엔진은 이벤트를 안 낸다 (#321, limits.ts TOOL_INPUT_STALL_TIMEOUT_MS) */
  const toolsRunning = new Set<string>()
  const toolsPending = new Set<string>()
  let watching = false
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  const progressed = (): void => {
    clearTimeout(stallTimer)
    const limit = toolsPending.size > 0 ? TOOL_INPUT_STALL_TIMEOUT_MS : MODEL_STALL_TIMEOUT_MS
    stallTimer = watching && !over && toolsRunning.size === 0 ? setTimeout(() => stalled(limit), limit) : undefined
  }
  const stalled = (limit: number): void => {
    void abort(conn, sessionId, workdir)
    finish(outcome({ ok: false, error: tr('error.modelStalled', { seconds: limit / 1000 }) }))
  }
  void admitted.then((sent) => {
    watching = sent
    progressed()
  })
  let resolveFinish!: (outcome: TurnOutcome) => void
  const finished = new Promise<TurnOutcome>((resolve) => (resolveFinish = resolve))
  const finish = (value: TurnOutcome): void => {
    over = true
    clearTimeout(stallTimer)
    resolveFinish(value)
  }
  const outcome = (base: Omit<TurnOutcome, 'text' | 'usage'>): TurnOutcome => ({ text: tracker.text(), usage: meter.usage(), ...base })
  /** 끝난 도구 호출을 호출마다 한 번 알린다 ('llm/tool-done') — 끝난 파트가 다시 와도(메타데이터 갱신) 한 번 */
  const toolsDone = new Set<string>()
  /** 실행에 들어간 도구 호출을 호출마다 한 번 알린다 ('llm/tool-started') — running 파트가 갱신으로 다시 와도 한 번 */
  const toolsStarted = new Set<string>()
  const toolStarted = (part: EnginePart | undefined, child: boolean): void => {
    if (part?.type !== 'tool' || !part.tool || !part.callID || part.state?.status !== 'running' || toolsStarted.has(part.callID)) return
    toolsStarted.add(part.callID)
    ctx.emit('llm/tool-started', { sessionId, directory: workdir, tool: part.tool, input: part.state.input, callID: part.callID, child })
  }
  const toolDone = (part: EnginePart | undefined, child: boolean): void => {
    const done = finishedTool(part, workdir)
    const key = part?.callID ?? part?.id
    if (!done || !key || toolsDone.has(key)) return
    toolsDone.add(key)
    ctx.emit('llm/tool-done', { sessionId, directory: workdir, ...done, child })
  }
  /** 사용자가 멈췄다 — 프롬프트가 받아들여진 뒤에 opencode 턴을 멈춘다(먼저 보내면 뒤에 받아들여진 프롬프트가 그대로 돈다).
   *  idle 을 기다리지 않는다 — 승인 대기 중이어도 abort 응답 뒤 바로 끝낸다. 뒤따르는 idle 은 다음 턴이 자기 user 메시지 전이라 버린다 */
  const stopped = async (): Promise<TurnOutcome> => {
    if (await admitted) await abort(conn, sessionId, workdir)
    return outcome({ ok: false, error: tr('error.stopped'), interrupted: true })
  }
  const ended = (): TurnOutcome => {
    if (overflowed && !compactionSeen) failure ??= { name: 'ContextOverflowError' }
    if (failure) {
      if (failure.name === 'MessageAbortedError') return outcome({ ok: false, error: tr('error.stopped'), interrupted: true }) // 다른 클라이언트가 멈췄다
      return outcome({ ok: false, error: failureText(failure) })
    }
    // 오류도 거절도 없는데 모델이 아무것도 내놓지 않고 끝났다 — 게이트웨이가 닿지 않을 때 "완료" 로 보이던 것 (사용자 2026-10-09)
    if (!declinedEnd && !tracker.hasOutput()) return outcome({ ok: false, error: tr('error.noAnswer') })
    return declinedEnd ? outcome({ ok: true, declined: true }) : outcome({ ok: true })
  }
  /** user 메시지가 생기기 전의 session.error — idle 없이 끝나는 거절(없는 에이전트 등)일 수 있다. 그 세션이 돌고 있지 않고 여전히 이 턴 user
   *  메시지가 없으면 끝이다. 앞 턴을 멈춘 MessageAbortedError 가 늦게 온 것은 이 턴과 무관하다 */
  const settleError = async (error: EngineMessageInfo['error']): Promise<void> => {
    if (error?.name === 'MessageAbortedError') return
    const res = await fetch(`${conn.url}/session/status?${at(workdir)}`, { headers: conn.headers, signal: conn.closed }).catch(() => undefined)
    if (!res?.ok) return
    const running = sessionId in ((await res.json()) as Record<string, unknown>)
    if (!running && !seenUser) {
      failure = error
      finish(ended())
    }
  }
  const handle = (event: EngineEvent): void => {
    const props = event.properties ?? {}
    if (event.type === 'server.connected') return connected()
    const role = scope.of(event.type, props)
    if (role) {
      const part = props['part'] as EnginePart | undefined
      if (role === 'assistant' && part?.type === 'tool' && part.callID) {
        if (part.state?.status === 'running') toolsRunning.add(part.callID)
        else toolsRunning.delete(part.callID)
        if (part.state?.status === 'pending') toolsPending.add(part.callID)
        else toolsPending.delete(part.callID)
      }
      progressed()
    }
    if (role === 'summary') {
      // 요약 답 — 글은 답이 아니다. 끝나면 요약 줄을 구분선으로, 실패(한도 초과로 요약도 못 함)면 그 사유로 턴이 끝난다 (idle 이 뒤따른다)
      if (event.type !== 'message.updated') return
      const info = props['info'] as EngineMessageInfo
      const item = info.error ? tracker.compaction(info.parentID!, 'failed') : info.time?.completed !== undefined ? tracker.compaction(info.parentID!, 'done') : undefined
      if (item) onProgress?.(item)
      if (info.error) failure = info.error
      return
    }
    if (role) {
      if (role === 'assistant' || event.type === 'message.updated') meter.observe(event.type, props) // user 의 글 파트는 출력이 아니다
      if (role === 'user' && event.type === 'message.updated') {
        seenUser = true
        // 기다리던 끼워 넣은 말이다 — 그 앞에 미룬 idle 은 앞 루프의 것이었고, 이 말은 자기 루프·idle 을 받는다
        if (awaiting.delete((props['info'] as EngineMessageInfo).id)) idleDeferred = false
      }
      if (role === 'user' && (props['part'] as EnginePart | undefined)?.type === 'compaction') {
        compactionSeen = true
        seenUser = true // 손으로 부른 요약은 이 요약 user 가 턴의 시작이다 (자동 요약이면 이미 참)
        const item = tracker.compaction((props['part'] as EnginePart).messageID!, 'running')
        if (item) onProgress?.(item)
      }
      if (role === 'assistant') {
        if (event.type === 'message.updated') {
          const info = props['info'] as EngineMessageInfo
          if (info.error) failure = info.error
        } else {
          const item = tracker.observe(event.type, props)
          if (item) onProgress?.(item)
          const part = props['part'] as EnginePart | undefined
          calls?.observe(part, false)
          toolStarted(part, false)
          toolDone(part, false)
          if (part?.type === 'tool' && part.state?.status === 'error' && part.callID && declined.has(part.callID)) declinedEnd = true
        }
      }
      return
    }
    // 하위 작업 (task, #31): 이 턴이 띄운 자식 세션의 이벤트는 그 하위 작업 줄로. 자식의 session.idle·session.error 는 부모 턴 끝이 아니다
    const about = props['info'] as EngineMessageInfo | undefined
    if (event.type === 'session.created' && seenUser && about?.parentID === sessionId) return tracker.adoptChild(about.id)
    if (tracker.isChild(props['sessionID'] ?? about?.sessionID)) {
      if (event.type.startsWith('permission.') || event.type.startsWith('question.')) return onAttentionSignal(event.type, props)
      if (event.type === 'message.part.updated') {
        calls?.observe(props['part'] as EnginePart | undefined, true) // 하위 작업이 부른 도구
        toolStarted(props['part'] as EnginePart | undefined, true)
        toolDone(props['part'] as EnginePart | undefined, true)
      }
      const item = tracker.child(event.type, props)
      if (item) onProgress?.(item)
      return
    }
    if (props['sessionID'] !== sessionId) return
    if (event.type.startsWith('permission.') || event.type.startsWith('question.')) return onAttentionSignal(event.type, props)
    if (event.type === 'session.status' && seenUser) {
      const status = props['status'] as Parameters<TurnTracker['status']>[0]
      const item = tracker.status(status)
      if (item) onProgress?.(item)
      // 재시도 상한 (이슈 #207): 엔진의 재시도를 끝까지 기다리지 않는다 — 연결 실패는 첫 알림에서, 그 밖은 MAX_RETRIES_PER_TURN 을 넘으면
      if (status?.type === 'retry') {
        const message = status.message ?? ''
        const unreachable = connectionRefused(message)
        const keyStore = KEY_STORE.test(message)
        if (unreachable || keyStore || (status.attempt ?? 1) > MAX_RETRIES_PER_TURN) {
          void abort(conn, sessionId, workdir)
          finish(outcome({ ok: false, error: keyStore ? message : turnError(message, unreachable ? (httpStatusOf(message) ?? UNREACHABLE_STATUS) : undefined) }))
        }
      }
      return
    }
    if (event.type === 'session.error') {
      const error = props['error'] as EngineMessageInfo['error']
      // 게이트웨이의 한도 초과는 끝이 아니다 — opencode 가 자동 요약으로 줄여 이어 간다(L2 실측). 요약도 못 하면 요약 답의 error 로 온다
      if (seenUser && error?.name === 'ContextOverflowError') overflowed = true
      else if (seenUser) failure ??= error // 이 턴의 실패 — idle 이 뒤따른다
      else void settleError(error)
      return
    }
    if (event.type === 'session.idle' && seenUser) {
      if (awaiting.size === 0) finish(ended())
      else idleDeferred = true // 끼워 넣은 말이 아직 엔진에 안 닿았다 — 그 말의 idle 까지
    }
    if (event.type === 'session.compacted' && seenUser && ++compactions > MAX_COMPACTIONS_PER_TURN) {
      void abort(conn, sessionId, workdir)
      finish(outcome({ ok: false, error: tr('error.contextOverflow') }))
    }
  }

  const result = (async (): Promise<TurnOutcome> => {
    const signal = AbortSignal.any([controller.signal, conn.closed, ...(userStop ? [userStop] : [])]) // 서버가 끝나거나 사용자가 멈추면 읽기를 바로 멈춘다
    const res = await fetch(`${conn.url}/event?${at(workdir)}`, {
      headers: conn.headers,
      signal,
      dispatcher: streamDispatcher,
    } as RequestInit).catch((error: unknown) => {
      if (userStop?.aborted && !controller.signal.aborted) return undefined // 연결 전에 멈췄다
      throw error
    }) // dispatcher 는 Node(undici) fetch 확장이라 DOM RequestInit 타입에 없다
    if (!res) {
      connected() // 보내는 쪽이 stop 을 보게
      return stopped()
    }
    if (!res.ok || !res.body) throw new Error(tr('error.subscribe', { status: res.status }))

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const read = (): Promise<ReadableStreamReadResult<Uint8Array> | undefined> =>
      reader.read().catch((error: unknown) => {
        if (controller.signal.aborted) throw error // 우리가 멈췄다 (stop)
        return undefined // 연결이 잘렸다 (undici: "terminated")
      })
    try {
      while (true) {
        const next = await Promise.race([read(), finished.then(() => 'finished' as const)])
        if (next === 'finished') return await finished
        if (userStop?.aborted) return await stopped()
        if (!next || next.done) {
          const error = await interruption(conn.closed)
          // 엔진이 살아 있으면 opencode 의 턴은 계속 돈다 — 재생이 없어 끝을 다시 받을 길이 없으니 멈추고 "중단됨" 으로 끝낸다 (01q 와 같은 정책)
          if (!conn.closed.aborted && (await admitted)) await abort(conn, sessionId, workdir)
          return outcome({ ok: false, error, interrupted: true })
        }
        buffer += decoder.decode(next.value, { stream: true })
        let frameEnd: number
        while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
          const event = parseFrame(buffer.slice(0, frameEnd))
          buffer = buffer.slice(frameEnd + 2)
          if (event) handle(event)
        }
      }
    } finally {
      void reader.cancel().catch(() => {})
    }
  })()
  result.catch((error: unknown) => failConnect(error)) // 구독 자체가 실패했으면 보내는 쪽도 알게
  const timer = setTimeout(() => failConnect(new Error(tr('error.subscribe', { status: 'timeout' }))), CONNECT_TIMEOUT_MS)
  void connecting.finally(() => clearTimeout(timer)).catch(() => {})

  void result.finally(() => ((over = true), clearTimeout(stallTimer))).catch(() => {})

  return {
    connected: connecting,
    result,
    stop: () => controller.abort(),
    expect: (messageId) => void awaiting.add(messageId),
    forget: (messageId) => {
      if (!awaiting.delete(messageId) || awaiting.size > 0 || !idleDeferred || over) return
      finish(ended())
    },
    over: () => over || controller.signal.aborted || !!userStop?.aborted || conn.closed.aborted,
  }
}

/** 끝난(completed·error) 도구 파트 → 'llm/tool-done' 의 중립 모양. 아직 도는 파트·도구가 아닌 파트면 undefined.
 *  file: read·write·edit 는 인자 `filePath`, apply_patch 는 결과 metadata 의 첫 파일 (toolDiffs.ts 와 같은 자리) — 세션 폴더 기준으로 푼다 */
export function finishedTool(part: EnginePart | undefined, workdir: string): Pick<ToolDone, 'tool' | 'input' | 'output' | 'error' | 'file'> | undefined {
  const state = part?.state
  if (part?.type !== 'tool' || !part.tool || !state || (state.status !== 'completed' && state.status !== 'error')) return undefined
  const input = state.input as { filePath?: unknown } | undefined
  const patched = (state.metadata?.['files'] as { filePath?: unknown }[] | undefined)?.[0]?.filePath
  const file = typeof input?.filePath === 'string' ? input.filePath : typeof patched === 'string' ? patched : undefined
  return {
    tool: part.tool,
    input: state.input,
    ...(state.status === 'completed' && typeof state.output === 'string' && { output: state.output }),
    ...(state.status === 'error' && { error: state.error ?? '' }),
    ...(file && { file: path.resolve(workdir, file) }),
  }
}

/** SSE 프레임 하나의 `data:` JSON. 없거나 깨졌으면 undefined */
function parseFrame(frame: string): EngineEvent | undefined {
  const dataLine = frame.split('\n').find((line) => line.startsWith('data:'))
  if (!dataLine) return undefined
  try {
    return JSON.parse(dataLine.slice('data:'.length).trim()) as EngineEvent
  } catch {
    return undefined
  }
}

/** 끝 이벤트 없이 스트림이 끊겼을 때의 사유. 서버가 끝나면 소켓이 exit 보다 먼저 닫혀(실측 2026-09-30, 앱 실물 테스트에서
 *  "terminated" 가 먼저 왔다) closed 가 아직 안 걸렸을 수 있다 — 잠깐 기다려 원인을 가린다. 어느 쪽이든 턴은 "중단됨" 이다 */
async function interruption(closed: AbortSignal): Promise<string> {
  if (!closed.aborted) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000)
      closed.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
    })
  }
  return closed.aborted ? interruptedError() : tr('error.streamBroken')
}
