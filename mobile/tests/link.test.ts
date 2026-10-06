import net from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FAKE_PAIR_CODE, startFakeDesktop, type FakeDesktop } from '../dev/fake-desktop.mts'
import { DEFAULT_ADDRESS, isLoopbackHost, parseAddress } from '../src/app/address.ts'
import { DesktopLink, pairFailure, type DesktopStore, type LinkState, type SavedDesktop } from '../src/app/link.ts'
import type { AppSession } from '../src/app/session.ts'
import { createFetchTransport, createNativePinnedNet, RemoteError, type Transport } from '../src/core/index.ts'
import { nodePinnedNative } from './nodePinned.ts'
import { until } from './support.ts'

// 짝짓기·저장·복원·해제(link.ts)와 진짜 세션(remoteSession.ts)을 가짜 데스크탑(진짜 http·SSE)에 붙여 본다.
// 진짜 데스크탑 서비스(ctx.remote)에 붙이는 것은 desktop.test.ts.

function memoryStore(initial?: SavedDesktop): DesktopStore & { value: SavedDesktop | undefined } {
  const store = {
    value: initial,
    load: async () => store.value,
    save: async (desktop: SavedDesktop) => void (store.value = desktop),
    clear: async () => void (store.value = undefined),
  }
  return store
}

/** 요청을 세는 transport */
function counting(inner: Transport = createFetchTransport()): Transport & { urls: string[] } {
  const urls: string[] = []
  return { urls, stream: (request, handlers) => inner.stream(request, handlers), request: (request) => (urls.push(request.url), inner.request(request)) }
}

let desktop: FakeDesktop
let links: DesktopLink[]
beforeEach(async () => {
  desktop = await startFakeDesktop({ port: 0, stepMs: 5, manualPair: true, pairWaitMs: 300 })
  links = []
})
afterEach(async () => {
  for (const link of links) link.dispose()
  await desktop.close()
})

function newLink(store: DesktopStore = memoryStore(), transport: Transport = createFetchTransport()): DesktopLink {
  const link = new DesktopLink({ store, transport, pinned: createNativePinnedNet(nodePinnedNative()), platform: 'android' })
  links.push(link)
  return link
}
const address = () => `127.0.0.1:${desktop.port}`
const input = (extra: Partial<{ address: string; code: string; deviceName: string }> = {}) => ({ address: address(), code: FAKE_PAIR_CODE, deviceName: 'Pixel 8', ...extra })
const phase = <P extends LinkState['phase']>(link: DesktopLink, name: P): Extract<LinkState, { phase: P }> => {
  expect(link.state.phase).toBe(name)
  return link.state as Extract<LinkState, { phase: P }>
}
/** 짝지어 붙은 세션까지 */
async function linked(store: DesktopStore = memoryStore(), transport?: Transport): Promise<{ link: DesktopLink; session: AppSession }> {
  const link = newLink(store, transport)
  await link.restore()
  const pairing = link.pair(input())
  await until(() => desktop.pendingPair() !== undefined, '짝짓기 요청')
  desktop.answerPair(true)
  await pairing
  const { session } = phase(link, 'linked')
  await until(() => session.getStatus().kind === 'connected', '연결')
  return { link, session }
}

