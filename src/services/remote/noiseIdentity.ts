import fs from 'node:fs/promises'
import path from 'node:path'
import { decodeNoiseKey, encodeNoiseKey, generateNoiseKeyPair, noiseKeyCode, noisePublicKey, type NoiseKeyPair } from '../../../shared/noiseNK.ts'
import { readJsonFile } from '../jsonFile.ts'
import type { KeyCipher } from '../providers.ts'

// 블루투스 채널의 신원 (이슈 #171, 설계 01ab 5절 "페어링·보안") — Noise NK 응답자의 정적 X25519 키쌍 하나.
// 공개키는 QR 의 `bk` 로 폰에 넘어가 고정된다 — TLS 리스너의 SPKI 지문(tlsIdentity.ts)과 같은 자리다. 그래서 다루는 규칙도 같다:
// 비밀키는 provider 키와 같은 safeStorage 로 봉해 userData 에 두고(봉할 수 없는 환경이면 권한 0600 평문), **봉한 키를 풀지 못하면 새 키로
// 덮지 않고 던진다** — 덮으면 짝지은 폰이 전부 키 불일치가 된다. 처음 필요할 때(블루투스를 켤 때) 만든다.

export interface NoiseIdentity extends NoiseKeyPair {
  /** 공개키 base64url 43자 — QR 의 bk */
  publicKeyText: string
  /** 사람이 맞춰 보는 8자 (`ABCD-EFGH`) — 공개키 SHA-256 앞 40bit (noiseKeyCode) */
  code: string
}

interface StoredKey {
  version: 1
  /** sealed 면 safeStorage 로 봉한 비밀키(base64url 43자)의 base64, 아니면 base64url 그대로 */
  key: string
  sealed: boolean
}

/** 저장한 키를 읽는다(없으면 만들어 저장한다). 봉한 키를 풀지 못하거나 모양이 틀리면 던진다(code ENOISEKEY) — 파일은 그대로 둔다 */
export async function loadNoiseIdentity(file: string, cipher?: KeyCipher): Promise<NoiseIdentity> {
  const stored = (await readJsonFile(file, 'object')) as Partial<StoredKey> | undefined
  let secretKey: Uint8Array
  if (typeof stored?.key === 'string') {
    if (stored.sealed && !cipher?.available()) throw keyError('the bluetooth key is sealed and the key store is unavailable')
    let text: string
    try {
      text = stored.sealed ? cipher!.decrypt(Buffer.from(stored.key, 'base64')) : stored.key
    } catch {
      throw keyError('cannot unseal the bluetooth key')
    }
    const decoded = decodeNoiseKey(text)
    if (!decoded) throw keyError('the stored bluetooth key is malformed')
    secretKey = decoded
  } else {
    secretKey = generateNoiseKeyPair().secretKey
    const text = encodeNoiseKey(secretKey)
    const sealed = cipher?.available() === true
    const next: StoredKey = { version: 1, key: sealed ? cipher!.encrypt(text).toString('base64') : text, sealed }
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    await fs.writeFile(temp, JSON.stringify(next), { mode: 0o600 })
    await fs.rename(temp, file)
  }
  const publicKey = noisePublicKey(secretKey)
  return { secretKey, publicKey, publicKeyText: encodeNoiseKey(publicKey), code: noiseKeyCode(publicKey) }
}

function keyError(message: string): Error {
  return Object.assign(new Error(message), { code: 'ENOISEKEY' })
}
