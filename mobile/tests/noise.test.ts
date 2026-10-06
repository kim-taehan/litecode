import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeNoiseKey, encodeNoiseKey, generateNoiseKeyPair, initiator, noisePublicKey, responder } from '../../shared/noiseNK.ts'
import { secureInitiator, secureResponder } from '../../shared/noiseRecord.ts'
import { FRAME, FrameChannel, type FrameMessage } from '../../shared/remoteFraming.ts'
import { memoryPipe } from '../../tests/unit/support/memoryPipe.ts'
import { fflateCodec } from '../src/core/index.ts'
import { pairUri, readPairQr, type PairLink } from '../src/core/pairQr.ts'

// 블루투스 Noise 채널(이슈 #171)이 폰 쪽에서도 같은 코드로 도는지 — shared/noiseNK.ts·noiseRecord.ts 를 폰의 vitest 로 돌린다.
// 데스크탑 단위(tests/unit/noiseNK.test.ts)와 같은 공개 검증 벡터 파일을 쓴다. Hermes 는 여기서 못 돌린다(Node 위의 순수 JS 확인).

interface Vector {
  init_prologue: string
  init_ephemeral: string
  init_remote_static: string
  resp_static: string
  resp_ephemeral: string
  handshake_hash?: string
  messages: { payload: string; ciphertext: string }[]
}
const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/noise-nk-vectors.json', import.meta.url), 'utf8')) as { sources: { name: string; vectors: Vector[] }[] }
const hex = (text: string): Uint8Array => Uint8Array.from(text.match(/../g) ?? [], (byte) => parseInt(byte, 16))
const toHex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

describe('Noise NK — 폰 쪽 (같은 shared 코드)', () => {
  for (const source of fixture.sources) {
    for (const vector of source.vectors) {
      it(`공개 벡터 ${source.name}: 폰이 쓰는 메시지 1·전송 레코드가 바이트 단위로 같다`, () => {
        const secret = hex(vector.resp_static)
        const phone = initiator(hex(vector.init_remote_static), { prologue: hex(vector.init_prologue), ephemeralSecret: hex(vector.init_ephemeral) })
        const desktop = responder({ secretKey: secret, publicKey: noisePublicKey(secret) }, { prologue: hex(vector.init_prologue), ephemeralSecret: hex(vector.resp_ephemeral) })
        const [m1, m2, ...transport] = vector.messages
        const message1 = phone.writeMessage1(hex(m1!.payload))
        expect(toHex(message1)).toBe(m1!.ciphertext)
        desktop.readMessage1(message1)
        const { message: message2, session: desktopSession } = desktop.writeMessage2(hex(m2!.payload))
        const { session } = phone.readMessage2(message2)
        if (vector.handshake_hash) expect(toHex(session.handshakeHash)).toBe(vector.handshake_hash)
        transport.forEach((message, index) => {
          const [from, to] = index % 2 === 0 ? [session, desktopSession] : [desktopSession, session]
          expect(toHex(from.encrypt(hex(message.payload)))).toBe(message.ciphertext)
          to.decrypt(hex(message.ciphertext))
        })
      })
    }
  }

  it('메모리 파이프(BLE 크기 조각) 위 보안 링크에 FrameChannel(fflate) 을 얹어 양방향으로 주고받는다', async () => {
    const pipe = memoryPipe({ maxChunk: 182 })
    const server = generateNoiseKeyPair()
    const [phone, desktop] = await Promise.all([secureInitiator(pipe.a, decodeNoiseKey(encodeNoiseKey(server.publicKey))!), secureResponder(pipe.b, server)])
    const got: FrameMessage[] = []
    const back: FrameMessage[] = []
    const p = new FrameChannel(phone, { codec: fflateCodec, onMessage: (message) => void back.push(message) })
    const d = new FrameChannel(desktop, { codec: fflateCodec, onMessage: (message) => void got.push(message) })
    const body = new TextEncoder().encode('data: hello\n\n'.repeat(3000))
    await Promise.all([p.send(FRAME.REQ, 1, body), d.send(FRAME.RES, 1, new TextEncoder().encode('{"status":200}'))])
    for (let tries = 0; tries < 200 && (got.length === 0 || back.length === 0); tries++) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(got[0]!.body).toEqual(body)
    expect(new TextDecoder().decode(back[0]!.body)).toBe('{"status":200}')
  })

  it('readPairQr 는 QR 의 bk 를 그대로 넘긴다 (없으면 없다)', () => {
    const link: PairLink = { version: 1, desktopId: 'desk_1', name: 'PC', addresses: ['192.168.0.12:47600'], fingerprint: 'q'.repeat(43), code: 'ABCD2345WXYZ', expiresAt: 1_900_000_000 }
    const bk = encodeNoiseKey(generateNoiseKeyPair().publicKey)
    const withKey = readPairQr(pairUri({ ...link, bluetoothKey: bk }), 1_800_000_000_000)
    expect(withKey).toMatchObject({ ok: true, link: { bluetoothKey: bk } })
    const without = readPairQr(pairUri(link), 1_800_000_000_000)
    expect(without.ok && 'bluetoothKey' in without.link).toBe(false)
  })
})
