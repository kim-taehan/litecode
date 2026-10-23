import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pendingCount, TODO_SYNC_NUDGE_AT, todoSyncReminder, TodoSyncTracker } from '../../src/services/todoSync.ts'
import { TodoGuardService } from '../../src/services/todoGuard.ts'
import { SettingsService } from '../../src/services/settings.ts'
import { FeaturesService } from '../../src/services/features.ts'
import type { ToolDone, ToolStarted } from '../../src/services/llm.ts'
import { CHOOSABLE_FEATURES, featureOn } from '../../shared/features.ts'

// 할 일 동기화 재촉 (이슈 #619) — 순수 세기(todoSync.ts)와 'llm/tool-started'·'llm/tool-done' 을 듣는 묶음(todoGuard.ts).
// ctx.llm 은 remind 만 흉내 낸다 — 엔진에 실제로 끼워 넣는 길은 interject.test.ts 의 remind 묶음이 가짜 opencode 로 본다

const todos = (overrides?: { status?: string }[]) => ({ todos: overrides ?? [{ content: 'a' }, { content: 'b', status: 'in_progress' }] })

describe('pendingCount — 성공한 todowrite 의 남은 항목 수', () => {
  it('completed·cancelled(대문자도)만 끝나고, 없거나 모르는 값은 안 끝난 것', () => {
    expect(pendingCount(todos())).toBe(2)
    expect(pendingCount({ todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'Cancelled' }] })).toBe(0)
    expect(pendingCount({ todos: [{ content: 'a', status: 'Completed' }, { content: 'b', status: 'pending' }] })).toBe(1)
    expect(pendingCount({ todos: [{ content: 'a', status: 'weird' }, { content: 'b' }] })).toBe(2)
  })

  it('todos 가 배열이 아니면(틀린 인자·없는 인자) undefined', () => {
    expect(pendingCount(undefined)).toBeUndefined()
    expect(pendingCount({})).toBeUndefined()
    expect(pendingCount({ todos: 'a,b' })).toBeUndefined()
  })
})

describe('TodoSyncTracker — 성공한 todowrite 이후 도구 실행 세기', () => {
  it('남은 항목이 있으면 8번째·32번째에만 재촉 (그 밖은 조용)', () => {
    expect(TODO_SYNC_NUDGE_AT).toEqual([8, 32])
    const tracker = new TodoSyncTracker()
    tracker.todoWritten('s', todos())
    const hits: string[] = []
    for (let i = 1; i <= 50; i++) {
      const text = tracker.toolStarted('s')
      if (text) hits.push(`${i}:${text}`)
    }
    expect(hits).toHaveLength(2)
    expect(hits[0]!.startsWith('8:')).toBe(true)
    expect(hits[1]!.startsWith('32:')).toBe(true)
    expect(hits[0]).toContain('8 tool calls')
    expect(hits[1]).toContain('32 tool calls')
  })

  it('다시 쓴 todowrite (재촉 응함) 이 있으면 새로 센다 — 8번째에 응하고 16번째에 다시', () => {
    const tracker = new TodoSyncTracker()
    tracker.todoWritten('s', todos())
    for (let i = 1; i < 8; i++) expect(tracker.toolStarted('s')).toBeUndefined()
    expect(tracker.toolStarted('s')).toBe(todoSyncReminder(8))
    tracker.todoWritten('s', todos()) // 모델이 목록을 다시 썼다 (여전히 남은 항목 있음)
    for (let i = 9; i < 16; i++) expect(tracker.toolStarted('s')).toBeUndefined()
    expect(tracker.toolStarted('s')).toBe(todoSyncReminder(8))
  })

  it('전부 끝난·빈 목록이면 재촉 없다', () => {
    const tracker = new TodoSyncTracker()
    tracker.todoWritten('s', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'cancelled' }] })
    for (let i = 0; i < 40; i++) expect(tracker.toolStarted('s')).toBeUndefined()
    const empty = new TodoSyncTracker()
    empty.todoWritten('s', { todos: [] })
    for (let i = 0; i < 40; i++) expect(empty.toolStarted('s')).toBeUndefined()
  })

  it('todowrite 이 없으면(목록 안 쓴 턴) 아무 일도 없다', () => {
    const tracker = new TodoSyncTracker()
    for (let i = 0; i < 50; i++) expect(tracker.toolStarted('s')).toBeUndefined()
  })

  it('틀린 인자(todos 가 배열 아님) todowrite 은 epoch 를 안 바꾼다', () => {
    const tracker = new TodoSyncTracker()
    tracker.todoWritten('s', todos())
    tracker.todoWritten('s', { todos: 'a,b' })
    for (let i = 0; i < 7; i++) expect(tracker.toolStarted('s')).toBeUndefined()
    expect(tracker.toolStarted('s')).toBe(todoSyncReminder(8))
  })

  it('대화(세션)마다 따로 세고, reset(새 턴·끝난 턴) 하면 초기', () => {
    const tracker = new TodoSyncTracker()
    tracker.todoWritten('s1', todos())
    tracker.todoWritten('s2', todos())
    for (let i = 0; i < 7; i++) expect(tracker.toolStarted('s1')).toBeUndefined()
    for (let i = 0; i < 4; i++) expect(tracker.toolStarted('s2')).toBeUndefined()
    expect(tracker.toolStarted('s1')).toBe(todoSyncReminder(8))
    for (let i = 0; i < 3; i++) expect(tracker.toolStarted('s2')).toBeUndefined()
    expect(tracker.toolStarted('s2')).toBe(todoSyncReminder(8))
    tracker.reset('s2')
    tracker.todoWritten('s2', todos())
    for (let i = 0; i < 7; i++) expect(tracker.toolStarted('s2')).toBeUndefined()
    expect(tracker.toolStarted('s2')).toBe(todoSyncReminder(8))
  })
})

