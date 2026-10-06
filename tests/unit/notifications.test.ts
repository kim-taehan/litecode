import { Context, Service } from 'cordis'
import { describe, expect, it } from 'vitest'
import { NotificationsService, route, type NotificationHost } from '../../src/services/notifications.ts'
import { SettingsService } from '../../src/services/settings.ts'
import type { Conversation } from '../../src/services/sessions.ts'
import type { Project } from '../../src/services/projects.ts'

// 알림 판정 (ctx.notifications) — 이벤트는 ctx.emit 으로 직접 쏜다 (ctx.llm 은 이벤트만 내고 알림을 모른다).
// 사용자 결정 2026-10-02: 사건 순간 창이 없거나 포커스가 없으면 PC 알림, 앞이면 앱 알림(토스트), 보고 있는 그 대화면 아무것도 안 함.
// 대화마다 최신 하나, 중단은 PC 알림 없이 앱 안 표시만, 스위치는 PC 알림만 끈다. 지운 대화·뺀 프로젝트의 알림은 거둔다(Q8).

class FakeSessions extends Service {
  conversations: Conversation[] = [
    { id: 'c1', project: '/work/alpha', engineSessionId: 'ses_1', title: 'API 리팩터링', updatedAt: 1 },
    { id: 'c2', project: '/work/alpha', engineSessionId: 'ses_2', title: '', updatedAt: 2 },
    { id: 'c3', project: '/work/beta', engineSessionId: 'ses_3', title: '테스트 고치기', updatedAt: 3 },
  ]
  constructor(ctx: Context) {
    super(ctx, 'sessions')
  }
  async list(): Promise<Conversation[]> {
    return this.conversations
  }
}

class FakeProjects extends Service {
  constructor(ctx: Context) {
    super(ctx, 'projects')
  }
  async list(): Promise<Project[]> {
    return [{ path: '/work/alpha', name: 'billing-service', displayPath: '/work/alpha', favorite: false }]
  }
}

interface Shown {
  title: string
  body: string
  closed: boolean
  click(): void
}

function fakeHost() {
  const host = {
    foreground: false,
    shown: [] as Shown[],
    badges: [] as number[],
    reveals: 0,
  }
  const impl: NotificationHost = {
    isForeground: () => host.foreground,
    show(note, onClick) {
      const entry: Shown = { ...note, closed: false, click: onClick }
      host.shown.push(entry)
      return { close: () => void (entry.closed = true) }
    },
    setBadge: (count) => void host.badges.push(count),
    reveal: () => void host.reveals++,
  }
  return { host, impl }
}

async function start() {
  const ctx = new Context()
  const { host, impl } = fakeHost()
  ctx.plugin(SettingsService, { defaults: { language: 'ko' } })
  ctx.plugin(FakeSessions)
  ctx.plugin(FakeProjects)
  const fiber = ctx.plugin(NotificationsService, impl)
  const notifications = await new Promise<NotificationsService>((resolve) => ctx.inject(['notifications'], (ready) => resolve(ready.notifications)))
  const toasts: unknown[] = []
  let opens = 0
  ctx.on('notifications/toast', (toast) => void toasts.push(toast))
  ctx.on('notifications/open', () => void opens++)
  return { ctx, host, notifications, toasts, opens: () => opens, fiber }
}

const ended = (sessionId: string, outcome: 'done' | 'failed' | 'interrupted', directory = '/work/alpha') => ({ sessionId, directory, outcome })

describe('route — 앞/뒤 판정 (G1)', () => {
  it('창이 없거나 포커스가 없으면 PC, 앞이고 다른 대화면 앱, 앞이고 그 대화면 없음', () => {
    expect(route({ foreground: false, viewing: 'c1', conversationId: 'c1' })).toBe('system')
    expect(route({ foreground: false, viewing: undefined, conversationId: 'c1' })).toBe('system')
    expect(route({ foreground: true, viewing: 'c2', conversationId: 'c1' })).toBe('app')
    expect(route({ foreground: true, viewing: 'c1', conversationId: 'c1' })).toBe('none')
  })
})

