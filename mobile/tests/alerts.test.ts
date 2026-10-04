import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attention } from '../../shared/contract.ts'
import type { RemoteEvent } from '../../shared/remote.ts'
import { AlertCenter, alertChannel, alertKey, AlertRules, alertText, BANNER_MS, type AlertContext, type AlertHost } from '../src/app/alerts.ts'
import { DEFAULT_PREFS, Preferences, type Prefs, type PrefsStore } from '../src/app/prefs.ts'
import type { AppSession } from '../src/app/session.ts'
import { initialState, reduce } from '../src/core/index.ts'
import { createDemoSession, DEMO_CHAT, DEMO_STEP_MS } from './demoSession.ts'

// 알림 규칙(alerts.ts) — "이 이벤트가 알림이 되나", 글, 대체 키. 화면·OS 알림 없이 순수 로직만 본다.

const permission = (id: string, command = 'npm test -- --run'): Attention => ({ kind: 'permission', id, sessionId: 's', action: 'bash', resources: [command] })
const asked = (cid: string, requests: Attention[]): RemoteEvent => ({ event: 'turn.attention', data: { cid, requests } })
const ended = (cid: string, outcome: 'done' | 'failed' | 'interrupted', extra: object = {}): RemoteEvent => ({ event: 'turn.ended', data: { cid, outcome, message: { role: 'assistant', text: '답', ...extra } } })
const front: AlertContext = { enabled: true, foreground: true }
const back: AlertContext = { enabled: true, foreground: false }

describe('AlertRules — 이 이벤트가 알림이 되나', () => {
  it('답 필요: 앞이면 띠, 뒤면 시스템 알림. 무엇을 묻는지 한 줄이 실린다', () => {
    const rules = new AlertRules()
    expect(rules.decide(asked('c1', [permission('p1')]), front)).toEqual([{ type: 'banner', alert: { cid: 'c1', kind: 'attention', detail: 'npm test -- --run' } }])
    expect(rules.decide(asked('c2', [permission('p2', 'rm -rf build')]), back)).toEqual([{ type: 'system', alert: { cid: 'c2', kind: 'attention', detail: 'rm -rf build' } }])
  })

  it('질문은 질문 글, MCP 도구 승인은 서버/도구가 한 줄이다', () => {
    const rules = new AlertRules()
    const question: Attention = { kind: 'question', id: 'q1', sessionId: 's', questions: [{ question: '어느 브랜치에\n배포할까요?', options: [] }] }
    expect(rules.decide(asked('c1', [question]), back)).toMatchObject([{ alert: { detail: '어느 브랜치에 배포할까요?' } }])
    const mcp: Attention = { kind: 'permission', id: 'p9', sessionId: 's', action: 'jira_search', resources: [], mcp: { server: 'jira', tool: 'search' } }
    expect(rules.decide(asked('c2', [mcp]), back)).toMatchObject([{ alert: { detail: 'jira/search' } }])
  })

  it('완료·실패는 알리고, 중단(사용자가 멈춤)·거절은 알리지 않는다 — 떠 있던 알림만 거둔다', () => {
    const rules = new AlertRules()
    expect(rules.decide(ended('c1', 'done'), back)).toEqual([{ type: 'system', alert: { cid: 'c1', kind: 'done' } }])
    expect(rules.decide(ended('c1', 'failed'), front)).toEqual([{ type: 'banner', alert: { cid: 'c1', kind: 'failed' } }])
    expect(rules.decide(ended('c1', 'interrupted'), back)).toEqual([{ type: 'dismiss', cid: 'c1' }])
    expect(rules.decide(ended('c1', 'done', { declined: true }), back)).toEqual([{ type: 'dismiss', cid: 'c1' }])
  })

  it('지금 보고 있는 대화의 일은 알리지 않는다 — 앱이 뒤에 있으면 보고 있는 것이 아니다', () => {
    const rules = new AlertRules()
    expect(rules.decide(asked('c1', [permission('p1')]), { ...front, viewing: 'c1' })).toEqual([])
    expect(rules.decide(ended('c1', 'done'), { ...front, viewing: 'c1' })).toEqual([{ type: 'dismiss', cid: 'c1' }])
    expect(rules.decide(ended('c1', 'done'), { ...front, viewing: 'c2' })).toMatchObject([{ type: 'banner' }])
    expect(rules.decide(ended('c1', 'done'), { ...back, viewing: 'c1' })).toMatchObject([{ type: 'system' }])
  })

  it('알림을 꺼 두면 아무것도 없다 — 그사이 본 요청은 켠 뒤에도 다시 알리지 않는다', () => {
    const rules = new AlertRules()
    const off = { ...back, enabled: false }
    expect(rules.decide(asked('c1', [permission('p1')]), off)).toEqual([])
    expect(rules.decide(ended('c2', 'done'), off)).toEqual([])
    expect(rules.decide(asked('c1', [permission('p1')]), back)).toEqual([])
  })

  it('같은 요청은 한 번만 — 목록이 다시 와도(요청이 하나 더 붙어도) 새 요청만 알린다', () => {
    const rules = new AlertRules()
    expect(rules.decide(asked('c1', [permission('p1')]), back)).toHaveLength(1)
    expect(rules.decide(asked('c1', [permission('p1')]), back)).toEqual([])
    expect(rules.decide(asked('c1', [permission('p1'), permission('p2', 'ls')]), back)).toEqual([{ type: 'system', alert: { cid: 'c1', kind: 'attention', detail: 'ls' } }])
  })

  it('답해서 대기가 없어지면(빈 목록) 그 대화의 알림을 거둔다. 새 턴이 시작돼도 거둔다', () => {
    const rules = new AlertRules()
    rules.decide(asked('c1', [permission('p1')]), back)
    expect(rules.decide(asked('c1', []), back)).toEqual([{ type: 'dismiss', cid: 'c1' }])
    expect(rules.decide({ event: 'turn.started', data: { cid: 'c1', origin: 'desktop', message: { role: 'user', text: '또' } } }, back)).toEqual([{ type: 'dismiss', cid: 'c1' }])
  })

  it('알림이 아닌 이벤트 — 진행 줄, 목록 신호, reset(스냅샷을 다시 받는 것)은 아무것도 만들지 않는다', () => {
    const rules = new AlertRules()
    const events: RemoteEvent[] = [
      { event: 'turn.progress', data: { cid: 'c1', item: { kind: 'text', id: 't', text: 'x', done: true } } },
      { event: 'conversations.changed', data: { project: '/p' } },
      { event: 'notices.changed', data: { c1: { project: '/p', status: 'done' } } },
      { event: 'reset', data: { runId: 'B', seq: 0 } },
      { event: 'ready', data: { runId: 'B', seq: 0 } },
    ]
    for (const event of events) expect(rules.decide(event, back), event.event).toEqual([])
  })
})

