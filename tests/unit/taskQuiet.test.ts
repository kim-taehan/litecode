import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackgroundTasks, type TaskHost } from '../../src/services/backgroundTasks.ts'
import type { ChatOptions, ChatResult } from '../../src/services/llm.ts'
import { setMainLanguage, tr } from '../../src/i18n.ts'
import { TASK_QUIET_MS, TASK_STALL_TIMEOUT_MS, TASK_STATUS_TOOL, taskStatusText, type TaskStatusEntry } from '../../shared/tasks.ts'
import type { QueuedSend } from '../../shared/chat.ts'
import type { Conversation, Subtask, TurnItem } from '../../shared/contract.ts'

// 백그라운드 작업은 타이머로 죽이지 않는다 (사용자 결정 2026-10-12) — 조용하면(TASK_QUIET_MS) 작업 줄에 표시하고 메인에게 한 번 알린다.
// 활동이 다시 오면 표시를 풀고 다시 무장한다. 상태는 litecode_task_status 가 본다. 엔진 턴(host.run)은 가짜 — 시험이 진행 줄을 흘리고 끝낸다

interface Run {
  options: ChatOptions
  finish(result?: Partial<ChatResult>): void
}

const conversation: Conversation = { id: 'c1', project: '/work/a', title: 't', updatedAt: 0, engineSessionId: 'ses_main', model: { providerId: 'gw', modelId: 'm1' }, mode: 'build' }
const explore = { agent: 'explore' as const, description: 'big doc', prompt: 'write it' }

let runs: Run[]
let reports: [string, QueuedSend][]
let changed: [string, Subtask[]][]

function host(limit = 2): TaskHost {
  return {
    run: (options) =>
      new Promise<ChatResult>((resolve) => {
        runs.push({ options, finish: (result = {}) => resolve({ ok: true, text: 'done', ...result }) })
        options.stop?.addEventListener('abort', () => resolve({ ok: false, error: 'stopped', interrupted: true }))
      }),
    reject: async () => {},
    report: async (cid, send) => void reports.push([cid, send]),
    changed: (cid, tasks) => void changed.push([cid, tasks]),
    limit: () => limit,
  }
}

const tool = (status: 'preparing' | 'running' | 'done'): TurnItem => ({ kind: 'tool', id: 'prt_w', name: 'write', status })
const view = (tasks: BackgroundTasks, n = 0) => tasks.list('c1')[n]!
const quietReports = () => reports.filter(([, send]) => send.text.includes('<task-notice'))

beforeEach(() => {
  setMainLanguage('ko')
  runs = []
  reports = []
  changed = []
  vi.useFakeTimers({ now: 1_000_000 })
})

afterEach(() => void vi.useRealTimers())

