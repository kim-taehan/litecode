import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryMessage, TurnItem } from '../../shared/contract.ts'
import type { ByteLink } from '../../shared/remoteFraming.ts'
import { memoryPipe, type MemoryPipe } from '../../tests/unit/support/memoryPipe.ts'
import { Connection, RemoteClient, createFramedTransport, newClientMessageId, type FramedTransport, type Transport } from '../src/core/index.ts'

// 느린 링크 — 블루투스 경로의 로직 전부를 블루투스 없이 (이슈 #68, 설계 01ab 8절 ①).
// 초당 20KB 로 조인 메모리 파이프(조각 185바이트 = BLE MTU 188) 위에 프레이밍을 얹어, 폰 앱의 연결 코어(RemoteClient·Connection·리듀서)를
// **진짜 ctx.remote**(진짜 ctx.chat·ctx.sessions·ctx.projects, 엔진만 가짜)에 붙인다. HTTP 운반은 올리지 않는다.
// 시간은 가짜 시계다 — 파이프의 지연·연결의 타이머가 다 가상 시간으로 가서, 수십 초짜리 흐름이 실제로는 금방 끝난다.
// 재는 것: 큰 스냅샷과 한 턴이 걸리는 (가상) 시간, 합치기·압축 전후의 바이트. 숫자는 console.info 로 찍는다(보고용).

interface Stats {
  messages: number
  rawBytes: number
  wireBytes: number
}
interface Turn {
  sessionId: string
  progress(item: TurnItem): void
  finish(): void
}
interface DesktopStatus {
  pairing?: { code: string }
  requests: { id: string }[]
  devices: { id: string; connected: boolean }[]
}
interface Desktop {
  ctx: { chat: { send(cid: string, input: { text: string }): Promise<unknown>; snapshot(): Record<string, unknown> } }
  remote: { startPairing(): DesktopStatus; answerPair(id: string, allow: boolean): DesktopStatus; revoke(deviceId: string): Promise<DesktopStatus>; status(): DesktopStatus }
  llm: { calls: Turn[] }
  /** 주소 없이 늘 떠 있는 운반을 올린다 */
  pipeCarrier(): Promise<void>
  /** 링크를 프레임 운반으로 ctx.remote 에 잇는다 */
  attach(link: ByteLink, key?: string): { stats: Stats }
  seed(id: string, messages: HistoryMessage[]): Promise<void>
  save(id: string, extra?: Record<string, unknown>): Promise<unknown>
}
interface Harness {
  box: { project: string; cleanups: (() => unknown)[] }
  setUp(): Promise<void>
  tearDown(): Promise<void>
  start(options?: { http?: boolean }): Promise<Desktop>
}
const harnessUrl = new URL('../../tests/unit/support/remoteHarness.ts', import.meta.url).href
const { box, setUp, start, tearDown } = (await import(/* @vite-ignore */ harnessUrl)) as Harness

const LINK = { maxChunk: 185, bytesPerSecond: 20_000 }

beforeEach(async () => {
  await setUp()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
})
afterEach(async () => {
  vi.useRealTimers()
  await tearDown()
})

/** 가상 시간을 ms 만큼 보내고, 진짜 입출력(파일)이 끝나게 한 번 양보한다 */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await new Promise<void>((resolve) => setImmediate(resolve))
}

/** 조건이 참이 될 때까지 가상 시간을 보낸다 — 걸린 가상 시간(ms)을 준다 */
async function waitFor(done: () => boolean, what: string, limitMs = 180_000): Promise<number> {
  const from = Date.now()
  while (!done()) {
    if (Date.now() - from > limitMs) throw new Error(`기다렸지만 오지 않았다(가상 ${limitMs}ms): ${what}`)
    await advance(10)
  }
  return Date.now() - from
}

/** 씨앗으로 정해지는 글 — 낱말이 되풀이되는 보통 글(답·코드)처럼 눌린다 */
function prose(bytes: number, seed: number): string {
  let state = seed * 2654435761
  const next = (): number => ((state = (state * 1103515245 + 12345) & 0x7fffffff), state)
  const words = Array.from({ length: 900 }, (_, index) => {
    const length = 2 + (next() % 9)
    return index % 7 === 0 ? `${'가나다라마바사아자차카타파하'[next() % 14]}${'고노도로모보소오조초코토포호'[next() % 14]}` : Array.from({ length }, () => 'abcdefghijklmnopqrstuvwxyz'[next() % 26]).join('')
  })
  let text = ''
  while (text.length < bytes) text += `${words[next() % words.length]}${next() % 13 === 0 ? '.\n' : ' '}`
  return text.slice(0, bytes)
}

