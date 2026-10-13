import net from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REMOTE_PORT_TRIES } from '../../src/services/remote.ts'
import { box, setUp, start, tearDown } from './support/remoteHarness.ts'

// 고정 포트 점유 — 설치본 + dev 를 동시에 띄우면 같은 고정 포트를 둘 다 쓰려 한다 (피드백 #2, 이슈 #332).
// 운반은 점유 중인 포트를 다음 포트 순으로 피해 듣는다. 실물이 아니라 고정 포트를 시험 머신에서 점유해 본다.

beforeEach(setUp)
afterEach(tearDown)

/** 포트 하나를 잠깐 묶어 본다 — 다른 인스턴스가 듣고 있으면 안 된다 */
function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => void probe.close(() => resolve(true)))
    probe.listen(port, '127.0.0.1')
  })
}

/** base + base+1 … base+count-1 이 다 빈 base 를 골라 준다 (점유 시험의 자리) */
async function freeBase(count: number): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const probe = await new Promise<net.Server>((resolve, reject) => {
      const server = net.createServer()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve(server))
    })
    const base = (probe.address() as net.AddressInfo).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    let allFree = true
    for (let port = base + 1; port < base + count; port++) if (!(await isFree(port))) { allFree = false; break }
    if (allFree) return base
  }
  throw new Error('빈 포트 묶음을 찾지 못했다')
}

/** 포트를 점유하고 거두는 함수(멱등)를 준다 */
function occupy(port: number): Promise<() => Promise<void>> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    let released = false
    server.listen(port, '127.0.0.1', () =>
      resolve(async () => {
        if (released) return
        released = true
        await new Promise<void>((done) => server.close(() => done()))
      }),
    )
  })
}

describe('HTTP 운반 — 고정 포트가 점유되면 다음 포트로 피한다 (이슈 #332)', () => {
  it('베이스 포트가 점유 중이면 그 포트를 피해 듣는다 — 오류가 없고 실제로 응답한다. 비면 다시 베이스로', async () => {
    const base = await freeBase(2)
    const release = await occupy(base)
    box.cleanups.push(release)
    const { remote, httpDown, httpUp, api } = await start({ port: base })
    const status = remote.status()
    expect(status.error).toBeUndefined()
    expect(status.port).not.toBe(base)
    expect(status.addresses).toEqual([`127.0.0.1:${status.port}`])
    expect((await api('GET', '/v1/hello')).status).toBe(401) // 새 포트에서 실제로 듣고 있다

    // 점유가 풀리면 다시 올리며 베이스 포트로 돌아온다
    await release()
    await httpDown()
    await httpUp()
    expect(remote.status()).toMatchObject({ port: base, addresses: [`127.0.0.1:${base}`] })
  })

  it('피할 범위까지 다 점유됐으면 EADDRINUSE 사유를 상태에 남긴다 (그냥 안 떠도 앱은 산다)', async () => {
    const base = await freeBase(REMOTE_PORT_TRIES)
    const releases = await Promise.all(Array.from({ length: REMOTE_PORT_TRIES }, (_, index) => occupy(base + index)))
    for (const release of releases) box.cleanups.push(release)
    const { remote } = await start({ port: base })
    expect(remote.status().addresses).toEqual([])
    expect(remote.status().error?.code).toBe('EADDRINUSE')
    expect(remote.status().error?.message).toContain(String(base + REMOTE_PORT_TRIES - 1))
  })
})

describe('TLS 운반 — 고정 포트가 점유되면 다음 포트로 피한다 (이슈 #332)', () => {
  it('베이스 포트가 점유 중이면 다음 포트에서 듣는다 — 주소·지문이 그대로이고 오류가 없다', async () => {
    const base = await freeBase(2)
    const release = await occupy(base)
    box.cleanups.push(release)
    // http 운반은 안 올린다 — 빈 포트 고르기가 대체 포트(base+1)를 훔쳐 시험을 흐리지 않게
    const { remote } = await start({ http: false, tls: { port: base, addresses: () => ['127.0.0.1'], allowPeer: () => true } })
    const status = remote.status()
    expect(status.error).toBeUndefined()
    expect(status.fingerprint).toBeDefined()
    // 점유한 포트를 피해서(그 앞의 포트) 들었다 — 병렬 시험에서 빈 포트로 다른 것이 섞일 수 있어 정확한 값은 안 판다
    const [address] = status.addresses
    expect(address).toBe(`127.0.0.1:${status.port}`)
    expect(status.port).not.toBe(base)
  })
})
