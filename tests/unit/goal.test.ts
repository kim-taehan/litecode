import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatService } from '../../src/services/chat.ts'
import { SessionsService } from '../../src/services/sessions.ts'
import { GoalService } from '../../src/services/goal.ts'
import { GoalTools } from '../../src/services/appMcp/tools/goal.ts'
import type { AppMcpTool } from '../../src/services/appMcp/rpc.ts'
import type { ChatOptions, ChatResult } from '../../src/services/llm.ts'
import type { ToolCaller } from '../../src/services/toolCalls.ts'
import { setMainLanguage, tr } from '../../src/i18n.ts'
import type { Attention } from '../../shared/contract.ts'
import type { ChatEventMap } from '../../shared/chat.ts'
import {
  GOAL_MAX_ROUNDS,
  createGoal,
  finishGoal,
  goalActions,
  goalOf,
  goalStartPrompt,
  nextRound,
  parseGoalCommand,
  pauseGoal,
  resumeGoal,
  type Goal,
} from '../../shared/goal.ts'

// 목표 (이슈 #285) — "이 목표가 끝날 때까지 계속". 순수 전이(shared/goal.ts), 자동 이어가기(ctx.goal — 진짜 ctx.chat·ctx.sessions 위에서, ctx.llm 은
// 턴을 받아 쥐고 있다가 시험이 끝내는 가짜), 모델 도구(litecode_goal_get·update — callerOf 는 시험이 정한 "부른 엔진 세션"), 기능 꺼짐.

describe('shared/goal — 순수 전이', () => {
  it('/goal 뒤의 글: 비면 보기, 낱말 하나뿐인 pause·resume·clear 는 제어, 그 밖은 새 목표', () => {
    expect(parseGoalCommand('')).toEqual({ kind: 'show' })
    expect(parseGoalCommand('   ')).toEqual({ kind: 'show' })
    expect(parseGoalCommand('pause')).toEqual({ kind: 'pause' })
    expect(parseGoalCommand(' resume ')).toEqual({ kind: 'resume' })
    expect(parseGoalCommand('clear')).toEqual({ kind: 'clear' })
    expect(parseGoalCommand('pause after tests')).toEqual({ kind: 'set', text: 'pause after tests' })
    expect(parseGoalCommand('  테스트 전부 초록 ')).toEqual({ kind: 'set', text: '테스트 전부 초록' })
  })

  it('만들기 → 멈춤 → 계속(라운드 새로) → 끝 / 막힘, 허용되지 않는 전이는 undefined', () => {
    const goal = createGoal('  X  ')
    expect(goal).toEqual({ text: 'X', status: 'active', rounds: 0 })
    const counted = nextRound(nextRound(goal)!)!
    expect(counted.rounds).toBe(2)
    const paused = pauseGoal(counted, 'user')!
    expect(paused).toEqual({ text: 'X', status: 'paused', rounds: 2, reason: 'user' })
    expect(pauseGoal(paused, 'user')).toBeUndefined() // 이미 멈췄다
    expect(resumeGoal(paused)).toEqual({ text: 'X', status: 'active', rounds: 0 })
    expect(resumeGoal(goal)).toBeUndefined() // 진행 중
    expect(finishGoal(goal, 'done', ' ok ')).toEqual({ text: 'X', status: 'done', rounds: 0, note: 'ok' })
    expect(finishGoal(paused, 'blocked', 'need key')).toMatchObject({ status: 'blocked', note: 'need key' })
    const done = finishGoal(goal, 'done')!
    expect(done.note).toBeUndefined()
    expect(finishGoal(done, 'blocked', 'x')).toBeUndefined() // 끝난 목표
    expect(resumeGoal(done)).toBeUndefined()
    expect(resumeGoal(finishGoal(goal, 'blocked', 'why'))).toEqual({ text: 'X', status: 'active', rounds: 0 })
    expect(finishGoal(undefined, 'done')).toBeUndefined()
  })

  it('라운드 한도 — 8번째까지는 세고 그 다음은 undefined', () => {
    let goal: Goal = createGoal('X')
    for (let round = 1; round <= GOAL_MAX_ROUNDS; round++) goal = nextRound(goal)!
    expect(goal.rounds).toBe(GOAL_MAX_ROUNDS)
    expect(nextRound(goal)).toBeUndefined()
  })

  it('읽은 값은 모양이 맞을 때만, 화면 버튼은 상태대로', () => {
    expect(goalOf({ text: 'X', status: 'paused', rounds: 3, reason: 'limit', extra: 1 })).toEqual({ text: 'X', status: 'paused', rounds: 3, reason: 'limit' })
    expect(goalOf({ text: 'X', status: 'active', rounds: -1, reason: 'limit' })).toEqual({ text: 'X', status: 'active', rounds: 0 })
    expect(goalOf({ text: '', status: 'active' })).toBeUndefined()
    expect(goalOf({ text: 'X', status: 'nope' })).toBeUndefined()
    expect(goalOf('X')).toBeUndefined()
    expect(goalActions(createGoal('X'))).toEqual(['pause', 'clear'])
    expect(goalActions(pauseGoal(createGoal('X'), 'limit')!)).toEqual(['resume', 'clear'])
    expect(goalActions(finishGoal(createGoal('X'), 'blocked', 'y')!)).toEqual(['resume', 'clear'])
    expect(goalActions(finishGoal(createGoal('X'), 'done')!)).toEqual(['clear'])
  })

  it('첫 프롬프트에 목표 본문과 도구 지침이 들어간다', () => {
    const prompt = goalStartPrompt('make "it" green')
    expect(prompt).toContain('Objective: "make \\"it\\" green"')
    expect(prompt).toContain('litecode_goal_update')
    expect(prompt).toContain('"done"')
    expect(prompt).toContain('"blocked"')
  })
})

