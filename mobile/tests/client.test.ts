import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startFakeDesktop, type FakeDesktop } from '../dev/fake-desktop.mts'
import { createFetchTransport, RemoteClient, RemoteError, type Transport } from '../src/core/index.ts'
import type { PermissionAttention } from '../../shared/contract.ts'
import { collect, pairedClient, until } from './support.ts'

// remote client 를 가짜 데스크탑(진짜 http·SSE, 127.0.0.1 빈 포트)에 붙인다 — 계약의 양쪽이 맞물리는지 본다.

let desktop: FakeDesktop
beforeEach(async () => {
  desktop = await startFakeDesktop({ port: 0, stepMs: 5 })
})
afterEach(() => desktop.close())

/** 보내고, 그 턴이 승인을 기다리며 서 있을 때까지 — 턴이 도는 중인 상태를 시간에 기대지 않고 만든다 */
async function sendAndWaitForAsk(client: RemoteClient, stream: ReturnType<typeof collect>, text: string): Promise<PermissionAttention> {
  await client.send('c_tests', { text, clientMessageId: `cm_${text}` })
  await until(() => stream.has('turn.attention'), 'turn.attention')
  const event = stream.events.find((candidate) => candidate.event === 'turn.attention')
  return (event?.event === 'turn.attention' ? event.data.requests[0] : undefined) as PermissionAttention
}

const status = (promise: Promise<unknown>): Promise<number | undefined> =>
  promise.then(
    () => undefined,
    (error) => (error instanceof RemoteError ? error.status : -1),
  )

describe('짝짓기·인증', () => {
  it('맞는 코드로 토큰을 받고, 그 토큰으로 hello·목록이 된다', async () => {
    const client = await pairedClient(desktop)
    expect(client.token).toMatch(/^[0-9a-f]{64}$/)
    expect(await client.hello()).toMatchObject({ apiVersion: 1, seq: 0, addresses: [`127.0.0.1:${desktop.port}`] })
    const [project] = await client.projects()
    expect((await client.conversations(project!.path)).map((conversation) => conversation.id)).toEqual(['c_login', 'c_tests', 'c_readme'])
    expect((await client.models())[0]).toEqual({ providerId: 'gateway', providerName: '사내 게이트웨이', modelId: 'qwen3.8-27b', displayName: 'Qwen 3.8 27B' })
  })

  it('틀린 코드는 403, 토큰 없는 요청은 401', async () => {
    const client = new RemoteClient({ transport: createFetchTransport(), baseUrl: desktop.url })
    expect(await status(client.pair({ code: 'WRONG', deviceName: 't', platform: 'android' }))).toBe(403)
    expect(await status(client.hello())).toBe(401)
  })

  it('해제되면 스트림에 device.revoked 가 오고 끊기며, 그 토큰은 401 이다', async () => {
    const client = await pairedClient(desktop)
    const stream = collect(client)
    await until(() => stream.has('ready'), 'ready')
    desktop.revokeAll()
    await until(() => stream.ended(), '스트림 끝')
    expect(stream.names()).toEqual(['ready', 'device.revoked'])
    expect(await status(client.hello())).toBe(401)
  })
})

