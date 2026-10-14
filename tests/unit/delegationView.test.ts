import { describe, expect, it } from 'vitest'
import { PICK_CONVERSATION_LIMIT, delegationLine, peerOf, projectTargets, readRequest, runningOrigin, sidebarMark, targetPicker, type Peer, type ProjectTarget } from '../../renderer/delegationView.ts'
import { projectId } from '../../shared/delegation.ts'
import type { Attention, HistoryMessage, TurnItem } from '../../shared/contract.ts'

// 다른 프로젝트에 지시 보내기의 화면 모양 (이슈 #55·#137) — 받을 곳(다른 프로젝트마다 마지막에 보던 대화), 보낸 줄의 상태 글, 승인 카드 내용, 사이드바 표시

const WEB = '/work/shop-web'
const BACK = '/work/order-backend'
const TOKENS = '/work/design-tokens'
/** 보내는 대화 (shop-web) */
const A = 'aaaaaaaa-0000-4000-8000-000000000001'
/** order-backend 의 대화 둘 */
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const D = 'dddddddd-0000-4000-8000-000000000004'
/** design-tokens 의 대화 */
const C = 'cccccccc-0000-4000-8000-000000000003'
const PROJECTS = [
  { path: WEB, name: 'shop-web', displayPath: '~/work/shop-web' },
  { path: BACK, name: 'order-backend', displayPath: '~/work/order-backend' },
  { path: TOKENS, name: 'design-tokens', displayPath: '~/work/design-tokens' },
]
const VIEWED = { [WEB]: A, [BACK]: B, [TOKENS]: C }
const peers = (b: Partial<Peer> = {}, c: Partial<Peer> = {}, list: Peer[] = []): Peer[] => [
  { id: A, project: WEB, title: '주문 화면', mode: 'build', running: true, updatedAt: 10 },
  { id: B, project: BACK, title: '주문 API 설계', mode: 'ask', running: false, updatedAt: 50, ...b },
  { id: D, project: BACK, title: '배포 스크립트', mode: 'build', running: false, updatedAt: 90 },
  { id: C, project: TOKENS, title: '색 토큰 이름 정리', mode: 'full', running: false, updatedAt: 80, ...c },
  ...list,
]
const targetsOf = (list: readonly Peer[], viewed: Record<string, string> = VIEWED): ProjectTarget[] => projectTargets(PROJECTS, viewed, list)
const BACK_ID = projectId(BACK)
const TOKENS_ID = projectId(TOKENS)
const tool = (name: string, patch: Partial<Extract<TurnItem, { kind: 'tool' }>>): TurnItem => ({
  kind: 'tool',
  id: `m:${name}`,
  name: `litecode_${name}`,
  status: 'done',
  mcp: { server: 'litecode', tool: name },
  ...patch,
})
const SEND_INPUT = JSON.stringify({ project: BACK_ID, message: '정리해 줘' })
const line = (item: TurnItem, list: readonly Peer[] = peers(), viewed?: Record<string, string>) => delegationLine(item, targetsOf(list, viewed), list)

const WEB_ID = projectId(WEB)

describe('받을 곳 — 프로젝트마다 마지막에 보던 대화 하나', () => {
  it('프로젝트 목록 순서대로 그 프로젝트의 마지막에 보던 대화가 붙는다 — 지금 프로젝트도 포함(#351, 카드의 "이 프로젝트" 그룹)', () => {
    expect(targetsOf(peers()).map((target) => [target.id, target.name, target.displayPath, target.peer.id])).toEqual([
      [WEB_ID, 'shop-web', '~/work/shop-web', A],
      [BACK_ID, 'order-backend', '~/work/order-backend', B],
      [TOKENS_ID, 'design-tokens', '~/work/design-tokens', C],
    ])
    // (메인 세션 도구의 목록·읽기는 자기 프로젝트 제외를 스스로 한다 — renderer 는 하나만 계산한다)
  })

  it('본 대화가 없는 프로젝트·마지막에 보던 대화가 지워진 프로젝트는 없다 — 그 프로젝트의 다른 대화로 대신하지 않는다', () => {
    expect(targetsOf(peers(), { [BACK]: B }).map((target) => target.name)).toEqual(['order-backend'])
    const withoutB = peers().filter((peer) => peer.id !== B) // D 는 남아 있다 (A · C 는 그대로 — 본 프로젝트도 포함, #351)
    expect(targetsOf(withoutB).map((target) => target.name)).toEqual(['shop-web', 'design-tokens'])
    // 적힌 id 가 다른 프로젝트의 대화면 쓰지 않는다
    expect(targetsOf(peers(), { [BACK]: C })).toEqual([])
    // 목록에서 뺀 프로젝트
    expect(projectTargets([PROJECTS[0]!, PROJECTS[2]!], VIEWED, peers()).map((target) => target.name)).toEqual(['shop-web', 'design-tokens'])
  })
})

