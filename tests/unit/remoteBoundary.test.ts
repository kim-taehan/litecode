import { afterEach, beforeEach, expect, it } from 'vitest'
import { tr } from '../../src/i18n.ts'
import type { Attention } from '../../shared/contract.ts'
import { setUp, start, tearDown, until } from './support/remoteHarness.ts'

// 이슈 #186 — "전체 권한은 폰에 열지 않는다"(remote.ts 머리 주석)가 새던 두 길 (01am B1·B2).

beforeEach(setUp)
afterEach(tearDown)

it('B1: 폰 글이 쌓인 사이 데스크탑이 전체 권한으로 바꾸면 엔진에 보내지 않고 붙잡는다 — 폰이 되돌린다', async () => {
  const { ctx, api, pair, save, turn, llm, chatEvents } = await start()
  const { token } = await pair()
  await save('c1') // mode: 'build'
  await ctx.chat.send('c1', { text: 'desktop first' })
  const first = await turn(1)

  // 폰이 보낸다 — 대화가 build 라 403 이 아니고 대기열에 들어간다
  const sent = await api('POST', '/v1/conversations/c1/messages', { token, body: { text: 'phone text', clientMessageId: 'cm_1' } })
  expect(sent).toMatchObject({ status: 202, body: { state: 'queued' } })

  // 데스크탑이 모드 칩을 전체 권한으로 바꾼다 (화면의 sessions:patch 와 같은 길)
  await ctx.sessions.patch('c1', () => ({ mode: 'full' }))
  first.finish()

  // 폰 글의 턴은 엔진에 닿지 않고 사유와 함께 실패로 끝난다
  await until(() => chatEvents.filter(([name]) => name === 'turn.ended').length === 2, '폰 글의 턴 끝')
  const [, ended] = chatEvents.filter(([name]) => name === 'turn.ended')[1]!
  expect(ended).toMatchObject({ cid: 'c1', outcome: 'failed', message: { error: tr('remote.fullAccessBlocked') } })
  expect(llm.calls).toHaveLength(1)

  // 폰 글은 대기열 맨 앞에 붙잡혀 있다 — 폰이 되돌리기로 입력창에 가져간다
  expect(ctx.chat.snapshot()['c1']?.queue).toMatchObject({ items: ['phone text'], held: true })
  expect(await api('POST', '/v1/conversations/c1/queue/take', { token })).toMatchObject({ status: 200, body: { text: 'phone text' } })
  expect(ctx.chat.snapshot()['c1']).toBeUndefined()

  // 데스크탑의 글은 그대로 전체 권한으로 간다
  await ctx.chat.send('c1', { text: 'desktop again' })
  expect(await turn(2)).toMatchObject({ prompt: 'desktop again', mode: 'full' })
})

it('B2: 전체 권한 대화의 승인 요청에 폰이 답하면 403 — 엔진에 가지 않는다 (데스크탑에서만)', async () => {
  const { ctx, api, pair, save, turn, llm } = await start()
  const { token } = await pair()
  await save('c1', { mode: 'full' })
  await ctx.chat.send('c1', { text: 'desktop' })
  const call = await turn(1)
  // 전체 권한에서도 묻는 도구 (litecode_create — 훅·MCP 를 만든다 = 이 PC 에서 명령이 돈다)
  call.attention([{ kind: 'permission', id: 'per_1', sessionId: call.sessionId, action: 'litecode_create', resources: ['*'] } as Attention])
  await until(() => (ctx.chat.snapshot()['c1']?.turn?.attention.length ?? 0) > 0, '승인 카드')

  const answer = await api('POST', `/v1/attention/${call.sessionId}/per_1`, { token, body: { answer: 'once' } })
  expect(answer).toMatchObject({ status: 403, body: { error: expect.any(String) } })
  expect(llm.replies).toEqual([])

  // 데스크탑은 답할 수 있다
  await ctx.chat.reply(call.sessionId, 'per_1', 'once')
  expect(llm.replies).toHaveLength(1)
  call.finish()
})

it('B2: 턴이 전체 권한으로 시작했으면 도중에 모드를 내려도 그 턴의 승인은 폰에 안 연다', async () => {
  const { ctx, api, pair, save, turn, llm } = await start()
  const { token } = await pair()
  await save('c1', { mode: 'full' })
  await ctx.chat.send('c1', { text: 'desktop' })
  const call = await turn(1)
  await ctx.sessions.patch('c1', () => ({ mode: 'build' }))
  call.attention([{ kind: 'permission', id: 'per_1', sessionId: call.sessionId, action: 'litecode_create', resources: ['*'] } as Attention])
  await until(() => (ctx.chat.snapshot()['c1']?.turn?.attention.length ?? 0) > 0, '승인 카드')

  expect((await api('POST', `/v1/attention/${call.sessionId}/per_1`, { token, body: { answer: 'once' } })).status).toBe(403)
  expect(llm.replies).toEqual([])
  call.finish()
})
