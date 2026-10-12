import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TaskTools } from '../../src/services/appMcp/tools/tasks.ts'
import type { AppMcpTool } from '../../src/services/appMcp/rpc.ts'
import type { ToolCaller } from '../../src/services/toolCalls.ts'
import type { TaskInput } from '../../src/services/backgroundTasks.ts'
import { TASK_DESCRIPTION_MAX, TASK_START_TOOL, taskPrompt, taskReport, TASK_RESULT_MAX } from '../../shared/tasks.ts'
import { mergeHidden } from '../../src/services/llm/prompt.ts'
import type { Conversation } from '../../shared/contract.ts'

// 백그라운드 하위 작업 도구 (이슈 #319) — litecode_task_start. 부른 대화를 ctx.llm.callerOf 로 가리고(목표 도구와 같은 길), 작업 세션·하위 작업이
// 부르면 거절(재귀 금지), 번호를 곧바로 돌려준다. ctx.chat·ctx.llm·ctx.sessions 는 가짜다

class FakeAppMcp extends Service {
  tools = new Map<string, AppMcpTool>()
  constructor(ctx: Context) {
    super(ctx, 'appMcp')
  }
  register(tool: AppMcpTool): () => void {
    this.tools.set(tool.name, tool)
    return () => void this.tools.delete(tool.name)
  }
}

class FakeLlm extends Service {
  caller: ToolCaller | undefined
  asked: unknown[] = []
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
  async callerOf(...args: unknown[]): Promise<ToolCaller | undefined> {
    this.asked.push(args)
    return this.caller
  }
}

class FakeSessions extends Service {
  conversations: Conversation[] = []
  constructor(ctx: Context) {
    super(ctx, 'sessions')
  }
  async list(): Promise<Conversation[]> {
    return this.conversations
  }
}

class FakeChat extends Service {
  started: [string, TaskInput][] = []
  taskSessions = new Set<string>()
  constructor(ctx: Context) {
    super(ctx, 'chat')
  }
  async startTask(cid: string, input: TaskInput) {
    this.started.push([cid, input])
    return { number: this.started.length, id: `bgtask:${cid}:${this.started.length}` }
  }
  isTaskSession(sessionId: string): boolean {
    return this.taskSessions.has(sessionId)
  }
}

let root: string
let project: string

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-tasktools-')))
  project = path.join(root, 'app')
  await fs.mkdir(project)
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function start() {
  const ctx = new Context()
  ctx.plugin(FakeAppMcp)
  ctx.plugin(FakeLlm)
  ctx.plugin(FakeSessions)
  ctx.plugin(FakeChat)
  ctx.plugin(TaskTools)
  const ready = await new Promise<Context>((resolve) => ctx.inject(['appMcp', 'llm', 'sessions', 'chat'], resolve))
  const appMcp = ready.appMcp as unknown as FakeAppMcp
  for (let tries = 0; tries < 200 && !appMcp.tools.has(TASK_START_TOOL); tries++) await new Promise((resolve) => setTimeout(resolve, 5))
  const llm = ready.llm as unknown as FakeLlm
  const sessions = ready.sessions as unknown as FakeSessions
  const chat = ready.chat as unknown as FakeChat
  sessions.conversations = [{ id: 'c1', project, title: 't', updatedAt: 0, engineSessionId: 'ses_main', model: { providerId: 'gw', modelId: 'm1' } }]
  llm.caller = { sessionId: 'ses_main', callId: 'call_1', child: false, approved: false } as unknown as ToolCaller
  const tool = appMcp.tools.get(TASK_START_TOOL)!
  const call = (args: Record<string, unknown>) => tool.run(args, { directory: project })
  return { tool, call, llm, sessions, chat }
}

const args = { agent: 'explore', description: 'find config', prompt: 'Where is the config loaded?' }