describe('NotificationsService', () => {
  it('뒤에서 끝나면 PC 알림 — 제목은 대화 제목, 본문은 "프로젝트 · 상태" (답 내용 없음). 점은 안 본 완료, 배지 1', async () => {
    const { ctx, host, notifications } = await start()
    ctx.emit('llm/turn-started', { sessionId: 'ses_1', directory: '/work/alpha' })
    await notifications.idle()
    expect(notifications.snapshot()).toEqual({ c1: { project: '/work/alpha', status: 'running' } })

    ctx.emit('llm/turn-ended', { ...ended('ses_1', 'done'), error: undefined })
    await notifications.idle()
    expect(host.shown.map(({ title, body }) => ({ title, body }))).toEqual([{ title: 'API 리팩터링', body: 'billing-service · 끝났습니다' }])
    expect(notifications.snapshot()).toEqual({ c1: { project: '/work/alpha', status: 'done' } })
    expect(host.badges.at(-1)).toBe(1)
  })

  it('실패 문구에 provider 오류 원문을 싣지 않는다. 제목 없는 대화는 "새 대화", 목록에 없는 프로젝트는 폴더 이름', async () => {
    const { ctx, host, notifications } = await start()
    ctx.emit('llm/turn-ended', { ...ended('ses_2', 'failed'), error: 'HTTP 500 secret-token-xyz' })
    ctx.emit('llm/turn-ended', ended('ses_3', 'done', '/work/beta'))
    await notifications.idle()
    expect(host.shown.map(({ title, body }) => ({ title, body }))).toEqual([
      { title: '새 대화', body: 'billing-service · 실패했습니다' },
      { title: '테스트 고치기', body: 'beta · 끝났습니다' },
    ])
    expect(JSON.stringify(host.shown)).not.toContain('secret')
  })

  it('앞에서 다른 대화가 끝나면 PC 알림 없이 토스트 + 점', async () => {
    const { ctx, host, notifications, toasts } = await start()
    host.foreground = true
    notifications.view('c2')
    ctx.emit('llm/turn-ended', ended('ses_1', 'done'))
    await notifications.idle()
    expect(host.shown).toEqual([])
    expect(toasts).toEqual([{ conversationId: 'c1', project: '/work/alpha', projectName: 'billing-service', title: 'API 리팩터링', kind: 'done' }])
    expect(notifications.snapshot().c1?.status).toBe('done')
  })

  it('앞에서 보고 있는 그 대화가 끝나면 아무것도 없다 — 토스트·PC·점·배지 0', async () => {
    const { ctx, host, notifications, toasts } = await start()
    host.foreground = true
    notifications.view('c1')
    ctx.emit('llm/turn-started', { sessionId: 'ses_1', directory: '/work/alpha' })
    ctx.emit('llm/turn-ended', ended('ses_1', 'done'))
    await notifications.idle()
    expect(host.shown).toEqual([])
    expect(toasts).toEqual([])
    expect(notifications.snapshot()).toEqual({})
    expect(host.badges.at(-1)).toBe(0)
  })

  it('대화마다 최신 하나 — 같은 대화의 새 알림은 이전 것을 닫고, 다른 대화의 알림은 그대로', async () => {
    const { ctx, host, notifications } = await start()
    ctx.emit('llm/turn-ended', ended('ses_1', 'done'))
    ctx.emit('llm/turn-ended', ended('ses_3', 'done', '/work/beta'))
    ctx.emit('llm/turn-ended', ended('ses_1', 'failed'))
    await notifications.idle()
    expect(host.shown.map((entry) => [entry.title, entry.body, entry.closed])).toEqual([
      ['API 리팩터링', 'billing-service · 끝났습니다', true],
      ['테스트 고치기', 'beta · 끝났습니다', false],
      ['API 리팩터링', 'billing-service · 실패했습니다', false],
    ])
    expect(host.badges.at(-1)).toBe(2)
  })

  it('중단은 PC 알림 없이 앱 안 표시만 (Q10)', async () => {
    const { ctx, host, notifications } = await start()
    ctx.emit('llm/turn-ended', ended('ses_1', 'interrupted'))
    await notifications.idle()
    expect(host.shown).toEqual([])
    expect(notifications.snapshot().c1?.status).toBe('interrupted')
  })

  // 설정 > 일반의 "알림" 스위치는 없앴다 (사용자 2026-10-06 — 설정 > 기능의 알림 카드와 겹쳤다). 설정에 그 값 자체가 없다 —
  // 예전에 꺼 둔 값이 파일에 남아 있어도 읽을 때 버린다 (settings.test.ts)
  it('일반 설정의 알림 값은 보지 않는다 — 기능이 켜져 있으면 PC 알림이 뜬다', async () => {
    const { ctx, host, notifications, toasts } = await start()
    ctx.emit('llm/turn-ended', ended('ses_1', 'done'))
    await notifications.idle()
    expect(host.shown).toHaveLength(1)
    expect(notifications.snapshot().c1?.status).toBe('done')
    host.foreground = true
    ctx.emit('llm/turn-ended', ended('ses_3', 'done', '/work/beta'))
    await notifications.idle()
    expect(toasts).toHaveLength(1)
  })

  it('질문·승인 대기는 "답 필요" — 보고 있어도 점은 남고(읽음과 무관), 풀리면 점과 그 PC 알림이 사라진다', async () => {
    const { ctx, host, notifications } = await start()
    ctx.emit('llm/turn-started', { sessionId: 'ses_1', directory: '/work/alpha' })
    ctx.emit('llm/attention', { sessionId: 'ses_1', directory: '/work/alpha', kind: 'question', title: 'DB 를 고르세요' })
    await notifications.idle()
    expect(host.shown.map(({ body }) => body)).toEqual(['billing-service · 질문에 답을 기다립니다'])
    expect(JSON.stringify(host.shown)).not.toContain('DB 를 고르세요') // 질문 내용은 싣지 않는다 (Q5)
    expect(notifications.snapshot().c1?.status).toBe('attention')

    host.foreground = true
    notifications.view('c1')
    expect(notifications.snapshot().c1?.status).toBe('attention')
    expect(host.badges.at(-1)).toBe(1)

    ctx.emit('llm/attention-resolved', { sessionId: 'ses_1', directory: '/work/alpha' })
    await notifications.idle()
    expect(host.shown[0]!.closed).toBe(true)
    expect(notifications.snapshot().c1?.status).toBe('running')
    expect(host.badges.at(-1)).toBe(0)

    host.foreground = false
    ctx.emit('llm/attention', { sessionId: 'ses_3', directory: '/work/beta', kind: 'permission', title: 'bash' })
    await notifications.idle()
    expect(host.shown.at(-1)!.body).toBe('beta · 승인을 기다립니다')
  })

  it('읽음 — 앞에서 그 대화를 열면 안 본 완료와 그 PC 알림이 사라진다. 뒤에서 열려 있던 것은 창이 앞으로 올 때', async () => {
    const { ctx, host, notifications } = await start()
    notifications.view('c1')
    ctx.emit('llm/turn-ended', ended('ses_1', 'done'))
    ctx.emit('llm/turn-ended', ended('ses_3', 'done', '/work/beta'))
    await notifications.idle()
    expect(notifications.snapshot().c1?.status).toBe('done') // 뒤에서 보던 대화 — 아직 안 봤다

    host.foreground = true
    notifications.focused()
    expect(notifications.snapshot().c1).toBeUndefined()
    expect(host.shown[0]!.closed).toBe(true)

    notifications.view('c3')
    expect(notifications.snapshot()).toEqual({})
    expect(host.shown[1]!.closed).toBe(true)
    expect(host.badges.at(-1)).toBe(0)
  })

  it('PC 알림을 누르면 창을 앞으로 + 열 대상을 적고 화면에 신호. 화면이 한 번 당겨 가면 비운다', async () => {
    const { ctx, host, notifications, opens } = await start()
    ctx.emit('llm/turn-ended', ended('ses_3', 'done', '/work/beta'))
    await notifications.idle()
    host.shown[0]!.click()
    expect(host.reveals).toBe(1)
    expect(host.shown[0]!.closed).toBe(true)
    expect(opens()).toBe(1)
    expect(notifications.takePendingOpen()).toEqual({ conversationId: 'c3', project: '/work/beta' })
    expect(notifications.takePendingOpen()).toBeUndefined()
  })

  it('대화를 지우거나 프로젝트를 빼면 그 알림·점을 거둔다 (Q8 c). 실행 중인 턴의 점은 남는다', async () => {
    const { ctx, host, notifications } = await start()
    ctx.emit('llm/turn-ended', ended('ses_1', 'done'))
    ctx.emit('llm/turn-ended', ended('ses_2', 'done'))
    ctx.emit('llm/turn-ended', ended('ses_3', 'done', '/work/beta'))
    ctx.emit('llm/turn-started', { sessionId: 'ses_3', directory: '/work/beta' })
    await notifications.idle()

    ctx.emit('sessions/removed', ['c1'])
    expect(host.shown[0]!.closed).toBe(true)
    expect(notifications.snapshot().c1).toBeUndefined()

    ctx.emit('projects/removed', '/work/beta')
    expect(host.shown[2]!.closed).toBe(true)
    expect(notifications.snapshot()).toEqual({ c2: { project: '/work/alpha', status: 'done' }, c3: { project: '/work/beta', status: 'running' } })
    expect(host.shown[1]!.closed).toBe(false)
  })

  it('목록에 없는 엔진 세션의 사건은 무시한다', async () => {
    const { ctx, host, notifications } = await start()
    ctx.emit('llm/turn-ended', ended('ses_unknown', 'done'))
    await notifications.idle()
    expect(host.shown).toEqual([])
    expect(notifications.snapshot()).toEqual({})
  })

  it('서비스를 내리면(앱 종료) 남은 PC 알림을 다 닫는다 — 꺼진 뒤 눌러도 이동 못 하는 알림을 남기지 않는다', async () => {
    const { ctx, host, notifications, fiber } = await start()
    ctx.emit('llm/turn-ended', ended('ses_1', 'done'))
    ctx.emit('llm/turn-ended', ended('ses_3', 'done', '/work/beta'))
    await notifications.idle()
    await fiber.dispose()
    expect(host.shown.map((entry) => entry.closed)).toEqual([true, true])
  })

  it('서비스를 내리면(설정 > 기능에서 알림 끄기) dock 배지도 지운다', async () => {
    const { ctx, host, notifications, fiber } = await start()
    ctx.emit('llm/turn-ended', ended('ses_1', 'done'))
    await notifications.idle()
    expect(host.badges.at(-1)).toBe(1)
    await fiber.dispose()
    expect(host.badges.at(-1)).toBe(0)
  })
})
