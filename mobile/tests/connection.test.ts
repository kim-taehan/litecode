import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hello } from '../../shared/remote.ts'
import { startFakeDesktop } from '../dev/fake-desktop.mts'
import { backoffMs, BluetoothError, Connection, RemoteClient, type ConnectionStatus } from '../src/core/index.ts'
import { ManualTransport, pairedClient, sse, until } from './support.ts'

// 연결 상태 전이 — 손으로 움직이는 transport + 가짜 시계. 맨 아래 묶음만 가짜 데스크탑(진짜 http)에 붙는다.

const json = (body: unknown) => ({ status: 200, body: JSON.stringify(body) })
const hello = (runId: string, seq: number): Hello => ({ desktopId: 'd', name: 'pc', appVersion: '0', apiVersion: 1, runId, seq, addresses: [] })
const flush = () => vi.advanceTimersByTimeAsync(0)

/** hello 는 run A / seq 5 로 답하고, 목록·스냅샷은 빈 값으로 답하는 데스크탑 */
function setup() {
  const transport = new ManualTransport()
  const server = { runId: 'A', seq: 5, down: false, status: 200 }
  transport.respond = (request) => {
    if (server.down) throw new Error('닿지 않는다')
    if (server.status !== 200) return { status: server.status, body: '{"error":"거절"}' }
    const path = new URL(request.url).pathname
    if (path === '/v1/hello') return json(hello(server.runId, server.seq))
    if (path === '/v1/projects' || path === '/v1/conversations') return json([])
    if (path.startsWith('/v1/conversations/')) return json({ history: { messages: [] }, seq: server.seq })
    return { status: 404, body: '{}' }
  }
  const connection = new Connection(new RemoteClient({ transport, baseUrl: 'http://10.0.0.2:47600', token: 't' }))
  const seen: ConnectionStatus['kind'][] = []
  connection.subscribe(() => {
    if (seen[seen.length - 1] !== connection.status.kind) seen.push(connection.status.kind)
  })
  /** 붙여서 connected 까지 */
  const connect = async () => {
    connection.start()
    await flush()
    transport.last.handlers.onOpen(200)
    await flush()
  }
  return { transport, server, connection, seen, connect }
}

