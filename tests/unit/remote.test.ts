import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RemoteStatus } from '../../src/services/remote.ts'
import { hashToken } from '../../src/services/remote/devices.ts'
import { EventLog } from '../../src/services/remote/eventLog.ts'
import { confirmCode, newPairCode, normalizePairCode } from '../../src/services/remote/pairing.ts'
import { tr } from '../../src/i18n.ts'
import type { Attention, AttentionAnswer, TurnItem } from '../../shared/contract.ts'
import type { ConversationSnapshot, Hello, RemoteConversation, RemoteModel } from '../../shared/remote.ts'
import { MODEL, box, parseFrames, setUp, start, tearDown, until } from './support/remoteHarness.ts'

// ctx.remote — 모바일이 붙는 문 (이슈 #56, 설계 01t 2·3절). 서버는 진짜 HTTP(127.0.0.1 빈 포트)로 띄운다 (support/remoteHarness.ts).
// 모바일 클라이언트 코어(폰 앱이 쓰는 그 코드)를 이 서버에 붙이는 테스트는 mobile/tests/desktop.test.ts 에 있다 — 루트 vitest 는
// mobile/ 을 못 읽는다(mobile/tsconfig.json 이 expo 설정을 물려받는다).

let root: string
let project: string
let cleanups: typeof box.cleanups

beforeEach(async () => {
  await setUp()
  ;({ root, project, cleanups } = box)
})
afterEach(tearDown)

describe('짝짓기 코드', () => {
  it('12자 Crockford base32 — 헷갈리는 글자가 없고, 친 글자는 대문자·칸 나눔 제거·O→0·I/L→1 로 견준다', () => {
    for (let index = 0; index < 50; index++) expect(newPairCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/)
    expect(normalizePairCode('ab1o-il0z 9xyz')).toBe('AB10110Z9XYZ')
  })

  it('확인 코드는 8자(XXXX-XXXX)이고 코드·기기 이름·플랫폼으로 정해진다', () => {
    const code = confirmCode('AB10110Z9XYZ', 'Pixel 8', 'android')
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    expect(confirmCode('AB10110Z9XYZ', 'Pixel 8', 'android')).toBe(code)
    expect(confirmCode('AB10110Z9XYZ', 'Pixel 9', 'android')).not.toBe(code)
  })
})

describe('이벤트 링', () => {
  it('seq 를 붙이고, 크기·나이를 넘은 것은 버린다 — 벗어난 after 는 이어 줄 수 없다', () => {
    let now = 0
    const log = new EventLog(() => now, 3, 1000)
    for (const name of ['a', 'b', 'c', 'd']) log.append(name, {})
    expect(log.seq).toBe(4)
    expect(log.after(2).map((entry) => entry.event)).toEqual(['c', 'd'])
    expect(log.canResume(log.runId, 1)).toBe(true) // 2·3·4 가 남아 있다
    expect(log.canResume(log.runId, 0)).toBe(false) // 1 은 버려졌다
    expect(log.canResume('run_other', 4)).toBe(false)
    expect(log.canResume(log.runId, 5)).toBe(false) // 아직 안 낸 seq
    expect(log.canResume(log.runId, Number.NaN)).toBe(false)
    now = 2000
    log.append('e', {})
    expect(log.after(0).map((entry) => entry.event)).toEqual(['e']) // 15분(여기선 1초) 지난 것
    expect(log.canResume(log.runId, 3)).toBe(false)
    expect(log.canResume(log.runId, 4)).toBe(true)
  })
})

