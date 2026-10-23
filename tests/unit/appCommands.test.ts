import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context, Service } from 'cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppCommandsService } from '../../src/services/appCommands.ts'
import { GoalService } from '../../src/services/goals.ts'
import { PlanReviewService } from '../../src/services/planReview.ts'
import type { GoalView } from '../../shared/goal.ts'
import { setMainLanguage } from '../../src/i18n.ts'
import type { Conversation } from '../../shared/contract.ts'
import type { Mode } from '../../shared/modes.ts'

// /goal·/plan 앱 명령의 본문 (이슈 #626) — dsh command-goal / plan-mode 명령의 파싱·상태 흐름.
// goals·planReview 는 진짜, sessions·chat 은 가짜 (패치·전송을 기록한다)

interface FakeConversation {
  id: string
  project: string
  mode?: Mode
  planBack?: Mode
}

class FakeSessions extends Service {
  conversations: FakeConversation[]
  constructor(ctx: Context, options: { conversations?: FakeConversation[] } = {}) {
    super(ctx, 'sessions')
    this.conversations = options.conversations ?? [{ id: 'c-1', project: '/p' }]
  }
  async list(): Promise<Conversation[]> {
    return this.conversations.map((entry) => ({ ...entry })) as unknown as Conversation[]
  }
  async patch(id: string, change: (entry: Conversation) => Partial<Conversation>): Promise<Conversation | undefined> {
    const entry = this.conversations.find((fake) => fake.id === id)
    if (!entry) return undefined
    Object.assign(entry, change({ ...entry } as unknown as Conversation))
    return { ...entry } as unknown as Conversation
  }
}

class FakeChat extends Service {
  sent: { cid: string; text: string; mode?: Mode }[] = []
  constructor(ctx: Context) {
    super(ctx, 'chat')
  }
  async send(cid: string, command: { text: string; mode?: Mode }): Promise<unknown> {
    this.sent.push({ cid, text: command.text, mode: command.mode })
    return { ok: true, text: '' }
  }
}

let root: string
let ctx: Context
const sessions = () => (ctx as unknown as { sessions: FakeSessions }).sessions
const planReview = () => (ctx as unknown as { planReview: PlanReviewService }).planReview
const goals = () => (ctx as unknown as { goals: GoalService }).goals
const runGoal = (args?: string) => (ctx as unknown as { appCommands: AppCommandsService }).appCommands.run('c-1', 'goal', args)
const runPlan = (args?: string) => (ctx as unknown as { appCommands: AppCommandsService }).appCommands.run('c-1', 'plan', args)