describe('보낸 줄 — "지시 보냄 → 프로젝트 · 대화 · 상태"', () => {
  const SENT = `Accepted. "order-backend" (${BACK_ID}) started working on it in its conversation "주문 API 설계" (c-bbbbbbbb).`

  it('받는 대화의 지금 상태를 따라간다: 도는 중(시작 시각) → 완료 / 실패 / 중단됨', () => {
    const item = tool('send_to_project', { input: SEND_INPUT, result: SENT })
    expect(line(item, peers({ running: true, startedAt: 5_000 }))).toEqual({ kind: 'sent', title: 'order-backend · 주문 API 설계', targetId: B, state: 'running', startedAt: 5_000 })
    expect(line(item)).toEqual({ kind: 'sent', title: 'order-backend · 주문 API 설계', targetId: B, state: 'done' })
    expect(line(item, peers({ outcome: 'failed' }))).toMatchObject({ state: 'failed' })
    expect(line(item, peers({ outcome: 'interrupted' }))).toMatchObject({ state: 'interrupted' })
  })

  it('보낸 뒤 사용자가 그 프로젝트에서 다른 대화를 봐도 줄은 받은 대화(결과 글의 c-…)를 가리킨다', () => {
    const item = tool('send_to_project', { input: SEND_INPUT, result: SENT })
    expect(line(item, peers({ running: true }), { ...VIEWED, [BACK]: D })).toMatchObject({ title: 'order-backend · 주문 API 설계', targetId: B, state: 'running' })
  })

  it('제목은 받는 대화의 지금 제목 — 지워졌으면 결과 글에 적힌 제목으로, 누를 곳은 없다', () => {
    const item = tool('send_to_project', { input: SEND_INPUT, result: `Accepted and queued — "order-backend" (${BACK_ID}) is busy (1 ahead). It will run in its conversation "옛 "제목"" (c-bbbbbbbb).` })
    expect(line(item, peers({ title: '바뀐 제목' }))).toMatchObject({ title: 'order-backend · 바뀐 제목', targetId: B })
    expect(line(item, peers().filter((peer) => peer.id !== B))).toEqual({ kind: 'sent', title: 'order-backend · 옛 "제목"', state: 'gone' })
  })

  it('승인을 기다리는 중(AI 가 고른 프로젝트의 지금 받을 대화)·거절(오류)로 못 보냄', () => {
    expect(line(tool('send_to_project', { status: 'running', input: SEND_INPUT }))).toEqual({ kind: 'sent', title: 'order-backend · 주문 API 설계', targetId: B, state: 'asking' })
    expect(line(tool('send_to_project', { status: 'error', input: SEND_INPUT, error: 'The user rejected permission' }))).toMatchObject({ state: 'notSent' })
    expect(line(tool('send_to_project', { status: 'preparing' }))).toEqual({ kind: 'sent', title: '', state: 'asking' })
    // 모르는 프로젝트 id 면 그 id 를 그대로 보인다
    expect(line(tool('send_to_project', { status: 'error', input: JSON.stringify({ project: 'p-zzzz', message: 'x' }) }))).toEqual({ kind: 'sent', title: 'p-zzzz', state: 'notSent' })
  })

  // 이슈 #67 — 사용자가 승인 카드에서 다른 프로젝트를 골랐으면 줄은 도구 인자(AI 가 고른 것)가 아니라 결과 글의 실제 대상을 가리킨다
  it('받을 프로젝트가 바뀌었으면 실제 대상을 가리킨다. 다시 열어도 같다(결과 글에서 읽는다)', () => {
    const redirected = tool('send_to_project', {
      input: SEND_INPUT,
      result: `Accepted. The user chose a different project: "design-tokens" (id ${TOKENS_ID}). It runs in its conversation "색 토큰 이름 정리" (c-cccccccc). Use this project id with read_project.`,
    })
    expect(line(redirected, peers({}, { running: true, startedAt: 9 }))).toEqual({ kind: 'sent', title: 'design-tokens · 색 토큰 이름 정리', targetId: C, state: 'running', startedAt: 9 })
    const queued = tool('send_to_project', {
      input: SEND_INPUT,
      result: `Accepted. The user chose a different project: "design-tokens" (id ${TOKENS_ID}). It is busy, so the instruction is queued (1 ahead). It runs in its conversation "색 토큰 이름 정리" (c-cccccccc). Use this project id with read_project.`,
    })
    expect(line(queued)).toMatchObject({ title: 'design-tokens · 색 토큰 이름 정리', targetId: C })
    // 승인을 기다리는 동안에는 아직 AI 가 고른 대상이다
    expect(line(tool('send_to_project', { status: 'running', input: SEND_INPUT }))).toMatchObject({ targetId: B, state: 'asking' })
    // 바뀐 대상이 지워졌으면 결과 글의 이름·제목으로
    expect(line(redirected, peers().filter((peer) => peer.id !== C))).toEqual({ kind: 'sent', title: 'design-tokens · 색 토큰 이름 정리', state: 'gone' })
  })

  it('보통의 도구·다른 MCP 서버·앱 MCP 의 다른 도구·없앤 도구는 이 줄이 아니다', () => {
    expect(line({ kind: 'tool', id: 'x', name: 'bash', status: 'done' })).toBeUndefined()
    expect(line(tool('open_file', {}))).toBeUndefined()
    expect(line(tool('list_projects', {}))).toBeUndefined()
    expect(line(tool('start_session', { input: JSON.stringify({ title: 'x', message: 'y' }) }))).toBeUndefined()
    expect(line({ ...tool('send_to_project', {}), mcp: { server: 'other', tool: 'send_to_project' } } as TurnItem)).toBeUndefined()
    expect(line({ kind: 'think', id: 't', text: '', done: true })).toBeUndefined()
  })
})