describe('litecode_task_start (이슈 #319)', () => {
  it('부른 대화에 작업을 띄우고 번호를 곧바로 돌려준다 — 기다리지 말라고 모델에게 말한다', async () => {
    const { call, chat, llm } = await start()
    const text = await call(args)
    expect(chat.started).toEqual([['c1', { agent: 'explore', description: 'find config', prompt: 'Where is the config loaded?' }]])
    expect(text).toContain('Started background task 1 (explore)')
    expect(text).toMatch(/Do not wait or poll/)
    expect(llm.asked[0]).toEqual([project, { server: 'litecode', tool: TASK_START_TOOL }, args])
  })

  it('작업 세션이나 하위 작업이 부르면 거절한다 (재귀 금지)', async () => {
    const { call, chat, llm } = await start()
    chat.taskSessions.add('ses_main')
    await expect(call(args)).rejects.toThrow(/cannot start other tasks/)
    chat.taskSessions.clear()
    llm.caller = { ...llm.caller!, child: true }
    await expect(call(args)).rejects.toThrow(/cannot start other tasks/)
    expect(chat.started).toHaveLength(0)
  })

  it('부른 대화를 못 가리면 거절한다 — 앱이 돌린 턴이 아니거나, 그 세션의 대화가 없거나, 다른 폴더의 대화', async () => {
    const { call, chat, llm, sessions } = await start()
    llm.caller = undefined
    await expect(call(args)).rejects.toThrow(/Could not tell which conversation/)
    llm.caller = { sessionId: 'ses_other', callId: 'c', child: false, approved: false } as unknown as ToolCaller
    await expect(call(args)).rejects.toThrow(/Could not tell which conversation/)
    llm.caller = { sessionId: 'ses_main', callId: 'c', child: false, approved: false } as unknown as ToolCaller
    sessions.conversations = [{ ...sessions.conversations[0]!, project: root }]
    await expect(call(args)).rejects.toThrow(/Could not tell which conversation/)
    expect(chat.started).toHaveLength(0)
  })

  it('인자를 본다 — agent 는 explore·general, 설명·지시는 비지 않고 상한 안', async () => {
    const { call, chat } = await start()
    await expect(call({ ...args, agent: 'general-ask' })).rejects.toThrow(/agent must be one of: explore, general/)
    await expect(call({ ...args, description: '  ' })).rejects.toThrow(/description is required/)
    await expect(call({ ...args, description: 'x'.repeat(TASK_DESCRIPTION_MAX + 1) })).rejects.toThrow(/too long/)
    await expect(call({ ...args, prompt: undefined })).rejects.toThrow(/prompt is required/)
    expect(chat.started).toHaveLength(0)
  })
})

describe('shared/tasks — 작업 글', () => {
  it('작업 세션의 첫 글: 사람에게 못 묻는다는 것·설명·지시', () => {
    const text = taskPrompt('find config', 'Where?')
    expect(text).toMatch(/nobody can answer questions or approve actions/)
    expect(text).toContain('Task: find config')
    expect(text.endsWith('Where?')).toBe(true)
  })

  it('결과 글: 완료는 글(길면 자른다), 실패는 사유, 중지는 사람이 멈춘 것과 끊긴 것을 가른다', () => {
    const done = taskReport({ number: 2, agent: 'general', description: 'd', end: 'completed', text: 'x'.repeat(TASK_RESULT_MAX + 5) })
    expect(done).toContain('<task-result number="2" agent="general" status="completed">')
    expect(done).toContain('…[truncated 5 chars]')
    expect(taskReport({ number: 1, agent: 'explore', description: 'd', end: 'completed', text: '  ' })).toContain('(no final text)')
    expect(taskReport({ number: 1, agent: 'explore', description: 'd', end: 'failed', error: 'boom' })).toContain('The task failed: boom')
    expect(taskReport({ number: 1, agent: 'explore', description: 'd', end: 'stopped' })).toContain('The user stopped this task')
    expect(taskReport({ number: 1, agent: 'explore', description: 'd', end: 'stopped', error: '엔진 재시작' })).toContain('interrupted before it finished (엔진 재시작)')
  })

  it('턴마다 숨길 MCP 도구는 폴더의 숨김에 서버별로 더한다', () => {
    expect(mergeHidden({ github: ['a'], litecode: ['open'] }, { litecode: ['task_start', 'open'] })).toEqual({ github: ['a'], litecode: ['open', 'task_start'] })
    expect(mergeHidden({}, {})).toEqual({})
  })
})