// 켜짐은 하나다 — ctx.remote 가 떠 있음 = 켜짐 (기능 `remote`, #124·#126). 서비스 안의 스위치는 없다
describe('떠 있음 = 켜짐', () => {
  it('서비스가 뜨면 운반이 올라오는 대로 127.0.0.1 에서 듣는다 — 운반이 내려가면 포트를 닫는다', async () => {
    const { remote, httpDown } = await start()
    const status = remote.status()
    expect(status.addresses).toHaveLength(1)
    expect(status.addresses[0]).toMatch(/^127\.0\.0\.1:\d+$/)
    expect(await reachable(status.port)).toBe(true)
    await httpDown()
    expect(remote.status().addresses).toEqual([])
    expect(await reachable(status.port)).toBe(false)
  })

  it('서비스가 내려가면 포트를 닫는다. 기기 파일은 남아 다시 올라오면 그 기기를 안다', async () => {
    const first = await start()
    await first.pair()
    const stored = JSON.parse(await fs.readFile(path.join(root, 'remote-devices.json'), 'utf8'))
    expect(stored).toMatchObject({ version: 1, devices: [{ name: 'Pixel 8' }] })
    expect(stored).not.toHaveProperty('enabled')
    expect(stored.desktopId).toMatch(/^[0-9a-f]{16}$/)
    const port = first.remote.status().port
    await cleanups.pop()!()
    expect(await reachable(port)).toBe(false)
    const second = await start()
    expect(second.remote.status().addresses).toHaveLength(1)
    expect(second.remote.status().devices).toHaveLength(1)
    expect((await second.api<Hello>('GET', '/v1/hello')).status).toBe(401)
  })

  // 옛 파일에는 설정 > 모바일 스위치의 값(enabled)이 남아 있다 — 꺼짐이었어도 듣고, 기기·데스크탑 id 는 그대로 읽는다
  it('옛 기기 파일의 enabled 필드는 보지 않는다 — 기기는 그대로 붙고, 다음 쓰기 때 필드가 사라진다', async () => {
    const file = path.join(root, 'remote-devices.json')
    const device = { id: 'dev_old', name: 'Old Phone', platform: 'android', tokenHash: hashToken('old-token'), pairedAt: 1 }
    await fs.writeFile(file, JSON.stringify({ version: 1, desktopId: '0123456789abcdef', enabled: false, devices: [device] }))
    const { remote, api, pair } = await start()
    expect(remote.status().addresses).toHaveLength(1)
    expect(remote.status().devices.map((entry) => entry.id)).toEqual(['dev_old'])
    expect((await api<Hello>('GET', '/v1/hello', { token: 'old-token' })).status).toBe(200)
    await pair()
    const stored = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(stored).not.toHaveProperty('enabled')
    expect(stored.desktopId).toBe('0123456789abcdef')
    expect(stored.devices).toHaveLength(2)
  })

  it('포트를 다른 프로그램이 쓰고 있으면 사유(EADDRINUSE)를 남기고 짝짓기를 시작할 수 없다', async () => {
    const blocker = net.createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise((resolve) => blocker.close(resolve)))
    const { remote } = await start({ port: (blocker.address() as net.AddressInfo).port })
    expect(remote.status()).toMatchObject({ addresses: [], error: { code: 'EADDRINUSE' } })
    expect(() => remote.startPairing()).toThrow()
  })

  it('평문 리스너는 루프백 주소만 연다 — 0.0.0.0·사내망 주소는 열지 않는다', async () => {
    for (const host of ['0.0.0.0', '192.168.0.10', '::']) {
      const { remote } = await start({ listeners: [{ host: '127.0.0.1' }, { host }] })
      const status = remote.status()
      expect(status.addresses).toEqual([])
      expect(status.error?.code).toBe('ENOTLOOPBACK')
    }
  })
})

/** 그 포트에 붙어지나 */
function reachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