const size = (value: unknown): number => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length
const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)}KB`

/** 링크를 바꿔 끼울 수 있는 운반 — 끊긴 뒤 새 링크로 다시 붙는 것을 흉내 낸다 (앱에서는 연결 후보를 고르는 층이 한다) */
function relinkable() {
  let current: FramedTransport | undefined
  const transport: Transport = {
    request: (request) => (current ? current.request(request) : Promise.reject(new Error('no link'))),
    stream: (request, handlers) => {
      if (current) return current.stream(request, handlers)
      void Promise.resolve().then(() => handlers.onEnd(new Error('no link')))
      return () => {}
    },
  }
  return { transport, link: (link: ByteLink) => (current = createFramedTransport(link)), stats: () => current!.stats }
}

describe('느린 링크(20KB/s, 조각 185바이트) 위의 모바일 코어 ↔ 진짜 ctx.remote', () => {
  it('짝짓기 → 목록 → 큰 스냅샷 → 보내기 → 누적 진행 이벤트 → 답 → 끊김 → 이어 받기 → 해제', async () => {
    const desktop = await start({ http: false })
    const { remote, llm } = desktop
    await desktop.pipeCarrier()

    // 300KB 대화 (말 150개 × 2KB) 와 작은 대화 하나
    const history: HistoryMessage[] = Array.from({ length: 150 }, (_, index) => ({ id: `msg_seed_${index}`, role: index % 2 ? 'assistant' : 'user', text: prose(2000, index + 1) }))
    await desktop.seed('c_big', history)
    await desktop.save('c_small')

    let pipe: MemoryPipe = memoryPipe(LINK)
    let server = desktop.attach(pipe.b, 'link-1')
    const phone = relinkable()
    phone.link(pipe.a)
    const client = new RemoteClient({ transport: phone.transport, baseUrl: 'bt://desktop', sendRetryDelayMs: 0 })
    const report: Record<string, string> = {}

    // ── 짝짓기 — 데스크탑에서 [허용] ──
    const code = remote.startPairing().pairing!.code
    const pairing = client.pair({ code, deviceName: 'Pixel 8', platform: 'android' })
    await waitFor(() => remote.status().requests.length === 1, '짝짓기 요청')
    remote.answerPair(remote.status().requests[0]!.id, true)
    let paired: { deviceId: string; token: string } | undefined
    void pairing.then((result) => (paired = result))
    await waitFor(() => paired !== undefined, '짝짓기 응답')
    expect(client.token).toBe(paired!.token)

    // ── 붙기·목록 ──
    const connection = new Connection(client)
    box.cleanups.push(() => connection.stop())
    connection.start()
    report['붙기(hello + 스트림 열림)'] = `${await waitFor(() => connection.status.kind === 'connected', 'connected')}ms`
    let listed = false
    void Promise.all([connection.loadProjects(), connection.loadConversations(box.project)]).then(() => (listed = true))
    report['목록(프로젝트 + 대화)'] = `${await waitFor(() => listed, '목록')}ms`
    expect(connection.state.conversations[box.project]!.map((entry) => entry.id).sort()).toEqual(['c_big', 'c_small'])

    // ── 큰 스냅샷 ──
    let before = { wire: pipe.bytes.bToA, raw: server.stats.rawBytes }
    let opened = false
    void connection.openConversation('c_big').then(() => (opened = true))
    const snapshotMs = await waitFor(() => opened, '큰 스냅샷')
    const snapshotRaw = server.stats.rawBytes - before.raw
    const snapshotWire = pipe.bytes.bToA - before.wire
    expect(connection.state.views.c_big!.messages).toHaveLength(150)
    expect(connection.state.views.c_big!.messages[149]!.text).toBe(history[149]!.text)
    expect(snapshotRaw).toBeGreaterThan(300_000)
    expect(snapshotWire).toBeLessThan(snapshotRaw / 2)
    report['스냅샷'] = `${kb(snapshotRaw)} → 링크 ${kb(snapshotWire)} (${(snapshotRaw / snapshotWire).toFixed(1)}배 압축), ${(snapshotMs / 1000).toFixed(1)}초 (압축 없이는 ${(snapshotRaw / LINK.bytesPerSecond).toFixed(1)}초)`

    // ── 보내기 → 누적 진행 이벤트 → 답 ──
    let opened2 = false
    void connection.openConversation('c_small').then(() => (opened2 = true))
    await waitFor(() => opened2, '작은 대화')
    const view = () => connection.state.views.c_small!
    const turnStart = Date.now()
    let sent: unknown
    void client.send('c_small', { text: '긴 답을 써 줘', clientMessageId: newClientMessageId() }).then((result) => (sent = result))
    await waitFor(() => sent !== undefined && llm.calls.length === 1, '보내기')
    expect(sent).toEqual({ state: 'sent' })
    await waitFor(() => view().running, 'turn.started')

    before = { wire: pipe.bytes.bToA, raw: server.stats.rawBytes }
    const messagesBefore = server.stats.messages
    const answer = prose(20_000, 777)
    const STEPS = 200
    let emittedBytes = 0
    let shown = 0 // 폰이 그린 진행 줄의 판 수
    let lastShown = ''
    let worstLag = 0
    connection.subscribe(() => {
      const item = connection.state.views.c_small?.progress[0]
      const text = item?.kind === 'text' ? item.text : ''
      if (text !== lastShown) {
        lastShown = text
        shown += 1
      }
    })
    // 0.1초마다 누적 전체를 다시 보낸다 — 답이 20KB 까지 자란다 (설계 4절의 가정)
    for (let step = 1; step <= STEPS; step++) {
      const item: TurnItem = { kind: 'text', id: 'txt_1', text: answer.slice(0, Math.round((answer.length * step) / STEPS)), done: step === STEPS }
      emittedBytes += size(`id: 1000\nevent: turn.progress\ndata: ${JSON.stringify({ cid: 'c_small', item })}\n\n`)
      llm.calls[0]!.progress(item)
      await advance(100)
      worstLag = Math.max(worstLag, item.text.length - lastShown.length)
    }
    const catchUpMs = await waitFor(() => lastShown === answer, '마지막 진행 줄')
    llm.calls[0]!.finish()
    await waitFor(() => !view().running, 'turn.ended')
    const turnMs = Date.now() - turnStart
    const progressRaw = server.stats.rawBytes - before.raw
    const progressWire = pipe.bytes.bToA - before.wire
    expect(view().messages.at(-1)).toMatchObject({ role: 'assistant', text: 'echo: 긴 답을 써 줘' })
    expect(view().messages.at(-1)!.items).toEqual([{ kind: 'text', id: 'txt_1', text: answer, done: true }])
    expect(shown).toBeLessThan(STEPS) // 다 가지 않았다 — 밀린 것은 합쳐졌다
    expect(shown).toBeGreaterThan(10) // 그래도 화면은 계속 움직였다
    expect(progressWire).toBeLessThan(emittedBytes / 4)
    expect(catchUpMs).toBeLessThan(3000) // 마지막 모습이 곧 닿는다 (뒤처짐이 쌓이지 않는다)
    report['한 턴(진행 200번, 답 20KB)'] =
      `보낸 이벤트 ${kb(emittedBytes)} → 합친 뒤 ${kb(progressRaw)}(프레임 ${server.stats.messages - messagesBefore}개) → 링크 ${kb(progressWire)}. ` +
      `폰이 그린 판 ${shown}/${STEPS}, 가장 뒤처졌을 때 ${kb(worstLag)}(글자), 마지막 판까지 ${catchUpMs}ms, 턴 전체 ${(turnMs / 1000).toFixed(1)}초(그중 내보내는 데 ${(STEPS * 100) / 1000}초)`
    report['합치기 없이 그대로였다면'] = `${kb(emittedBytes)} ÷ 20KB/s = ${(emittedBytes / LINK.bytesPerSecond).toFixed(0)}초`

    // ── 끊김 → 끊긴 사이에 데스크탑에서 한 턴 → 새 링크로 이어 받기 ──
    pipe.cut(new Error('멀어졌다'))
    await waitFor(() => connection.status.kind === 'reconnecting', 'reconnecting')
    await waitFor(() => !remote.status().devices[0]!.connected, '데스크탑이 끊김을 안다')
    await desktop.ctx.chat.send('c_small', { text: '그사이' })
    await waitFor(() => llm.calls.length === 2, '둘째 턴')
    llm.calls[1]!.finish()
    await waitFor(() => desktop.ctx.chat.snapshot().c_small === undefined, '둘째 턴 끝')
    expect(view().messages).toHaveLength(2) // 아직 모른다

    pipe = memoryPipe(LINK)
    server = desktop.attach(pipe.b, 'link-2')
    phone.link(pipe.a)
    const resyncs = connection.state.resync
    connection.wake()
    const resumeMs = await waitFor(() => connection.status.kind === 'connected' && view().messages.length === 4, '이어 받기')
    expect(connection.state.resync).toBe(resyncs) // reset 이 아니라 `after` 재생이다
    expect(view().messages.map((message) => message.text)).toEqual(['긴 답을 써 줘', 'echo: 긴 답을 써 줘', '그사이', 'echo: 그사이'])
    report['이어 받기(hello → events?after= → 놓친 턴)'] = `${resumeMs}ms, 링크 ${kb(pipe.bytes.bToA)}`

    // ── 해제 ──
    await remote.revoke(paired!.deviceId)
    await waitFor(() => connection.status.kind === 'revoked', 'revoked')

    console.info(`[느린 링크 ${LINK.bytesPerSecond / 1000}KB/s]\n${Object.entries(report).map(([name, value]) => `  ${name}: ${value}`).join('\n')}`)
  }, 120_000)

  it('아주 긴 누적 진행(합 ~6MB)도 밀리지 않는다 — 내보내기가 끝나고 곧 마지막 모습이 닿는다', async () => {
    const desktop = await start({ http: false })
    await desktop.pipeCarrier()
    await desktop.save('c1')
    const pipe = memoryPipe(LINK)
    desktop.attach(pipe.b)
    const transport = createFramedTransport(pipe.a)
    const client = new RemoteClient({ transport, baseUrl: 'bt://desktop' })
    const code = desktop.remote.startPairing().pairing!.code
    void client.pair({ code, deviceName: 'Pixel', platform: 'android' })
    await waitFor(() => desktop.remote.status().requests.length === 1, '요청')
    desktop.remote.answerPair(desktop.remote.status().requests[0]!.id, true)
    await waitFor(() => client.token !== undefined, '토큰')
    const connection = new Connection(client)
    box.cleanups.push(() => connection.stop())
    connection.start()
    await waitFor(() => connection.status.kind === 'connected', 'connected')
    let opened = false
    void connection.openConversation('c1').then(() => (opened = true))
    await waitFor(() => opened, '대화')
    await desktop.ctx.chat.send('c1', { text: 'go' })
    await waitFor(() => desktop.llm.calls.length === 1 && connection.state.views.c1!.running, '턴')

    // 60초 동안 0.1초마다, 답이 20KB 까지 — 합 ~6MB (설계 4절의 표)
    const answer = prose(20_000, 5)
    let emitted = 0
    const from = pipe.bytes.bToA
    for (let step = 1; step <= 600; step++) {
      const item: TurnItem = { kind: 'text', id: 't', text: answer.slice(0, Math.round((answer.length * step) / 600)), done: step === 600 }
      emitted += size(item)
      desktop.llm.calls[0]!.progress(item)
      await advance(100)
    }
    const shownText = () => {
      const item = connection.state.views.c1!.progress[0]
      return item?.kind === 'text' ? item.text : ''
    }
    const lagMs = await waitFor(() => shownText() === answer, '마지막 모습')
    expect(emitted).toBeGreaterThan(5_500_000)
    expect(lagMs).toBeLessThan(2000) // 링크가 60초에 실을 수 있는 것은 1.2MB 뿐이다 — 합치지 않으면 4분 뒤처진다
    expect(pipe.bytes.bToA - from).toBeLessThan(1_300_000)
    console.info(`[6MB 진행] 보낸 이벤트 ${kb(emitted)} → 링크 ${kb(pipe.bytes.bToA - from)}, 내보내기가 끝난 뒤 마지막 모습까지 ${lagMs}ms`)
  }, 120_000)
})