describe('보내기와 이벤트', () => {
  it('보내면 turn.started → 진행 줄 → turn.ended("echo: …") 가 seq 순서로 온다', async () => {
    const client = await pairedClient(desktop)
    const stream = collect(client)
    await until(() => stream.has('ready'), 'ready')
    expect(await client.send('c_tests', { text: '안녕', clientMessageId: 'cm_1' })).toEqual({ state: 'sent' })
    await until(() => stream.has('turn.ended'), 'turn.ended')
    stream.close()

    const recorded = stream.events.filter((event) => event.seq !== undefined)
    expect(recorded.map((event) => event.seq)).toEqual(recorded.map((_, index) => index + 1))
    expect(stream.events.find((event) => event.event === 'turn.started')?.data).toMatchObject({ cid: 'c_tests', message: { id: 'cm_1', role: 'user', text: '안녕' } })
    const kinds = stream.events.flatMap((event) => (event.event === 'turn.progress' ? [event.data.item.kind] : []))
    expect([...new Set(kinds)]).toEqual(['think', 'tool', 'text'])
    expect(stream.events.find((event) => event.event === 'turn.ended')?.data).toMatchObject({ outcome: 'done', message: { role: 'assistant', text: 'echo: 안녕' } })
  })

  it('응답을 못 받으면 같은 clientMessageId 로 다시 보내고, 데스크탑은 턴을 한 번만 만든다', async () => {
    const real = createFetchTransport()
    let lost = 0
    // 첫 보내기는 데스크탑에 도착하지만 응답이 오는 길에 사라진다
    const flaky: Transport = {
      stream: real.stream,
      async request(request) {
        const response = await real.request(request)
        if (request.url.endsWith('/messages') && lost++ === 0) throw new Error('응답 유실')
        return response
      },
    }
    const client = await pairedClient(desktop, flaky)
    expect(await client.send('c_tests', { text: '한 번만', clientMessageId: 'cm_same' })).toEqual({ state: 'sent' })
    expect(lost).toBe(2)
    expect(desktop.turnCount()).toBe(1)

    // 화면이 같은 id 로 또 눌러도 같다
    expect(await client.send('c_tests', { text: '한 번만', clientMessageId: 'cm_same' })).toEqual({ state: 'sent' })
    expect(desktop.turnCount()).toBe(1)
  })

  it('데스크탑이 거절한 보내기(full 모드 대화 403)는 다시 보내지 않는다', async () => {
    const real = createFetchTransport()
    let calls = 0
    const counting: Transport = { stream: real.stream, request: (request) => (request.url.endsWith('/messages') && calls++, real.request(request)) }
    const client = await pairedClient(desktop, counting)
    expect(await status(client.send('c_readme', { text: '보내기', clientMessageId: 'cm_full' }))).toBe(403)
    expect(calls).toBe(1)
    expect(desktop.turnCount()).toBe(0)
  })

  it('턴 중에 보낸 것은 대기열에 들어가고, 턴이 끝나면 합쳐 한 턴으로 간다', async () => {
    const client = await pairedClient(desktop)
    const stream = collect(client)
    await until(() => stream.has('ready'), 'ready')
    const request = await sendAndWaitForAsk(client, stream, '[ask] 하나')
    expect(await client.send('c_tests', { text: '둘', clientMessageId: 'cm_b' })).toEqual({ state: 'queued' })
    expect(await client.send('c_tests', { text: '셋', clientMessageId: 'cm_c' })).toEqual({ state: 'queued' })
    await client.reply(request.sessionId, request.id, 'once')
    await until(() => stream.events.filter((event) => event.event === 'turn.ended').length === 2, '두 번째 턴 끝')
    stream.close()

    expect(stream.events.flatMap((event) => (event.event === 'queue.changed' ? [event.data.items] : []))).toEqual([['둘'], ['둘', '셋'], []])
    expect(stream.events.flatMap((event) => (event.event === 'turn.ended' ? [event.data.message.text] : []))).toEqual(['echo: [ask] 하나', 'echo: 둘\n셋'])
    expect(desktop.turnCount()).toBe(2)
  })

  it('대기열 되돌리기는 합친 글을 주고 비운다 — 그 글은 턴이 되지 않는다', async () => {
    const client = await pairedClient(desktop)
    const stream = collect(client)
    await until(() => stream.has('ready'), 'ready')
    const request = await sendAndWaitForAsk(client, stream, '[ask] 하나')
    await client.send('c_tests', { text: '둘', clientMessageId: 'cm_b' })
    expect(await client.takeQueue('c_tests')).toEqual({ text: '둘' })
    await client.reply(request.sessionId, request.id, 'once')
    await until(() => stream.has('turn.ended'), 'turn.ended')
    await new Promise((resolve) => setTimeout(resolve, 30))
    stream.close()
    expect(desktop.turnCount()).toBe(1)
    expect(await client.takeQueue('c_tests')).toEqual({ text: '' })
  })

  it('중지하면 그 턴이 interrupted 로 끝난다', async () => {
    const client = await pairedClient(desktop)
    const stream = collect(client)
    await until(() => stream.has('ready'), 'ready')
    await sendAndWaitForAsk(client, stream, '[ask] 멈출 것')
    expect(await client.stop('c_tests')).toEqual({ stopped: true })
    await until(() => stream.has('turn.ended'), 'turn.ended')
    stream.close()
    expect(stream.events.find((event) => event.event === 'turn.ended')?.data).toMatchObject({ outcome: 'interrupted', message: { interrupted: true } })
    expect(await client.stop('c_tests')).toEqual({ stopped: false })
  })

  it('새 대화를 만들면 목록에 생기고, 등록되지 않은 프로젝트는 거절된다', async () => {
    const client = await pairedClient(desktop)
    const [project] = await client.projects()
    const created = await client.createConversation({ project: project!.path, mode: 'plan' })
    expect(created).toMatchObject({ project: project!.path, mode: 'plan', title: '' })
    expect((await client.conversations(project!.path)).some((conversation) => conversation.id === created.id)).toBe(true)
    expect(await status(client.createConversation({ project: '/etc' }))).toBe(404)
  })
})