describe('짝짓기', () => {
  it('코드가 맞으면 데스크탑 [허용] 을 기다리고, 허용하면 기기 id·토큰을 준다 — 파일에는 토큰 해시만 남는다', async () => {
    const { ctx, remote, requestPair, api } = await start()
    const pairing = remote.startPairing().pairing!
    expect(pairing.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    const uri = new URL(pairing.uri)
    expect(uri.protocol).toBe('litecode:')
    expect(Object.fromEntries(uri.searchParams)).toMatchObject({ v: '1', n: 'test-pc', a: remote.status().addresses[0], fp: '', c: pairing.code.replace(/-/g, '') })

    const changes: RemoteStatus[] = []
    ctx.on('remote/changed', (status) => void changes.push(status))
    const { answer, request } = await requestPair('  Pixel\u0007 8  ', pairing.code.toLowerCase()) // 친 모양 그대로(소문자·칸 나눔)
    expect(request).toMatchObject({ deviceName: 'Pixel 8', platform: 'android' }) // 제어 문자는 뺀다
    expect(request.confirm).toBe(confirmCode(pairing.code.replace(/-/g, ''), 'Pixel 8', 'android'))
    expect(remote.status().pairing).toBeUndefined() // 1회용 — 맞게 쓴 순간 사라진다
    expect(changes.at(-1)!.requests).toHaveLength(1)

    remote.answerPair(request.id, true)
    const paired = await answer
    expect(paired.status).toBe(200)
    expect(paired.body.deviceId).toMatch(/^dev_[0-9a-f]{16}$/)
    expect(Buffer.from(paired.body.token, 'base64url')).toHaveLength(32) // 256bit
    expect(remote.status().requests).toEqual([])
    expect(remote.status().devices).toMatchObject([{ id: paired.body.deviceId, name: 'Pixel 8', platform: 'android', connected: false }])

    const file = await fs.readFile(path.join(root, 'remote-devices.json'), 'utf8')
    expect(file).not.toContain(paired.body.token)
    expect(JSON.parse(file).devices).toMatchObject([{ id: paired.body.deviceId, tokenHash: hashToken(paired.body.token) }])
    expect((await api('GET', '/v1/hello', { token: paired.body.token })).status).toBe(200)
  })

  it('거절하면 403 이고 기기는 생기지 않는다', async () => {
    const { remote, requestPair } = await start()
    const { answer, request } = await requestPair()
    remote.answerPair(request.id, false)
    expect((await answer).status).toBe(403)
    expect(remote.status()).toMatchObject({ requests: [], devices: [] })
  })

  it('아무도 답하지 않으면 시간 초과(408) — 확인 창이 걷힌다', async () => {
    const { remote, requestPair } = await start({ pairWaitMs: 40 })
    const { answer } = await requestPair()
    expect((await answer).status).toBe(408)
    expect(remote.status()).toMatchObject({ requests: [], devices: [] })
  })

  it('폰이 기다리다 끊으면 확인 창이 걷힌다', async () => {
    const { remote, base } = await start()
    const code = remote.startPairing().pairing!.code
    const request = http.request(`${base()}/v1/pair`, { method: 'POST', agent: false, headers: { 'content-type': 'application/json' } })
    request.on('error', () => {})
    request.end(JSON.stringify({ code, deviceName: 'Pixel', platform: 'android' }))
    await until(() => remote.status().requests.length === 1, '요청')
    request.destroy()
    await until(() => remote.status().requests.length === 0, '걷힘')
    expect(remote.status().devices).toEqual([])
  })

  it('틀린 코드는 403 — 5회째에 코드를 버려, 그 뒤엔 맞는 코드도 안 된다', async () => {
    const { remote, api } = await start()
    const code = remote.startPairing().pairing!.code
    const attempt = (given: string) => api('POST', '/v1/pair', { body: { code: given, deviceName: 'x', platform: 'ios' } })
    for (let count = 1; count <= 5; count++) {
      expect(remote.status().pairing).toBeDefined()
      expect((await attempt('000000000000')).status).toBe(403)
    }
    expect(remote.status().pairing).toBeUndefined()
    expect((await attempt(code)).status).toBe(403)
    expect(remote.status().requests).toEqual([])
  })

  it('코드는 2분 뒤 만료되고, 한 번 쓴 코드는 다시 못 쓴다. 짝짓기를 시작하지 않았으면 어떤 코드도 안 된다', async () => {
    const { remote, api, requestPair } = await start()
    const attempt = (code: string) => api('POST', '/v1/pair', { body: { code, deviceName: 'x', platform: 'android' } })
    expect((await attempt('AAAAAAAAAAAA')).status).toBe(403)

    const expired = remote.startPairing().pairing!
    expect(expired.expiresAt - (Date.now() + box.offset)).toBeGreaterThan(115_000)
    box.offset += 2 * 60_000 + 1
    expect(remote.status().pairing).toBeUndefined()
    expect((await attempt(expired.code)).status).toBe(403)

    const used = remote.startPairing().pairing!.code
    const { answer, request } = await requestPair('Pixel', used)
    remote.answerPair(request.id, true)
    expect((await answer).status).toBe(200)
    expect((await attempt(used)).status).toBe(403)

    remote.startPairing()
    expect(remote.cancelPairing().pairing).toBeUndefined()
  })

  it('본문이 모자라면 400 (코드를 쓰지 않는다)', async () => {
    const { remote, api } = await start()
    const code = remote.startPairing().pairing!.code
    expect((await api('POST', '/v1/pair', { body: { code, platform: 'android' } })).status).toBe(400)
    expect((await api('POST', '/v1/pair', { body: { code, deviceName: 'x', platform: 'windows' } })).status).toBe(400)
    expect((await api('POST', '/v1/pair', { raw: '{' })).status).toBe(400)
    expect(remote.status().pairing).toBeDefined()
  })
})

describe('인증·경계', () => {
  it('토큰이 없거나 틀리면 401. 폰에 열지 않은 경로는 없다(404)', async () => {
    const { api, pair } = await start()
    const { token } = await pair()
    expect((await api('GET', '/v1/hello')).status).toBe(401)
    expect((await api('GET', '/v1/projects', { token: 'nope' })).status).toBe(401)
    expect((await api('GET', '/v1/events', { token: 'nope' })).status).toBe(401)
    for (const route of ['/v1/settings', '/v1/providers', '/v1/fs', '/v1/pty', '/v1/mcp', '/v1/skills', '/v1/conversations/c1/shell', '/v2/hello']) {
      expect((await api('GET', route, { token })).status).toBe(404)
      expect((await api('POST', route, { token, body: {} })).status).toBe(404)
    }
    expect((await api('DELETE', '/v1/conversations/c1', { token })).status).toBe(405)
  })

  it('`Origin` 헤더가 있는 요청은 토큰이 맞아도 거절한다 — 짝짓기도', async () => {
    const { remote, api, pair } = await start()
    const { token } = await pair()
    const code = remote.startPairing().pairing!.code
    expect((await api('GET', '/v1/hello', { token, headers: { origin: 'http://evil.example' } })).status).toBe(403)
    expect((await api('POST', '/v1/pair', { headers: { origin: 'null' }, body: { code, deviceName: 'x', platform: 'android' } })).status).toBe(403)
    expect(remote.status().requests).toEqual([])
    expect(remote.status().pairing).toBeDefined() // 코드도 쓰이지 않았다
  })

  it('본문 상한을 넘으면 413', async () => {
    const { api, pair, save } = await start()
    const { token } = await pair()
    await save('c1')
    const answer = await api('POST', '/v1/conversations/c1/messages', { token, body: { text: 'x'.repeat(300 * 1024), clientMessageId: 'big' } })
    expect(answer.status).toBe(413)
  })

  it('인증 실패가 1분에 10회면 그 IP 를 5분 차단한다 — 맞는 토큰도 429', async () => {
    const { api, pair } = await start()
    const { token } = await pair()
    for (let count = 0; count < 10; count++) expect((await api('GET', '/v1/hello', { token: 'wrong' })).status).toBe(401)
    const blocked = await api('GET', '/v1/hello', { token })
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(290)
    box.offset += 5 * 60_000 + 1
    expect((await api('GET', '/v1/hello', { token })).status).toBe(200)
  })

  it('1분에 걸쳐 흩어진 실패는 차단하지 않는다', async () => {
    const { api, pair } = await start()
    const { token } = await pair()
    for (let count = 0; count < 12; count++) {
      expect((await api('GET', '/v1/hello', { token: 'wrong' })).status).toBe(401)
      box.offset += 10_000
    }
    expect((await api('GET', '/v1/hello', { token })).status).toBe(200)
  })

  it('기기를 해제하면 그 토큰은 곧바로 401 이고, 열린 스트림은 `device.revoked` 를 받고 끊긴다. 다른 기기는 그대로다', async () => {
    const { remote, api, pair, events } = await start()
    const first = await pair('first')
    const second = await pair('second')
    const stream = await events(first.token)
    const other = await events(second.token)
    await until(() => remote.status().devices.every((device) => device.connected), '둘 다 연결')
    const status = await remote.revoke(first.deviceId)
    expect(status.devices.map((device) => device.name)).toEqual(['second'])
    await until(() => stream.ended(), '스트림 끊김')
    expect(parseFrames(stream.raw()).at(-1)).toEqual({ event: 'device.revoked', data: {}, seq: undefined })
    expect((await api('GET', '/v1/hello', { token: first.token })).status).toBe(401)
    expect(other.ended()).toBe(false)
    expect((await api('GET', '/v1/hello', { token: second.token })).status).toBe(200)
    expect(JSON.parse(await fs.readFile(path.join(root, 'remote-devices.json'), 'utf8')).devices).toHaveLength(1)
  })

  it('접속하면 마지막 접속 시각이 적힌다', async () => {
    const { remote, api, pair } = await start()
    const { token } = await pair()
    expect(remote.status().devices[0]!.lastSeenAt).toBeUndefined()
    await api('GET', '/v1/hello', { token })
    expect(remote.status().devices[0]!.lastSeenAt).toBeGreaterThan(Date.now() - 5000)
  })
})

describe('REST', () => {
  it('hello — 데스크탑 id·이름·버전·실행 id·seq·주소', async () => {
    const { remote, api, pair } = await start()
    const { token } = await pair()
    const hello = (await api<Hello>('GET', '/v1/hello', { token })).body
    expect(hello).toMatchObject({ name: 'test-pc', appVersion: '1.2.3', apiVersion: 1, seq: 0, addresses: remote.status().addresses })
    expect(hello.runId).toMatch(/^run_[0-9a-f]{12}$/)
    expect(hello.desktopId).toMatch(/^[0-9a-f]{16}$/)
  })

  it('프로젝트는 등록된 것만, 대화 목록은 그 프로젝트 것만 최근 순으로 — usage·labels·shells 는 싣지 않는다', async () => {
    const { ctx, api, pair, save } = await start()
    const { token } = await pair()
    await save('old', { updatedAt: 1000, usage: { turns: 3 }, labels: { msg_1: '/hi' }, attachments: { msg_1: [{ kind: 'file', name: 'a.txt' }] } })
    await save('new', { updatedAt: 2000, engineSessionId: 'ses_x' })
    await ctx.sessions.addShell('new', { id: 's1', at: 1, position: 0, command: 'ls', output: 'secret', exitCode: 0 } as never)
    await ctx.sessions.save({ id: 'elsewhere', project: '/not/registered', title: 't', updatedAt: 3000 })

    expect((await api('GET', '/v1/projects', { token })).body).toEqual([{ path: project, name: 'proj', displayPath: expect.any(String), favorite: false }])
    const list = (await api<RemoteConversation[]>('GET', `/v1/conversations?project=${encodeURIComponent(project)}`, { token })).body
    expect(list).toEqual([
      { id: 'new', project, title: '대화 new', updatedAt: 2000, model: MODEL, mode: 'build', engineSessionId: 'ses_x' },
      { id: 'old', project, title: '대화 old', updatedAt: 1000, model: MODEL, mode: 'build' },
    ])
    // 등록 안 된 프로젝트의 대화는 폰에 없다
    expect((await api('GET', `/v1/conversations?project=${encodeURIComponent('/not/registered')}`, { token })).body).toEqual([])
    expect((await api('GET', '/v1/conversations', { token })).body).toEqual([])
    expect((await api('GET', '/v1/conversations/elsewhere', { token })).status).toBe(404)
    expect((await api('POST', '/v1/conversations/elsewhere/messages', { token, body: { text: 'hi', clientMessageId: 'a' } })).status).toBe(404)
  })

  it('목록의 진행 중·답 필요는 알림 기능 없이도 ctx.chat 의 도는 턴에서 온다 — 이벤트(notices.changed)도 같이 (#126 E3)', async () => {
    const { ctx, api, pair, save, turn, events } = await start()
    const { token } = await pair()
    await save('c1')
    await save('c2')
    const stream = await events(token)
    const statuses = async () => Object.fromEntries((await api<RemoteConversation[]>('GET', `/v1/conversations?project=${encodeURIComponent(project)}`, { token })).body.map((entry) => [entry.id, entry.status]))
    const notices = () => parseFrames(stream.raw()).filter((frame) => frame.event === 'notices.changed').map((frame) => frame.data)
    expect(ctx.get('notifications')).toBeUndefined()
    expect(await statuses()).toEqual({ c1: undefined, c2: undefined })

    await ctx.chat.send('c1', { text: 'go' })
    const call = await turn(1)
    expect(await statuses()).toEqual({ c1: 'running', c2: undefined })

    call.attention([{ kind: 'permission', id: 'per_1', sessionId: call.sessionId, action: 'bash', resources: ['ls'] } as Attention])
    expect(await statuses()).toEqual({ c1: 'attention', c2: undefined })
    call.attention([])
    expect(await statuses()).toEqual({ c1: 'running', c2: undefined })

    call.finish()
    await until(() => ctx.chat.snapshot().c1 === undefined, '턴 끝')
    expect(await statuses()).toEqual({ c1: undefined, c2: undefined })
    await until(() => notices().length === 4, 'notices')
    expect(notices()).toEqual([{ c1: { project, status: 'running' } }, { c1: { project, status: 'attention' } }, { c1: { project, status: 'running' } }, {}])
  })

  it('안 본 완료·실패는 알림 기능의 것 그대로 — 도는 턴이 있는 대화는 ctx.chat 것이 이긴다', async () => {
    const { ctx, api, pair, save, turn } = await start()
    const { token } = await pair()
    await save('c1')
    await save('c2')
    ctx.provide('notifications')
    ;(ctx as unknown as { notifications: unknown }).notifications = { snapshot: () => ({ c1: { project, status: 'done' }, c2: { project, status: 'failed' } }) }
    await ctx.chat.send('c1', { text: 'go' })
    const call = await turn(1)
    const list = (await api<RemoteConversation[]>('GET', `/v1/conversations?project=${encodeURIComponent(project)}`, { token })).body
    expect(Object.fromEntries(list.map((entry) => [entry.id, entry.status]))).toEqual({ c1: 'running', c2: 'failed' })
    call.finish()
  })

  it('모델 목록에는 주소·키가 없다', async () => {
    const { api, pair } = await start()
    const { token } = await pair()
    const answer = await api<RemoteModel[]>('GET', '/v1/models', { token })
    expect(answer.body).toEqual([
      { providerId: 'gw', providerName: 'Gateway', modelId: 'm1', displayName: 'Model One' },
      { providerId: 'gw', providerName: 'Gateway', modelId: 'm2', displayName: 'm2' },
    ])
    expect(JSON.stringify(answer.body)).not.toContain('secret.example')
  })

  it('새 대화 — 등록된 프로젝트에만, full 모드는 거절. 첫 메시지를 보내기 전에는 저장하지 않는다', async () => {
    const { ctx, api, pair, turn } = await start()
    const { token } = await pair()
    expect((await api('POST', '/v1/conversations', { token, body: { project: '/etc' } })).status).toBe(404)
    expect((await api('POST', '/v1/conversations', { token, body: { project, mode: 'full' } })).status).toBe(403)
    expect((await api('POST', '/v1/conversations', { token, body: { project, mode: 'nope' } })).status).toBe(400)
    expect((await api('POST', '/v1/conversations', { token, body: { project, model: { providerId: 'gw', modelId: 'zz' } } })).status).toBe(400)

    const created = await api<RemoteConversation>('POST', '/v1/conversations', { token, body: { project, mode: 'plan', model: { providerId: 'gw', modelId: 'm2' } } })
    expect(created.status).toBe(200)
    expect(created.body).toMatchObject({ project, title: '', mode: 'plan', model: { providerId: 'gw', modelId: 'm2' } })
    const cid = created.body.id
    expect(await ctx.sessions.list()).toEqual([]) // 빈 새 대화가 보관 개수를 차지하지 않는다
    expect((await api<RemoteConversation[]>('GET', `/v1/conversations?project=${encodeURIComponent(project)}`, { token })).body.map((entry) => entry.id)).toEqual([cid])
    expect((await api<ConversationSnapshot>('GET', `/v1/conversations/${cid}`, { token })).body).toEqual({ history: { messages: [] }, seq: 1 })

    // 첫 메시지 — 만들 때 정한 프로젝트·모델·모드로 ctx.chat 이 저장하고 제목을 짓는다
    expect((await api('POST', `/v1/conversations/${cid}/messages`, { token, body: { text: '첫 말', clientMessageId: 'a' } })).body).toEqual({ state: 'sent' })
    expect((await turn(1)).mode).toBe('plan')
    expect(await ctx.sessions.list()).toMatchObject([{ id: cid, project, title: '첫 말', mode: 'plan', model: { providerId: 'gw', modelId: 'm2' } }])
    expect((await api<RemoteConversation[]>('GET', `/v1/conversations?project=${encodeURIComponent(project)}`, { token })).body).toHaveLength(1)
  })

  it('모델·모드를 안 주면 첫 모델과 설정의 기본 모드 — 기본이 전체 권한이어도 폰의 새 대화는 full 이 아니다', async () => {
    const { ctx, api, pair } = await start()
    const { token } = await pair()
    ctx.settings.set({ defaultMode: 'ask' })
    expect((await api<RemoteConversation>('POST', '/v1/conversations', { token, body: { project } })).body).toMatchObject({ mode: 'ask', model: MODEL })
    ctx.settings.set({ defaultMode: 'full' })
    expect((await api<RemoteConversation>('POST', '/v1/conversations', { token, body: { project } })).body).toMatchObject({ mode: 'build' })
  })

  it('보내기 — 202 sent, 출처는 그 기기. 도는 중에 또 보내면 queued. 같은 clientMessageId 는 다시 보내도 한 번만 간다', async () => {
    const { api, pair, save, turn, llm, chatEvents, events } = await start()
    const { token, deviceId } = await pair()
    await save('c1')
    const stream = await events(token)
    const send = (text: string, clientMessageId: string) => api('POST', '/v1/conversations/c1/messages', { token, body: { text, clientMessageId } })

    const first = await send('안녕', 'cm_1')
    expect(first).toMatchObject({ status: 202, body: { state: 'sent' } })
    expect((await turn(1)).prompt).toBe('안녕')
    expect(chatEvents[0]![1]).toMatchObject({ cid: 'c1', origin: `device:${deviceId}` })

    // 응답을 못 받아 다시 보낸 것 — 처음 결과 그대로, 턴도 대기열도 늘지 않는다
    expect(await send('안녕', 'cm_1')).toMatchObject({ status: 202, body: { state: 'sent' } })
    expect(await send('둘째', 'cm_2')).toMatchObject({ status: 202, body: { state: 'queued' } })
    expect(await send('둘째', 'cm_2')).toMatchObject({ status: 202, body: { state: 'queued' } })
    await until(() => stream.has('queue.changed'), 'queue.changed')
    expect(parseFrames(stream.raw()).filter((frame) => frame.event === 'queue.changed').map((frame) => frame.data)).toEqual([{ cid: 'c1', items: ['둘째'] }])

    llm.calls[0]!.finish()
    expect((await turn(2)).prompt).toBe('둘째')
    expect(llm.calls).toHaveLength(2)
    llm.calls[1]!.finish()
    await until(() => parseFrames(stream.raw()).filter((frame) => frame.event === 'turn.ended').length === 2, '턴 끝 둘')

    // 스트림에는 계약의 모양만 — 데스크탑 화면용 덧붙인 필드(conversation·held·attachments·removed)는 없다
    const frames = parseFrames(stream.raw())
    const started = frames.find((frame) => frame.event === 'turn.started')!
    expect(Object.keys(started.data).sort()).toEqual(['cid', 'message', 'origin'])
    expect(started.data).toMatchObject({ cid: 'c1', origin: deviceId, message: { role: 'user', text: '안녕' } })
    expect(Object.keys(frames.find((frame) => frame.event === 'turn.ended')!.data).sort()).toEqual(['cid', 'message', 'outcome'])
    expect(frames.filter((frame) => frame.event === 'queue.changed').every((frame) => Object.keys(frame.data).sort().join() === 'cid,items')).toBe(true)
    expect(frames.filter((frame) => frame.event === 'conversations.changed').every((frame) => Object.keys(frame.data).join() === 'project')).toBe(true)
  })

  it('데스크탑이 보낸 턴의 origin 은 desktop', async () => {
    const { ctx, pair, save, turn, events } = await start()
    const { token } = await pair()
    await save('c1')
    const stream = await events(token)
    await ctx.chat.send('c1', { text: 'pc 에서', origin: 'user' })
    await turn(1)
    await until(() => stream.has('turn.started'), 'turn.started')
    expect(parseFrames(stream.raw()).find((frame) => frame.event === 'turn.started')!.data.origin).toBe('desktop')
  })

  it('전체 권한 모드 — 그 모드의 대화에 보내기도, 그 모드로 바꾸기도 403', async () => {
    const { api, pair, save, llm } = await start()
    const { token } = await pair()
    await save('full', { mode: 'full' })
    await save('c1')
    expect((await api('POST', '/v1/conversations/full/messages', { token, body: { text: 'rm -rf', clientMessageId: 'a' } })).status).toBe(403)
    expect((await api('POST', '/v1/conversations/c1/messages', { token, body: { text: 'hi', clientMessageId: 'b', mode: 'full' } })).status).toBe(403)
    expect(llm.calls).toEqual([])
  })

  it('보내기의 본문 검사 — 글·clientMessageId 가 없으면 400, 모르는 모델·모드도 400. 고른 모델·모드는 그 턴부터 그 대화의 것', async () => {
    const { ctx, api, pair, save, turn } = await start()
    const { token } = await pair()
    await save('c1')
    const send = (body: unknown) => api('POST', '/v1/conversations/c1/messages', { token, body })
    expect((await send({ text: '  ', clientMessageId: 'a' })).status).toBe(400)
    expect((await send({ text: 'hi' })).status).toBe(400)
    expect((await send({ text: 'hi', clientMessageId: 'a', model: { providerId: 'x', modelId: 'y' } })).status).toBe(400)
    expect((await send({ text: 'hi', clientMessageId: 'a', mode: 'root' })).status).toBe(400)
    expect((await send({ text: '!ls @a.ts /cmd', clientMessageId: 'a', mode: 'plan', model: { providerId: 'gw', modelId: 'm2' } })).status).toBe(202)
    // 입력 트리거를 풀지 않는다 — 친 글 그대로 프롬프트다
    expect(await turn(1)).toMatchObject({ prompt: '!ls @a.ts /cmd', mode: 'plan' })
    expect((await ctx.sessions.list())[0]).toMatchObject({ mode: 'plan', model: { providerId: 'gw', modelId: 'm2' } })
  })

  it('스냅샷 — 끝난 대화는 기록과 seq, 도는 중이면 기록은 그 턴의 내 말까지 + live(진행 줄·승인·대기열)', async () => {
    const { api, pair, save, turn, llm, ctx } = await start()
    const { token } = await pair()
    await save('c1')
    expect((await api<ConversationSnapshot>('GET', '/v1/conversations/c1', { token })).body).toEqual({ history: { messages: [] }, seq: 0 })

    await ctx.chat.send('c1', { text: '하나' })
    ;(await turn(1)).finish()
    await until(() => ctx.chat.snapshot().c1 === undefined, '턴 끝')
    const idle = (await api<ConversationSnapshot>('GET', '/v1/conversations/c1', { token })).body
    expect(idle.live).toBeUndefined()
    expect(idle.history.messages.map((message) => message.text)).toEqual(['하나', 'echo: 하나'])

    await ctx.chat.send('c1', { text: '둘' })
    const running = await turn(2)
    const tool: TurnItem = { kind: 'tool', id: 't1', name: 'bash', status: 'running' }
    const ask: Attention = { kind: 'permission', id: 'per_1', sessionId: running.sessionId, action: 'bash', resources: ['ls'] } as Attention
    running.progress(tool)
    running.attention([ask])
    await ctx.chat.send('c1', { text: '셋' })
    const live = (await api<ConversationSnapshot>('GET', '/v1/conversations/c1', { token })).body
    expect(live.history.messages.map((message) => message.text)).toEqual(['하나', 'echo: 하나', '둘'])
    expect(live.live).toEqual({ progress: [tool], attention: [ask], queue: ['셋'] })
    expect(live.seq).toBe((await api<Hello>('GET', '/v1/hello', { token })).body.seq)
    expect((await api('GET', '/v1/conversations/nope', { token })).status).toBe(404)
    llm.calls[1]!.finish()
  })

  it('중지 — 도는 턴을 멈추고(interrupted), 대기열 되돌리기는 이 기기가 쌓은 것을 합쳐 준다', async () => {
    const { ctx, api, pair, save, turn, chatEvents } = await start()
    const { token } = await pair()
    await save('c1')
    expect((await api('POST', '/v1/conversations/c1/stop', { token })).body).toEqual({ stopped: false })
    expect((await api('POST', '/v1/conversations/c1/queue/take', { token })).body).toEqual({ text: '' })

    await api('POST', '/v1/conversations/c1/messages', { token, body: { text: '하나', clientMessageId: 'a' } })
    await turn(1)
    await api('POST', '/v1/conversations/c1/messages', { token, body: { text: '둘', clientMessageId: 'b' } })
    await api('POST', '/v1/conversations/c1/messages', { token, body: { text: '셋', clientMessageId: 'c' } })
    await ctx.chat.send('c1', { text: 'pc 것', origin: 'user' })
    expect((await api('POST', '/v1/conversations/c1/stop', { token })).body).toEqual({ stopped: true })
    await until(() => chatEvents.some(([name]) => name === 'turn.ended'), '턴 끝')
    expect(chatEvents.find(([name]) => name === 'turn.ended')![1]).toMatchObject({ outcome: 'interrupted' })
    expect((await api('POST', '/v1/conversations/c1/queue/take', { token })).body).toEqual({ text: '둘\n셋' })
    expect(ctx.chat.takeQueue('c1')?.text).toBe('pc 것') // 데스크탑이 쌓은 것은 데스크탑 입력창으로
    expect((await api('POST', '/v1/conversations/nope/stop', { token })).status).toBe(404)
    expect((await api('POST', '/v1/conversations/nope/queue/take', { token })).status).toBe(404)
  })

  it('승인 답 — 기다리는 요청이면 ctx.chat 에 전하고 ok, 이미 풀린 요청은 오류가 아니라 elsewhere', async () => {
    const { ctx, api, pair, save, turn, llm } = await start()
    const { token } = await pair()
    await save('c1')
    await ctx.chat.send('c1', { text: 'go' })
    const call = await turn(1)
    const reply = (rid: string, answer: AttentionAnswer | undefined) => api('POST', `/v1/attention/${call.sessionId}/${rid}`, { token, body: { answer } })

    // 아무것도 기다리지 않는다 (다른 기기가 먼저 답했다)
    expect((await reply('per_1', 'once')).body).toEqual({ handled: 'elsewhere' })
    expect(llm.replies).toEqual([])

    call.attention([{ kind: 'permission', id: 'per_1', sessionId: call.sessionId, action: 'bash', resources: ['ls'] } as Attention])
    expect((await reply('per_1', undefined)).status).toBe(400)
    expect((await reply('per_1', 'always' as never)).status).toBe(400)
    expect(await reply('per_1', 'once')).toMatchObject({ status: 200, body: { handled: 'ok' } })
    expect(llm.replies).toEqual([[call.sessionId, 'per_1', 'once']])

    // 카드는 아직 떠 있는데 엔진에서는 이미 풀렸다 (데스크탑이 한발 먼저) — ctx.llm 이 던진 것을 elsewhere 로
    llm.replyError = tr('error.attentionGone')
    expect(await reply('per_1', 'reject')).toMatchObject({ status: 200, body: { handled: 'elsewhere' } })
    llm.replyError = tr('error.attentionReply', { status: 404 })
    expect(await reply('per_1', 'reject')).toMatchObject({ status: 200, body: { handled: 'elsewhere' } })
    // 그 밖의 실패는 오류다
    llm.replyError = tr('error.attentionReply', { status: 500 })
    expect((await reply('per_1', 'reject')).status).toBe(502)
    // 다른 세션의 요청 id 로는 못 답한다
    llm.replyError = undefined
    expect((await api('POST', '/v1/attention/ses_other/per_1', { token, body: { answer: 'once' } })).body).toEqual({ handled: 'elsewhere' })
    expect(llm.replies).toHaveLength(1)
    call.finish()
  })
})

describe('이벤트 스트림', () => {
  it('연결 직후 ready(id 없음), 그 뒤 이벤트는 seq 순 — `after` 로 이어 받고, 못 이으면 reset', async () => {
    const { remote, api, pair, save, turn, events, ctx } = await start()
    const { token } = await pair()
    await save('c1')
    const first = await events(token)
    await until(() => first.frames.length === 1, 'ready')
    const hello = (await api<Hello>('GET', '/v1/hello', { token })).body
    expect(first.frames[0]).toEqual({ event: 'ready', data: { runId: hello.runId, seq: 0 }, seq: undefined })
    expect(first.status()).toBe(200)
    await until(() => remote.status().devices[0]!.connected, '연결 표시')

    await ctx.chat.send('c1', { text: '하나' })
    const call = await turn(1)
    call.progress({ kind: 'text', id: 'x', text: 'ec', done: false })
    await until(() => parseFrames(first.raw()).some((frame) => frame.event === 'turn.progress'), 'progress')
    const seen = parseFrames(first.raw())
    expect(seen.slice(1).map((frame) => frame.seq)).toEqual(seen.slice(1).map((_, index) => index + 1))
    const last = seen.at(-1)!.seq!
    first.close()
    await until(() => !remote.status().devices[0]!.connected, '끊김 표시')

    // 끊긴 사이에 턴이 끝났다
    call.finish()
    await until(() => ctx.chat.snapshot().c1 === undefined, '턴 끝')

    const resumed = await events(token, `?run=${hello.runId}&after=${last}`)
    await until(() => parseFrames(resumed.raw()).some((frame) => frame.event === 'turn.ended'), '재생')
    const replayed = parseFrames(resumed.raw())
    expect(replayed[0]).toMatchObject({ event: 'ready', seq: undefined })
    expect(replayed[1]!.seq).toBe(last + 1)
    expect(replayed.map((frame) => frame.event)).toContain('turn.ended')
    expect(replayed.some((frame) => frame.event === 'turn.started')).toBe(false) // 이미 받은 것은 다시 안 온다

    // 실행이 다르거나(데스크탑 재시작) 링을 벗어난 after — reset 하나, 재생 없음
    for (const query of [`?run=run_other&after=1`, `?run=${hello.runId}&after=9999`, `?run=${hello.runId}&after=x`]) {
      const reset = await events(token, query)
      await until(() => parseFrames(reset.raw()).length >= 1, 'reset')
      expect(parseFrames(reset.raw())).toEqual([{ event: 'reset', data: { runId: hello.runId, seq: replayed.at(-1)!.seq }, seq: undefined }])
      reset.close()
    }
  })

  it('조용하면 `: ping` 을 보낸다', async () => {
    const { pair, events } = await start({ pingMs: 15 })
    const { token } = await pair()
    const stream = await events(token)
    await until(() => stream.raw().split(': ping\n\n').length > 3, 'ping')
    expect(parseFrames(stream.raw()).map((frame) => frame.event)).toEqual(['ready'])
  })

  it('알림 상태가 바뀌면 notices.changed — 알림 기능이 없어도 나머지는 그대로 돈다', async () => {
    const { ctx, pair, events } = await start()
    const { token } = await pair()
    const stream = await events(token)
    ctx.emit('notifications/changed', { c1: { project, status: 'running' } })
    await until(() => parseFrames(stream.raw()).length === 2, 'notices')
    expect(parseFrames(stream.raw())[1]).toEqual({ event: 'notices.changed', data: { c1: { project, status: 'running' } }, seq: 1 })
  })

  it('운반이 내려갔다 올라오면 새 실행이다 — 붙어 있던 스트림은 끊기고, 옛 run 으로 이으면 reset', async () => {
    const { api, pair, events, httpDown, httpUp } = await start()
    const { token } = await pair()
    const before = (await api<Hello>('GET', '/v1/hello', { token })).body
    const stream = await events(token)
    await httpDown()
    await until(() => stream.ended(), '끊김')
    await httpUp()
    const after = (await api<Hello>('GET', '/v1/hello', { token })).body // 기기는 그대로 짝지어져 있다
    expect(after.runId).not.toBe(before.runId)
    const resumed = await events(token, `?run=${before.runId}&after=0`)
    await until(() => parseFrames(resumed.raw()).length === 1, 'reset')
    expect(parseFrames(resumed.raw())[0]!.event).toBe('reset')
  })
})
