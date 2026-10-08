import { createHash, createPrivateKey, X509Certificate } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isPrivatePeer, privateAddresses } from '../../src/services/remote/lan.ts'
import { loadTlsIdentity, spkiFingerprint } from '../../src/services/remote/tlsIdentity.ts'
import type { KeyCipher } from '../../src/services/providers.ts'
import { fingerprintCode } from '../../shared/remotePairing.ts'
import { isLoopbackHost, PAIR_URI_PREFIX, pairUri, parsePairUri, type Hello, type PairLink } from '../../shared/remote.ts'
import { box, parseFrames, setUp, start, tearDown, until } from './support/remoteHarness.ts'

// 사내망 연결 (01t 3절) — TLS 1.3 + 자체 서명 + 공개키 지문(SPKI SHA-256) 고정 + 사설 IPv4 주소마다 바인딩 + 사설 대역 필터 + QR.
// 사내망 주소를 시험 머신에서 고를 수 없으므로 TLS 운반의 "들을 주소" 와 "받을 상대" 를 바꿔 루프백에서 띄운다 (기본값은 lan.ts 를 따로 본다).
//
// 지문 고정 클라이언트: Node 는 체인 검증이 실패하면(자체 서명) checkServerIdentity 를 부르지 않는다 — 그래서 TLS 를 먼저 맺고
// 받은 인증서의 공개키 지문을 견준 뒤에만 그 소켓으로 HTTP 를 보낸다 (지문이 다르면 한 바이트도 안 보낸다). 폰의 고정도 이 순서여야 한다.

beforeEach(setUp)
afterEach(tearDown)

/** TLS 를 맺고 지문을 견준다 — 다르면 끊고 던진다 */
async function pinnedSocket(address: string, fingerprint: string, extra: tls.ConnectionOptions = {}): Promise<tls.TLSSocket> {
  const { host, port } = split(address)
  const socket = tls.connect({ host, port, rejectUnauthorized: false, ...extra })
  box.cleanups.push(() => socket.destroy())
  await Promise.race([once(socket, 'secureConnect'), once(socket, 'error').then(([error]) => Promise.reject(error)), once(socket, 'close').then(() => Promise.reject(new Error('closed')))])
  const got = spkiFingerprint(socket.getPeerX509Certificate()!.publicKey)
  if (got !== fingerprint) {
    socket.destroy()
    throw new Error('fingerprint mismatch')
  }
  return socket
}

/** 지문을 견준 소켓으로 요청 하나 */
async function tlsApi<T = any>(address: string, fingerprint: string, method: string, route: string, init: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const socket = await pinnedSocket(address, fingerprint)
  const payload = init.body === undefined ? undefined : JSON.stringify(init.body)
  return new Promise((resolve, reject) => {
    const request = http.request(
      { createConnection: () => socket, method, path: route, headers: { ...(init.token && { authorization: `Bearer ${init.token}` }), ...(payload && { 'content-type': 'application/json' }) } },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => (text += chunk))
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : undefined }))
      },
    )
    request.on('error', reject)
    request.end(payload)
  })
}

function split(address: string): { host: string; port: number } {
  const at = address.lastIndexOf(':')
  return { host: address.slice(0, at).replace(/^\[|\]$/g, ''), port: Number(address.slice(at + 1)) }
}

/** 루프백에서 TLS 를 띄운 데스크탑 — 평문 http 는 그대로 함께 뜬다 */
async function startTls(tlsOptions: Parameters<typeof start>[0] extends infer O ? (O extends { tls?: infer T } ? T : never) : never = {}) {
  const desktop = await start({ tls: { addresses: () => ['127.0.0.1'], allowPeer: () => true, ...tlsOptions } })
  const status = desktop.remote.status()
  const tlsAddress = status.addresses[1] ?? '' // 첫째는 평문 루프백 (harness 가 HTTP 를 먼저 올린다)
  return { ...desktop, tlsAddress, fingerprint: status.fingerprint! }
}