describe('읽기 줄 — "결과 읽기 · 프로젝트 · 대화 · 상태"', () => {
  const input = JSON.stringify({ project: BACK_ID, wait_seconds: 30 })
  const HEAD = 'conversation: "주문 API 설계" (c-bbbbbbbb)'
  it('읽는 중 → 아직 도는 중 / 답 필요 / 읽음 / 못 읽음', () => {
    expect(line(tool('read_project', { status: 'running', input }))).toEqual({ kind: 'read', title: 'order-backend · 주문 API 설계', targetId: B, state: 'reading' })
    expect(line(tool('read_project', { input, result: `${HEAD}\nstate: running — call again later` }))).toMatchObject({ targetId: B, state: 'running' })
    expect(line(tool('read_project', { input, result: `${HEAD}\nstate: waiting for the user — …` }))).toMatchObject({ state: 'waiting' })
    expect(line(tool('read_project', { input, result: `${HEAD}\nstate: idle\nuser: a\nanswer: b` }))).toMatchObject({ title: 'order-backend · 주문 API 설계', state: 'read' })
    expect(line(tool('read_project', { status: 'error', input, error: 'Unknown project.' }))).toMatchObject({ state: 'failed' })
  })

  it('읽은 대화는 결과 글의 첫 줄에서 — 그 아래(다른 대화의 글)에 같은 모양이 있어도 속지 않는다', () => {
    const item = tool('read_project', { input, result: `${HEAD}\nstate: idle\nuser: a\nanswer: see conversation: "x" (c-cccccccc)` })
    expect(line(item)).toMatchObject({ title: 'order-backend · 주문 API 설계', targetId: B, state: 'read' })
  })

  it('모르는 id 면 그 id 를 그대로 보인다', () => {
    expect(line(tool('read_project', { status: 'error', input: JSON.stringify({ project: 'p-zzzz' }) }))).toEqual({ kind: 'read', title: 'p-zzzz', state: 'failed' })
  })
})

