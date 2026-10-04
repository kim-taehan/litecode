import { describe, expect, it } from 'vitest'
import { delegationCard, delegationLine, peerOf, runningOrigin, sidebarMark, type Peer } from '../../renderer/delegationView.ts'
import type { Attention, HistoryMessage, TurnItem } from '../../shared/contract.ts'

// 다른 대화에 지시 보내기의 화면 모양 (이슈 #55) — 보낸 줄의 상태 글, 승인 카드 내용, 사이드바 표시

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const peers = (b: Partial<Peer> = {}): Peer[] => [
  { id: A, title: '릴리스 준비', mode: 'build', running: true },
  { id: B, title: '테스트 실패 고치기', mode: 'ask', running: false, ...b },
]
const tool = (name: string, patch: Partial<Extract<TurnItem, { kind: 'tool' }>>): TurnItem => ({
  kind: 'tool',
  id: `m:${name}`,
  name: `litecode_${name}`,
  status: 'done',
  mcp: { server: 'litecode', tool: name },
  ...patch,
})
const SEND_INPUT = JSON.stringify({ session: 'c-bbbbbbbb', message: '고쳐 줘' })

describe('보낸 줄 — "지시 보냄 → 제목 · 상태"', () => {
  it('받는 대화의 지금 상태를 따라간다: 도는 중(시작 시각) → 완료 / 실패 / 중단됨', () => {
    const item = tool('send_to_session', { input: SEND_INPUT, result: 'Accepted. "테스트 실패 고치기" (c-bbbbbbbb) started working on it.' })
    expect(delegationLine(item, peers({ running: true, startedAt: 5_000 }))).toEqual({ kind: 'sent', title: '테스트 실패 고치기', targetId: B, state: 'running', startedAt: 5_000 })
    expect(delegationLine(item, peers())).toEqual({ kind: 'sent', title: '테스트 실패 고치기', targetId: B, state: 'done' })
    expect(delegationLine(item, peers({ outcome: 'failed' }))).toMatchObject({ state: 'failed' })
    expect(delegationLine(item, peers({ outcome: 'interrupted' }))).toMatchObject({ state: 'interrupted' })
  })

  it('제목은 받는 대화의 지금 제목 — 지워졌으면 결과 글에 적힌 제목으로, 누를 곳은 없다', () => {
    const item = tool('send_to_session', { input: SEND_INPUT, result: 'Accepted and queued — "옛 "제목"" (c-bbbbbbbb) is busy (1 ahead).' })
    expect(delegationLine(item, peers({ title: '바뀐 제목' }))).toMatchObject({ title: '바뀐 제목', targetId: B })
    expect(delegationLine(item, [peers()[0]!])).toEqual({ kind: 'sent', title: '옛 "제목"', state: 'gone' })
  })

  it('승인을 기다리는 중·거절(오류)로 못 보냄', () => {
    expect(delegationLine(tool('send_to_session', { status: 'running', input: SEND_INPUT }), peers())).toMatchObject({ title: '테스트 실패 고치기', targetId: B, state: 'asking' })
    expect(delegationLine(tool('send_to_session', { status: 'error', input: SEND_INPUT, error: 'The user rejected permission' }), peers())).toMatchObject({ state: 'notSent' })
    expect(delegationLine(tool('send_to_session', { status: 'preparing' }), peers())).toEqual({ kind: 'sent', title: '', state: 'asking' })
  })

  it('새 대화(start_session) — 대상 id 는 결과 글에서. 허용 전에는 인자의 제목으로', () => {
    const input = JSON.stringify({ title: 'README 정리', message: '고쳐 줘' })
    expect(delegationLine(tool('start_session', { status: 'running', input }), peers())).toEqual({ kind: 'sent', title: 'README 정리', state: 'asking' })
    const done = tool('start_session', { input, result: 'Started "README 정리" (c-bbbbbbbb). Use read_session to collect the result.' })
    expect(delegationLine(done, peers({ title: 'README 정리', running: true }))).toMatchObject({ kind: 'sent', title: 'README 정리', targetId: B, state: 'running' })
  })

  it('보통의 도구·다른 MCP 서버·앱 MCP 의 다른 도구는 이 줄이 아니다', () => {
    expect(delegationLine({ kind: 'tool', id: 'x', name: 'bash', status: 'done' }, peers())).toBeUndefined()
    expect(delegationLine(tool('open_file', {}), peers())).toBeUndefined()
    expect(delegationLine(tool('list_sessions', {}), peers())).toBeUndefined()
    expect(delegationLine({ ...tool('send_to_session', {}), mcp: { server: 'other', tool: 'send_to_session' } } as TurnItem, peers())).toBeUndefined()
    expect(delegationLine({ kind: 'think', id: 't', text: '', done: true }, peers())).toBeUndefined()
  })
})

