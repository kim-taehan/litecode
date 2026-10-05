import { Context, Service } from 'cordis'
import { realpathSync } from 'node:fs'
import fs from 'node:fs/promises'
import './chat.ts'
import './sessions.ts'
import { realDirectory } from './llm.ts'
import type { ExecHandle } from './exec.ts'
import { readJsonFileSync, writeJsonFileSync } from './jsonFile.ts'
import { entriesFor, lenientReader, parseHooks, parseProjects, serializeHooks, serializeProjects } from './hooks/config.ts'
import { runHook, type HookInput, type HookRun } from './hooks/run.ts'
import { tr } from '../i18n.ts'
import { fromPerson } from '../../shared/chat.ts'
import { matchesTool, STOP_CHAIN_MAX, TOOL_HOOK_EVENTS, type HookDef, type HookEntry } from '../../shared/hooks.ts'
import type { Conversation } from '../../shared/contract.ts'

// 훅 (ctx.hooks, 이슈 #102 1단계, 설계 _workspace/01af_hooks.md §6 — 방식 B) — 사용자가 이벤트에 걸어 둔 셸 명령을 **앱 메인 프로세스가**
// 프로젝트 폴더에서 돌린다. 엔진 플러그인을 쓰지 않는다(엔진은 `--pure` 그대로)·엔진을 모른다 — 듣는 것은 ctx.chat 의 턴 앞뒤 확장점과
// ctx.llm 의 중립 이벤트뿐이다. 기능 `hooks`(기본 꺼짐)의 묶음이라 꺼져 있으면 이 서비스가 통째로 없다.
//
// - 정의: userData `hooks.json`(모든 프로젝트) + `hooks-projects.json`(이 프로젝트만 + 프로젝트별 켜기 값) — hooks/config.ts.
//   **돌 때마다 다시 읽는다** — 화면이 생기기 전(3단계)에는 파일을 직접 고쳐 쓰고, 고치면 다음 실행부터 반영된다.
//   프로젝트 폴더가 가진 훅(`.claude/settings.json`)은 읽지 않는다 (자동 실행 금지, 사용자 결정 — 가져오기는 3단계)
// - 실행·결과 해석: hooks/run.ts. 같은 이벤트의 훅은 모든 프로젝트 → 이 프로젝트 순으로 **하나씩** 돌고, 결과는 가장 제한적인 것 —
//   하나라도 막으면 막기다 (그 뒤 훅은 돌지 않는다). 실패(그 밖의 코드·기한 초과·실행 실패)는 막지 않는다
// - 이벤트 연결:
//   · 프롬프트 제출(UserPromptSubmit) — 'chat/before-send', **사람이 친 글만**(데스크탑·폰; 다른 대화의 지시·훅이 이어 보낸 글은 아니다).
//     막으면 보내지 않고 stdout 은 그 턴의 맥락
//   · 세션 시작(SessionStart) — 'chat/before-send' 의 첫 턴(출처 무관), stdout 은 그 턴의 맥락. 프롬프트 제출이 막았으면 돌지 않는다
//   · 턴 끝(Stop) — 'chat/after-turn', **완료된 턴만**(실패·중단·거절로 끝난 턴은 아니다). 막으면 사유를 다음 메시지로 이어 보낸다 —
//     연속 STOP_CHAIN_MAX 번까지 (그 뒤엔 막아도 이어 가지 않는다)
//   · 도구 실행 후(PostToolUse) — 'llm/tool-done', 성공한 호출만·하위 작업의 도구 포함, 관찰만(막기·피드백 없음). 대화마다 차례로 돌고
//     턴 끝 훅은 그것들이 끝난 뒤에 돈다
//   · 알림(Notification) — 'llm/attention'(답 필요)·'llm/turn-ended'(완료·실패), 관찰만. 대화에 줄을 남기지 않는다(기록·로그만)
//   · 도구 실행 전(PreToolUse) — 정의만 읽는다. 실행은 2단계(권한 게이트)
// - 표시: 훅이 끝날 때마다 그 대화의 도는 턴에 진행 줄 하나(ctx.chat.note — kind 'hook'). 최근 실행은 메모리(recent)와 main.log 한 줄

declare module 'cordis' {
  interface Context {
    hooks: HooksService
  }
}

export interface HooksOptions {
  /** 모든 프로젝트 훅 (userData hooks.json) */
  file: string
  /** 이 프로젝트만의 훅·프로젝트별 켜기 값 (userData hooks-projects.json) */
  projectsFile: string
  /** 테스트만 — 모든 훅의 기한(ms) */
  timeoutMs?: number
}

/** 한 이벤트의 훅을 다 돌린 결과 — 가장 제한적인 것 */
export interface HookResult {
  outcome: 'passed' | 'blocked'
  /** 막은 훅의 사유 */
  reason?: string
  /** 통과한 훅들이 낸 맥락 글 (돈 순서) */
  context: string[]
  runs: HookRun[]
}

