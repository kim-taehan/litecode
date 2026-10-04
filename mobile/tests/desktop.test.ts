import net from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Attention } from '../../shared/contract.ts'
import { Connection, RemoteClient, createFetchTransport, newClientMessageId, type StreamHandlers, type Transport } from '../src/core/index.ts'

// 연결 코어(폰 앱이 쓰는 RemoteClient·Connection·리듀서 그대로)를 **진짜 데스크탑 서비스**(ctx.remote, 이슈 #56)에 붙인다.
// 가짜 데스크탑(dev/fake-desktop.mts)이 아니라 데스크탑 메인 프로세스가 올리는 그 서비스다 — 진짜 ctx.chat·ctx.sessions·ctx.projects 위에서
// 진짜 HTTP(127.0.0.1 빈 포트)로 돌고, 엔진(ctx.llm)만 가짜다 (바탕은 루트 tests/unit/support/remoteHarness.ts).
// 계약(shared/remote.ts)을 양쪽이 같게 읽는지 지킨다: 짝짓기 → 목록 → 보내기 → 이벤트로 답 받기 → 끊기고 이어 받기 → 해제.

// 바탕은 실행 때 불러온다 — 정적 import 면 앱의 tsc 가 데스크탑 서비스 코드(cordis·Electron 쪽 Node 타입)까지 따라 들어간다.
// 그래서 여기서 쓰는 만큼만 모양을 적는다 (어긋나면 아래 테스트가 실행에서 깨진다).
interface PairRequestView {
  id: string
}
interface DesktopStatus {
  pairing?: { code: string }
  requests: PairRequestView[]
}
interface Turn {
  sessionId: string
  progress(item: unknown): void
  attention(requests: Attention[]): void
  finish(): void
}
interface Desktop {
  ctx: {
    on(name: 'remote/changed', listener: (status: DesktopStatus) => void): () => void
    chat: { send(cid: string, input: { text: string }): Promise<unknown>; snapshot(): Record<string, unknown> }
  }
  remote: {
    startPairing(): DesktopStatus
    answerPair(id: string, allow: boolean): DesktopStatus
    revoke(deviceId: string): Promise<DesktopStatus>
    setEnabled(enabled: boolean): Promise<DesktopStatus>
  }
  llm: { replies: unknown[][] }
  /** 엔진에 n 번째 턴이 닿을 때까지 */
  turn(n: number): Promise<Turn>
  /** 저장된 대화 하나를 만든다 */
  save(id: string, extra?: Record<string, unknown>): Promise<unknown>
  pair(deviceName?: string): Promise<{ deviceId: string; token: string }>
  /** http://127.0.0.1:<port> */
  base(): string
}
interface Harness {
  box: { project: string; cleanups: (() => unknown)[] }
  setUp(): Promise<void>
  tearDown(): Promise<void>
  start(options?: { port?: number }): Promise<Desktop>
  until(done: () => boolean, what?: string): Promise<void>
}
const harnessUrl = new URL('../../tests/unit/support/remoteHarness.ts', import.meta.url).href
const { box, setUp, start, tearDown, until } = (await import(/* @vite-ignore */ harnessUrl)) as Harness

let project: string
let cleanups: Harness['box']['cleanups']

beforeEach(async () => {
  await setUp()
  ;({ project, cleanups } = box)
})
afterEach(tearDown)

/** 스트림을 손으로 끊을 수 있는 fetch transport */
function droppable(): Transport & { drop(): void } {
  const inner = createFetchTransport()
  const open = new Set<{ close(): void; handlers: StreamHandlers }>()
  return {
    request: (request) => inner.request(request),
    stream(request, handlers) {
      const entry = { close: inner.stream(request, handlers), handlers }
      open.add(entry)
      return () => {
        open.delete(entry)
        entry.close()
      }
    },
    drop() {
      for (const entry of [...open]) {
        open.delete(entry)
        entry.close()
        entry.handlers.onEnd(new Error('끊김'))
      }
    },
  }
}

