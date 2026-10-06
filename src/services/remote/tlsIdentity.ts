import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { readJsonFile } from '../jsonFile.ts'
import type { KeyCipher } from '../providers.ts'

// 사내망 리스너의 신원 (01t 3절 "인증서") — ECDSA P-256 키 하나와 그 키로 서명한 자체 서명 인증서.
// 폰은 인증서 체인을 믿지 않고 **공개키 지문(SPKI DER 의 SHA-256, base64url)** 을 고정한다. 그래서 키만 저장하고 인증서는 띄울 때마다
// 새로 만든다 — 키가 같으면 지문이 같아 폰을 다시 짝지을 필요가 없다. 키는 provider 키와 같은 safeStorage 로 봉해 userData 에 둔다
// (봉할 수 없는 환경이면 권한 0600 평문 — 같은 사용자가 이 파일을 읽을 수 있으면 이미 기기 토큰 파일·대화도 읽는다).
//
// 인증서는 의존성 없이 node:crypto 로 만든다: X.509 v1(확장 없음 — RFC 5280 4.1.2.1) TBSCertificate 를 DER 로 직접 쓰고
// `crypto.sign` 으로 서명한다. 인증서 라이브러리(@peculiar/x509 는 21 패키지 + 전역 reflect-metadata 폴리필)를 들이지 않는다.

export interface TlsIdentity {
  /** PKCS#8 PEM */
  key: string
  /** 자체 서명 인증서 PEM */
  cert: string
  /** SPKI SHA-256 base64url (43자) */
  fingerprint: string
}

interface StoredKey {
  version: 1
  /** sealed 면 safeStorage 로 봉한 PKCS#8 PEM 의 base64, 아니면 PEM 그대로 */
  key: string
  sealed: boolean
}

/** 인증서 유효 기간 — 띄울 때마다 새로 만드므로 길 필요는 없지만, PC 시계가 틀려도 폰이 보지 않는다(지문만 본다) */
const VALID_DAYS = 3650

/** 공개키 지문 — SPKI DER 의 SHA-256 을 base64url(덧붙임 없음)로. 폰이 고정하는 값이다 */
export function spkiFingerprint(key: KeyObject): string {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('base64url')
}

/** 저장한 키를 읽고(없으면 만들어 저장하고) 인증서를 새로 만든다. 봉한 키를 풀지 못하면 던진다 — 새 키로 덮으면 짝지은 폰이 전부 지문 불일치가 된다 */
export async function loadTlsIdentity(file: string, cipher?: KeyCipher, now: Date = new Date()): Promise<TlsIdentity> {
  const stored = (await readJsonFile(file, 'object')) as Partial<StoredKey> | undefined
  let privateKey: KeyObject
  if (typeof stored?.key === 'string') {
    if (stored.sealed && !cipher?.available()) throw Object.assign(new Error('the TLS key is sealed and the key store is unavailable'), { code: 'ETLSKEY' })
    const pem = stored.sealed ? cipher!.decrypt(Buffer.from(stored.key, 'base64')) : stored.key
    privateKey = createPrivateKey(pem)
  } else {
    privateKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    const sealed = cipher?.available() === true
    const next: StoredKey = { version: 1, key: sealed ? cipher!.encrypt(pem).toString('base64') : pem, sealed }
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    await fs.writeFile(temp, JSON.stringify(next), { mode: 0o600 })
    await fs.rename(temp, file)
  }
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    cert: selfSignedCertificate(privateKey, now),
    fingerprint: spkiFingerprint(privateKey),
  }
}

/** 자체 서명 인증서 PEM (X.509 v1, ecdsa-with-SHA256, 주체·발급자 CN=litecode) */
export function selfSignedCertificate(privateKey: KeyObject, now: Date = new Date()): string {
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  const serial = randomBytes(16)
  serial[0]! &= 0x7f // 양수
  const ecdsaWithSha256 = der(0x30, oid([1, 2, 840, 10045, 4, 3, 2]))
  const name = der(0x30, der(0x31, der(0x30, oid([2, 5, 4, 3]), der(0x0c, Buffer.from('litecode')))))
  const notBefore = new Date(now.getTime() - 24 * 3600_000) // PC 시계가 조금 늦어도
  const notAfter = new Date(now.getTime() + VALID_DAYS * 24 * 3600_000)
  const tbs = der(0x30, der(0x02, serial), ecdsaWithSha256, name, der(0x30, time(notBefore), time(notAfter)), name, spki)
  const signature = sign('sha256', tbs, privateKey) // EC 키는 DER(ECDSA-Sig-Value)로 나온다
  const certificate = der(0x30, tbs, ecdsaWithSha256, der(0x03, Buffer.from([0]), signature))
  const base64 = certificate.toString('base64').replace(/.{64}/g, '$&\n')
  return `-----BEGIN CERTIFICATE-----\n${base64}${base64.endsWith('\n') ? '' : '\n'}-----END CERTIFICATE-----\n`
}

/** DER 한 덩어리 — 태그·길이·내용 */
function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts)
  const length = body.length
  let head: number[]
  if (length < 0x80) head = [length]
  else {
    const bytes: number[] = []
    for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 255)
    head = [0x80 | bytes.length, ...bytes]
  }
  return Buffer.concat([Buffer.from([tag, ...head]), body])
}

function oid(arcs: number[]): Buffer {
  const bytes = [arcs[0]! * 40 + arcs[1]!]
  for (const arc of arcs.slice(2)) {
    const chunk = [arc & 0x7f]
    for (let rest = Math.floor(arc / 128); rest > 0; rest = Math.floor(rest / 128)) chunk.unshift((rest & 0x7f) | 0x80)
    bytes.push(...chunk)
  }
  return der(0x06, Buffer.from(bytes))
}

/** 2049년까지는 UTCTime, 그 뒤는 GeneralizedTime (RFC 5280 4.1.2.5) */
function time(at: Date): Buffer {
  const iso = at.toISOString().replace(/[-:T]/g, '').slice(0, 14) // YYYYMMDDHHMMSS
  return at.getUTCFullYear() < 2050 ? der(0x17, Buffer.from(`${iso.slice(2)}Z`)) : der(0x18, Buffer.from(`${iso}Z`))
}