describe('알림 글·키·채널', () => {
  const state = reduce(reduce(initialState, { type: 'projects.loaded', projects: [{ path: '/w/billing-api', name: 'billing-api', displayPath: '~/billing-api', favorite: false }] }), {
    type: 'conversations.loaded',
    project: '/w/billing-api',
    conversations: [{ id: 'c1', project: '/w/billing-api', title: '배포 스크립트 정리', updatedAt: 1 }],
  })

  it('제목 = 대화 제목, 본문 = "프로젝트 · 상태" (답 필요면 무엇을 묻는지 한 줄 더)', () => {
    expect(alertText({ cid: 'c1', kind: 'attention', detail: 'npm test -- --run' }, state)).toEqual({ title: '배포 스크립트 정리', body: 'billing-api · 답 필요\nnpm test -- --run' })
    expect(alertText({ cid: 'c1', kind: 'done' }, state)).toEqual({ title: '배포 스크립트 정리', body: 'billing-api · 완료' })
    expect(alertText({ cid: 'c1', kind: 'failed' }, state)).toEqual({ title: '배포 스크립트 정리', body: 'billing-api · 실패' })
  })

  it('목록에 없는 대화(아직 못 받았다)는 이름 없이 상태만', () => {
    expect(alertText({ cid: 'c_unknown', kind: 'done' }, state)).toEqual({ title: '새 대화', body: '완료' })
  })

  it('대화마다 키 하나(같은 대화의 새 알림이 앞의 것을 바꾼다), 채널은 답 필요와 결과 둘', () => {
    expect(alertKey('c1')).toBe(alertKey('c1'))
    expect(alertKey('c1')).not.toBe(alertKey('c2'))
    expect([alertChannel('attention'), alertChannel('done'), alertChannel('failed')]).toEqual(['attention', 'result', 'result'])
  })
})

