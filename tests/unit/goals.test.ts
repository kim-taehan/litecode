import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from 'cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { foldGoalLog, GoalError, GOAL_ROUNDS_DEFAULT, goalRoundPrompt, type GoalChangeOperation, type GoalSnapshot } from '../../shared/goal.ts'
import { GoalService } from '../../src/services/goals.ts'

// 목표 도메인 (이슈 #626, dsh packages/goal) — fold 순수 함수와 GoalService(JSON 이벤트 로그 + CAS + armed + 라운드 예약)

let root: string

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-goals-')))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

const snapshot = (overrides: Partial<GoalSnapshot> = {}): GoalSnapshot => ({
  id: 'g1',
  revision: 1,
  objective: 'ship it',
  phase: 'active',
  maxGoalRounds: GOAL_ROUNDS_DEFAULT,
  ...overrides,
})

const event = (operation: GoalChangeOperation, goal: GoalSnapshot, rounds: number, at = 1) => ({
  kind: 'goal/change' as const,
  version: 1 as const,
  operation,
  goal,
  roundsStarted: rounds,
  createdAt: 1,
  updatedAt: at,
})

describe('foldGoalLog — 이벤트 로그 fold (dsh strict replay)', () => {
  it('create 이벤트가 현재 목표가 된다 (fold 는 armed 을 안 복구한다 — 프로세스 로컬)', () => {
    const view = foldGoalLog({ events: [event('create', snapshot(), 0)] })
    expect(view).toMatchObject({ id: 'g1', revision: 1, objective: 'ship it', phase: 'active', roundsStarted: 0, maxGoalRounds: GOAL_ROUNDS_DEFAULT, armed: false })
  })

  it('전체 수명을 fold 한다 — create → round → pause → resume → block → resume → complete', () => {
    const log = {
      events: [
        event('create', snapshot(), 0, 1),
        event('round', snapshot({ revision: 2 }), 1, 2),
        event('pause', snapshot({ revision: 3, phase: 'paused' }), 1, 3),
        event('resume', snapshot({ revision: 4 }), 1, 4),
        event('block', snapshot({ revision: 5, phase: 'blocked', blockedReason: { code: 'dep-down', message: 'dep 503' } }), 1, 5),
        event('resume', snapshot({ revision: 6 }), 1, 6),
        event('round', snapshot({ revision: 7 }), 2, 7),
        event('complete', snapshot({ revision: 8, phase: 'complete' }), 2, 8),
      ],
    }
    expect(foldGoalLog(log)).toMatchObject({ revision: 8, phase: 'complete', roundsStarted: 2 })
  })

  it('마지막이 clear 톰스톤이면 현재 목표가 없다.', () => {
    const log = {
      events: [event('create', snapshot(), 0, 1), { kind: 'goal/change' as const, version: 1 as const, operation: 'clear' as const, cleared: { id: 'g1', revision: 1 }, clearedAt: 2 }],
    }
    expect(foldGoalLog(log)).toBeUndefined()
    expect(foldGoalLog(undefined)).toBeUndefined()
  })

  it('clear 이후의 create 는 새 목표로, complete 이후의 create 도 새 식별자로', () => {
    const cleared = { kind: 'goal/change' as const, version: 1 as const, operation: 'clear' as const, cleared: { id: 'g1', revision: 1 }, clearedAt: 2 }
    expect(foldGoalLog({ events: [event('create', snapshot(), 0, 1), cleared, event('create', snapshot(), 0, 3)] })).toMatchObject({ phase: 'active', revision: 1 })
    expect(foldGoalLog({ events: [event('create', snapshot(), 0, 1), event('complete', snapshot({ revision: 2, phase: 'complete' }), 0, 2), event('create', snapshot({ id: 'g2' }), 0, 3)] })).toMatchObject({ id: 'g2', phase: 'active' })
  })

  it('active 중인 동안 create 는 거른다 (dsh: completed 가 아니라면 clear)', () => {
    expect(() => foldGoalLog({ events: [event('create', snapshot(), 0, 1), event('create', snapshot(), 0, 2)] })).toThrow(GoalError)
  })

  it('revision 이 어긋나면(CAS) 거른다 — create 는 1 로 시작, 나머지는 현재+1', () => {
    expect(() => foldGoalLog({ events: [event('create', snapshot({ revision: 2 }), 0)] })).toThrow(GoalError)
    expect(() => foldGoalLog({ events: [event('create', snapshot(), 0, 1), event('edit', snapshot({ revision: 5 }), 0, 2)] })).toThrow(GoalError)
  })

  it('blocked 는 사유가 있고, blocked 가 아니면 사유가 없다 (dsh: present exactly while blocked)', () => {
    expect(() => foldGoalLog({ events: [event('create', snapshot(), 0, 1), event('block', snapshot({ revision: 2, phase: 'blocked' }), 0, 2)] })).toThrow(GoalError)
    expect(() => foldGoalLog({ events: [event('create', snapshot({ blockedReason: { code: 'x', message: 'y' } }), 0)] })).toThrow(GoalError)
  })

  it('라운드 수가 줄거나 상한을 넘으면 거른다', () => {
    expect(() => foldGoalLog({ events: [event('create', snapshot(), 0, 1), event('round', snapshot({ revision: 2 }), 1, 2), event('round', snapshot({ revision: 3 }), 0, 3)] })).toThrow(GoalError)
    expect(() => foldGoalLog({ events: [event('create', snapshot(), 0, 1), event('round', snapshot({ revision: 2 }), 9, 2)] })).toThrow(GoalError)
  })

  it('roundsStarted 가 스킵(크래시 후 재개)이면 최대 값을 딴다 — fold 는 허용한다 (예약·수용으로 정상 오름을 보장)', () => {
    const view = foldGoalLog({ events: [event('create', snapshot({ maxGoalRounds: 10 }), 0, 1), event('round', snapshot({ revision: 2 }), 4, 2)] })
    expect(view?.roundsStarted).toBe(4)
  })
})

