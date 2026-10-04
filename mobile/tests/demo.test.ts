import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSession } from '../src/app/session.ts'
import { ago, rowView, runningSubtasks, statusBanner, turnHead, turnLines, turnStartedAt, turnTexts } from '../src/app/view.ts'
import { createDemoSession, DEMO_CHAT, DEMO_PROJECT, DEMO_RECONNECT_MS, DEMO_STEP_MS } from './demoSession.ts'

// 견본 세션이 리듀서 상태를 기대대로 만드는지 — 화면은 이 상태를 그리기만 한다 (화면 렌더 테스트는 없다).

let session: AppSession
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-04T09:00:00Z'))
  session = createDemoSession()
})
afterEach(() => {
  session.dispose()
  vi.useRealTimers()
})

const chat = (cid = DEMO_CHAT) => session.getState().views[cid]!
const rows = () => {
  const state = session.getState()
  return state.conversations[DEMO_PROJECT.path]!.map((conversation) => ({ ...rowView(conversation, state.notices[conversation.id]?.status, state.views[conversation.id]), time: ago(conversation.updatedAt, Date.now()) }))
}
/** 걸음 n 개만큼 시간을 보낸다 */
const steps = (count: number) => vi.advanceTimersByTimeAsync(count * DEMO_STEP_MS)
const permission = () => chat().attention[0]!

describe('견본의 처음 모습 (시안)', () => {
  it('목록 — 대화 5개가 시안의 상태·글·시각으로 나온다', () => {
    expect(rows()).toEqual([
      { dot: 'attention', title: '배포 스크립트 정리', subtitle: '답 필요 · 명령 실행 승인', time: '지금' },
      { dot: 'running', title: '로그인 인증 리팩터링', subtitle: '진행 중 · 하위 작업 2', time: '12초' },
      { dot: 'unread', title: '결제 API 문서 정리', subtitle: '완료 · 엔드포인트 12개를 표로 정리했습니다', time: '2분' },
      { dot: 'none', title: '테스트 실패 원인 찾기', subtitle: '시간대 변환에서 하루가 밀립니다', time: '어제' },
      { dot: 'none', title: 'README 다듬기', subtitle: '설치 절차를 세 단계로 줄였습니다', time: '3일' },
    ])
  })

  it('대화 — 내 말, 진행 줄, 글, 승인 카드, 대기 1', () => {
    const view = chat()
    expect(view.messages).toMatchObject([{ role: 'user', text: '배포 스크립트에서 테스트를 먼저 돌리게 바꿔 줘.' }])
    expect(view.running).toBe(true)
    expect(turnHead('진행 중', Date.now() - turnStartedAt(view)!, view.progress)).toBe('진행 중 · 18초 · 생각 1 · 도구 3')
    expect(turnLines(view.progress).map((line) => line.text)).toEqual(['생각 · 테스트 단계를 빌드 앞에 둔다', 'read scripts/deploy.sh', 'edit scripts/deploy.sh +4 −1'])
    expect(turnTexts(view.progress).map((text) => text.text)).toEqual(['스크립트를 고쳤습니다. 바뀐 순서가 맞는지 테스트를 한 번 돌려 확인하겠습니다.'])
    expect(view.attention).toMatchObject([{ kind: 'permission', action: 'bash', resources: ['npm test -- --run'] }])
    expect(view.queue).toEqual(['그리고 README 도 맞춰 줘'])
    expect(runningSubtasks(view.progress)).toBe(2)
  })

  it('연결 띠 — "다시 연결 중 · 3초" 로 시작해 3초 뒤 붙는다', async () => {
    expect(statusBanner(session.getStatus(), Date.now())).toBe('다시 연결 중 · 3초')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(statusBanner(session.getStatus(), Date.now())).toBe('다시 연결 중 · 2초')
    await vi.advanceTimersByTimeAsync(DEMO_RECONNECT_MS)
    expect(session.getStatus()).toEqual({ kind: 'connected' })
    expect(statusBanner(session.getStatus(), Date.now())).toBeUndefined()
  })
})