describe('주소', () => {
  it('host · host:port · http(s):// 를 읽고, 포트가 없으면 47600', () => {
    expect(parseAddress(' 10.0.2.2:47611 ')).toEqual({ host: '10.0.2.2', port: 47611, address: '10.0.2.2:47611', scheme: 'http', baseUrl: 'http://10.0.2.2:47611' })
    expect(parseAddress('LOCALHOST')).toMatchObject({ host: 'localhost', port: 47600 })
    expect(parseAddress('http://127.0.0.1:8080/')).toMatchObject({ baseUrl: 'http://127.0.0.1:8080' })
    expect(parseAddress(DEFAULT_ADDRESS)).toMatchObject({ host: '10.0.2.2', port: 47600 })
    for (const bad of ['', 'ftp://10.0.2.2', '10.0.2.2:99999', '10.0.2.2:0', 'a b', '10.0.2.2/path', 'user@10.0.2.2']) expect(parseAddress(bad), bad).toBeUndefined()
  })

  it('방식을 안 쓰면 이 컴퓨터 안은 http, 그 밖은 https(지문 고정). 쓴 방식은 그대로', () => {
    expect(parseAddress('192.168.0.12')).toMatchObject({ scheme: 'https', baseUrl: 'https://192.168.0.12:47600' })
    expect(parseAddress('HTTPS://10.0.2.2:47600')).toMatchObject({ scheme: 'https', baseUrl: 'https://10.0.2.2:47600' })
    expect(parseAddress('http://192.168.0.12:47600')).toMatchObject({ scheme: 'http' }) // 짝(link.ts)이 not-loopback 으로 거절한다
  })

  it('이 컴퓨터 안 주소만 루프백이다 — 비슷하게 생긴 것은 아니다', () => {
    expect(['10.0.2.2', '127.0.0.1', 'localhost', 'LocalHost'].map(isLoopbackHost)).toEqual([true, true, true, true])
    expect(['10.0.2.3', '192.168.0.12', '127.0.0.1.evil.example', 'localhost.example', '10.0.2.22'].map(isLoopbackHost)).toEqual([false, false, false, false, false])
  })
})

describe('짝짓기', () => {
  it('요청을 보내면 허용 대기 — 폰의 확인 코드가 데스크탑에 뜬 것과 같다. 허용되면 붙고 저장된다', async () => {
    const store = memoryStore()
    const link = newLink(store)
    expect(link.state).toEqual({ phase: 'loading' })
    await link.restore()
    expect(link.state).toEqual({ phase: 'unpaired' })

    // 사람이 친 모양 그대로 — 소문자·하이픈·O/I, 이름 앞뒤 공백
    const pairing = link.pair(input({ code: 'devo-dev0-devO', deviceName: '  Pixel 8 ' }))
    await until(() => desktop.pendingPair() !== undefined, '짝짓기 요청')
    const waiting = phase(link, 'pairing')
    expect(waiting.confirm).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    expect(desktop.pendingPair()).toEqual({ deviceName: 'Pixel 8', confirm: waiting.confirm })

    desktop.answerPair(true)
    await pairing
    const { desktop: saved, session } = phase(link, 'linked')
    expect(saved).toMatchObject({ address: address(), baseUrl: `http://${address()}`, desktopName: '가짜 데스크탑 (개발용)', token: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(store.value).toEqual(saved)
    expect(session.desktop).toEqual({ name: '가짜 데스크탑 (개발용)', address: address() })
  })

  it('데스크탑에서 거절하면 denied, 아무도 안 누르면 timeout — 저장되지 않는다', async () => {
    const store = memoryStore()
    const link = newLink(store)
    await link.restore()

    const denied = link.pair(input())
    await until(() => desktop.pendingPair() !== undefined, '짝짓기 요청')
    desktop.answerPair(false)
    await denied
    expect(link.state).toEqual({ phase: 'unpaired', failure: 'denied' })

    await link.pair(input()) // pairWaitMs 300 — 아무도 답하지 않는다
    expect(link.state).toEqual({ phase: 'unpaired', failure: 'timeout' })
    expect(store.value).toBeUndefined()
  })

  it('틀린 코드는 wrong-code — 허용 대기까지 가지 않는다', async () => {
    const link = newLink()
    await link.restore()
    await link.pair(input({ code: 'AAAA-BBBB-CCCC' }))
    expect(link.state).toEqual({ phase: 'unpaired', failure: 'wrong-code' })
    expect(desktop.pendingPair()).toBeUndefined()
  })

  it('보내기 전에 걸러지는 것 — 읽을 수 없는 주소, 12자가 아닌 코드, 빈 이름, 그리고 이 컴퓨터 밖 주소. 요청이 하나도 안 나간다', async () => {
    const transport = counting()
    const link = newLink(memoryStore(), transport)
    await link.restore()
    const failures: unknown[] = []
    for (const bad of [{ address: 'not an address' }, { code: 'DEV0' }, { code: 'DEV0DEV0DEVU' }, { deviceName: ' \n ' }, { address: 'http://192.168.0.12:47600' }, { address: 'http://example.com' }]) {
      await link.pair(input(bad))
      failures.push((link.state as { failure?: string }).failure)
    }
    expect(failures).toEqual(['bad-address', 'bad-code', 'bad-code', 'no-name', 'not-loopback', 'not-loopback'])
    expect(transport.urls).toEqual([])
  })

  it('아무도 안 듣는 포트면 refused (PC 는 닿았다 — 모바일 연결이 꺼져 있다)', async () => {
    // 열었다 닫은 포트 — 아무도 듣지 않는다
    const closed = await new Promise<number>((resolve) => {
      const server = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = server.address() as net.AddressInfo
        server.close(() => resolve(port))
      })
    })
    const link = newLink()
    await link.restore()
    await link.pair(input({ address: `127.0.0.1:${closed}` }))
    expect(link.state).toEqual({ phase: 'unpaired', failure: 'refused' })
  })

  it('데스크탑의 답을 사유로: 403(거절·틀린 코드·만료) · 408 · 429 · 그 밖', () => {
    expect(pairFailure(new RemoteError(403, 'denied on the desktop'))).toBe('denied')
    expect(pairFailure(new RemoteError(403, 'wrong pairing code'))).toBe('wrong-code')
    expect(pairFailure(new RemoteError(403, 'no pairing in progress'))).toBe('wrong-code')
    expect(pairFailure(new RemoteError(408, 'nobody answered on the desktop'))).toBe('timeout')
    expect(pairFailure(new RemoteError(429, 'too many failed attempts'))).toBe('blocked')
    expect(pairFailure(new RemoteError(500, 'boom'))).toBe('failed')
    expect(pairFailure(new TypeError('fetch failed'))).toBe('unreachable')
  })

  it('403 은 본문의 reason 으로 가른다 — 글이 바뀌어도. reason 이 없으면(옛 데스크탑) 글로', () => {
    expect(pairFailure(new RemoteError(403, 'pairing denied: expired', 'no-code'))).toBe('wrong-code')
    expect(pairFailure(new RemoteError(403, 'not denied, just wrong', 'wrong-code'))).toBe('wrong-code')
    expect(pairFailure(new RemoteError(403, 'nope', 'denied'))).toBe('denied')
    expect(pairFailure(new RemoteError(403, 'denied on the desktop'))).toBe('denied')
    expect(pairFailure(new RemoteError(403, 'wrong pairing code'))).toBe('wrong-code')
  })
})