// 이슈 #67·#137 — 받을 프로젝트는 사용자가 고른다. 승인 카드의 목록 (시안 mock-cross-project):
// #348 — 프로젝트마다 그 **대화 목록**(최근 활동 순)이고 줄은 대화 단위다. AI 가 고른 프로젝트의 마지막에 보던 대화가 먼저 선택된다
describe('승인 카드 — 받을 프로젝트·대화 목록', () => {
  const request = (name: string, input?: unknown): Extract<Attention, { kind: 'permission' }> => ({
    kind: 'permission',
    id: 'per_1',
    sessionId: 'ses_1',
    action: `litecode_${name}`,
    resources: ['*'],
    mcp: { server: 'litecode', tool: name },
    ...(input !== undefined && { input: JSON.stringify(input) }),
  })
  /** 보내는 대화(A — shop-web)를 고른다 — 실제 카드는 지금 대화의 id 를 싣는다 (#351: 자기 자신은 받을 목록에서 빠진다) */
  const self = { mode: 'build' as const, id: A }
  const SEND = { project: BACK_ID, message: '정리해 줘\n전부' }
  const pickerOf = (list: Peer[] = peers(), viewed: Record<string, string> = VIEWED) => targetPicker(request('send_to_project', SEND), targetsOf(list, viewed), list, self)!

  it('프로젝트마다 "새 대화" 줄 + 그 대화(최근 활동 순) — 지금 보내는 대화(self.id) 자신은 제외. AI 가 고른 프로젝트의 마지막에 보던 대화가 먼저 선택', () => {
    const picker = pickerOf()
    expect(picker.message).toBe('정리해 줘\n전부')
    // shop-web: 지금 대화 A 는 빠져 "새 대화" 줄뿐. order-backend 는 D(90)·B(50) 순, design-tokens 는 C
    expect(picker.choices.map((choice) => choice.key)).toEqual([`new:${WEB_ID}`, `new:${BACK_ID}`, D, B, `new:${TOKENS_ID}`, C])
    expect(picker.initial).toBe(B)
    expect(picker.missing).toBeUndefined()
    // 새 대화 줄 — 대상은 프로젝트 id, 모드(= 그 프로젝트 마지막에 본 대화 것)를 이어 받고 도는 것이 아니다
    expect(picker.choices[1]).toEqual({
      key: `new:${BACK_ID}`,
      target: { kind: 'new-conversation', projectId: BACK_ID },
      project: { name: 'order-backend', displayPath: '~/work/order-backend' },
      projectId: BACK_ID,
      title: '',
      byAi: false,
      mode: 'ask',
      wider: false,
      busy: false,
      newConversation: true,
    })
    expect(picker.choices[2]).toEqual({
      key: D,
      target: { kind: 'conversation', conversationId: D },
      project: { name: 'order-backend', displayPath: '~/work/order-backend' },
      projectId: BACK_ID,
      title: '배포 스크립트',
      byAi: false,
      mode: 'build',
      wider: false,
      busy: false,
    })
    expect(picker.choices[3]).toMatchObject({ title: '주문 API 설계', byAi: true })
    // 다른 프로젝트의 마지막에 보던 대화는 "마지막에 본 대화" 로 표시된다
    expect(picker.choices[5]).toMatchObject({ project: { name: 'design-tokens' }, title: '색 토큰 이름 정리', byAi: false, lastViewed: true })
  })

  it('줄마다 모드 경고(이 대화보다 권한이 넓다)와 도는 중(대기열에 들어간다)', () => {
    const picker = pickerOf(peers({ running: true }))
    expect(picker.choices[1]).toMatchObject({ newConversation: true, mode: 'ask', wider: false, busy: false })
    expect(picker.choices[3]).toMatchObject({ mode: 'ask', wider: false, busy: true })
    expect(picker.choices[5]).toMatchObject({ mode: 'full', wider: true, busy: false })
    // 보낸 쪽이 계획이면 모든 줄의 모드가 넓다
    const fromPlan = targetPicker(request('send_to_project', SEND), targetsOf(peers()), peers(), { mode: 'plan', id: A })!
    expect(fromPlan.choices.map((choice) => choice.wider)).toEqual([true, true, true, true, true, true])
  })

  it('지시를 받을 수 없는 대화(모델·폴더 없음)만 빠진다 — 같은 프로젝트의 다른 대화가 남아 있으면 그걸로 프로젝트를 보여 준다', () => {
    const picker = pickerOf(peers({ unusable: true }))
    expect(picker.choices.map((choice) => choice.key)).toEqual([`new:${WEB_ID}`, `new:${BACK_ID}`, D, `new:${TOKENS_ID}`, C])
    expect(picker.choices.map((choice) => choice.project.name)).toEqual(['shop-web', 'order-backend', 'order-backend', 'design-tokens', 'design-tokens'])
    // B(마지막에 본 대화) 가 못 쓰면 새 대화 줄도 쓸 수 있는 대화(D) 의 모드를 잇는다
    expect(picker.choices[1]).toMatchObject({ newConversation: true, mode: 'build' })
    // 본 대화가 쓸 수 있으면 그 모드를 잇는다
    expect(pickerOf(peers()).choices[1]).toMatchObject({ newConversation: true, mode: 'ask' })
    // 마지막에 보던 대화(B) 가 못 쓰면 다른 대화(D) 가 프로젝트 줄을 보여 준다
    const viewedD = pickerOf(peers({ unusable: true }), { ...VIEWED, [BACK]: D })
    expect(viewedD.initial).toBe(D)
  })

  it('프로젝트의 대화가 상한(PICK_CONVERSATION_LIMIT)을 넘으면 — 보이는 줄(최근 + 마지막에 본 대화) 그 밖은 folded 로 접힌다 (#351)', () => {
    const many = Array.from({ length: PICK_CONVERSATION_LIMIT + 2 }, (value, index) => ({
      id: `f000000${index}-0000-4000-8000-00000000000${index + 1}`,
      project: BACK,
      title: `바쁜 대화 ${index}`,
      mode: 'build' as const,
      running: false,
      updatedAt: 100 + index,
    }))
    // B(최신이 아님)는 상한 밖 — 보이는 줄에 넣어 준다 (보이는 상한 + 1). 접힌 줄은 D(90)·최연 2 개
    const first = pickerOf(peers({}, {}, many))
    expect(first.choices.filter((choice) => choice.projectId === BACK_ID && !choice.folded && !choice.newConversation)).toHaveLength(PICK_CONVERSATION_LIMIT + 1)
    expect(first.choices.filter((choice) => choice.projectId === BACK_ID && choice.folded)).toHaveLength(3)
    // B 가 최신이면 보이는 줄이 상한 그 자체, 접힌 줄은 4 개 (D 포함)
    const second = pickerOf(peers({ updatedAt: 10_000 }, {}, many))
    expect(second.choices.filter((choice) => choice.projectId === BACK_ID && !choice.folded && !choice.newConversation)).toHaveLength(PICK_CONVERSATION_LIMIT)
    expect(second.choices.filter((choice) => choice.projectId === BACK_ID && choice.folded)).toHaveLength(4)
    // 접힌 줄도 choices 에 있다 (folded 로) — 화면이 "N 개 더 보기" 로 펼친다. folded 에 byAi 는 없다
    expect(first.choices.filter((choice) => choice.folded).every((choice) => !choice.byAi)).toBe(true)
  })

  it('AI 가 고른 프로젝트가 목록에 없으면(없는 id·이 프로젝트 자신·못 쓰는 대화) 아무것도 선택돼 있지 않다 — 사용자가 골라야 한다', () => {
    const noProject = targetPicker(request('send_to_project', { project: 'p-zzzzzzzz', message: 'x' }), targetsOf(peers()), peers(), self)!
    expect(noProject.initial).toBeUndefined()
    expect(noProject.missing).toBe('p-zzzzzzzz')
    expect(noProject.choices.every((choice) => !choice.byAi)).toBe(true)
    const itself = targetPicker(request('send_to_project', { project: projectId(WEB), message: 'x' }), targetsOf(peers()), peers(), self)!
    expect(itself).toMatchObject({ missing: projectId(WEB) })
    expect(itself.initial).toBeUndefined()
  })

  it('받을 수 있는 프로젝트가 하나도 없으면 빈 목록 — 보낼 수 없다', () => {
    const picker = targetPicker(request('send_to_project', SEND), targetsOf(peers(), {}), peers(), self)!
    expect(picker.choices).toEqual([])
    expect(picker.missing).toBe(BACK_ID)
  })

  it('인자를 못 이었거나 다른 도구·없앤 도구·다른 서버면 보통의 승인 카드로', () => {
    const targets = targetsOf(peers())
    expect(targetPicker(request('send_to_project'), targets, peers(), self)).toBeUndefined()
    expect(targetPicker(request('open_terminal', { command: 'ls' }), targets, peers(), self)).toBeUndefined()
    expect(targetPicker(request('read_project', { project: BACK_ID }), targets, peers(), self)).toBeUndefined()
    expect(targetPicker(request('start_session', { title: 'x', message: 'y' }), targets, peers(), self)).toBeUndefined()
    expect(targetPicker({ ...request('send_to_project', {}), mcp: { server: 'other', tool: 'send_to_project' } }, targets, peers(), self)).toBeUndefined()
    expect(targetPicker({ kind: 'permission', id: 'p', sessionId: 's', action: 'bash', resources: ['ls'] }, targets, peers(), self)).toBeUndefined()
  })

  it('읽기 승인 (이슈 #137) — 읽을 프로젝트와 그 대화를 보인다. 모르는 id 면 그 id, 다른 도구면 보통의 카드', () => {
    const targets = targetsOf(peers())
    expect(readRequest(request('read_project', { project: BACK_ID, wait_seconds: 30 }), targets)).toBe('order-backend · 주문 API 설계')
    expect(readRequest(request('read_project', { project: 'p-zzzzzzzz' }), targets)).toBe('p-zzzzzzzz')
    expect(readRequest(request('read_project'), targets)).toBeUndefined()
    expect(readRequest(request('send_to_project', SEND), targets)).toBeUndefined()
    expect(readRequest({ ...request('read_project', {}), mcp: { server: 'other', tool: 'read_project' } }, targets)).toBeUndefined()
  })
})