describe('모바일 클라이언트 코어 ↔ ctx.remote', () => {
  it('짝짓기 → 목록 → 새 대화 → 보내기 → 이벤트로 답 받기 → 끊기고 이어 받기 → 승인 답 → 해제', async () => {
    const { ctx, remote, llm, turn, save, base } = await start()
    await save('c_old', { updatedAt: 1000 })
    const transport = droppable()
    const client = new RemoteClient({ transport, baseUrl: base(), sendRetryDelayMs: 0 })

    // 짝짓기 — 데스크탑에서 [허용]
    const code = remote.startPairing().pairing!.code
    const off = ctx.on('remote/changed', (status) => {
      if (status.requests[0]) remote.answerPair(status.requests[0].id, true)
    })
    const paired = await client.pair({ code, deviceName: 'Pixel 8', platform: 'android' })
    off()
    expect(client.token).toBe(paired.token)

    const connection = new Connection(client)
    cleanups.push(() => connection.stop())
    connection.start()
    await until(() => connection.status.kind === 'connected', 'connected')
    await connection.loadProjects()
    await connection.loadConversations(project)
    expect(connection.state.projects.map((entry) => entry.path)).toEqual([project])
    expect(connection.state.conversations[project]!.map((entry) => entry.id)).toEqual(['c_old'])
    expect((await client.models()).map((model) => model.modelId)).toEqual(['m1', 'm2'])

    // 새 대화 → 목록이 낡았다는 신호로 다시 받는다
    const created = await client.createConversation({ project })
    const cid = created.id
    await until(() => connection.state.conversations[project]!.some((entry) => entry.id === cid), '새 대화가 목록에')
    await connection.openConversation(cid)
    const view = () => connection.state.views[cid]!
    expect(view()).toMatchObject({ messages: [], running: false })

    // 보내기 → 내 말·진행 줄·답이 이벤트로 온다
    expect(await client.send(cid, { text: '안녕', clientMessageId: newClientMessageId() })).toEqual({ state: 'sent' })
    const first = await turn(1)
    await until(() => view().running && view().messages.length === 1, 'turn.started')
    expect(view().messages[0]).toMatchObject({ role: 'user', text: '안녕' })
    first.progress({ kind: 'think', id: 'th', text: '생각', done: false })
    first.progress({ kind: 'think', id: 'th', text: '생각 끝', done: true })
    await until(() => JSON.stringify(view().progress[0]) === JSON.stringify({ kind: 'think', id: 'th', text: '생각 끝', done: true }), 'progress')
    expect(view().progress).toHaveLength(1) // 같은 id 는 교체
    first.finish()
    await until(() => !view().running, 'turn.ended')
    expect(view().messages.map((message) => message.text)).toEqual(['안녕', 'echo: 안녕'])
    await until(() => connection.state.conversations[project]!.find((entry) => entry.id === cid)?.title === '안녕', '제목')

    // 끊긴 사이에 턴이 시작되고 승인을 기다린다 → 다시 붙으면 놓친 이벤트를 이어 받는다 (다시 그리지 않고)
    transport.drop()
    await until(() => connection.status.kind === 'reconnecting', 'reconnecting')
    expect(await client.send(cid, { text: '둘째', clientMessageId: newClientMessageId() })).toEqual({ state: 'sent' })
    const second = await turn(2)
    second.attention([{ kind: 'permission', id: 'per_9', sessionId: second.sessionId, action: 'bash', resources: ['ls'] } as Attention])
    expect(view().messages).toHaveLength(2) // 아직 모른다
    const resyncs = connection.state.resync
    connection.wake()
    await until(() => connection.status.kind === 'connected' && view().attention.length === 1, '이어 받기')
    expect(connection.state.resync).toBe(resyncs) // reset 이 아니라 재생이다
    expect(view().messages.map((message) => message.text)).toEqual(['안녕', 'echo: 안녕', '둘째'])
    expect(view().running).toBe(true)

    // 승인 답 — 처음은 ok, 같은 요청에 또 답하면(이미 풀렸다) elsewhere
    expect(await client.reply(second.sessionId, 'per_9', 'once')).toEqual({ handled: 'ok' })
    expect(llm.replies).toEqual([[second.sessionId, 'per_9', 'once']])
    second.attention([])
    await until(() => view().attention.length === 0, '카드 사라짐')
    expect(await client.reply(second.sessionId, 'per_9', 'once')).toEqual({ handled: 'elsewhere' })

    // 도는 중에 다시 연 대화 — 스냅샷이 도는 턴을 싣는다
    connection.closeConversation(cid)
    await connection.openConversation(cid)
    expect(view()).toMatchObject({ running: true, messages: [{ text: '안녕' }, { text: 'echo: 안녕' }, { text: '둘째' }] })
    expect((await client.stop(cid)).stopped).toBe(true)
    await until(() => !view().running, '중단')
    expect(view().messages.at(-1)).toMatchObject({ role: 'assistant', interrupted: true })

    // 해제 — 연결이 revoked 로 끝나고 다시 붙지 않는다
    await remote.revoke(paired.deviceId)
    await until(() => connection.status.kind === 'revoked', 'revoked')
    await expect(client.hello()).rejects.toMatchObject({ status: 401 })
  })

  it('데스크탑이 연결을 껐다 켜면(새 실행) 폰은 목록과 열린 대화를 다시 받는다', async () => {
    const { remote, save, pair, turn, ctx, base } = await start({ port: await freePort() })
    await save('c1')
    const { token } = await pair()
    const transport = droppable()
    const connection = new Connection(new RemoteClient({ transport, baseUrl: base(), token }))
    cleanups.push(() => connection.stop())
    connection.start()
    await until(() => connection.status.kind === 'connected', 'connected')
    await connection.loadProjects()
    await connection.loadConversations(project)
    await connection.openConversation('c1')

    await remote.setEnabled(false)
    await until(() => connection.status.kind === 'reconnecting', 'reconnecting')
    await ctx.chat.send('c1', { text: '그사이' })
    ;(await turn(1)).finish()
    await until(() => ctx.chat.snapshot().c1 === undefined, '턴 끝')
    await remote.setEnabled(true)
    connection.wake()
    await until(() => connection.state.views.c1!.messages.length === 2, '다시 받은 스냅샷')
    expect(connection.state.resync).toBe(1)
    expect(connection.state.views.c1!.messages.map((message) => message.text)).toEqual(['그사이', 'echo: 그사이'])
  })
})

/** 지금 비어 있는 포트 — 껐다 켜도 같은 주소로 다시 붙는 시험에 쓴다 (47600 은 쓰지 않는다) */
async function freePort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as net.AddressInfo
  await new Promise((resolve) => probe.close(resolve))
  return port
}
