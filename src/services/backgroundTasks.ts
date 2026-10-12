import { APP_MCP_NAME } from './mcp.ts'
import type { ChatOptions, ChatResult } from './llm.ts'
import { tr } from '../i18n.ts'
import { upsertItem } from '../../shared/chatReducer.ts'
import { GOAL_GET_TOOL, GOAL_UPDATE_TOOL } from '../../shared/goal.ts'
import { DEFAULT_MODE, type Mode } from '../../shared/modes.ts'
import {
  TASK_QUIET_MS,
  TASK_STALL_TIMEOUT_MS,
  TASK_START_TOOL,
  TASK_STATUS_TOOL,
  taskActivity,
  taskCap,
  taskPrompt,
  taskQuietNotice,
  taskReport,
  type TaskAgent,
  type TaskEnd,
  type TaskStatusEntry,
} from '../../shared/tasks.ts'
import type { QueuedSend } from '../../shared/chat.ts'
import type { Conversation, Subtask, TurnItem } from '../../shared/contract.ts'

// 백그라운드 하위 작업 (이슈 #319) — ctx.chat 이 쥐는 대화별 작업 목록. 모델이 `litecode_task_start` 로 띄운다(appMcp/tools/tasks.ts).
// 내장 task(동기식 — 메인 턴이 하위 작업을 기다리며 막힌다)는 엔진 설정에서 껐다 (engineConfig.ts).
//
// - 작업 하나 = **따로 만든 엔진 세션의 한 턴**(ctx.llm.chat). 대화 목록에는 없다. 메인 턴은 번호만 받고 곧바로 끝난다
// - 모드: explore 는 계획 모드 규칙(읽기 전용), general 은 그 대화의 모드. **매번 묻기의 general 은 거절한다** — 작업은 사람에게 물을 곳이 없어
//   편집·명령이 다 막힌다. 그 밖의 승인·질문 요청은 곧바로 거절로 답한다(작업이 멈춰 서지 않게) — 작업 글에도 그렇게 알린다
// - 작업 턴에서는 작업 도구·목표 도구를 숨긴다(재귀 금지 — 도구도 부른 세션이 작업이면 거절한다)
// - 끝나면(완료·실패·중지) 그 대화에 출처 'task' 의 새 턴으로 결과를 넣는다 (report). 메인이 돌고 있으면 기존 대기열 규칙 — 사람 글이 아니라
//   끼워 넣지 않고 대기열 끝에 선다. 작업마다 한 번만 넣는다. 대화가 지워졌으면 멈추고 넣지 않는다
// - 중지는 작업마다 (stop) — 메인 ■ 는 작업을 건드리지 않는다. 엔진 재시작 등으로 끊기면 "중단됨" 으로 알린다
// - **대화마다 동시에 실행되는 작업은 설정의 수(기본 MAX_RUNNING_TASKS = 2, host.limit)** (#321) — 나머지는 대기(queued)로 줄 서고 앞이 끝나면(완료·실패·중지) 들어온 순서로 시작한다.
//   대기 중엔 엔진에 아무것도 안 보냈으므로 stall 타이머(MODEL_STALL_TIMEOUT_MS)도 없다. 실행 + 대기 합계 상한은 taskCap. 대기 중인 작업도 중지할 수 있다.
//   설정을 바꾸면 도는 작업은 그대로, 대기 중인 것은 새 수에 맞춰 시작한다(pumpAll)
//   (엔진 없이 곧바로 "중단됨" 결과 턴). 모드·모델·폴더는 띄울 때의 대화 것으로 돈다
// - **타이머로 죽이지 않는다** (사용자 결정 2026-10-12): 작업 턴은 ctx.llm 의 평소 무응답 한도(120초·도구 인자 600초) 대신 하드 한도
//   TASK_STALL_TIMEOUT_MS 하나로만 끊긴다(게이트웨이가 정말 죽은 경우). 그 전엔 진행 줄 변화를 마지막 활동으로 적어 두고, TASK_QUIET_MS 동안 조용하면
//   작업 줄에 표시(quietSince)하고 메인에게 출처 'task' 의 알림 턴을 **한 번** 넣는다 — 판단(기다리기·중지)은 메인·사람이. 활동이 다시 오면 표시를 풀고
//   다시 무장한다. 상태는 litecode_task_status 로 본다(status)
// - 앱을 끄면 메모리째 사라진다 (실행·대기 작업은 종료 확인의 수에 든다 — ctx.chat.running)
// 화면은 진행 줄의 하위 작업 줄(Subtask)과 같은 모양으로 받아 작업 줄(JobsDock)에 그린다