/** 실행 기록 하나 */
export interface HookRecord extends HookRun {
  at: number
  conversationId: string
  directory: string
}

const RECENT_MAX = 200
const COMMAND_SHOWN = 120

/** 턴 끝 훅이 막았을 때 이어 보내는 글 — 모델이 읽는다 (Claude Code 와 같은 머리) */
export function stopFeedback(reason: string): string {
  return `Stop hook feedback:\n${reason}`
}

export class HooksService extends Service {
  static readonly inject = ['chat', 'sessions']

  private read = lenientReader()
  private running = new Set<ExecHandle>()
  private records: HookRecord[] = []
  /** 대화 id → 턴 끝 훅이 연속으로 이어 가게 한 횟수 */
  private chains = new Map<string, number>()
  /** 엔진 세션 id → 밀린 도구 실행 후 훅 (차례로 돈다) */
  private afterTools = new Map<string, Promise<void>>()
  private disposed = false
  private seq = 0

  constructor(
    ctx: Context,
    private opts: HooksOptions,
  ) {
    super(ctx, 'hooks')
    ctx.effect(() => () => {
      this.disposed = true
      for (const handle of this.running) handle.stop('stopped')
    })
    ctx.on('chat/before-send', async (send) => {
      const directory = await realDirectory(send.project)
      if (!directory) return
      const base = { directory, conversationId: send.cid, mode: send.mode }
      const opts = { signal: send.signal, onRun: (run: HookRun) => this.show(send.cid, run) }
      const submitted = fromPerson(send.origin) ? await this.run({ ...base, event: 'UserPromptSubmit', prompt: send.text }, opts) : undefined
      if (submitted?.outcome === 'blocked') {
        send.blocked = tr('hooks.blocked', { reason: submitted.reason ?? '' })
        return
      }
      const started = send.first ? await this.run({ ...base, event: 'SessionStart' }, opts) : undefined
      send.context.push(...(started?.context ?? []), ...(submitted?.context ?? []))
    })
    ctx.on('chat/after-turn', async (turn) => {
      if (turn.outcome !== 'done' || turn.declined) return void this.chains.delete(turn.cid)
      const directory = await realDirectory(turn.project)
      if (!directory) return
      const conversation = await this.conversation((entry) => entry.id === turn.cid)
      if (conversation?.engineSessionId) await this.afterTools.get(conversation.engineSessionId) // 밀린 도구 실행 후 훅이 먼저
      const chained = turn.origin === 'hook' ? (this.chains.get(turn.cid) ?? 0) : 0
      const exhausted = chained >= STOP_CHAIN_MAX
      const result = await this.run(
        { event: 'Stop', directory, conversationId: turn.cid, mode: turn.mode },
        {
          signal: turn.signal,
          onRun: (run) => this.show(turn.cid, exhausted && run.outcome === 'blocked' ? { ...run, reason: `${run.reason ?? ''} (${tr('hooks.stopLimit', { max: STOP_CHAIN_MAX })})` } : run),
        },
      )
      if (result.outcome !== 'blocked' || exhausted) return void this.chains.delete(turn.cid)
      this.chains.set(turn.cid, chained + 1)
      turn.followUp = stopFeedback(result.reason ?? '')
    })
    ctx.on('llm/tool-done', (info) => {
      if (info.error !== undefined) return
      const next = (this.afterTools.get(info.sessionId) ?? Promise.resolve()).then(async () => {
        const conversation = await this.conversation((entry) => entry.engineSessionId === info.sessionId)
        if (!conversation) return
        await this.run(
          { event: 'PostToolUse', directory: info.directory, conversationId: conversation.id, mode: conversation.mode, tool: { name: info.tool, input: info.input, response: info.output, file: info.file } },
          { onRun: (run) => this.show(conversation.id, run) },
        )
      })
      this.afterTools.set(info.sessionId, next)
      void next.finally(() => this.afterTools.get(info.sessionId) === next && this.afterTools.delete(info.sessionId))
    })
    ctx.on('llm/attention', (info) => void this.notify(info.sessionId, info.kind, info.title))
    ctx.on('llm/turn-ended', (info) => void (info.outcome !== 'interrupted' && this.notify(info.sessionId, info.outcome, info.error ?? '')))
    ctx.on('sessions/removed', (ids) => ids.forEach((id) => this.chains.delete(id)))
  }

  /** 그 프로젝트에서 본 훅 전부 (도는 순서: 모든 프로젝트 → 이 프로젝트만). directory 를 안 주면 모든 프로젝트 훅만.
   *  파일을 매번 다시 읽는다 — 못 읽는 파일·모양이 틀린 원소는 없는 것으로 */
  async list(directory?: string): Promise<HookEntry[]> {
    const key = directory && ((await fs.realpath(directory).catch(() => undefined)) ?? directory)
    const all = parseHooks(await this.read(this.opts.file))
    const project = key ? parseProjects(await this.read(this.opts.projectsFile))[key] : undefined
    return entriesFor(all, project)
  }

