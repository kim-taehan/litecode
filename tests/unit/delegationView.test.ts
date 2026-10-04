import { describe, expect, it } from 'vitest'
import { delegationLine, peerOf, runningOrigin, sidebarMark, targetPicker, type Peer } from '../../renderer/delegationView.ts'
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

  // 이슈 #67 — 사용자가 승인 카드에서 다른 대화를 골랐으면 줄은 도구 인자(AI 가 고른 것)가 아니라 결과 글의 실제 대상을 가리킨다
  it('받을 대화가 바뀌었으면 실제 대상을 가리킨다 — 기존 → 다른 기존, 기존 → 새 대화, 새 대화 → 기존. 다시 열어도 같다(결과 글에서 읽는다)', () => {
    const three: Peer[] = [...peers(), { id: 'cccccccc-0000-4000-8000-000000000003', title: '문서 정리', mode: 'full', running: true, startedAt: 9 }]
    const C = three[2]!.id
    const redirected = tool('send_to_session', { input: SEND_INPUT, result: 'Accepted. The user chose a different conversation: "문서 정리" (id c-cccccccc). Use this id with read_session.' })
    expect(delegationLine(redirected, three)).toEqual({ kind: 'sent', title: '문서 정리', targetId: C, state: 'running', startedAt: 9 })
    const queued = tool('send_to_session', { input: SEND_INPUT, result: 'Accepted. The user chose a different conversation: "문서 정리" (id c-cccccccc). It is busy, so the instruction is queued (1 ahead). Use this id with read_session.' })
    expect(delegationLine(queued, three)).toMatchObject({ title: '문서 정리', targetId: C })
    const toNew = tool('send_to_session', { input: SEND_INPUT, result: 'Accepted. The user chose to start a new conversation instead: "문서 정리" (id c-cccccccc). Use this id with read_session.' })
    expect(delegationLine(toNew, three)).toMatchObject({ title: '문서 정리', targetId: C })
    const toExisting = tool('start_session', { input: JSON.stringify({ title: 'README 정리', message: 'x' }), result: 'Accepted. The user chose a different conversation: "테스트 실패 고치기" (id c-bbbbbbbb). Use this id with read_session.' })
    expect(delegationLine(toExisting, three)).toEqual({ kind: 'sent', title: '테스트 실패 고치기', targetId: B, state: 'done' })
    // 승인을 기다리는 동안에는 아직 AI 가 고른 대상이다
    expect(delegationLine(tool('send_to_session', { status: 'running', input: SEND_INPUT }), three)).toMatchObject({ targetId: B, state: 'asking' })
    // 바뀐 대상이 지워졌으면 결과 글의 제목으로
    expect(delegationLine(redirected, peers())).toEqual({ kind: 'sent', title: '문서 정리', state: 'gone' })
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

// 이슈 #67 — 받을 대화는 사용자가 고른다. 승인 카드의 목록: 같은 프로젝트의 대화(자신·못 쓰는 대화 제외, 최근 활동 순) + 맨 아래 새 대화
describe('승인 카드 — 받을 대화 목록', () => {
  const C = 'cccccccc-0000-4000-8000-000000000003'
  const D = 'dddddddd-0000-4000-8000-000000000004'
  const request = (name: string, input?: unknown): Extract<Attention, { kind: 'permission' }> => ({
    kind: 'permission',
    id: 'per_1',
    sessionId: 'ses_1',
    action: `litecode_${name}`,
    resources: ['*'],
    mcp: { server: 'litecode', tool: name },
    ...(input !== undefined && { input: JSON.stringify(input) }),
  })
  const self = { id: A, mode: 'build' as const }
  const all: Peer[] = [
    { id: A, title: '릴리스 준비', mode: 'build', running: true, updatedAt: 900 },
    { id: B, title: '테스트 실패 고치기', mode: 'ask', running: false, updatedAt: 100 },
    { id: C, title: '로그인 리팩터링', mode: 'build', running: true, updatedAt: 300 },
    { id: D, title: '결제 문서', mode: 'full', running: false, updatedAt: 200 },
  ]

  it('보낸 대화 자신은 빼고 최근 활동 순, 맨 아래 새 대화. AI 가 고른 대화가 표시되고 먼저 선택된다', () => {
    const picker = targetPicker(request('send_to_session', { session: 'c-bbbbbbbb', message: '고쳐 줘\n전부' }), all, self)!
    expect(picker.kind).toBe('send')
    expect(picker.message).toBe('고쳐 줘\n전부')
    expect(picker.choices.map((choice) => choice.key)).toEqual([C, D, B, 'new'])
    expect(picker.choices.filter((choice) => choice.byAi).map((choice) => choice.key)).toEqual([B])
    expect(picker.initial).toBe(B)
    expect(picker.missing).toBeUndefined()
    expect(picker.choices[2]).toEqual({ key: B, target: { kind: 'conversation', conversationId: B }, title: '테스트 실패 고치기', byAi: true, mode: 'ask', wider: false, busy: false })
    expect(picker.choices.at(-1)).toEqual({ key: 'new', target: { kind: 'new' }, title: '', byAi: false, mode: 'build', wider: false, busy: false })
  })

  it('줄마다 모드 경고(이 대화보다 권한이 넓다)와 도는 중(대기열에 들어간다)', () => {
    const picker = targetPicker(request('send_to_session', { session: 'c-bbbbbbbb', message: 'x' }), all, self)!
    const row = (id: string) => picker.choices.find((choice) => choice.key === id)!
    expect(row(D)).toMatchObject({ mode: 'full', wider: true, busy: false })
    expect(row(C)).toMatchObject({ mode: 'build', wider: false, busy: true })
    // 보낸 쪽이 매번 묻기면 기본 모드 대화도 넓다
    const fromAsk = targetPicker(request('send_to_session', { session: 'c-bbbbbbbb', message: 'x' }), all, { id: A, mode: 'ask' })!
    expect(fromAsk.choices.filter((choice) => choice.wider).map((choice) => choice.key)).toEqual([C, D])
  })

  it('새 대화(start_session) — "새 대화" 줄이 AI 가 고른 것으로 먼저 선택되고 AI 가 준 제목이 실린다. 기존 대화로 바꿀 수 있게 목록도 있다', () => {
    const picker = targetPicker(request('start_session', { title: 'README 정리', message: 'x' }), all, self)!
    expect(picker.kind).toBe('start')
    expect(picker.initial).toBe('new')
    expect(picker.choices.at(-1)).toMatchObject({ key: 'new', title: 'README 정리', byAi: true })
    expect(picker.choices.slice(0, -1).map((choice) => [choice.key, choice.byAi])).toEqual([[C, false], [D, false], [B, false]])
  })

  it('지시를 받을 수 없는 대화(모델·폴더 없음)는 목록에 없다 — 짧은 id 는 그래도 전체 묶음으로 푼다', () => {
    const peers = all.map((peer) => (peer.id === D ? { ...peer, unusable: true as const } : peer))
    const picker = targetPicker(request('send_to_session', { session: 'c-bbbbbbbb', message: 'x' }), peers, self)!
    expect(picker.choices.map((choice) => choice.key)).toEqual([C, B, 'new'])
    expect(picker.initial).toBe(B)
  })

  it('AI 가 고른 대화가 목록에 없으면(없는 id·자기 자신·못 쓰는 대화) 아무것도 선택돼 있지 않다 — 사용자가 골라야 한다', () => {
    const unknown = targetPicker(request('send_to_session', { session: 'c-zzzzzzzz', message: 'x' }), all, self)!
    expect(unknown.initial).toBeUndefined()
    expect(unknown.missing).toBe('c-zzzzzzzz')
    expect(unknown.choices.every((choice) => !choice.byAi)).toBe(true)
    const itself = targetPicker(request('send_to_session', { session: 'c-aaaaaaaa', message: 'x' }), all, self)!
    expect(itself).toMatchObject({ missing: 'c-aaaaaaaa' })
    expect(itself.initial).toBeUndefined()
  })

  it('다른 대화가 하나도 없어도 새 대화 줄은 있다', () => {
    const picker = targetPicker(request('send_to_session', { session: 'c-bbbbbbbb', message: 'x' }), [all[0]!], self)!
    expect(picker.choices.map((choice) => choice.key)).toEqual(['new'])
    expect(picker.missing).toBe('c-bbbbbbbb')
  })

  it('인자를 못 이었거나 다른 도구·다른 서버면 보통의 승인 카드로', () => {
    expect(targetPicker(request('send_to_session'), all, self)).toBeUndefined()
    expect(targetPicker(request('open_terminal', { command: 'ls' }), all, self)).toBeUndefined()
    expect(targetPicker(request('read_session', { session: 'c-bbbbbbbb' }), all, self)).toBeUndefined()
    expect(targetPicker({ ...request('send_to_session', {}), mcp: { server: 'other', tool: 'send_to_session' } }, all, self)).toBeUndefined()
    expect(targetPicker({ kind: 'permission', id: 'p', sessionId: 's', action: 'bash', resources: ['ls'] }, all, self)).toBeUndefined()
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
    // 받을 대화 목록이 쓰는 것 — 마지막 활동 시각, 지시를 받을 수 있는지
    expect(peerOf({ ...base, updatedAt: 42, messages: [] })).toEqual({ id: B, title: '제목', mode: 'ask', running: false, updatedAt: 42 })
    expect(peerOf({ ...base, messages: [] }, undefined, false)).toMatchObject({ unusable: true })
  })
})