describe('승인', () => {
  const askUntilWaiting = async () => {
    const client = await pairedClient(desktop)
    const stream = collect(client)
    await until(() => stream.has('ready'), 'ready')
    return { client, stream, request: await sendAndWaitForAsk(client, stream, '[ask] 실행') }
  }

  it('먼저 온 답이 이기고(ok), 같은 요청에 또 답하면 오류가 아니라 elsewhere 다', async () => {
    const { client, stream, request } = await askUntilWaiting()
    expect(request).toMatchObject({ kind: 'permission', action: 'bash' })

    // 스냅샷에도 기다리는 승인이 실린다 (늦게 연 화면도 카드를 그린다)
    expect((await client.conversation('c_tests')).live?.attention).toEqual([request])

    const other = await pairedClient(desktop) // 두 번째 기기
    expect(await client.reply(request.sessionId, request.id, 'once')).toEqual({ handled: 'ok' })
    expect(await other.reply(request.sessionId, request.id, 'once')).toEqual({ handled: 'elsewhere' })

    await until(() => stream.has('turn.ended'), 'turn.ended')
    stream.close()
    expect(stream.events.flatMap((event) => (event.event === 'turn.attention' ? [event.data.requests.length] : []))).toEqual([1, 0])
    expect(stream.events.find((event) => event.event === 'turn.ended')?.data).toMatchObject({ message: { text: 'echo: [ask] 실행' } })
  })

  it('거절하면 턴이 도구를 돌리지 않고 declined 로 끝난다', async () => {
    const { client, stream, request } = await askUntilWaiting()
    expect(await client.reply(request.sessionId, request.id, 'reject')).toEqual({ handled: 'ok' })
    await until(() => stream.has('turn.ended'), 'turn.ended')
    stream.close()
    expect(stream.events.find((event) => event.event === 'turn.ended')?.data).toMatchObject({ message: { declined: true, text: '' } })
    expect(stream.events.some((event) => event.event === 'turn.progress' && event.data.item.kind === 'tool')).toBe(false)
  })
})

describe('이어 받기', () => {
  it('끊긴 뒤 run·after 로 다시 붙으면 빠진 이벤트만 온다', async () => {
    const client = await pairedClient(desktop)
    const { runId } = await client.hello()
    const first = collect(client, { run: runId, after: 0 })
    await until(() => first.has('ready'), 'ready')
    const request = await sendAndWaitForAsk(client, first, '[ask] 이어')
    first.close()
    const lastSeen = Math.max(...first.events.map((event) => event.seq ?? 0))

    // 끊긴 사이 승인에 답해 턴이 끝까지 간다
    await client.reply(request.sessionId, request.id, 'once')
    await until(() => desktop.turnCount() === 1 && !desktop.running('c_tests'), '턴 끝')
    const second = collect(client, { run: runId, after: lastSeen })
    await until(() => second.has('turn.ended'), '재생된 turn.ended')
    second.close()

    expect(second.events[0]).toMatchObject({ event: 'ready', seq: undefined })
    const replayed = second.events.slice(1).map((event) => event.seq!)
    expect(replayed[0]).toBe(lastSeen + 1)
    expect(replayed).toEqual(replayed.map((_, index) => lastSeen + 1 + index))
  })

  it('데스크탑이 재시작했으면(runId 다름) 재생 대신 reset 이 온다', async () => {
    const client = await pairedClient(desktop)
    const before = await client.hello()
    await client.send('c_tests', { text: '재시작 전', clientMessageId: 'cm_1' })
    desktop.restart()

    const stream = collect(client, { run: before.runId, after: 3 })
    await until(() => stream.events.length > 0, '첫 이벤트')
    stream.close()
    const after = await client.hello()
    expect(after.runId).not.toBe(before.runId)
    expect(stream.events).toEqual([{ event: 'reset', data: { runId: after.runId, seq: 0 }, seq: undefined }])

    // 돌던 턴은 기록에 "중단됨" 으로 남는다
    expect((await client.conversation('c_tests')).history.messages.at(-1)).toMatchObject({ role: 'assistant', interrupted: true })
  })
})