describe('백그라운드 작업 — 조용함 알림 (타이머로 죽이지 않는다)', () => {
  it('작업 턴은 평소 무응답 한도 대신 하드 한도 하나로 돈다 — 상태 도구도 숨긴다', async () => {
    const tasks = new BackgroundTasks(host())
    tasks.start(conversation, explore)
    await vi.advanceTimersByTimeAsync(0)
    expect(runs[0]!.options.stallTimeoutMs).toBe(TASK_STALL_TIMEOUT_MS)
    expect(runs[0]!.options.hideMcpTools!['litecode']).toContain(TASK_STATUS_TOOL)
  })

  it(`${TASK_QUIET_MS / 1000}초 조용하면 멈추지 않고 표시 + 메인에게 출처 task 알림 한 번 — 더 조용해도 다시 안 알린다`, async () => {
    const tasks = new BackgroundTasks(host())
    tasks.start(conversation, explore)
    await vi.advanceTimersByTimeAsync(10_000)
    runs[0]!.options.onProgress!(tool('preparing'))
    const lastAt = Date.now()
    await vi.advanceTimersByTimeAsync(TASK_QUIET_MS - 1)
    expect(view(tasks).quietSince).toBeUndefined()
    expect(quietReports()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(view(tasks)).toMatchObject({ status: 'running', quietSince: lastAt })
    expect(changed.at(-1)![1][0]!.quietSince).toBe(lastAt) // 화면(작업 줄)에 곧바로
    expect(quietReports()).toHaveLength(1)
    const [cid, send] = quietReports()[0]!
    expect(cid).toBe('c1')
    expect(send.origin).toBe('task')
    expect(send.display).toBe(tr('task.notice.quiet', { number: 1, description: 'big doc', minutes: 3 }))
    expect(send.text).toContain('<task-notice number="1" status="quiet">')
    expect(send.text).toContain('last activity: tool write (preparing input)')
    expect(send.text).toContain(`litecode_${TASK_STATUS_TOOL}`)
    await vi.advanceTimersByTimeAsync(TASK_QUIET_MS * 5)
    expect(quietReports()).toHaveLength(1)
    expect(tasks.live('c1')).toBe(1) // 죽이지 않았다
    expect(runs[0]!.options.stop!.aborted).toBe(false)
  })

  it('활동이 다시 오면 표시를 풀고 다시 무장한다 — 또 조용해지면 한 번 더 알린다', async () => {
    const tasks = new BackgroundTasks(host())
    tasks.start(conversation, explore)
    await vi.advanceTimersByTimeAsync(TASK_QUIET_MS)
    expect(view(tasks).quietSince).toBeDefined()
    expect(quietReports()).toHaveLength(1)
    runs[0]!.options.onProgress!(tool('done'))
    expect(view(tasks).quietSince).toBeUndefined()
    expect('quietSince' in view(tasks)).toBe(false)
    await vi.advanceTimersByTimeAsync(TASK_QUIET_MS - 1)
    expect(quietReports()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(quietReports()).toHaveLength(2)
  })

  it('끝난 작업·대기 중인 작업은 알리지 않는다', async () => {
    const tasks = new BackgroundTasks(host(1))
    tasks.start(conversation, explore)
    tasks.start(conversation, { ...explore, description: 'second' }) // 대기
    await vi.advanceTimersByTimeAsync(0)
    runs[0]!.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(runs).toHaveLength(2) // 둘째가 이제 시작했다
    runs[1]!.finish()
    await vi.advanceTimersByTimeAsync(TASK_QUIET_MS * 2)
    expect(quietReports()).toHaveLength(0)
  })

  it('상태 도구의 원재료 — 번호·설명·상태·시작/끝·마지막 활동·조용함', async () => {
    const tasks = new BackgroundTasks(host(1))
    const startedAt = Date.now()
    tasks.start(conversation, explore)
    tasks.start(conversation, { ...explore, agent: 'general', description: 'second' })
    await vi.advanceTimersByTimeAsync(5_000)
    runs[0]!.options.onProgress!({ kind: 'think', id: 'r', text: 'hmm', done: false })
    expect(tasks.status('c1')).toEqual<TaskStatusEntry[]>([
      { number: 1, agent: 'explore', description: 'big doc', state: 'running', startedAt, lastActivityAt: startedAt + 5_000, lastActivity: 'thinking', quiet: false },
      { number: 2, agent: 'general', description: 'second', state: 'queued', quiet: false },
    ])
    await vi.advanceTimersByTimeAsync(TASK_QUIET_MS)
    expect(tasks.status('c1')[0]!.quiet).toBe(true)
    runs[0]!.finish({ ok: false, error: 'boom' })
    await vi.advanceTimersByTimeAsync(0)
    expect(tasks.status('c1')[0]).toMatchObject({ state: 'failed', error: 'boom', quiet: false })
    expect(tasks.status('c1')[0]!.lastActivityAt).toBeUndefined()
    expect(tasks.status('c1')[1]!.state).toBe('running')
    expect(tasks.status('other')).toEqual([])
  })
})

describe('shared/tasks — 상태 글 (litecode_task_status)', () => {
  const now = 10_000_000
  it('작업마다 한 줄 — 실행은 경과·마지막 활동(몇 초 전·무엇)·조용함, 대기, 끝난 것은 걸린 시간·사유', () => {
    const text = taskStatusText(
      [
        { number: 1, agent: 'general', description: 'doc', state: 'running', startedAt: now - 245_000, lastActivityAt: now - 185_000, lastActivity: 'tool write (preparing input)', quiet: true },
        { number: 2, agent: 'explore', description: 'scan', state: 'queued', quiet: false },
        { number: 3, agent: 'explore', description: 'grep', state: 'completed', startedAt: now - 100_000, endedAt: now - 40_000, quiet: false },
        { number: 4, agent: 'explore', description: 'x', state: 'failed', startedAt: now - 9_000, endedAt: now - 1_000, error: 'gateway down', quiet: false },
      ],
      now,
    )
    expect(text).toContain('Background tasks in this conversation (4):')
    expect(text).toContain('- Task 1 (general) "doc": running for 4m05s; last activity 3m05s ago (tool write (preparing input)) — quiet for over 3 minutes.')
    expect(text).toContain('- Task 2 (explore) "scan": waiting in the queue (not started yet).')
    expect(text).toContain('- Task 3 (explore) "grep": completed after 1m00s.')
    expect(text).toContain('- Task 4 (explore) "x": failed after 8s (gateway down).')
    expect(text).toMatch(/cannot stop a task yourself/)
  })

  it('작업이 없으면 그렇게 말한다', () => {
    expect(taskStatusText([], now)).toBe('There are no background tasks in this conversation.')
  })
})