describe('읽기 줄 — "결과 읽기 · 제목 · 상태"', () => {
  const input = JSON.stringify({ session: 'c-bbbbbbbb', wait_seconds: 30 })
  it('읽는 중 → 아직 도는 중 / 답 필요 / 읽음 / 못 읽음', () => {
    expect(delegationLine(tool('read_session', { status: 'running', input }), peers())).toEqual({ kind: 'read', title: '테스트 실패 고치기', targetId: B, state: 'reading' })
    expect(delegationLine(tool('read_session', { input, result: 'state: running — call again later' }), peers())).toMatchObject({ state: 'running' })
    expect(delegationLine(tool('read_session', { input, result: 'state: waiting for the user — …' }), peers())).toMatchObject({ state: 'waiting' })
    expect(delegationLine(tool('read_session', { input, result: 'state: idle\nuser: a\nanswer: b' }), peers())).toMatchObject({ state: 'read' })
    expect(delegationLine(tool('read_session', { status: 'error', input, error: 'Unknown session.' }), peers())).toMatchObject({ state: 'failed' })
  })

  it('모르는 id 면 그 id 를 그대로 보인다', () => {
    expect(delegationLine(tool('read_session', { status: 'error', input: JSON.stringify({ session: 'c-zzzz' }) }), peers())).toEqual({ kind: 'read', title: 'c-zzzz', state: 'failed' })
  })
})

describe('승인 카드 내용', () => {
  const request = (name: string, input?: unknown): Extract<Attention, { kind: 'permission' }> => ({
    kind: 'permission',
    id: 'per_1',
    sessionId: 'ses_1',
    action: `litecode_${name}`,
    resources: ['*'],
    mcp: { server: 'litecode', tool: name },
    ...(input !== undefined && { input: JSON.stringify(input) }),
  })
  const self = { mode: 'build' as const, model: 'Devstral 24B' }

  it('보내기 — 받는 대화의 제목·모드·도는 중인지와 보낼 글 전문', () => {
    const message = '깨진 테스트를 전부 고치고\n결과를 알려 줘'
    expect(delegationCard(request('send_to_session', { session: 'c-bbbbbbbb', message }), peers(), self)).toEqual({
      kind: 'send', title: '테스트 실패 고치기', message, unknown: false, busy: false, mode: 'ask', wider: false,
    })
    expect(delegationCard(request('send_to_session', { session: 'c-bbbbbbbb', message }), peers({ running: true }), self)).toMatchObject({ busy: true })
  })

  it('받는 대화의 모드가 이 대화보다 권한이 넓으면 경고 — 같거나 좁으면 아니다', () => {
    const input = { session: 'c-bbbbbbbb', message: 'x' }
    expect(delegationCard(request('send_to_session', input), peers({ mode: 'full' }), self)).toMatchObject({ mode: 'full', wider: true })
    expect(delegationCard(request('send_to_session', input), peers({ mode: 'build' }), self)).toMatchObject({ wider: false })
    expect(delegationCard(request('send_to_session', input), peers({ mode: 'build' }), { mode: 'ask' })).toMatchObject({ wider: true })
    expect(delegationCard(request('send_to_session', input), peers({ mode: undefined }), self)).toMatchObject({ wider: false })
  })

  it('없는 대화로 보내려 하면 그렇다고 보인다 (허용해도 보내지지 않는다)', () => {
    expect(delegationCard(request('send_to_session', { session: 'c-zzzzzzzz', message: 'x' }), peers(), self)).toEqual({
      kind: 'send', title: 'c-zzzzzzzz', message: 'x', unknown: true, busy: false, wider: false,
    })
  })

  it('새 대화 — 제목과 물려받는 모드·모델', () => {
    expect(delegationCard(request('start_session', { title: 'README 정리', message: 'x' }), peers(), self)).toEqual({ kind: 'start', title: 'README 정리', message: 'x', mode: 'build', model: 'Devstral 24B' })
  })

  it('인자를 못 이었거나 다른 도구·다른 서버면 보통의 승인 카드로', () => {
    expect(delegationCard(request('send_to_session'), peers(), self)).toBeUndefined()
    expect(delegationCard(request('open_terminal', { command: 'ls' }), peers(), self)).toBeUndefined()
    expect(delegationCard({ ...request('send_to_session', {}), mcp: { server: 'other', tool: 'send_to_session' } }, peers(), self)).toBeUndefined()
    expect(delegationCard({ kind: 'permission', id: 'p', sessionId: 's', action: 'bash', resources: ['ls'] }, peers(), self)).toBeUndefined()
  })
})