/** 대화마다 남겨 둘 끝난 작업 수 (작업 줄의 "끝난 작업") */
const FINISHED_KEEP = 10
/** 진행 줄을 화면에 알리는 간격 — 글 조각마다 목록 전체를 보내지 않게 모은다 */
const EMIT_MS = 200

export interface TaskInput {
  agent: TaskAgent
  description: string
  prompt: string
}

export interface TaskHost {
  /** 작업 한 턴 (ctx.llm.chat) */
  run(options: ChatOptions): Promise<ChatResult>
  /** 작업의 승인·질문 요청을 거절한다 (ctx.llm.reply … 'reject') */
  reject(sessionId: string, requestId: string): Promise<void>
  /** 결과 턴을 넣는다 (ctx.chat.send) */
  report(cid: string, send: QueuedSend): Promise<unknown>
  /** 그 대화의 작업 목록이 바뀌었다 */
  changed(cid: string, tasks: Subtask[]): void
  /** 대화마다 동시에 실행할 작업 수 (설정) */
  limit(): number
}

interface Task {
  cid: string
  number: number
  agent: TaskAgent
  description: string
  prompt: string
  /** 띄울 때의 대화 (모델·폴더)와 작업 모드 — 대기했다가 시작해도 이것으로 */
  conversation: Conversation
  mode: Mode
  view: Subtask
  sessionId?: string
  stop: AbortController
  /** 대화가 지워져 결과를 넣지 않는다 */
  dropped: boolean
  /** 마지막 활동 시각·종류 — 시작하면 시작 시각, 그 뒤로 진행 줄이 바뀔 때마다 */
  lastActivityAt?: number
  lastActivity?: string
  /** 조용함 감시 (TASK_QUIET_MS) — 실행 중에만 */
  quietTimer?: ReturnType<typeof setTimeout>
}

