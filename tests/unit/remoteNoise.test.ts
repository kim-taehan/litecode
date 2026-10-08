import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateNoiseKeyPair, initiator, noiseKeyCode, noisePublicKey, responder, decodeNoiseKey, encodeNoiseKey } from '../../shared/noiseNK.ts'
import { PAIR_URI_PREFIX, pairUri, parsePairUri, type PairLink } from '../../shared/remote.ts'
import type { KeyCipher } from '../../src/services/providers.ts'
import { loadNoiseIdentity } from '../../src/services/remote/noiseIdentity.ts'
import { box, setUp, start, tearDown } from './support/remoteHarness.ts'

// 블루투스 Noise 채널의 데스크탑 신원(키 봉인)과 QR 의 bk (이슈 #171). 운반은 아직 없다 — 키를 만들고 QR 글자에 실을 수 있는 데까지.

beforeEach(setUp)
afterEach(tearDown)

const reversing = (available: () => boolean): KeyCipher => ({
  available,
  encrypt: (plain) => Buffer.from(plain, 'utf8').reverse(),
  decrypt: (sealed) => Buffer.from(sealed).reverse().toString('utf8'),
})

describe('데스크탑 정적 키 — 봉해서 userData 에', () => {
  it('처음 부르면 만들어 0600 으로 저장하고, 다시 읽으면 같은 키다. 공개키 글자 43자·8자 코드가 함께 나온다', async () => {
    const file = path.join(box.root, 'nested', 'remote-noise-key.json')
    const first = await loadNoiseIdentity(file)
    expect(first.secretKey.length).toBe(32)
    expect(first.publicKey).toEqual(noisePublicKey(first.secretKey))
    expect(first.publicKeyText).toBe(encodeNoiseKey(first.publicKey))
    expect(first.code).toBe(noiseKeyCode(first.publicKey))
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    const second = await loadNoiseIdentity(file)
    expect(second.publicKeyText).toBe(first.publicKeyText)
    expect(second.secretKey).toEqual(first.secretKey)
    // 그 키로 핸드셰이크가 된다
    const phone = initiator(decodeNoiseKey(second.publicKeyText)!)
    responder(second).readMessage1(phone.writeMessage1())
  })

  it('봉할 수 있으면 봉해서 둔다(파일에 비밀키 글자가 없다). 봉한 키를 풀 수 없으면 새 키로 덮지 않고 던진다', async () => {
    const file = path.join(box.root, 'remote-noise-key.json')
    let available = true
    const cipher = reversing(() => available)
    const first = await loadNoiseIdentity(file, cipher)
    const text = await fs.readFile(file, 'utf8')
    expect(text).not.toContain(encodeNoiseKey(first.secretKey))
    expect(JSON.parse(text)).toMatchObject({ version: 1, sealed: true })
    expect((await loadNoiseIdentity(file, cipher)).publicKeyText).toBe(first.publicKeyText)
    available = false
    // 키 저장소 탓이면 keyStore 표시 — 화면이 영어 원문 대신 키체인 안내를 보인다 (이슈 #231)
    await expect(loadNoiseIdentity(file, cipher)).rejects.toMatchObject({ code: 'ENOISEKEY', keyStore: true })
    await expect(loadNoiseIdentity(file)).rejects.toMatchObject({ code: 'ENOISEKEY', keyStore: true })
    expect(await fs.readFile(file, 'utf8')).toBe(text)
  })

  it('봉한 글이 깨졌거나(풀기 실패) 키 모양이 틀려도 덮지 않고 던진다', async () => {
    const file = path.join(box.root, 'remote-noise-key.json')
    const broken: KeyCipher = { available: () => true, encrypt: () => Buffer.from('x'), decrypt: () => { throw new Error('bad') } }
    await fs.writeFile(file, JSON.stringify({ version: 1, key: 'AAAA', sealed: true }))
    await expect(loadNoiseIdentity(file, broken)).rejects.toMatchObject({ code: 'ENOISEKEY', keyStore: true }) // 풀기 실패 = 키체인이 거절 (#231)
    await fs.writeFile(file, JSON.stringify({ version: 1, key: 'too-short', sealed: false }))
    const malformed = await loadNoiseIdentity(file).catch((error: unknown) => error)
    expect(malformed).toMatchObject({ code: 'ENOISEKEY' })
    expect((malformed as { keyStore?: boolean }).keyStore).toBeUndefined() // 모양이 틀린 것은 키 저장소 탓이 아니다
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({ key: 'too-short' })
  })

  it('ctx.remote 가 쥔다 — 처음 부를 때 만들고 같은 것을 돌려준다. 파일을 안 주면 거절, 부르기 전에는 파일이 없다', async () => {
    const file = path.join(box.root, 'remote-noise-key.json')
    const { remote } = await start({ http: false, noiseKeyFile: file })
    await expect(fs.stat(file)).rejects.toThrow()
    const identity = await remote.noiseIdentity()
    expect(await remote.noiseIdentity()).toBe(identity)
    expect((await loadNoiseIdentity(file)).publicKeyText).toBe(identity.publicKeyText)
  })

  it('ctx.remote — 봉한 키를 못 풀면 거절하고, 다음 호출에 다시 시도한다', async () => {
    const file = path.join(box.root, 'remote-noise-key.json')
    let available = true
    const made = await loadNoiseIdentity(file, reversing(() => available))
    available = false
    const { remote } = await start({ http: false, noiseKeyFile: file, cipher: reversing(() => available) })
    await expect(remote.noiseIdentity()).rejects.toMatchObject({ code: 'ENOISEKEY' })
    available = true
    expect((await remote.noiseIdentity()).publicKeyText).toBe(made.publicKeyText)
  })
})