describe('견본의 살아 있는 동작', () => {
  it('한 번 허용 → 카드가 사라지고 턴이 이어져 답이 붙는다. 끝나면 대기 글이 다음 턴으로 간다', async () => {
    session.reply(permission(), 'once')
    expect(chat().attention).toEqual([])
    expect(chat().running).toBe(true)
    expect(rows()[0]).toMatchObject({ dot: 'running', title: '배포 스크립트 정리' })

    await steps(2)
    expect(turnLines(chat().progress).map((line) => line.text)).toContain('bash npm test -- --run')
    await steps(4)

    // 턴이 끝나 답이 말풍선이 됐고, 대기하던 글이 바로 다음 턴으로 시작됐다
    expect(chat().messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
    expect(chat().messages[1]).toMatchObject({ text: expect.stringContaining('테스트 14개가 모두 통과했습니다') })
    expect(chat().messages[1]!.text).toContain('스크립트를 고쳤습니다')
    expect(chat().messages[2]).toMatchObject({ text: '그리고 README 도 맞춰 줘' })
    expect(chat().queue).toEqual([])
    expect(chat().running).toBe(true)

    await steps(5)
    expect(chat().running).toBe(false)
    expect(chat().messages.at(-1)).toMatchObject({ role: 'assistant', text: 'echo: 그리고 README 도 맞춰 줘' })
    expect(rows()[0]).toMatchObject({ dot: 'unread', subtitle: '완료 · echo: 그리고 README 도 맞춰 줘' })
  })

  it('거절 → 카드가 사라지고 턴이 도구를 돌리지 않고 "거절됨" 으로 끝난다', async () => {
    session.reply(permission(), 'reject')
    expect(chat().attention).toEqual([])
    const answer = chat().messages[1]!
    expect(answer).toMatchObject({ role: 'assistant', declined: true, text: '스크립트를 고쳤습니다. 바뀐 순서가 맞는지 테스트를 한 번 돌려 확인하겠습니다.' })
    expect(answer.items!.find((item) => item.id === 'd_bash')).toMatchObject({ status: 'error' })
  })

  it('같은 승인에 두 번 답해도 한 번만 먹는다', async () => {
    const request = permission()
    session.reply(request, 'once')
    session.reply(request, 'reject')
    await steps(6)
    expect(chat().messages[1]).not.toMatchObject({ declined: true })
  })

  it('보내기 → 내 말이 붙고 잠시 뒤 "echo: …" 답이 온다', async () => {
    session.send('c_tests', '안녕')
    expect(chat('c_tests').messages.at(-1)).toMatchObject({ role: 'user', text: '안녕' })
    expect(chat('c_tests').running).toBe(true)

    await steps(3)
    expect(turnTexts(chat('c_tests').progress)).toMatchObject([{ text: 'echo' }])
    await steps(2)
    expect(chat('c_tests').running).toBe(false)
    expect(chat('c_tests').messages.at(-1)).toMatchObject({ role: 'assistant', text: 'echo: 안녕' })
    expect(rows()[0]).toMatchObject({ title: '테스트 실패 원인 찾기', dot: 'unread' })
  })

  it('턴 중에 보낸 글은 대기열에 쌓인다', () => {
    session.send(DEMO_CHAT, '하나 더')
    expect(chat().queue).toEqual(['그리고 README 도 맞춰 줘', '하나 더'])
    expect(chat().messages).toHaveLength(1)
  })

  it('되돌리기 → 대기 글을 돌려주고 비운다. 그 글은 턴이 되지 않는다', async () => {
    expect(await session.takeQueue(DEMO_CHAT)).toBe('그리고 README 도 맞춰 줘')
    expect(chat().queue).toEqual([])

    session.reply(permission(), 'once')
    await steps(12)
    expect(chat().running).toBe(false)
    expect(chat().messages.map((message) => message.role)).toEqual(['user', 'assistant'])
  })

  it('중지 → 그 턴이 "중단됨" 으로 끝나고 승인 카드도 사라진다. 대기 글은 보내지 않고 남는다', async () => {
    session.stop(DEMO_CHAT)
    expect(chat()).toMatchObject({ running: false, attention: [], progress: [], queue: ['그리고 README 도 맞춰 줘'] })
    expect(chat().messages.at(-1)).toMatchObject({ role: 'assistant', interrupted: true })
    await steps(10)
    expect(chat().messages).toHaveLength(2)
    expect(rows()[0]).toMatchObject({ title: '배포 스크립트 정리', subtitle: expect.stringContaining('중단됨') })
  })

  it('새 대화 → 목록 맨 위에 생기고, 첫 글이 제목이 된다', async () => {
    await vi.advanceTimersByTimeAsync(1_000)
    const cid = (await session.createConversation(DEMO_PROJECT.path))!
    expect(chat(cid)).toMatchObject({ messages: [], running: false })
    session.send(cid, '새로 시작')
    expect(rows()[0]).toMatchObject({ title: '새로 시작', dot: 'running' })
  })

  it('상태가 바뀔 때마다 구독자를 부르고, 그만 들으면 안 부른다', () => {
    const listener = vi.fn()
    const unsubscribe = session.subscribe(listener)
    session.send('c_tests', '안녕')
    expect(listener).toHaveBeenCalled()
    unsubscribe()
    listener.mockClear()
    session.stop('c_tests')
    expect(listener).not.toHaveBeenCalled()
  })
})