interface Call {
  prompt: string
  sessionId?: string
  attention(requests: Attention[]): void
  finish(result?: Partial<ChatResult>): void
}

class FakeLlm extends Service {
  calls: Call[] = []
  caller: ToolCaller | undefined
  private ids = 0
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
  newMessageId(): string {
    return `msg_${++this.ids}`
  }
  async chat({ prompt, sessionId, onSession, onAttention, stop }: ChatOptions): Promise<ChatResult> {
    const id = sessionId ?? `ses_${this.calls.length + 1}`
    if (!sessionId) await onSession?.(id)
    return new Promise<ChatResult>((resolve) => {
      this.calls.push({ prompt, sessionId, attention: (requests) => onAttention?.(requests), finish: (result = {}) => resolve({ ok: true, sessionId: id, text: 'ok', ...result }) })
      stop?.addEventListener('abort', () => resolve({ ok: false, sessionId: id, error: tr('error.stopped'), interrupted: true }))
    })
  }
  reserve() {
    return undefined // 끼워 넣기 자리를 안 준다 — 도는 중에 보낸 사람 글은 대기열로 간다
  }
  async callerOf(): Promise<ToolCaller | undefined> {
    return this.caller
  }
  async deleteSession(): Promise<void> {}
  purgeDeleted(): void {}
}

class FakeProviders extends Service {
  constructor(ctx: Context) {
    super(ctx, 'providers')
  }
  get(id: string) {
    return id === 'gw' ? { models: [{ id: 'm1' }] } : undefined
  }
}

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

let root: string
let project: string
const MODEL = { providerId: 'gw', modelId: 'm1' }