describe('저장·복원·해제', () => {
  it('앱을 다시 켜면 저장된 짝으로 바로 붙는다 (짝짓기 없이)', async () => {
    const store = memoryStore()
    const first = await linked(store)
    first.link.dispose()

    const transport = counting()
    const again = newLink(store, transport)
    await again.restore()
    const { session } = phase(again, 'linked')
    await until(() => session.getStatus().kind === 'connected' && session.getState().projects.length > 0, '다시 붙음')
    expect(transport.urls.some((url) => url.endsWith('/v1/pair'))).toBe(false)
  })

  it('설정의 연결 해제 → 저장을 지우고 연결 화면으로. 다시 켜도 짝이 없다', async () => {
    const store = memoryStore()
    const { link } = await linked(store)
    await link.disconnect()
    expect(link.state).toEqual({ phase: 'unpaired' })
    expect(store.value).toBeUndefined()

    const again = newLink(store)
    await again.restore()
    expect(again.state).toEqual({ phase: 'unpaired' })
  })

  it('데스크탑에서 해제되면 저장을 지우고 연결 화면으로 (revoked)', async () => {
    const store = memoryStore()
    const { link } = await linked(store)
    desktop.revokeAll()
    await until(() => link.state.phase === 'unpaired', '해제')
    expect(link.state).toEqual({ phase: 'unpaired', revoked: true })
    expect(store.value).toBeUndefined()
  })

  it('저장된 토큰이 이미 죽었으면(401) 붙지 않고 연결 화면으로', async () => {
    const store = memoryStore({ address: address(), baseUrl: `http://${address()}`, deviceId: 'dev_x', token: 'dead', desktopName: 'pc' })
    const link = newLink(store)
    await link.restore()
    await until(() => link.state.phase === 'unpaired', '해제')
    expect(link.state).toEqual({ phase: 'unpaired', revoked: true })
    expect(store.value).toBeUndefined()
  })
})