describe('goalRoundPrompt — dsh renderGoalRoundPrompt 과 같은 본문', () => {
  it('목표·라운드 번호·지시문을 <goal_round> 블록으로 둔다', () => {
    const prompt = goalRoundPrompt('ship it', 2, 8)
    expect(prompt.startsWith('<goal_round>\n')).toBe(true)
    expect(prompt.endsWith('</goal_round>')).toBe(true)
    expect(prompt).toContain('Objective: "ship it"')
    expect(prompt).toContain('Round: 2/8')
    expect(prompt).toContain('Continue working toward the objective in this same session')
    expect(prompt).toContain('mark it complete')
  })
})

describe('GoalService — goals.json 이벤트 로그 + CAS + armed + 라운드 예약', () => {
  type Event = [name: string, cid: string, view: unknown]
  const open = async (file = path.join(root, 'goals.json')) => {
    const ctx = new Context()
    const events: Event[] = []
    ctx.on('goal/changed', (cid, view) => events.push(['goal/changed', cid, view]))
    ctx.plugin(GoalService, { file })
    await new Promise<void>((resolve) => {
      ctx.inject(['goals'], () => resolve())
    })
    return { ctx: ctx, goals: ctx.get('goals') as GoalService, events }
  }
  const cid = 'c-1'

  it('create 가 현재 목표를 만들고 arm 한다 (기본 라운드 상한). 또 만들면 거른다', async () => {
    const { goals, events } = await open()
    const view = await goals.create(cid, { objective: 'ship it' })
    expect(view).toMatchObject({ objective: 'ship it', phase: 'active', revision: 1, roundsStarted: 0, maxGoalRounds: GOAL_ROUNDS_DEFAULT, armed: true })
    expect(await goals.view(cid)).toMatchObject({ phase: 'active', armed: true })
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(['goal/changed', cid, view])
    await expect(goals.create(cid, { objective: 'another' })).rejects.toThrow(GoalError)
    // 완료 후에는 새 식별자로 교체 (dsh create)
    await goals.complete(cid, { id: view.id, revision: view.revision })
    const next = await goals.create(cid, { objective: 'again' })
    expect(next).toMatchObject({ objective: 'again', revision: 1, phase: 'active' })
    expect(next.id).not.toBe(view.id)
  })

  it('objective·라운드 상한 검증 — 비어 있거나 너무 길거나, 상한 밖이면 거른다', async () => {
    const { goals } = await open()
    await expect(goals.create(cid, { objective: '  ' })).rejects.toThrow(GoalError)
    await expect(goals.create(cid, { objective: 'x'.repeat(501) })).rejects.toThrow(GoalError)
    await expect(goals.create(cid, { objective: 'ok', maxGoalRounds: 0 })).rejects.toThrow(GoalError)
    await expect(goals.create(cid, { objective: 'ok', maxGoalRounds: 51 })).rejects.toThrow(GoalError)
  })

  it('edit 는 CAS 로 — 어긋난 revision 은 거른다', async () => {
    const { goals } = await open()
    const view = await goals.create(cid, { objective: 'ship it' })
    await expect(goals.edit(cid, { id: view.id, revision: 99 }, { objective: 'new' })).rejects.toThrow(GoalError)
    const edited = await goals.edit(cid, { id: view.id, revision: 1 }, { objective: 'new', maxGoalRounds: 3 })
    expect(edited).toMatchObject({ objective: 'new', maxGoalRounds: 3, revision: 2 })
    await expect(goals.edit(cid, { id: view.id, revision: 1 }, { objective: 'stale' })).rejects.toThrow(GoalError)
    await expect(goals.edit(cid, { id: view.id, revision: 2 }, {})).rejects.toThrow(GoalError)
  })

  it('pause 는 disarm, resume 은 재개+arm — 완료 목표는 못 연다, 잔량이 없으면 못 연다', async () => {
    const { goals } = await open()
    const view = await goals.create(cid, { objective: 'ship it', maxGoalRounds: 1 })
    const paused = await goals.pause(cid, { id: view.id, revision: 1 })
    expect(paused).toMatchObject({ phase: 'paused', revision: 2 })
    expect((await goals.view(cid))?.armed).toBe(false)
    const resumed = await goals.resume(cid, { id: view.id, revision: 2 })
    expect(resumed).toMatchObject({ phase: 'active', revision: 3 })
    expect((await goals.view(cid))?.armed).toBe(true)
    // 라운드 1 잔량 소진 → resume 거절
    await goals.reserveRound(cid)
    expect(await goals.admitRound(cid)).toBe(true)
    await goals.pause(cid, { id: view.id, revision: 4 })
    await expect(goals.resume(cid, { id: view.id, revision: 5 })).rejects.toThrow(GoalError)
    // 완료 목표는 못 연다
    await goals.complete(cid, { id: view.id, revision: 5 })
    await expect(goals.resume(cid, { id: view.id, revision: 6 })).rejects.toThrow(GoalError)
  })

  it('block 은 사유를 싣고 disarm, resume 이면 사유가 빠진다', async () => {
    const { goals } = await open()
    const view = await goals.create(cid, { objective: 'ship it' })
    const blocked = await goals.block(cid, { id: view.id, revision: 1 }, { code: 'dep-down', message: 'dep 503' })
    expect(blocked).toMatchObject({ phase: 'blocked', blockedReason: { code: 'dep-down', message: 'dep 503' } })
    expect((await goals.view(cid))?.armed).toBe(false)
    await expect(goals.block(cid, { id: view.id, revision: 2 }, { code: 'x', message: 'y' })).rejects.toThrow(GoalError) // 이미 blocked
    const resumed = await goals.resume(cid, { id: view.id, revision: 2 })
    expect(resumed.blockedReason).toBeUndefined()
    expect(resumed.phase).toBe('active')
  })

  it('clear 는 톰스톤으로 — view 가 사라지고, 없으면 다시 clear 못 한다', async () => {
    const { goals, events } = await open()
    const view = await goals.create(cid, { objective: 'ship it' })
    await goals.clear(cid, { id: view.id, revision: 1 })
    expect(await goals.view(cid)).toBeUndefined()
    expect(events.at(-1)).toEqual(['goal/changed', cid, undefined])
    await expect(goals.clear(cid, { id: view.id, revision: 1 })).rejects.toThrow(GoalError)
  })

  it('내구 상태는 파일에, armed 은 프로세스 로컬이다 — 새 인스턴스는 fold 로 이어받고 armed 은 없다', async () => {
    const file = path.join(root, 'shared.json')
    const first = await open(file)
    await first.goals.create(cid, { objective: 'ship it' })
    expect((await first.goals.view(cid))?.armed).toBe(true)
    const second = await open(file)
    expect(await second.goals.view(cid)).toMatchObject({ objective: 'ship it', phase: 'active', armed: false })
  })

  it('라운드 예약·수용 — active+armed+잔량만 예약, hook 턴이 실제로 시작했을 때만 증가 (dsh reservation→admission)', async () => {
    const { goals } = await open()
    const view = await goals.create(cid, { objective: 'ship it', maxGoalRounds: 2 })
    expect(await goals.reserveRound(cid)).toMatchObject({ goalId: view.id, revision: 1, round: 1 })
    expect(await goals.admitRound(cid)).toBe(true)
    expect((await goals.view(cid))?.roundsStarted).toBe(1)
    // 예약 없는 admit 은 stale — 증가 없이 false
    expect(await goals.admitRound(cid)).toBe(false)
    expect((await goals.view(cid))?.roundsStarted).toBe(1)
    // paused 면 예약 안 됨
    await goals.pause(cid, { id: view.id, revision: 2 })
    expect(await goals.reserveRound(cid)).toBeUndefined()
    // 재개 후 예약→stale(파상 변경)이면 admit 실패
    await goals.resume(cid, { id: view.id, revision: 3 })
    expect(await goals.reserveRound(cid)).toMatchObject({ round: 2 })
    await goals.edit(cid, { id: view.id, revision: 4 }, { objective: 'changed' })
    expect(await goals.admitRound(cid)).toBe(false)
    expect((await goals.view(cid))?.roundsStarted).toBe(1)
    // 잔량 소진면 예약 안 됨
    const fresh = await open(path.join(root, 'cap.json'))
    const cap = await fresh.goals.create(cid, { objective: 'cap', maxGoalRounds: 1 })
    await fresh.goals.reserveRound(cid)
    expect(await fresh.goals.admitRound(cid)).toBe(true)
    expect(await fresh.goals.reserveRound(cid)).toBeUndefined()
    expect((await fresh.goals.view(cid))?.roundsStarted).toBe(1)
    expect(cap.id).toBeTruthy()
  })
})