export class BackgroundTasks {
  private tasks = new Map<string, Task[]>()
  private numbers = new Map<string, number>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private host: TaskHost) {}

  /** 작업을 띄우고 번호를 준다 — 실행 자리가 있으면 곧바로(엔진 턴은 뒤에서), 없으면 대기(queued). 못 띄우면 사유를 던진다 (모델이 읽는다 — 영어) */
  start(conversation: Conversation, input: TaskInput): { number: number; id: string; queued: boolean; limit: number } {
    const cid = conversation.id
    const model = conversation.model
    if (!model) throw new Error('This conversation has no model.')
    const mode: Mode = input.agent === 'explore' ? 'plan' : (conversation.mode ?? DEFAULT_MODE)
    if (input.agent === 'general' && mode === 'ask')
      throw new Error('In "ask every time" mode every edit and command needs the user\'s approval, which a background task cannot ask for. Use agent "explore", or do the work yourself.')
    const limit = this.host.limit()
    const cap = taskCap(limit)
    if (this.live(cid) >= cap) throw new Error(`Too many background tasks in this conversation (at most ${cap} running or waiting). Wait for one to finish.`)
    const queued = this.active(cid) >= limit
    const number = (this.numbers.get(cid) ?? 0) + 1
    this.numbers.set(cid, number)
    const id = `bgtask:${cid}:${number}`
    const task: Task = {
      cid,
      number,
      agent: input.agent,
      description: input.description,
      prompt: input.prompt,
      conversation,
      mode,
      view: { kind: 'subtask', id, agent: input.agent, description: `#${number} ${input.description}`, status: 'queued', items: [] },
      stop: new AbortController(),
      dropped: false,
    }
    this.tasks.set(cid, [...(this.tasks.get(cid) ?? []), task])
    if (!queued) this.begin(task)
    this.emit(cid, true)
    return { number, id, queued, limit }
  }

  /** 작업 하나를 멈춘다 — 실행·대기 중이면 true. 실행 중이면 끝은 run 이 처리하고, 대기 중이면 엔진 없이 곧바로 끝낸다 (둘 다 "중단됨" 결과 턴) */
  stop(id: string): boolean {
    for (const list of this.tasks.values()) {
      const task = list.find((entry) => entry.view.id === id)
      if (!task) continue
      if (task.view.status === 'queued') {
        task.stop.abort()
        void this.finish(task, 'stopped')
        return true
      }
      if (task.view.status !== 'running') return false
      task.stop.abort()
      return true
    }
    return false
  }

  /** 대화가 지워졌다 — 도는 작업을 멈추고(결과는 안 넣는다) 목록을 비운다 */
  remove(cid: string): void {
    for (const task of this.tasks.get(cid) ?? []) {
      task.dropped = true
      task.stop.abort()
      clearTimeout(task.quietTimer)
    }
    this.tasks.delete(cid)
    clearTimeout(this.timers.get(cid))
    this.timers.delete(cid)
    this.host.changed(cid, [])
  }

  /** 끝나지 않은 작업 수(실행 + 대기) — cid 를 주면 그 대화만 */
  live(cid?: string): number {
    const lists = cid === undefined ? [...this.tasks.values()] : [this.tasks.get(cid) ?? []]
    return lists.reduce((sum, list) => sum + list.filter((task) => task.view.status === 'running' || task.view.status === 'queued').length, 0)
  }

  /** 그 대화에서 실행 중인 작업 수 (대기 제외) */
  private active(cid: string): number {
    return (this.tasks.get(cid) ?? []).filter((task) => task.view.status === 'running').length
  }

  /** 실행 자리가 비었으면 대기 중인 작업을 들어온 순서로 시작한다 */
  private pump(cid: string): boolean {
    const waiting = (this.tasks.get(cid) ?? []).filter((task) => task.view.status === 'queued')
    const starting = waiting.slice(0, Math.max(0, this.host.limit() - this.active(cid)))
    for (const task of starting) this.begin(task)
    return starting.length > 0
  }

  /** 동시 실행 수가 바뀌었다 — 늘었으면 대기 중인 작업을 시작한다 (줄었으면 도는 것은 그대로 두고 새로 시작하지 않을 뿐) */
  pumpAll(): void {
    for (const cid of this.tasks.keys()) if (this.pump(cid)) this.emit(cid, true)
  }

  private begin(task: Task): void {
    task.view = { ...task.view, status: 'running', startedAt: Date.now() }
    task.lastActivityAt = task.view.startedAt
    this.watchQuiet(task)
    void this.run(task)
  }

  /** 그 엔진 세션이 작업의 세션인가 — 작업이 작업 도구를 부르면 거절한다 */
  owns(sessionId: string): boolean {
    for (const list of this.tasks.values()) if (list.some((task) => task.sessionId === sessionId)) return true
    return false
  }

  /** 그 대화의 작업 상태 (litecode_task_status) — 들어온 순서 */
  status(cid: string): TaskStatusEntry[] {
    return (this.tasks.get(cid) ?? []).map((task) => {
      const { status, startedAt, endedAt, error } = task.view
      const state = status === 'done' ? 'completed' : status === 'error' ? 'failed' : status === 'stopped' ? 'stopped' : status === 'queued' ? 'queued' : 'running'
      return {
        number: task.number,
        agent: task.agent,
        description: task.description,
        state,
        ...(startedAt !== undefined && { startedAt }),
        ...(endedAt !== undefined && { endedAt }),
        ...(state === 'running' && task.lastActivityAt !== undefined && { lastActivityAt: task.lastActivityAt }),
        ...(state === 'running' && task.lastActivity && { lastActivity: task.lastActivity }),
        quiet: state === 'running' && task.view.quietSince !== undefined,
        ...(error && { error }),
      }
    })
  }

  list(cid: string): Subtask[] {
    return (this.tasks.get(cid) ?? []).map((task) => task.view)
  }

  /** 작업이 있는 대화 전부 — 화면이 다시 뜨면 이것으로 이어 그린다 */
  snapshot(): Record<string, Subtask[]> {
    return Object.fromEntries([...this.tasks.keys()].map((cid) => [cid, this.list(cid)]))
  }

  private async run(task: Task): Promise<void> {
    const { conversation, mode, prompt } = task
    const model = conversation.model!
    const rejected = new Set<string>()
    const result = await this.host
      .run({
        providerId: model.providerId,
        modelId: model.modelId,
        directory: conversation.project,
        prompt: taskPrompt(task.description, prompt),
        onSession: async (sessionId) => void (task.sessionId = sessionId),
        onProgress: (item: TurnItem) => {
          if (task.view.status !== 'running') return
          this.touch(task, item)
          task.view = { ...task.view, items: upsertItem(task.view.items, item) }
          this.emit(task.cid)
        },
        mode,
        // 작업은 사람에게 묻지 못한다 — 승인·질문은 곧바로 거절 (안 그러면 그 요청에서 영영 멈춘다)
        onAttention: (requests) => {
          for (const request of requests) {
            if (rejected.has(request.id)) continue
            rejected.add(request.id)
            void this.host.reject(request.sessionId, request.id).catch((error: unknown) => console.error('[tasks] 승인 거절 실패', (error as Error).message))
          }
        },
        stop: task.stop.signal,
        stallTimeoutMs: TASK_STALL_TIMEOUT_MS, // 평소 무응답 한도로 죽이지 않는다 — 조용함은 알림으로 (quiet)
        hideMcpTools: { [APP_MCP_NAME]: [TASK_START_TOOL, TASK_STATUS_TOOL, GOAL_GET_TOOL, GOAL_UPDATE_TOOL] },
      })
      .catch((error: unknown): ChatResult => ({ ok: false, error: (error as Error).message }))
    const end: TaskEnd = result.ok ? 'completed' : result.interrupted || task.stop.signal.aborted ? 'stopped' : 'failed'
    const error = result.ok || task.stop.signal.aborted ? undefined : String(result.error ?? '')
    await this.finish(task, end, result.text, error)
  }

  /** 작업 끝 — 작업 줄을 고치고, 다음 대기 작업을 시작하고, 결과 턴을 넣는다 (지워진 대화면 아무것도 안 한다) */
  private async finish(task: Task, end: TaskEnd, resultText?: string, error?: string): Promise<void> {
    clearTimeout(task.quietTimer)
    task.quietTimer = undefined
    task.view = { ...awake(task.view), status: end === 'completed' ? 'done' : end === 'stopped' ? 'stopped' : 'error', endedAt: Date.now(), ...(error && { error }) }
    if (task.dropped) return
    this.pump(task.cid)
    this.trim(task.cid)
    this.emit(task.cid, true)
    const text = taskReport({ number: task.number, agent: task.agent, description: task.description, end, text: resultText, ...(error && { error }) })
    await this.host
      .report(task.cid, { text, display: tr(`task.report.${end}`, { number: task.number, description: task.description }), origin: 'task' })
      .catch((reason: unknown) => console.error('[tasks] 결과 턴 넣기 실패', (reason as Error).message))
  }

  /** 작업이 움직였다 — 마지막 활동을 적고, 조용함 표시를 풀고, 감시를 다시 건다 */
  private touch(task: Task, item: TurnItem): void {
    task.lastActivityAt = Date.now()
    task.lastActivity = taskActivity(item)
    task.view = awake(task.view)
    this.watchQuiet(task)
  }

  private watchQuiet(task: Task): void {
    clearTimeout(task.quietTimer)
    task.quietTimer = setTimeout(() => this.quiet(task), TASK_QUIET_MS)
  }

  /** TASK_QUIET_MS 동안 조용했다 — 죽이지 않고 작업 줄에 표시하고 메인에게 한 번 알린다 (다음 알림은 활동이 다시 온 뒤에만 — touch 가 다시 건다) */
  private quiet(task: Task): void {
    task.quietTimer = undefined
    if (task.view.status !== 'running' || task.dropped) return
    task.view = { ...task.view, quietSince: task.lastActivityAt ?? Date.now() }
    this.emit(task.cid, true)
    const minutes = Math.round(TASK_QUIET_MS / 60_000)
    const text = taskQuietNotice({ number: task.number, description: task.description, quietMs: TASK_QUIET_MS, ...(task.lastActivity && { lastActivity: task.lastActivity }) })
    void this.host
      .report(task.cid, { text, display: tr('task.notice.quiet', { number: task.number, description: task.description, minutes }), origin: 'task' })
      .catch((reason: unknown) => console.error('[tasks] 조용함 알림 넣기 실패', (reason as Error).message))
  }

  /** 끝난 작업은 최근 것만 남긴다 */
  private trim(cid: string): void {
    const list = this.tasks.get(cid) ?? []
    const finished = list.filter((task) => task.view.status !== 'running' && task.view.status !== 'queued')
    if (finished.length <= FINISHED_KEEP) return
    const drop = new Set(finished.slice(0, finished.length - FINISHED_KEEP))
    this.tasks.set(cid, list.filter((task) => !drop.has(task)))
  }

  /** 화면에 알린다 — now 가 아니면 EMIT_MS 동안 모은다 */
  private emit(cid: string, now = false): void {
    clearTimeout(this.timers.get(cid))
    this.timers.delete(cid)
    if (now) return this.host.changed(cid, this.list(cid))
    this.timers.set(
      cid,
      setTimeout(() => {
        this.timers.delete(cid)
        this.host.changed(cid, this.list(cid))
      }, EMIT_MS),
    )
  }
}

/** 조용함 표시를 뺀 작업 줄 */
function awake(view: Subtask): Subtask {
  if (view.quietSince === undefined) return view
  const { quietSince: _quiet, ...rest } = view
  return rest
}