describe('사이드바 표시·대화 상태', () => {
  const origin = { conversationId: A, title: '릴리스 준비' }
  const asked: HistoryMessage = { role: 'user', text: '지시', origin }
  const typed: HistoryMessage = { role: 'user', text: '사람 글' }

  it('다른 대화가 시킨 일을 하는 중 — 도는 턴의 내 말에 출처가 있을 때만. 끝나면 사라진다', () => {
    expect(runningOrigin({ pending: true, messages: [typed, { role: 'assistant', text: 'a' }, asked] })).toEqual(origin)
    expect(sidebarMark({ id: B, pending: true, messages: [asked] }, new Set())).toBe('delegated')
    expect(sidebarMark({ id: B, pending: false, messages: [asked, { role: 'assistant', text: 'a' }] }, new Set())).toBeUndefined()
    expect(sidebarMark({ id: B, pending: true, messages: [asked, { role: 'assistant', text: 'a' }, typed] }, new Set())).toBeUndefined()
  })

  it('지시로 새로 생긴 대화는 "새로 생김" 이 먼저다 — 열어서 목록에서 빠지면 도는 중 표시로', () => {
    expect(sidebarMark({ id: B, pending: true, messages: [asked] }, new Set([B]))).toBe('fresh')
    expect(sidebarMark({ id: B, pending: false, messages: [] }, new Set([B]))).toBe('fresh')
    expect(sidebarMark({ id: B, pending: true, messages: [asked] }, new Set([A]))).toBe('delegated')
  })

  it('대화 → 상태: 도는 중이면 시작 시각, 쉬면 마지막 턴의 실패·중단 (알림 상태가 먼저 — 기록을 안 연 대화도 안다)', () => {
    const base = { id: B, title: '제목', mode: 'ask' as const }
    expect(peerOf({ ...base, pending: true, sentAt: 7, messages: [] })).toEqual({ id: B, title: '제목', mode: 'ask', running: true, startedAt: 7 })
    expect(peerOf({ ...base, messages: [typed, { role: 'assistant', text: '', error: 'boom' }] })).toMatchObject({ running: false, outcome: 'failed' })
    expect(peerOf({ ...base, messages: [typed, { role: 'assistant', text: '', error: '중단됨', interrupted: true }] })).toMatchObject({ outcome: 'interrupted' })
    expect(peerOf({ ...base, messages: [] }, 'failed')).toMatchObject({ outcome: 'failed' })
    expect(peerOf({ ...base, messages: [typed, { role: 'assistant', text: 'ok' }] }, 'done').outcome).toBeUndefined()
    expect(peerOf({ ...base, pending: true, messages: [] }, 'failed').outcome).toBeUndefined() // 다시 돌고 있다
  })
})