describe('QR 의 bk — 선택 필드', () => {
  const link: PairLink = { version: 1, desktopId: 'abcdef0123456789', name: 'PC', addresses: ['192.168.0.10:47600'], fingerprint: 'q'.repeat(43), code: 'AB10110Z9XYZ', expiresAt: 1_800_000_000 }
  const bk = encodeNoiseKey(generateNoiseKeyPair().publicKey)

  it('bk 가 있으면 맨 끝에 싣고 읽으면 같은 값, v 는 그대로 1', () => {
    const uri = pairUri({ ...link, bluetoothKey: bk })
    expect(uri.endsWith(`&x=1800000000&bk=${bk}`)).toBe(true)
    expect(uri).toContain('?v=1&')
    expect(parsePairUri(uri)).toEqual({ ...link, bluetoothKey: bk })
  })

  it('bk 가 없으면 지금 글자 그대로(옛 형식) — 읽으면 bluetoothKey 필드가 없다', () => {
    const uri = pairUri(link)
    expect(uri).not.toContain('bk=')
    expect(uri).toBe(`${PAIR_URI_PREFIX}v=1&d=abcdef0123456789&n=PC&a=192.168.0.10%3A47600&fp=${'q'.repeat(43)}&c=AB10110Z9XYZ&x=1800000000`)
    const parsed = parsePairUri(uri)!
    expect(parsed).toEqual(link)
    expect('bluetoothKey' in parsed).toBe(false)
  })

  it('bk 모양이 틀리면 QR 전체를 읽지 않는다', () => {
    expect(parsePairUri(pairUri({ ...link, bluetoothKey: bk.slice(1) }))).toBeUndefined()
    expect(parsePairUri(pairUri({ ...link, bluetoothKey: '' }))).toBeUndefined()
    expect(parsePairUri(`${pairUri(link)}&bk=${'+'.repeat(43)}`)).toBeUndefined()
  })
})

describe('블루투스 단독 QR — bk 가 있으면 a·fp 는 선택 (이슈 #229)', () => {
  const bk = encodeNoiseKey(generateNoiseKeyPair().publicKey)
  const both: PairLink = { version: 1, desktopId: 'abcdef0123456789', name: 'PC', addresses: ['192.168.0.10:47600'], fingerprint: 'q'.repeat(43), code: 'AB10110Z9XYZ', expiresAt: 1_800_000_000, bluetoothKey: bk }
  const bluetoothOnly: PairLink = { version: 1, desktopId: 'abcdef0123456789', name: 'PC', addresses: [], code: 'AB10110Z9XYZ', expiresAt: 1_800_000_000, bluetoothKey: bk }

  it('블루투스 단독: a·fp 를 싣지 않고, 읽으면 주소 없음·지문 없음 — v 는 그대로 1', () => {
    const uri = pairUri(bluetoothOnly)
    expect(uri).toBe(`${PAIR_URI_PREFIX}v=1&d=abcdef0123456789&n=PC&c=AB10110Z9XYZ&x=1800000000&bk=${bk}`)
    const parsed = parsePairUri(uri)!
    expect(parsed).toEqual(bluetoothOnly)
    expect('fingerprint' in parsed).toBe(false)
  })

  it('둘 다·사내망 단독은 지금 글자 그대로 라운드트립', () => {
    expect(parsePairUri(pairUri(both))).toEqual(both)
    const { bluetoothKey: _, ...lanOnly } = both
    expect(parsePairUri(pairUri(lanOnly))).toEqual(lanOnly)
  })

  it('bk 가 없으면 a·fp 는 여전히 필수 — 블루투스 단독 모양에서 bk 만 빼면 읽지 않는다', () => {
    expect(parsePairUri(pairUri({ ...bluetoothOnly, bluetoothKey: undefined }))).toBeUndefined()
  })

  it('a 만 있고 fp 가 없거나, fp 만 있고 a 가 없으면 bk 가 있어도 거절 (사내망 경로가 반쪽)', () => {
    expect(parsePairUri(pairUri({ ...both, fingerprint: undefined }))).toBeUndefined()
    expect(parsePairUri(pairUri({ ...both, addresses: [] }))).toBeUndefined()
    expect(parsePairUri(pairUri({ ...both, fingerprint: 'short' }))).toBeUndefined()
  })

  it('bk 모양이 틀리면 블루투스 단독 QR 도 읽지 않는다', () => {
    expect(parsePairUri(pairUri({ ...bluetoothOnly, bluetoothKey: bk.slice(1) }))).toBeUndefined()
    expect(parsePairUri(pairUri({ ...bluetoothOnly, bluetoothKey: '' }))).toBeUndefined()
  })
})