describe('연결 상태', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => vi.useRealTimers())

  it('idle → connecting → connected. 구독은 hello 가 알려 준 run·seq 뒤부터다', async () => {
    const { transport, connection, seen, connect } = setup()
    expect(connection.status).toEqual({ kind: 'idle' })
    await connect()
    expect(seen).toEqual(['connecting', 'connected'])
    expect(transport.last.url).toBe('http://10.0.0.2:47600/v1/events?run=A&after=5')
  })

  it('스트림이 끊기면 reconnecting — 1초 뒤 다시 붙고, 적용한 마지막 seq 뒤부터 이어 받는다', async () => {
    const { transport, connection, connect } = setup()
    await connect()
    await connection.openConversation('c1')
    transport.last.handlers.onData(sse('turn.started', { cid: 'c1', origin: 'x', message: { id: 'm', role: 'user', text: 'hi' } }, 6))
    transport.last.handlers.onData(sse('turn.progress', { cid: 'c1', item: { kind: 'text', id: 't', text: 'ec', done: false } }, 7))

    transport.last.handlers.onEnd(new Error('끊김'))
    expect(connection.status).toEqual({ kind: 'reconnecting', attempt: 1, retryAt: 1_001_000 })
    expect(transport.streams).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(999)
    expect(transport.streams).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(transport.last.url).toBe('http://10.0.0.2:47600/v1/events?run=A&after=7')
    transport.last.handlers.onOpen(200)
    expect(connection.status).toEqual({ kind: 'connected' })

    // 재생이 이미 본 것과 겹쳐도 한 번만 적용된다
    transport.last.handlers.onData(sse('ready', { runId: 'A', seq: 8 }) + sse('turn.progress', { cid: 'c1', item: { kind: 'text', id: 't', text: 'XX', done: false } }, 7))
    transport.last.handlers.onData(sse('turn.progress', { cid: 'c1', item: { kind: 'text', id: 't', text: 'echo', done: true } }, 8))
    expect(connection.state.views['c1']).toMatchObject({ messages: [{ id: 'm' }], progress: [{ id: 't', text: 'echo', done: true }] })
    expect(connection.state.resync).toBe(0)
  })

  it('계속 실패하면 1·2·4·8·16·30·30초로 벌어지고, 붙으면 처음부터 다시 센다', async () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])

    const { transport, server, connection, connect } = setup()
    await connect()
    server.down = true
    transport.last.handlers.onEnd()
    for (const [attempt, delay] of [[1, 1000], [2, 2000], [3, 4000]] as const) {
      expect(connection.status).toEqual({ kind: 'reconnecting', attempt, retryAt: Date.now() + delay })
      await vi.advanceTimersByTimeAsync(delay)
    }
    expect(connection.status).toMatchObject({ kind: 'reconnecting', attempt: 4 })

    server.down = false
    await vi.advanceTimersByTimeAsync(8000)
    transport.last.handlers.onOpen(200)
    expect(connection.status).toEqual({ kind: 'connected' })
    transport.last.handlers.onEnd()
    expect(connection.status).toMatchObject({ kind: 'reconnecting', attempt: 1 })
  })

  it('앞으로 돌아오면(wake) 기다리지 않고 바로 다시 붙는다', async () => {
    const { transport, connection, connect } = setup()
    await connect()
    transport.last.handlers.onEnd()
    connection.wake()
    await flush()
    expect(transport.streams).toHaveLength(2)
    transport.last.handlers.onOpen(200)
    expect(connection.status).toEqual({ kind: 'connected' })

    // 기다리던 재시도 타이머는 거둬졌다 — 스트림을 또 열지 않는다
    await vi.advanceTimersByTimeAsync(5_000)
    expect(transport.streams).toHaveLength(2)
  })

  it('30초 동안 아무 바이트도 없으면 unresponsive — ping 이 오는 동안은 connected 다', async () => {
    const { transport, connection, connect } = setup()
    await connect()
    await vi.advanceTimersByTimeAsync(29_000)
    transport.last.handlers.onData(': ping\n\n')
    await vi.advanceTimersByTimeAsync(29_000)
    expect(connection.status).toEqual({ kind: 'connected' })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(connection.status).toMatchObject({ kind: 'unresponsive', attempt: 1 })
    expect(transport.streams[0]!.closed).toBe(true)
  })

  it('unresponsive 는 다시 붙을 때까지 유지되고(뒤에서 계속 시도), 붙으면 connected', async () => {
    const { transport, server, connection, connect } = setup()
    await connect()
    server.down = true
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(connection.status).toMatchObject({ kind: 'unresponsive', attempt: 2 })

    server.down = false
    await vi.advanceTimersByTimeAsync(2_000)
    transport.last.handlers.onOpen(200)
    expect(connection.status).toEqual({ kind: 'connected' })
  })

  it('device.revoked 를 받으면 revoked — 다시 붙지 않는다', async () => {
    const { transport, connection, connect } = setup()
    await connect()
    transport.last.handlers.onData(sse('device.revoked', {}))
    transport.last.handlers.onEnd()
    expect(connection.status).toEqual({ kind: 'revoked' })

    const requests = transport.requests.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(transport.requests).toHaveLength(requests)
    expect(connection.status).toEqual({ kind: 'revoked' })
  })

  it('401 은 revoked 다 (hello 에서도, 스트림을 열 때도)', async () => {
    const atHello = setup()
    atHello.server.status = 401
    atHello.connection.start()
    await flush()
    expect(atHello.connection.status).toEqual({ kind: 'revoked' })

    const atStream = setup()
    atStream.connection.start()
    await flush()
    atStream.transport.last.handlers.onOpen(401)
    atStream.transport.last.handlers.onEnd()
    expect(atStream.connection.status).toEqual({ kind: 'revoked' })
  })

  it('reset 을 받으면 목록과 열린 대화의 스냅샷을 다시 받는다', async () => {
    const { transport, server, connection, connect } = setup()
    await connect()
    await connection.loadConversations('/p')
    await connection.openConversation('c1')
    const before = transport.requests.length

    server.runId = 'B'
    server.seq = 2
    transport.last.handlers.onData(sse('reset', { runId: 'B', seq: 2 }))
    await flush()
    expect(transport.requests.slice(before).map((request) => new URL(request.url)).map((url) => url.pathname + url.search).sort()).toEqual(['/v1/conversations/c1', '/v1/conversations?project=%2Fp', '/v1/projects'])
    expect(connection.state).toMatchObject({ runId: 'B', seq: 2, views: { c1: { seq: 2 } } })
  })

  // #187 B4 — 404 는 다시 해도 404 다. 다시 받기를 끝내지 못하면 그 뒤 이벤트(진행 줄은 초당 수십)마다 목록·모든 열린 대화를 또 부른다
  it('다시 받을 때 열린 대화가 404(데스크탑에서 지움)면 그 대화를 닫고 다시 받기를 끝낸다 — 그 뒤 이벤트마다 다시 받지 않는다', async () => {
    const { transport, server, connection, connect } = setup()
    await connect()
    await connection.loadConversations('/p')
    await connection.openConversation('c1')
    const respond = transport.respond
    transport.respond = (request) => (new URL(request.url).pathname === '/v1/conversations/c1' ? { status: 404, body: '{"error":"no such conversation"}' } : respond(request))

    server.runId = 'B'
    server.seq = 10
    transport.last.handlers.onData(sse('reset', { runId: 'B', seq: 10 }))
    await flush()
    const afterReset = transport.requests.length
    expect(connection.state.views['c1']).toBeUndefined()

    // 다른 대화(c2)의 진행 이벤트 20개
    for (let seq = 11; seq <= 30; seq++) {
      transport.last.handlers.onData(sse('turn.progress', { cid: 'c2', item: { kind: 'text', id: 'p', text: String(seq) } }, seq))
      await flush()
    }
    expect(transport.requests.length).toBe(afterReset)
    expect(connection.state.seq).toBe(30)
  })

  it('다시 받기의 404 가 아닌 실패(끊김)는 그대로 실패다 — 열린 대화를 닫지 않는다', async () => {
    const { transport, server, connection, connect } = setup()
    await connect()
    await connection.openConversation('c1')
    const respond = transport.respond
    transport.respond = (request) => (new URL(request.url).pathname === '/v1/conversations/c1' ? { status: 500, body: '{"error":"x"}' } : respond(request))

    server.runId = 'B'
    transport.last.handlers.onData(sse('reset', { runId: 'B', seq: 2 }))
    await flush()
    expect(connection.state.views['c1']).toBeDefined()
  })

  it('다시 붙었는데 hello 의 runId 가 바뀌었으면(데스크탑 재시작) 새 run 으로 구독하고 스냅샷을 다시 받는다', async () => {
    const { transport, server, connection, connect } = setup()
    await connect()
    await connection.openConversation('c1')
    transport.last.handlers.onData(sse('turn.started', { cid: 'c1', origin: 'x', message: { id: 'm', role: 'user', text: 'hi' } }, 6))

    server.runId = 'B'
    server.seq = 0
    transport.last.handlers.onEnd()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(transport.last.url).toBe('http://10.0.0.2:47600/v1/events?run=B&after=0')
    transport.last.handlers.onOpen(200)
    await flush()
    // 다시 받은 스냅샷(빈 기록)이 낡은 모습을 덮는다
    expect(connection.state.views['c1']).toMatchObject({ messages: [], running: false, seq: 0 })
  })

  it('conversations.changed 가 오면 받아 둔 그 프로젝트 목록을 다시 받는다', async () => {
    const { transport, connection, connect } = setup()
    await connect()
    await connection.loadConversations('/p')
    const before = transport.requests.length
    transport.last.handlers.onData(sse('conversations.changed', { project: '/p' }, 6) + sse('conversations.changed', { project: '/other' }, 7))
    await flush()
    expect(transport.requests.slice(before).map((request) => request.url)).toEqual(['http://10.0.0.2:47600/v1/conversations?project=%2Fp'])
    expect(connection.state.staleProjects).toEqual([])
  })

  it('onEvent: 이벤트를 한 번씩 준다 — 열지 않은 대화의 것도 오고, 다시 붙어 재생된 이미 본 seq 는 오지 않는다 (알림이 두 번 울리지 않게)', async () => {
    const { transport, connection, connect } = setup()
    await connect()
    const heard: string[] = []
    connection.onEvent((event) => heard.push(`${event.event}#${event.seq ?? '-'}`))
    // c9 는 열어 두지 않았다 (리듀서는 버리지만 알림은 들어야 한다)
    transport.last.handlers.onData(sse('turn.attention', { cid: 'c9', requests: [] }, 6) + sse('turn.ended', { cid: 'c9', outcome: 'done', message: { role: 'assistant', text: '답' } }, 7))
    expect(heard).toEqual(['turn.attention#6', 'turn.ended#7'])

    transport.last.handlers.onEnd()
    await vi.advanceTimersByTimeAsync(1_000)
    transport.last.handlers.onOpen(200)
    // 재생이 본 것(7)과 겹치고, 새 것(8)이 이어진다. ready 는 seq 가 없다
    transport.last.handlers.onData(sse('ready', { runId: 'A', seq: 8 }) + sse('turn.ended', { cid: 'c9', outcome: 'done', message: { role: 'assistant', text: '답' } }, 7))
    transport.last.handlers.onData(sse('turn.started', { cid: 'c9', origin: 'desktop', message: { role: 'user', text: '또' } }, 8))
    expect(heard).toEqual(['turn.attention#6', 'turn.ended#7', 'ready#-', 'turn.started#8'])
  })

  it('stop 하면 스트림·타이머를 거두고 idle 이다', async () => {
    const { transport, connection, connect } = setup()
    await connect()
    connection.stop()
    expect(connection.status).toEqual({ kind: 'idle' })
    expect(transport.last.closed).toBe(true)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(connection.status).toEqual({ kind: 'idle' })
  })
})