describe('신원 — 키 하나, 인증서는 띄울 때마다', () => {
  it('자체 서명 인증서(ECDSA P-256)를 만들고, 지문은 공개키(SPKI DER)의 SHA-256 base64url 이다', async () => {
    const file = path.join(box.root, 'key.json')
    const identity = await loadTlsIdentity(file)
    const cert = new X509Certificate(identity.cert)
    expect(cert.verify(cert.publicKey)).toBe(true) // 자기 키로 서명했다
    expect(cert.subject).toBe('CN=litecode')
    expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1')
    const spki = createPrivateKey(identity.key)
    expect(identity.fingerprint).toBe(createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64url'))
    expect(identity.fingerprint).toBe(spkiFingerprint(spki))
    expect(identity.fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(new Date(cert.validTo).getTime()).toBeGreaterThan(Date.now() + 9 * 365 * 24 * 3600_000)
  })

  it('인증서는 X.509 v3 — 서버 인증서의 보통 모양(BasicConstraints CA:false · KeyUsage digitalSignature · EKU serverAuth). 같은 키면 지문은 그대로', async () => {
    const file = path.join(box.root, 'key.json')
    const identity = await loadTlsIdentity(file)
    const cert = new X509Certificate(identity.cert)
    // TBSCertificate 의 첫 칸이 [0] EXPLICIT version = 2(v3)
    const header = (bytes: Buffer, at: number): number => (bytes[at + 1]! < 0x80 ? at + 2 : at + 2 + (bytes[at + 1]! & 0x7f))
    const tbs = header(cert.raw, 0)
    const version = header(cert.raw, tbs)
    expect([...cert.raw.subarray(version, version + 5)]).toEqual([0xa0, 0x03, 0x02, 0x01, 0x02])
    expect(cert.ca).toBe(false)
    expect(cert.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1'])
    expect(cert.toLegacyObject()).toMatchObject({ subject: { CN: 'litecode' } })
    expect(cert.verify(cert.publicKey)).toBe(true)
    // 키 파일은 그대로 — 인증서 모양이 바뀌어도 SPKI 지문은 키에서 나온다 (짝지은 폰이 그대로 붙는다)
    const again = await loadTlsIdentity(file)
    expect(spkiFingerprint(createPrivateKey(again.key))).toBe(identity.fingerprint)
    expect(createHash('sha256').update(new X509Certificate(again.cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64url')).toBe(identity.fingerprint)
  })

  it('다시 읽으면 키가 같아 지문이 같다 — 인증서는 새로 만든다(일련번호가 다르다)', async () => {
    const file = path.join(box.root, 'key.json')
    const first = await loadTlsIdentity(file)
    const second = await loadTlsIdentity(file)
    expect(second.fingerprint).toBe(first.fingerprint)
    expect(new X509Certificate(second.cert).serialNumber).not.toBe(new X509Certificate(first.cert).serialNumber)
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
  })

  it('봉할 수 있으면 봉해서 둔다(파일에 PEM 이 없다). 봉한 키를 풀 수 없으면 새 키로 덮지 않고 던진다', async () => {
    const file = path.join(box.root, 'key.json')
    let available = true
    const cipher: KeyCipher = {
      available: () => available,
      encrypt: (plain) => Buffer.from(plain, 'utf8').reverse(),
      decrypt: (sealed) => Buffer.from(sealed).reverse().toString('utf8'),
    }
    const first = await loadTlsIdentity(file, cipher)
    const text = await fs.readFile(file, 'utf8')
    expect(text).not.toContain('PRIVATE KEY')
    expect(JSON.parse(text)).toMatchObject({ version: 1, sealed: true })
    expect((await loadTlsIdentity(file, cipher)).fingerprint).toBe(first.fingerprint)
    available = false
    await expect(loadTlsIdentity(file, cipher)).rejects.toMatchObject({ code: 'ETLSKEY', keyStore: true })
    // 키체인이 풀기를 거절해도(복호화가 던짐) 같은 표시 — 화면이 키체인 안내를 보인다 (이슈 #231)
    available = true
    const denied: KeyCipher = { ...cipher, decrypt: () => { throw new Error('Error while decrypting the ciphertext') } }
    await expect(loadTlsIdentity(file, denied)).rejects.toMatchObject({ code: 'ETLSKEY', keyStore: true })
    expect(await fs.readFile(file, 'utf8')).toBe(text)
  })

  it('봉한 키를 못 풀어 TLS 운반이 못 뜨면 상태 오류에 keyStore 표시가 실린다 (코드는 ETLSKEY 그대로, 이슈 #231)', async () => {
    let available = true
    const cipher: KeyCipher = {
      available: () => available,
      encrypt: (plain) => Buffer.from(plain, 'utf8').reverse(),
      decrypt: (sealed) => Buffer.from(sealed).reverse().toString('utf8'),
    }
    await loadTlsIdentity(path.join(box.root, 'remote-tls-key.json'), cipher)
    available = false
    const desktop = await start({ tls: { addresses: () => ['127.0.0.1'], allowPeer: () => true, cipher } })
    expect(desktop.remote.status().error).toMatchObject({ code: 'ETLSKEY', keyStore: true })
  })
})

describe('사내망 주소', () => {
  it('사설 대역(10/8·172.16/12·192.168/16·100.64/10)의 IPv4 만 받는다 — 공인·루프백·링크 로컬·IPv6 는 아니다', () => {
    for (const address of ['10.0.0.1', '10.255.255.254', '172.16.0.1', '172.31.255.1', '192.168.1.20', '100.64.0.1', '100.127.255.1', '::ffff:192.168.0.5']) {
      expect(isPrivatePeer(address), address).toBe(true)
    }
    for (const address of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1', '100.128.0.1', '127.0.0.1', '169.254.1.1', '::1', 'fe80::1', 'fd00::1', '0.0.0.0', '', undefined]) {
      expect(isPrivatePeer(address), String(address)).toBe(false)
    }
  })

  it('들을 주소는 사설 IPv4 를 가진 인터페이스의 주소들 — 루프백·IPv6·공인 주소는 빼고 겹치지 않게', () => {
    const entry = (address: string, family: 'IPv4' | 'IPv6' = 'IPv4', internal = false) => ({ address, family, internal, netmask: '', mac: '', cidr: null }) as any
    expect(
      privateAddresses({
        lo0: [entry('127.0.0.1', 'IPv4', true), entry('::1', 'IPv6', true)],
        en0: [entry('fe80::1', 'IPv6'), entry('192.168.0.10')],
        en1: [entry('203.0.113.5')],
        utun3: [entry('100.70.1.2'), entry('192.168.0.10')],
      }),
    ).toEqual(['192.168.0.10', '100.70.1.2'])
  })

  it('스킴은 호스트로 정해진다 — 루프백만 평문', () => {
    expect(['127.0.0.1', '[::1]', '::1', '127.1.2.3'].every(isLoopbackHost)).toBe(true)
    expect(['192.168.0.10', '10.0.2.2', 'localhost', '[fe80::1]'].some(isLoopbackHost)).toBe(false)
  })
})

describe('TLS 운반', () => {
  it('같은 경로·같은 REST 를 TLS 1.3 으로 낸다 — 지문이 같은 클라이언트만 요청을 보낸다', async () => {
    const { remote, tlsAddress, fingerprint, pair } = await startTls()
    expect(remote.status().addresses).toHaveLength(2) // 평문 루프백 + TLS
    const socket = await pinnedSocket(tlsAddress, fingerprint)
    expect(socket.getProtocol()).toBe('TLSv1.3')
    expect((await tlsApi(tlsAddress, fingerprint, 'GET', '/v1/hello')).status).toBe(401)
    const { token } = await pair()
    const hello = await tlsApi<Hello>(tlsAddress, fingerprint, 'GET', '/v1/hello', { token })
    expect(hello.status).toBe(200)
    expect(hello.body).toMatchObject({ fingerprint, addresses: remote.status().addresses })
    // 지문이 다르면 보내기 전에 끊는다
    await expect(tlsApi(tlsAddress, 'A'.repeat(43), 'GET', '/v1/hello', { token })).rejects.toThrow('fingerprint mismatch')
  })

  it('체인을 믿는 보통 클라이언트는 붙지 못하고(자체 서명), TLS 1.2 는 받지 않는다', async () => {
    const { tlsAddress, fingerprint } = await startTls()
    await expect(pinnedSocket(tlsAddress, fingerprint, { rejectUnauthorized: true })).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
    await expect(pinnedSocket(tlsAddress, fingerprint, { maxVersion: 'TLSv1.2' })).rejects.toThrow()
  })

  it('이벤트 스트림도 TLS 로 열린다', async () => {
    const { tlsAddress, fingerprint, pair } = await startTls()
    const { token } = await pair()
    const socket = await pinnedSocket(tlsAddress, fingerprint)
    let raw = ''
    const request = http.get({ createConnection: () => socket, path: '/v1/events', headers: { authorization: `Bearer ${token}` } }, (response) => {
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => (raw += chunk))
    })
    request.on('error', () => {})
    box.cleanups.push(() => request.destroy())
    await until(() => parseFrames(raw).some((frame) => frame.event === 'ready'), 'ready')
  })

  it('짝짓기 — QR(uri)에는 TLS 주소·지문·코드·만료가 실리고, TLS 로 온 요청의 확인 코드는 지문 앞 8자다', async () => {
    const { remote, tlsAddress, fingerprint } = await startTls()
    const pairing = remote.startPairing().pairing!
    const link = parsePairUri(pairing.uri!)!
    expect(link).toEqual({
      version: 1,
      desktopId: expect.stringMatching(/^[0-9a-f]{16}$/),
      name: 'test-pc',
      addresses: [tlsAddress], // 평문 루프백은 싣지 않는다
      fingerprint,
      code: pairing.code.replace(/-/g, ''),
      expiresAt: Math.floor(pairing.expiresAt / 1000),
    })
    expect(remote.status()).toMatchObject({ fingerprint, fingerprintCode: fingerprintCode(fingerprint) })

    const answer = tlsApi(tlsAddress, fingerprint, 'POST', '/v1/pair', { body: { code: link.code, deviceName: 'Galaxy', platform: 'android' } })
    await until(() => remote.status().requests.length > 0, '짝짓기 요청')
    const request = remote.status().requests[0]!
    expect(request.confirm).toBe(fingerprintCode(fingerprint))
    expect(request.pinned).toBe(true)
    remote.answerPair(request.id, true)
    expect((await answer).status).toBe(200)
  })

  it('사설 대역 밖에서 온 접속은 TLS 전에 닫는다 — 막은 것도 마지막 수신 시도로 남는다', async () => {
    // 받을 상대는 기본값(사설 대역만) — 루프백(127.0.0.1)에서 붙으면 막힌다
    const { remote, tlsAddress, fingerprint } = await startTls({ allowPeer: undefined })
    expect(remote.status().lastAttemptAt).toBeUndefined() // 수신 시도 없음
    await expect(pinnedSocket(tlsAddress, fingerprint)).rejects.toThrow()
    await until(() => remote.status().lastAttemptAt !== undefined, '수신 시도')
  })

  it('모든 주소(0.0.0.0·::)에서는 듣지 않는다 — 들을 사내망 주소가 없다는 사유를 남긴다', async () => {
    const { remote } = await start({ tls: { addresses: () => ['0.0.0.0', '::'] } })
    const status = remote.status()
    expect(status.addresses).toHaveLength(1) // 평문 루프백뿐
    expect(status.error?.code).toBe('ENOLAN')
    expect(status.fingerprint).toBeUndefined()
    expect(remote.startPairing().pairing!.uri).toBeUndefined()
  })

  it('주소가 바뀌면 다시 바인딩하고 붙어 있는 폰에 addresses.changed 를 보낸다 — 없어진 주소는 닫는다', async () => {
    let hosts = ['127.0.0.1']
    const { remote, tlsAddress, fingerprint, pair, events } = await startTls({ addresses: () => hosts, pollMs: 20 })
    const { token } = await pair()
    const stream = await events(token)
    const port = split(tlsAddress).port
    hosts = ['::1']
    await until(() => stream.has('addresses.changed'), 'addresses.changed')
    const moved = `[::1]:${port}`
    expect(remote.status().addresses).toContain(moved)
    expect(remote.status().addresses).not.toContain(tlsAddress)
    expect(parseFrames(stream.raw()).find((frame) => frame.event === 'addresses.changed')!.data).toEqual({ addresses: remote.status().addresses })
    expect(await reachable('127.0.0.1', port)).toBe(false)
    expect((await tlsApi(moved, fingerprint, 'GET', '/v1/hello', { token })).status).toBe(200)
  })

  it('모바일 연결을 끄면(서비스가 내려가면) TLS 포트도 닫는다', async () => {
    const { tlsAddress } = await startTls()
    const { host, port } = split(tlsAddress)
    expect(await reachable(host, port)).toBe(true)
    await box.cleanups.pop()!()
    expect(await reachable(host, port)).toBe(false)
  })
})

describe('QR 글', () => {
  const link: PairLink = { version: 1, desktopId: 'abcdef0123456789', name: '김 의 PC & 2', addresses: ['192.168.0.10:47600', '100.70.1.2:47600'], fingerprint: 'q'.repeat(43), code: 'AB10110Z9XYZ', expiresAt: 1_800_000_000 }

  it('litecode://pair?v&d&n&a&fp&c&x — 읽으면 같은 값', () => {
    const uri = pairUri(link)
    expect(uri.startsWith(`${PAIR_URI_PREFIX}v=1&d=abcdef0123456789&n=`)).toBe(true)
    expect(uri).toContain('&a=192.168.0.10%3A47600%2C100.70.1.2%3A47600&fp=')
    expect(parsePairUri(uri)).toEqual(link)
    // URLSearchParams 로 만든 글(+ 공백)도 읽는다
    const viaSearchParams = `${PAIR_URI_PREFIX}${new URLSearchParams({ v: '1', d: link.desktopId, n: link.name, a: link.addresses.join(','), fp: link.fingerprint!, c: link.code, x: String(link.expiresAt) })}`
    expect(parsePairUri(viaSearchParams)).toEqual(link)
  })

  it('모양이 다르면 읽지 않는다 — 지문·주소·코드가 없거나 다른 스킴', () => {
    expect(parsePairUri('https://example.com/?v=1')).toBeUndefined()
    expect(parsePairUri(pairUri({ ...link, fingerprint: '' }))).toBeUndefined()
    expect(parsePairUri(pairUri({ ...link, addresses: [] }))).toBeUndefined()
    expect(parsePairUri(pairUri({ ...link, code: '' }))).toBeUndefined()
    expect(parsePairUri(`${PAIR_URI_PREFIX}v=1&n=%E0%A4%A`)).toBeUndefined()
  })

  it('지문 앞 8자 — SPKI SHA-256 의 앞 40bit 를 Crockford base32 로, XXXX-XXXX', () => {
    const digest = createHash('sha256').update('any key').digest()
    const fingerprint = digest.toString('base64url')
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
    let bits = 0n
    for (const byte of digest.subarray(0, 5)) bits = (bits << 8n) | BigInt(byte)
    let text = ''
    for (let index = 7; index >= 0; index--) text += alphabet[Number((bits >> BigInt(index * 5)) & 31n)]
    expect(fingerprintCode(fingerprint)).toBe(`${text.slice(0, 4)}-${text.slice(4)}`)
  })
})

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, host)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}