describe('사이드바 표시·대화 상태', () => {
  const origin = { conversationId: A, title: '주문 화면', project: 'shop-web' }
  const asked: HistoryMessage = { role: 'user', text: '지시', origin }
  const typed: HistoryMessage = { role: 'user', text: '사람 글' }

  it('다른 프로젝트가 시킨 일을 하는 중 — 도는 턴의 내 말에 출처가 있을 때만. 끝나면 사라진다', () => {
    expect(runningOrigin({ pending: true, messages: [typed, { role: 'assistant', text: 'a' }, asked] })).toEqual(origin)
    expect(sidebarMark({ id: B, pending: true, messages: [asked] }, new Set())).toBe('delegated')
    expect(sidebarMark({ id: B, pending: false, messages: [asked, { role: 'assistant', text: 'a' }] }, new Set())).toBeUndefined()
    expect(sidebarMark({ id: B, pending: true, messages: [asked, { role: 'assistant', text: 'a' }, typed] }, new Set())).toBeUndefined()
  })

  it('화면 밖에서 새로 생긴 대화는 "새로 생김" 이 먼저다 — 열어서 목록에서 빠지면 도는 중 표시로', () => {
    expect(sidebarMark({ id: B, pending: true, messages: [asked] }, new Set([B]))).toBe('fresh')
    expect(sidebarMark({ id: B, pending: false, messages: [] }, new Set([B]))).toBe('fresh')
    expect(sidebarMark({ id: B, pending: true, messages: [asked] }, new Set([A]))).toBe('delegated')
  })

  it('대화 → 상태: 도는 중이면 시작 시각, 쉬면 마지막 턴의 실패·중단 (알림 상태가 먼저 — 기록을 안 연 대화도 안다)', () => {
    const base = { id: B, project: BACK, title: '제목', mode: 'ask' as const, updatedAt: 1 }
    expect(peerOf({ ...base, pending: true, sentAt: 7, messages: [] })).toEqual({ id: B, project: BACK, title: '제목', mode: 'ask', running: true, updatedAt: 1, startedAt: 7 })
    expect(peerOf({ ...base, messages: [typed, { role: 'assistant', text: '', error: 'boom' }] })).toMatchObject({ running: false, outcome: 'failed' })
    expect(peerOf({ ...base, messages: [typed, { role: 'assistant', text: '', error: '중단됨', interrupted: true }] })).toMatchObject({ outcome: 'interrupted' })
    expect(peerOf({ ...base, messages: [] }, 'failed')).toMatchObject({ outcome: 'failed' })
    expect(peerOf({ ...base, messages: [typed, { role: 'assistant', text: 'ok' }] }, 'done').outcome).toBeUndefined()
    expect(peerOf({ ...base, pending: true, messages: [] }, 'failed').outcome).toBeUndefined() // 다시 돌고 있다
    // 받을 프로젝트 목록이 쓰는 것 — 지시를 받을 수 있는지
    expect(peerOf({ ...base, messages: [] }, undefined, false)).toMatchObject({ unusable: true })
  })
})