describe('블루투스가 꺼져 있다가 켜지면 (이슈 #270)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => vi.useRealTimers())

  /** hello 가 radio 상태에 따라 BluetoothError 로 실패하는 블루투스 세션 — 켜짐 구독은 손으로 울린다 */
  function bluetoothSetup(failure: 'bluetooth-off' | 'permission') {
    const transport = new ManualTransport()
    const radio = { blocked: true }
    transport.respond = (request) => {
      if (radio.blocked) throw new BluetoothError(failure)
      const path = new URL(request.url).pathname
      if (path === '/v1/hello') return json(hello('A', 5))
      return json([])
    }
    const listeners = new Set<() => void>()
    const whenBluetoothOn = vi.fn((listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    })
    const connection = new Connection(new RemoteClient({ transport, baseUrl: 'bt://d', token: 't' }), { whenBluetoothOn })
    const turnOn = () => {
      radio.blocked = false
      for (const listener of [...listeners]) listener()
    }
    return { transport, connection, listeners, whenBluetoothOn, turnOn }
  }

  it('bluetooth-off 는 needs-action(사유 문구)을 보이며 켜짐을 듣고 — 폴링 없이 기다리다 켜지면 곧바로 connecting → connected', async () => {
    const { transport, connection, listeners, turnOn } = bluetoothSetup('bluetooth-off')
    connection.start()
    await flush()
    expect(connection.status).toEqual({ kind: 'needs-action' })
    expect(connection.failure).toMatchObject({ reason: 'bluetooth-off' })
    expect(listeners.size).toBe(1)

    // 기다리는 동안 다시 시도하지 않는다 (타이머 없음)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(transport.requests).toHaveLength(1)
    expect(connection.status).toEqual({ kind: 'needs-action' })

    turnOn()
    expect(connection.status).toEqual({ kind: 'connecting' })
    expect(listeners.size).toBe(0) // 다시 붙기 시작하면 구독을 거둔다
    await flush()
    transport.last.handlers.onOpen(200)
    expect(connection.status).toEqual({ kind: 'connected' })
    expect(connection.failure).toBeUndefined()
  })

  it('켜졌지만 아직 못 붙으면(또 꺼짐) 다시 켜짐을 기다린다 — 구독은 하나뿐', async () => {
    const { connection, listeners } = bluetoothSetup('bluetooth-off')
    connection.start()
    await flush()
    for (const listener of [...listeners]) listener() // 켜짐 이벤트가 왔지만 어댑터는 아직 꺼짐으로 답한다
    await flush()
    expect(connection.status).toEqual({ kind: 'needs-action' })
    expect(listeners.size).toBe(1)
  })

  it('permission 은 그대로 멈춘다 — 켜짐을 듣지 않고 저절로 다시 시도하지 않는다', async () => {
    const { transport, connection, whenBluetoothOn } = bluetoothSetup('permission')
    connection.start()
    await flush()
    expect(connection.status).toEqual({ kind: 'needs-action' })
    expect(whenBluetoothOn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(transport.requests).toHaveLength(1)
  })

  it('기다리는 중에 stop(세션 닫기)하면 구독을 거두고, 그 뒤 켜져도 붙지 않는다', async () => {
    const { transport, connection, listeners, turnOn } = bluetoothSetup('bluetooth-off')
    connection.start()
    await flush()
    expect(listeners.size).toBe(1)
    connection.stop()
    expect(listeners.size).toBe(0)
    turnOn()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(connection.status).toEqual({ kind: 'idle' })
    expect(transport.requests).toHaveLength(1)
  })

  it('기다리는 중에 [다시 시도] 를 눌러도 구독은 겹치지 않는다', async () => {
    const { connection, listeners, whenBluetoothOn } = bluetoothSetup('bluetooth-off')
    connection.start()
    await flush()
    connection.retry()
    expect(listeners.size).toBe(0)
    await flush()
    expect(connection.status).toEqual({ kind: 'needs-action' })
    expect(listeners.size).toBe(1)
    expect(whenBluetoothOn).toHaveBeenCalledTimes(2)
  })
})