beforeEach(async () => {
  setMainLanguage('ko')
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-appcmd-')))
  ctx = new Context()
  ctx.plugin(FakeSessions)
  ctx.plugin(FakeChat)
  ctx.plugin(GoalService, { file: path.join(root, 'goals.json') })
  ctx.plugin(PlanReviewService)
  ctx.plugin(AppCommandsService)
  await new Promise<void>((resolve) => {
    ctx.inject(['appCommands', 'goals', 'sessions', 'chat', 'planReview'], () => resolve())
  })
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

describe('/goal (dsh command-goal 파싱·흐름)', () => {
  it('목표가 없으면 안내, 있으면 dsh renderGoal 로 — CAS 는 안 보인다', async () => {
    expect((await runGoal()).text).toContain('목표가 없습니다')
    const created = await runGoal('로그인 버그 고치기')
    expect(created.sent).toBeUndefined()
    for (const needle of ['목표가 생겼습니다', 'Status: active', 'Objective: 로그인 버그 고치기', 'Rounds: 0/8', 'Activation: armed', '/goal edit <objective>']) {
      expect(created.text, needle).toContain(needle)
    }
    // active 도중 다른 목표 = 이미 있다 (dsh Already have goal)
    expect((await runGoal('또 다른 목표')).text).toContain('이미 있습니다')
    expect((await runGoal('clear')).text).toContain('목표를 지웠습니다')
    expect((await runGoal('clear')).text).toContain('지울 목표가 없습니다')
  })

  it('pause·resume·edit — dsh 명령 그대로. 완료 목표의 edit 은 새 목표', async () => {
    // 없는 목표의 pause·resume·edit
    expect((await runGoal('pause')).text).toContain('pause')
    expect((await runGoal('resume')).text).toContain('resume')
    expect((await runGoal('edit 또')).text).toContain('edit 은 목표가 있어야 합니다')
    await runGoal('로그인 버그 고치기')
    expect((await runGoal('pause')).text).toContain('목표를 중지했습니다')
    expect((await runGoal('resume')).text).toContain('목표를 다시 시작했습니다')
    expect((await runGoal('edit')).text).toContain('새 목표가 있어야 합니다')
    const edited = await runGoal('edit 수정된 목표')
    expect(edited.text).toContain('목표가 바뀐 것입니다')
    expect(edited.text).toContain('Objective: 수정된 목표')
    // 완료 목표의 edit = 새 식별자로 재창조 (dsh create)
    const current = (await goals().view('c-1')) as GoalView
    await goals().complete('c-1', { id: current.id, revision: current.revision })
    const recreated = await runGoal('edit 새 목표')
    expect(recreated.text).toContain('목표가 생겼습니다')
    expect((await goals().view('c-1'))!.id).not.toBe(current.id)
  })
})

describe('/plan (dsh plan-mode 명령의 흐름)', () => {
  it('일반 모드에서 진입 — planBack 을 기억하고, 인자가 있으면 그 메시지를 보낸다', async () => {
    const entered = await runPlan('')
    expect(entered.sent).toBeUndefined()
    expect(entered.text).toContain('계획 모드로 들어갔습니다')
    expect(sessions().conversations[0]).toMatchObject({ mode: 'plan' })
    expect(sessions().conversations[0]!.planBack).toBeUndefined() // 기본 모드였으니 planBack 없음
    // 인자와 함께 — 계획 모드로 메시지 전송 (화면은 말풍선에서 본다)
    const sent = await runPlan('로그인 화면만 먼저')
    expect(sent).toEqual({ text: '계획 모드에서 보냈습니다.', sent: true })
    expect((ctx as unknown as { chat: FakeChat }).chat.sent.at(-1)).toEqual({ cid: 'c-1', text: '로그인 화면만 먼저', mode: 'plan' })
  })

  it('전체 권한에서 진입하면 planBack=full, off 로 돌아온다. plan 메시지는 계획 모드로 전송', async () => {
    sessions().conversations[0]!.mode = 'full'
    await runPlan('')
    expect(sessions().conversations[0]).toMatchObject({ mode: 'plan', planBack: 'full' })
    expect((await runPlan('')).text).toContain('이미 계획 모드입니다')
    expect((await runPlan('계속 다듬어')).sent).toBe(true)
    const off = await runPlan('off')
    expect(off.sent).toBeUndefined()
    expect(off.text).toContain('계획 모드를 종료했습니다')
    expect(sessions().conversations[0]!.mode).toBe('full')
    // 계획이 아니면 off 는 그냥 사유 — 모드는 안 바뀐다
    const notIn = await runPlan('off')
    expect(notIn.text).toContain('계획 모드가 아닙니다')
    expect(sessions().conversations[0]!.mode).toBe('full')
  })
})

describe('PlanReviewService — dsh exit_plan_mode 의 검토 대기', () => {
  it('start 는 이벤트를 흘리고 답을 기다린다 — 승인은 planBack 으로, 거절은 feedback 함께', async () => {
    const reviews: { id: string; cid: string; plan: string }[] = []
    const answered: string[] = []
    const offReview = ctx.on('plan/review', (data) => reviews.push(data))
    const offAnswered = ctx.on('plan/review-answered', (id) => answered.push(id))
    sessions().conversations[0]!.mode = 'plan'
    sessions().conversations[0]!.planBack = 'build'

    const pending1 = planReview().start('c-1', '# 계획\n1. 고친다')
    const pending2 = planReview().start('c-1', '# 계획2')
    expect(reviews).toEqual([
      { id: expect.any(String), cid: 'c-1', plan: '# 계획\n1. 고친다' },
      { id: expect.any(String), cid: 'c-1', plan: '# 계획2' },
    ])
    // 거절 — feedback 과 함께 실패 (dsh Keep planning)
    planReview().answer(reviews[0]!.id, 'revise', '2단계 먼저')
    expect(await pending1).toEqual({ approved: false, feedback: '2단계 먼저' })
    // 승인 — 모도는 planBack 으로 (exitPlan 은 비동기 — 한 틱)
    planReview().answer(reviews[1]!.id, 'approve')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await pending2).toEqual({ approved: true })
    expect(sessions().conversations[0]!.mode).toBe('build')
    expect(answered).toHaveLength(2)
    offReview()
    offAnswered()
  })

  it('drop 은 대화 삭제 — 대기 검토를 승인 없이 닫는다', async () => {
    const pending = planReview().start('c-1', '# 계획')
    planReview().drop('c-1')
    expect(await pending).toEqual({ approved: false })
  })
})