/** ctx.llm 흉내 — remind 로 온 것을 적는다 */
class FakeLlm extends Service {
  reminded: { sessionId: string; text: string }[] = []
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
  async remind(sessionId: string, text: string): Promise<boolean> {
    this.reminded.push({ sessionId, text })
    return true
  }
}

let calls = 0
/** 실행에 들어간 호출 하나 (callID 는 매번 새로) */
const started = (sessionId: string, tool = 'read', input: unknown = { filePath: 'a.ts' }, child = false): ToolStarted => ({
  sessionId,
  directory: '/p',
  tool,
  input,
  callID: `call_${++calls}`,
  child,
})
/** 끝난 호출 하나 — todowrite 성공: error 없이, 실패: error */
const done = (sessionId: string, tool: string, input: unknown, child = false, error?: string): ToolDone => ({
  sessionId,
  directory: '/p',
  tool,
  input,
  ...(error !== undefined ? { error } : { output: '[]' }),
  child,
})

describe('TodoGuardService — tool-done(todowrite 성공) 으로 epoch, tool-started 로 세고 ctx.llm.remind', () => {
  async function start(): Promise<{ ctx: Context; llm: FakeLlm; fiber: { dispose(): unknown } }> {
    const ctx = new Context()
    ctx.plugin(FakeLlm)
    const fiber = ctx.plugin(TodoGuardService)
    const ready = await new Promise<Context>((resolve) => ctx.inject(['llm', 'todoGuard'], resolve))
    return { ctx, llm: ready.llm as unknown as FakeLlm, fiber }
  }

  const writeList = (ctx: Context, sessionId = 'ses_1') => void ctx.emit('llm/tool-done', done(sessionId, 'todowrite', todos()))

  it('남은 항목 있는 목록 쓴 뒤 다른 도구 8번째 실행 진입에 그 세션으로 한 줄', async () => {
    const { ctx, llm } = await start()
    writeList(ctx)
    for (let i = 0; i < 7; i++) ctx.emit('llm/tool-started', started('ses_1'))
    expect(llm.reminded).toEqual([])
    ctx.emit('llm/tool-started', started('ses_1'))
    expect(llm.reminded).toEqual([{ sessionId: 'ses_1', text: todoSyncReminder(8) }])
    ctx.emit('llm/tool-started', started('ses_1'))
    expect(llm.reminded).toHaveLength(1) // 9번째엔 조용 — 32번째까지
  })

  it('실패한 todowrite(틀린 인자가 error)은 epoch 를 안 바꾼다 — 다른 도구의 tool-done 도 아니다', async () => {
    const { ctx, llm } = await start()
    writeList(ctx)
    ctx.emit('llm/tool-done', done('ses_1', 'todowrite', { todos: 'bad' }, false, 'invalid arguments'))
    ctx.emit('llm/tool-done', done('ses_1', 'bash', { command: 'ls' }))
    for (let i = 0; i < 7; i++) ctx.emit('llm/tool-started', started('ses_1'))
    expect(llm.reminded).toEqual([])
    ctx.emit('llm/tool-started', started('ses_1'))
    expect(llm.reminded).toHaveLength(1)
  })

  it('하위 작업(task)의 도구는 세지 않는다 — 재촉이 부모 턴으로 가 그 하위 에이전트가 못 읽는다', async () => {
    const { ctx, llm } = await start()
    writeList(ctx)
    for (let i = 0; i < 10; i++) ctx.emit('llm/tool-started', started('ses_1', 'read', {}, true))
    expect(llm.reminded).toEqual([])
  })

  it('새 턴이면 다시 세고, 턴이 끝나면 버린다', async () => {
    const { ctx, llm } = await start()
    writeList(ctx)
    for (let i = 0; i < 7; i++) ctx.emit('llm/tool-started', started('ses_1'))
    ctx.emit('llm/turn-started', { sessionId: 'ses_1', directory: '/p' })
    writeList(ctx)
    for (let i = 0; i < 7; i++) ctx.emit('llm/tool-started', started('ses_1'))
    ctx.emit('llm/turn-ended', { sessionId: 'ses_1', directory: '/p', outcome: 'done' })
    writeList(ctx)
    for (let i = 0; i < 7; i++) ctx.emit('llm/tool-started', started('ses_1'))
    expect(llm.reminded).toEqual([])
    ctx.emit('llm/tool-started', started('ses_1'))
    expect(llm.reminded).toHaveLength(1)
  })

  it('다른 대화의 목록은 그 대화에만 — 같은 시점에 두 세션이 따로 센다', async () => {
    const { ctx, llm } = await start()
    writeList(ctx, 'ses_1')
    writeList(ctx, 'ses_2')
    for (let i = 0; i < 7; i++) {
      ctx.emit('llm/tool-started', started('ses_1'))
      ctx.emit('llm/tool-started', started('ses_2'))
    }
    ctx.emit('llm/tool-started', started('ses_1'))
    expect(llm.reminded).toEqual([{ sessionId: 'ses_1', text: todoSyncReminder(8) }])
  })

  it('묶음을 내리면 재촉이 없다', async () => {
    const { ctx, llm, fiber } = await start()
    await fiber.dispose()
    writeList(ctx)
    for (let i = 0; i < 10; i++) ctx.emit('llm/tool-started', started('ses_1'))
    expect(llm.reminded).toEqual([])
  })
})