describe('가짜 데스크탑에 붙여서', () => {
  it('턴 중에 스트림이 끊겨도 다시 붙어 같은 대화 모습이 된다 (말풍선·진행 줄이 겹치지 않는다)', async () => {
    const desktop = await startFakeDesktop({ port: 0, stepMs: 150 })
    const connection = new Connection(await pairedClient(desktop))
    try {
      connection.start()
      await until(() => connection.status.kind === 'connected', '연결')
      const [project] = await connection.client.projects()
      await connection.loadConversations(project!.path)
      await connection.openConversation('c_tests')

      await connection.client.send('c_tests', { text: '끊겨도', clientMessageId: 'cm_1' })
      await until(() => (connection.state.views['c_tests']?.progress.length ?? 0) > 0, '첫 진행 줄')
      desktop.dropStreams()
      await until(() => connection.status.kind === 'reconnecting', '다시 연결 중')
      await until(() => connection.state.views['c_tests']?.running === false && connection.status.kind === 'connected', '다시 붙어 턴 끝', 8_000)

      expect(connection.state.views['c_tests']!.messages).toMatchObject([
        { id: 'cm_1', role: 'user', text: '끊겨도' },
        { role: 'assistant', text: 'echo: 끊겨도' },
      ])
      expect(connection.state.views['c_tests']!.messages[1]!.items!.map((item) => item.kind)).toEqual(['think', 'tool', 'text'])
      // 목록도 따라온다 (conversations.changed → 다시 받기)
      await until(() => connection.state.conversations[project!.path]?.[0]?.id === 'c_tests', '목록 갱신')
      expect(connection.state.notices['c_tests']).toEqual({ project: project!.path, status: 'done' })
    } finally {
      connection.stop()
      await desktop.close()
    }
  })

  it('데스크탑이 재시작해도 다시 붙어 스냅샷으로 맞춘다 — 돌던 턴은 "중단됨" 으로 보인다', async () => {
    const desktop = await startFakeDesktop({ port: 0, stepMs: 150 })
    const connection = new Connection(await pairedClient(desktop))
    try {
      connection.start()
      await until(() => connection.status.kind === 'connected', '연결')
      await connection.openConversation('c_tests')
      await connection.client.send('c_tests', { text: '재시작', clientMessageId: 'cm_1' })
      await until(() => connection.state.views['c_tests']?.running === true, '턴 시작')
      const before = connection.state.runId

      desktop.restart()
      await until(() => connection.state.runId !== before && connection.state.views['c_tests']?.running === false, '다시 받은 스냅샷', 8_000)
      expect(connection.state.views['c_tests']!.messages.at(-1)).toMatchObject({ role: 'assistant', interrupted: true })
      expect(connection.state.views['c_tests']!.progress).toEqual([])
    } finally {
      connection.stop()
      await desktop.close()
    }
  })
})