describe('진짜 세션 (remoteSession) — 화면이 보는 것이 전부 데스크탑에서 온다', () => {
  it('붙으면 프로젝트·대화 목록·모델을 받는다', async () => {
    const { session } = await linked()
    await until(() => session.models.length > 0, '목록')
    const [project] = session.getState().projects
    expect(project).toMatchObject({ name: 'litecode' })
    expect(session.getState().conversations[project!.path]!.map((conversation) => conversation.id)).toEqual(['c_login', 'c_tests', 'c_readme'])
    expect(session.models[0]).toMatchObject({ displayName: 'Qwen 3.8 27B' })
  })

  it('대화를 열고 보내면 내 말·진행 줄·답이 이벤트로 붙는다', async () => {
    const { session } = await linked()
    session.openConversation('c_tests')
    await until(() => session.getState().views['c_tests'] !== undefined, '스냅샷')
    expect(await session.send('c_tests', '안녕')).toBe(true)
    await until(() => session.getState().views['c_tests']!.messages.length === 2, '답')
    expect(session.getState().views['c_tests']!.messages).toMatchObject([
      { role: 'user', text: '안녕' },
      { role: 'assistant', text: 'echo: 안녕' },
    ])
    expect(session.getNotice()).toBeUndefined()

    session.closeConversation('c_tests')
    expect(session.getState().views['c_tests']).toBeUndefined()
  })

  it('전체 권한 모드 대화에 보내면 false 와 desktop-only 안내 — 다음 보내기에서 안내가 지워진다', async () => {
    const { session } = await linked()
    expect(await session.send('c_readme', '보내기')).toBe(false)
    expect(session.getNotice()).toBe('desktop-only')
    expect(desktop.turnCount()).toBe(0)

    expect(await session.send('c_tests', '보내기')).toBe(true)
    expect(session.getNotice()).toBeUndefined()
  })

  it('승인 답 · 다른 기기가 먼저 답했으면 elsewhere 안내 · 되돌리기 · 중지', async () => {
    const { session } = await linked()
    session.openConversation('c_tests')
    await until(() => session.getState().views['c_tests'] !== undefined, '스냅샷')
    const view = () => session.getState().views['c_tests']!

    await session.send('c_tests', '[ask] 실행')
    await until(() => view().attention.length === 1, '승인 카드')
    await session.send('c_tests', '다음 것')
    await until(() => view().queue.length === 1, '대기열')
    expect(await session.takeQueue('c_tests')).toBe('다음 것')

    const request = view().attention[0]!
    session.reply(request, 'once')
    await until(() => view().attention.length === 0, '카드 사라짐')
    session.reply(request, 'once') // 이미 답한 요청
    await until(() => session.getNotice() === 'elsewhere', 'elsewhere')

    session.stop('c_tests')
    await until(() => !view().running, '턴 끝')
    expect(view().messages.at(-1)).toMatchObject({ role: 'assistant' })
  })

  it('새 대화를 만들면 열린 채로 id 가 온다', async () => {
    const { session } = await linked()
    await until(() => session.getState().projects.length > 0, '목록')
    const cid = await session.createConversation(session.getState().projects[0]!.path)
    expect(session.getState().views[cid!]).toMatchObject({ messages: [], running: false })
    expect(await session.createConversation('/etc')).toBeUndefined()
    expect(session.getNotice()).toBe('failed')
  })

  it('끊긴 사이에 열어 못 받은 대화는 다시 붙을 때 받는다', async () => {
    const real = createFetchTransport()
    let down = false
    // 내려가 있는 동안에는 그 대화의 스냅샷 요청이 닿지 않는다
    const flaky: Transport = {
      stream: (request, handlers) => real.stream(request, handlers),
      request: (request) => (down && request.url.endsWith('/v1/conversations/c_login') ? Promise.reject(new Error('닿지 않는다')) : real.request(request)),
    }
    const { session } = await linked(memoryStore(), flaky)
    down = true
    session.openConversation('c_login')
    desktop.dropStreams()
    await until(() => session.getStatus().kind === 'reconnecting', '끊김')
    expect(session.getState().views['c_login']).toBeUndefined()

    down = false
    session.wake()
    await until(() => session.getState().views['c_login'] !== undefined, '다시 붙어 받음')
    expect(session.getState().views['c_login']!.messages).toHaveLength(2)
  })
})