beforeEach(async () => {
  setMainLanguage('ko')
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-goal-')))
  project = path.join(root, 'shop')
  await fs.mkdir(project)
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

async function until(done: () => boolean | Promise<boolean>): Promise<void> {
  for (let tries = 0; tries < 400 && !(await done()); tries++) await new Promise((resolve) => setTimeout(resolve, 5))
  if (!(await done())) throw new Error('기다리던 일이 일어나지 않았다')
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

async function start(opts: { goal?: boolean } = {}) {
  const ctx = new Context()
  ctx.plugin(FakeLlm)
  ctx.plugin(FakeProviders)
  ctx.plugin(SessionsService, { file: path.join(root, 'sessions.json') })
  ctx.plugin(ChatService)
  ctx.plugin(FakeAppMcp)
  const fiber = opts.goal === false ? undefined : ctx.plugin((inner: Context) => {
    inner.plugin(GoalService)
    inner.plugin(GoalTools)
  })
  const ready = await new Promise<Context>((resolve) => ctx.inject(['chat', 'sessions', 'llm', 'appMcp'], resolve))
  if (fiber) await until(() => !!ctx.get('goal') && (ready.appMcp as unknown as FakeAppMcp).tools.size === 2)
  const llm = ready.llm as unknown as FakeLlm
  const ended: ChatEventMap['turn.ended'][] = []
  const started: ChatEventMap['turn.started'][] = []
  const changed: [string, Goal | undefined][] = []
  ctx.on('chat/turn-ended', (data) => void ended.push(data))
  ctx.on('chat/turn-started', (data) => void started.push(data))
  ctx.on('goal/changed', (cid, goal) => void changed.push([cid, goal]))
  const stored = async (id: string) => (await ready.sessions.list()).find((entry) => entry.id === id)
  const turn = async (n: number): Promise<Call> => {
    await until(() => llm.calls.length >= n)
    return llm.calls[n - 1]!
  }
  const endedCount = async (n: number) => until(() => ended.length >= n)
  /** 화면이 `/goal <목표>` 를 친 것처럼 — 메인에 묻고, 돌려준 첫 프롬프트를 평소 보내기로 */
  const setGoal = async (cid: string, text: string) => {
    const reply = await ctx.goal.command(cid, text)
    expect(reply.send).toBeDefined()
    await ready.chat.send(cid, { project, model: MODEL, mode: 'build', text: reply.send!.text, display: reply.send!.display })
  }
  const tools = (ready.appMcp as unknown as FakeAppMcp).tools
  return { ctx, chat: ready.chat, sessions: ready.sessions, llm, ended, started, changed, stored, turn, endedCount, setGoal, tools, fiber }
}

describe('ctx.goal — 자동 이어가기', () => {
  it('/goal <목표> — 새 대화면 메모리에 두었다가 첫 턴에 저장하고, 턴이 끝나면 "계속해" 라운드를 출처 goal 로 보낸다', async () => {
    const { ctx, chat, llm, started, stored, turn, endedCount, changed } = await start()
    const reply = await ctx.goal.command('c1', '로그인 버그 고치기\n세부')
    expect(reply.send).toEqual({ text: goalStartPrompt('로그인 버그 고치기\n세부'), display: '/goal 로그인 버그 고치기\n세부' })
    expect(await ctx.goal.get('c1')).toEqual({ text: '로그인 버그 고치기\n세부', status: 'active', rounds: 0 })
    expect(changed.at(-1)).toEqual(['c1', { text: '로그인 버그 고치기\n세부', status: 'active', rounds: 0 }])
    expect(await stored('c1')).toBeUndefined() // 아직 저장 안 된 대화

    await chat.send('c1', { project, model: MODEL, mode: 'build', text: reply.send!.text, display: reply.send!.display })
    const first = await turn(1)
    expect(first.prompt).toContain('로그인 버그 고치기')
    await until(async () => (await stored('c1'))?.goal?.status === 'active')

    first.finish()
    const round = await turn(2)
    expect(round.prompt).toContain('<goal_round>')
    expect(round.prompt).toContain(`Round: 1/${GOAL_MAX_ROUNDS}`)
    expect(started.at(-1)).toMatchObject({ cid: 'c1', origin: 'goal', message: { text: tr('goal.continue', { text: '로그인 버그 고치기' }) } })
    expect((await stored('c1'))?.goal).toEqual({ text: '로그인 버그 고치기\n세부', status: 'active', rounds: 1 })
    expect(llm.calls).toHaveLength(2)
    round.finish()
    await endedCount(2)
    expect((await turn(3)).prompt).toContain(`Round: 2/${GOAL_MAX_ROUNDS}`)
  })

  it(`연속 자동 라운드는 ${GOAL_MAX_ROUNDS}번까지 — 닿으면 보내지 않고 paused(limit), resume 은 라운드를 새로 세고 쉬면 바로 보낸다`, async () => {
    const { ctx, llm, stored, turn, endedCount, setGoal } = await start()
    await setGoal('c1', 'X')
    for (let n = 1; n <= GOAL_MAX_ROUNDS + 1; n++) (await turn(n)).finish()
    await endedCount(GOAL_MAX_ROUNDS + 1)
    await until(async () => (await stored('c1'))?.goal?.status === 'paused')
    expect((await stored('c1'))?.goal).toEqual({ text: 'X', status: 'paused', rounds: GOAL_MAX_ROUNDS, reason: 'limit' })
    await settle()
    expect(llm.calls).toHaveLength(GOAL_MAX_ROUNDS + 1) // 첫 턴 + 8 라운드

    expect(await ctx.goal.command('c1', 'resume')).toEqual({})
    const again = await turn(GOAL_MAX_ROUNDS + 2)
    expect(again.prompt).toContain(`Round: 1/${GOAL_MAX_ROUNDS}`)
    expect((await stored('c1'))?.goal).toMatchObject({ status: 'active', rounds: 1 })
  })

  it('■ 중지로 끝난 턴 — paused(stopped), 다음 라운드 없음', async () => {
    const { chat, llm, stored, turn, endedCount, setGoal } = await start()
    await setGoal('c1', 'X')
    await turn(1)
    chat.stop('c1')
    await endedCount(1)
    await until(async () => (await stored('c1'))?.goal?.status === 'paused')
    expect((await stored('c1'))?.goal?.reason).toBe('stopped')
    await settle()
    expect(llm.calls).toHaveLength(1)
  })

  it('오류로 끝난 턴 — paused(failed), 승인·질문을 거절해 끝난 턴 — paused(declined)', async () => {
    const { llm, stored, turn, endedCount, setGoal } = await start()
    await setGoal('c1', 'X')
    ;(await turn(1)).finish({ ok: false, error: 'boom' })
    await endedCount(1)
    await until(async () => (await stored('c1'))?.goal?.status === 'paused')
    expect((await stored('c1'))?.goal?.reason).toBe('failed')

    await setGoal('c2', 'Y')
    ;(await turn(2)).finish({ declined: true })
    await endedCount(2)
    await until(async () => (await stored('c2'))?.goal?.status === 'paused')
    expect((await stored('c2'))?.goal?.reason).toBe('declined')
    await settle()
    expect(llm.calls).toHaveLength(2)
  })

  it('승인·질문 카드가 뜨면 paused(attention) — 답하고 턴이 끝나도 저절로 잇지 않는다', async () => {
    const { llm, stored, turn, endedCount, setGoal } = await start()
    await setGoal('c1', 'X')
    const first = await turn(1)
    first.attention([{ kind: 'permission', id: 'per_1', sessionId: 'ses_1', permission: 'bash', patterns: ['ls'] } as unknown as Attention])
    await until(async () => (await stored('c1'))?.goal?.status === 'paused')
    expect((await stored('c1'))?.goal?.reason).toBe('attention')
    first.finish()
    await endedCount(1)
    await settle()
    expect(llm.calls).toHaveLength(1)
  })

  it('사람이 보낸 글이 먼저 — 라운드 중 쌓인 사람 글이 그 다음 턴이고, 그 턴이 끝난 뒤 라운드를 처음부터 센다', async () => {
    const { chat, llm, stored, turn, endedCount, setGoal, started } = await start()
    await setGoal('c1', 'X')
    ;(await turn(1)).finish()
    const round1 = await turn(2)
    expect((await chat.send('c1', { text: '이것도 봐 줘' })).state).toBe('queued')
    round1.finish()
    const human = await turn(3)
    expect(human.prompt).toBe('이것도 봐 줘')
    expect(started.at(-1)?.origin).toBe('user')
    await until(async () => (await stored('c1'))?.goal?.rounds === 0)
    human.finish()
    await endedCount(3)
    const round = await turn(4)
    expect(round.prompt).toContain('Round: 1/')
    expect(llm.calls).toHaveLength(4)
  })

  it('pause·clear·보기 — 멈추면 턴이 끝나도 잇지 않고, 없는 목표를 멈추거나 지우면 사유', async () => {
    const { ctx, llm, stored, turn, endedCount, setGoal } = await start()
    expect(await ctx.goal.command('c1', '')).toEqual({ message: tr('goal.none') })
    expect(await ctx.goal.command('c1', 'pause')).toEqual({ message: tr('goal.notActive') })
    expect(await ctx.goal.command('c1', 'resume')).toEqual({ message: tr('goal.notResumable') })
    expect(await ctx.goal.command('c1', 'clear')).toEqual({ message: tr('goal.none') })
    await setGoal('c1', '테스트 초록')
    expect((await ctx.goal.command('c1', '')).message).toBe(tr('goal.show', { status: tr('goal.status.active'), rounds: 0, max: GOAL_MAX_ROUNDS, text: '테스트 초록' }))
    expect(await ctx.goal.command('c1', 'pause')).toEqual({})
    expect((await ctx.goal.command('c1', '')).message).toContain(tr('goal.reason.user'))
    ;(await turn(1)).finish()
    await endedCount(1)
    await settle()
    expect(llm.calls).toHaveLength(1)
    expect(await ctx.goal.command('c1', 'clear')).toEqual({})
    expect((await stored('c1'))?.goal).toBeUndefined()
    expect(await ctx.goal.get('c1')).toBeUndefined()
  })

  it('앱을 다시 켜면 진행 중이던 목표는 paused(restart) — 저절로 다시 보내지 않는다', async () => {
    const file = path.join(root, 'sessions.json')
    await fs.writeFile(
      file,
      JSON.stringify({
        conversations: [
          { id: 'c1', project, title: 'X', updatedAt: 1, model: MODEL, engineSessionId: 'ses_old', goal: { text: 'X', status: 'active', rounds: 3 } },
          { id: 'c2', project, title: 'Y', updatedAt: 1, model: MODEL, goal: { text: 'Y', status: 'done', rounds: 1, note: 'ok' } },
        ],
        orphans: [],
        viewed: {},
      }),
    )
    const { ctx, llm, stored } = await start()
    await until(async () => (await stored('c1'))?.goal?.status === 'paused')
    expect((await stored('c1'))?.goal).toEqual({ text: 'X', status: 'paused', rounds: 3, reason: 'restart' })
    expect((await stored('c2'))?.goal).toEqual({ text: 'Y', status: 'done', rounds: 1, note: 'ok' })
    expect(await ctx.goal.get('c1')).toMatchObject({ status: 'paused' })
    await settle()
    expect(llm.calls).toHaveLength(0)
  })

  it('턴 시작의 통째 저장이 목표를 덮지 않는다', async () => {
    const { sessions, stored, setGoal, turn } = await start()
    await setGoal('c1', 'X')
    await turn(1)
    await until(async () => (await stored('c1'))?.goal?.status === 'active')
    const entry = (await stored('c1'))!
    await sessions.save({ ...entry, goal: undefined, title: 'Z' })
    expect((await stored('c1'))?.goal).toEqual({ text: 'X', status: 'active', rounds: 0 })
  })
})

describe('litecode_goal_* 도구', () => {
  it('부른 대화의 목표를 읽고, done 이면 끝 — 그 턴이 끝나도 다음 라운드가 없다', async () => {
    const { tools, llm, stored, turn, endedCount, setGoal } = await start()
    await setGoal('c1', 'X')
    const first = await turn(1)
    await until(async () => (await stored('c1'))?.engineSessionId === 'ses_1' && (await stored('c1'))?.goal !== undefined)
    llm.caller = { sessionId: 'ses_1', callId: 'call_1', child: false, approved: false }
    expect(JSON.parse(await tools.get('goal_get')!.run({}, { directory: project }))).toEqual({ goal: { objective: 'X', status: 'active', round: 0, max_rounds: GOAL_MAX_ROUNDS } })
    expect(await tools.get('goal_update')!.run({ status: 'done', note: '다 됐다' }, { directory: project })).toContain('done')
    expect((await stored('c1'))?.goal).toEqual({ text: 'X', status: 'done', rounds: 0, note: '다 됐다' })
    first.finish()
    await endedCount(1)
    await settle()
    expect(llm.calls).toHaveLength(1)
    // 끝난 목표는 다시 끝낼 수 없다
    await expect(tools.get('goal_update')!.run({ status: 'blocked', note: 'x' }, { directory: project })).rejects.toThrow(/no open goal/)
  })

  it('blocked 는 사유가 있어야 하고, 하위 작업·모르는 호출·다른 폴더는 거절', async () => {
    const { tools, llm, stored, turn, setGoal } = await start()
    await setGoal('c1', 'X')
    await turn(1)
    await until(async () => (await stored('c1'))?.engineSessionId === 'ses_1' && (await stored('c1'))?.goal !== undefined)
    const update = tools.get('goal_update')!
    llm.caller = { sessionId: 'ses_1', callId: 'call_1', child: false, approved: false }
    await expect(update.run({ status: 'blocked' }, { directory: project })).rejects.toThrow(/note is required/)
    await expect(update.run({ status: 'active' }, { directory: project })).rejects.toThrow(/status must be/)
    await expect(update.run({ status: 'done' }, { directory: root })).rejects.toThrow(/Could not tell/) // 그 폴더의 대화가 아니다
    llm.caller = { sessionId: 'ses_1', callId: 'call_2', child: true, approved: false }
    await expect(update.run({ status: 'done' }, { directory: project })).rejects.toThrow(/Sub-tasks/)
    llm.caller = undefined
    await expect(update.run({ status: 'done' }, { directory: project })).rejects.toThrow(/Could not tell/)
    llm.caller = { sessionId: 'ses_1', callId: 'call_3', child: false, approved: false }
    await update.run({ status: 'blocked', note: 'API 키가 없다' }, { directory: project })
    expect((await stored('c1'))?.goal).toMatchObject({ status: 'blocked', note: 'API 키가 없다' })
  })
})

describe('기능 꺼짐', () => {
  it('목표 묶음이 없으면 ctx.goal·도구가 없고 턴이 끝나도 아무것도 보내지 않는다', async () => {
    const { ctx, chat, llm, tools, turn, endedCount } = await start({ goal: false })
    expect(ctx.get('goal')).toBeUndefined()
    expect(tools.size).toBe(0)
    await chat.send('c1', { project, model: MODEL, text: 'hi' })
    ;(await turn(1)).finish()
    await endedCount(1)
    await settle()
    expect(llm.calls).toHaveLength(1)
  })

  it('켜져 있다가 끄면(묶음 dispose) 서비스·도구·자동 이어가기가 함께 내려간다', async () => {
    const { ctx, llm, tools, turn, endedCount, setGoal, fiber } = await start()
    await setGoal('c1', 'X')
    const first = await turn(1)
    await fiber!.dispose()
    expect(ctx.get('goal')).toBeUndefined()
    expect(tools.size).toBe(0)
    first.finish()
    await endedCount(1)
    await settle()
    expect(llm.calls).toHaveLength(1)
  })
})