describe('기능 묶음 todoGuard', () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-todo-'))
  })
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('필수 기능 — 저장된 꺼짐 값이 있어도 켜지고, 고르는 기능에서 빠진다 (설정 > 기능 카드는 없다)', () => {
    expect(featureOn(undefined, 'todoGuard')).toBe(true)
    expect(featureOn({ todoGuard: false }, 'todoGuard')).toBe(true)
    expect(CHOOSABLE_FEATURES).not.toContain('todoGuard')
  })

  it('꺼짐 저장값이 남아 있어도 묶음은 내려가지 않는다 — 필수', async () => {
    const ctx = new Context()
    ctx.plugin(FakeLlm)
    ctx.plugin(SettingsService, { file: path.join(tmp, 'settings.json') })
    ctx.plugin(FeaturesService, [{ id: 'todoGuard', service: 'todoGuard', plugin: (inner: Context) => void inner.plugin(TodoGuardService) }])
    const ready = await new Promise<Context>((resolve) => ctx.inject(['llm', 'settings', 'features'], resolve))
    await ready.features.idle()
    ready.settings.set({ features: { todoGuard: false } })
    await ready.features.idle()
    expect(ready.features.isEnabled('todoGuard')).toBe(true)
    void ctx.emit('llm/tool-done', done('ses_1', 'todowrite', todos()))
    for (let i = 0; i < 8; i++) ctx.emit('llm/tool-started', started('ses_1'))
    expect((ready.llm as unknown as FakeLlm).reminded).toEqual([{ sessionId: 'ses_1', text: todoSyncReminder(8) }])
  })
})