  /** 훅 목록을 통째로 저장한다 — directory 를 주면 그 프로젝트만의 훅, 안 주면 모든 프로젝트 훅. 모양이 틀린 것은 빠진다 */
  save(hooks: readonly HookDef[], directory?: string): void {
    const valid = parseHooks(serializeHooks(hooks))
    if (!directory) {
      readJsonFileSync(this.opts.file, 'object') // 덮어쓰기 전에 깨진 파일은 옆으로 옮겨 둔다 (jsonFile.ts)
      return writeJsonFileSync(this.opts.file, serializeHooks(valid))
    }
    this.updateProject(directory, (entry) => ({ ...entry, hooks: valid }))
  }

  /** 그 프로젝트에서만 훅 하나를 켜거나 끈다 (key 는 HookEntry.key) — 모든 프로젝트 훅도 이 프로젝트에서만 바뀐다 */
  setEnabled(directory: string, key: string, enabled: boolean): void {
    this.updateProject(directory, (entry) => ({ ...entry, enabled: { ...entry.enabled, [key]: enabled } }))
  }

  /** 그 이벤트에 걸린 켜진 훅을 차례로 돌린다 — 던지지 않는다. 막는 훅이 나오면 거기서 멈춘다. input.directory 는 realpath.
   *  signal 이 걸리면 도는 훅을 끄고 남은 훅은 돌리지 않는다. onRun 은 훅 하나가 끝날 때마다 */
  async run(input: HookInput, opts: { signal?: AbortSignal; onRun?(run: HookRun): void } = {}): Promise<HookResult> {
    const result: HookResult = { outcome: 'passed', context: [], runs: [] }
    const hooks = (await this.list(input.directory)).filter(
      (hook) => hook.on && hook.event === input.event && (!TOOL_HOOK_EVENTS.includes(hook.event) || matchesTool(hook.matcher, input.tool?.name ?? '')),
    )
    for (const hook of hooks) {
      if (this.disposed || opts.signal?.aborted) break
      let handle: ExecHandle | undefined
      const abort = (): void => handle?.stop('stopped')
      opts.signal?.addEventListener('abort', abort)
      const run = await runHook(hook, input, {
        timeoutMs: this.opts.timeoutMs,
        onStart: (started) => this.running.add((handle = started)),
      })
      opts.signal?.removeEventListener('abort', abort)
      if (handle) this.running.delete(handle)
      this.record(run, input)
      result.runs.push(run)
      opts.onRun?.(run)
      if (run.outcome === 'blocked') return { ...result, outcome: 'blocked', reason: run.reason }
      if (run.outcome === 'passed' && run.context) result.context.push(run.context)
    }
    return result
  }

  /** 최근 실행 기록 (오래된 것부터, RECENT_MAX 건까지 — 앱을 끄면 사라진다) */
  recent(): HookRecord[] {
    return [...this.records]
  }

  private updateProject(directory: string, change: (entry: { hooks: HookDef[]; enabled: Record<string, boolean> }) => { hooks: HookDef[]; enabled: Record<string, boolean> }): void {
    let key = directory
    try {
      key = realpathSync(directory)
    } catch {
      // 없는 폴더 — 준 경로 그대로
    }
    const projects = parseProjects(readJsonFileSync(this.opts.projectsFile, 'object'))
    projects[key] = change(projects[key] ?? { hooks: [], enabled: {} })
    writeJsonFileSync(this.opts.projectsFile, serializeProjects(projects))
  }

  private async conversation(match: (entry: Conversation) => boolean): Promise<Conversation | undefined> {
    return (await this.ctx.sessions.list().catch(() => [])).find(match)
  }

  private async notify(sessionId: string, type: string, message: string): Promise<void> {
    const conversation = await this.conversation((entry) => entry.engineSessionId === sessionId)
    const directory = conversation && (await realDirectory(conversation.project))
    if (!conversation || !directory) return
    await this.run({ event: 'Notification', directory, conversationId: conversation.id, mode: conversation.mode, notification: { type, message } })
  }

  /** 대화의 도는 턴에 훅 줄 하나 */
  private show(cid: string, run: HookRun): void {
    this.ctx.chat.note(cid, {
      kind: 'hook',
      id: `hook_${++this.seq}`,
      event: run.event,
      command: run.command.slice(0, COMMAND_SHOWN),
      outcome: run.outcome,
      seconds: run.seconds,
      ...(run.reason && { reason: run.reason }),
    })
  }

  private record(run: HookRun, input: HookInput): void {
    this.records.push({ ...run, at: Date.now(), conversationId: input.conversationId, directory: input.directory })
    if (this.records.length > RECENT_MAX) this.records.shift()
    const reason = run.reason?.split('\n')[0]
    console.warn(`[hooks] ${run.event} ${run.outcome} ${run.seconds}s exit=${run.exitCode} — ${run.command.slice(0, COMMAND_SHOWN)}${reason ? ` — ${reason}` : ''}`)
  }
}