describe('AlertCenter — 세션의 이벤트를 띠와 시스템 알림으로', () => {
  let session: AppSession
  let calls: string[]
  let foreground: boolean
  let prefs: Prefs
  let center: AlertCenter
  const host: AlertHost = {
    notify: (key, channel, text) => void calls.push(`notify ${key} ${channel} ${text.title} | ${text.body.replace('\n', ' / ')}`),
    dismiss: (key) => void calls.push(`dismiss ${key}`),
  }
  const steps = (count: number) => vi.advanceTimersByTimeAsync(count * DEMO_STEP_MS)
  const waiting = () => session.getState().views[DEMO_CHAT]!.attention[0]!

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-05T09:00:00Z'))
    session = createDemoSession()
    calls = []
    foreground = true
    prefs = { ...DEFAULT_PREFS }
    center = new AlertCenter({ host, prefs: () => prefs, foreground: () => foreground })
    center.attach(session)
  })
  afterEach(() => {
    center.dispose()
    session.dispose()
    vi.useRealTimers()
  })

  it('앞에서 다른 화면에 있을 때: 띠가 뜨고(시스템 알림 없음) 몇 초 뒤 사라진다', async () => {
    await session.takeQueue(DEMO_CHAT) // 대기 글을 빼 둔다 — 턴이 끝난 뒤 다음 턴이 바로 이어지지 않게
    session.reply(waiting(), 'once')
    await steps(6) // 턴 끝 → 완료
    expect(center.banner).toMatchObject({ cid: DEMO_CHAT, kind: 'done', title: '배포 스크립트 정리', body: 'billing-api · 완료' })
    expect(calls.filter((call) => call.startsWith('notify'))).toEqual([])

    await vi.advanceTimersByTimeAsync(BANNER_MS - 1)
    expect(center.banner).toBeDefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(center.banner).toBeUndefined()
  })

  it('턴이 끝나자마자 대기 글이 다음 턴으로 이어지면 "완료" 는 거둔다 — 그 대화는 아직 도는 중이다', async () => {
    foreground = false
    session.reply(waiting(), 'once')
    await steps(6)
    expect(calls.slice(-2)).toEqual([`notify ${alertKey(DEMO_CHAT)} result 배포 스크립트 정리 | billing-api · 완료`, `dismiss ${alertKey(DEMO_CHAT)}`])
  })

  it('뒤에 있을 때: 시스템 알림 — 대화마다 키 하나, 답 필요는 attention 채널, 완료는 result 채널', async () => {
    foreground = false
    session.send('c_tests', '안녕')
    await steps(5)
    expect(calls).toContain(`notify ${alertKey('c_tests')} result 테스트 실패 원인 찾기 | billing-api · 완료`)
    expect(center.banner).toBeUndefined()
  })

  it('보고 있는 대화의 일은 띠도 알림도 없다. 대화를 열면 그 대화의 알림·띠가 지워진다', async () => {
    center.view(DEMO_CHAT)
    expect(calls).toEqual([`dismiss ${alertKey(DEMO_CHAT)}`])
    session.reply(waiting(), 'once')
    await steps(6)
    expect(center.banner).toBeUndefined()
    expect(calls.filter((call) => call.startsWith('notify'))).toEqual([])

    // 다른 대화의 띠가 떠 있을 때 그 대화를 열면 띠가 내려간다
    center.view(undefined)
    session.send('c_tests', '안녕')
    await steps(5)
    expect(center.banner).toMatchObject({ cid: 'c_tests' })
    center.view('c_tests')
    expect(center.banner).toBeUndefined()
  })

  it('중단은 알리지 않는다', () => {
    foreground = false
    session.stop(DEMO_CHAT)
    expect(calls.filter((call) => call.startsWith('notify'))).toEqual([])
    expect(center.banner).toBeUndefined()
  })

  it('알림을 끄면 띠도 시스템 알림도 없다', async () => {
    prefs = { ...prefs, notifications: false }
    session.reply(waiting(), 'once')
    await steps(6)
    foreground = false
    await steps(6)
    expect(center.banner).toBeUndefined()
    expect(calls.filter((call) => call.startsWith('notify'))).toEqual([])
  })

  it('세션에서 떼면 더 듣지 않는다', async () => {
    center.dispose()
    foreground = false
    session.send('c_tests', '안녕')
    await steps(5)
    expect(calls).toEqual([])
  })
})

describe('Preferences — 알림·연결 유지 스위치', () => {
  function memory(initial?: string): PrefsStore & { raw: string | undefined } {
    const store = { raw: initial, load: async () => store.raw, save: async (raw: string) => void (store.raw = raw) }
    return store
  }

  it('기본값: 알림 켜짐, 연결 유지 꺼짐. 바꾸면 저장되고 다시 켜면 그대로다', async () => {
    const store = memory()
    const first = new Preferences(store)
    await first.restore()
    expect(first.value).toEqual({ notifications: true, keepAlive: false })
    const listener = vi.fn()
    first.subscribe(listener)
    first.set({ keepAlive: true })
    expect(listener).toHaveBeenCalledTimes(1)

    const again = new Preferences(store)
    await again.restore()
    expect(again.value).toEqual({ notifications: true, keepAlive: true })
  })

  it('깨진 저장·모르는 값은 기본값으로', async () => {
    for (const raw of ['{not json', '{"notifications":"yes","keepAlive":1}', 'null']) {
      const prefs = new Preferences(memory(raw))
      await prefs.restore()
      expect(prefs.value, raw).toEqual(DEFAULT_PREFS)
    }
  })
})
