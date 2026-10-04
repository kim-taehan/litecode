// 폰의 프레임 압축 수단 — fflate(순수 JS, 네이티브 없음)의 raw deflate. 데스크탑은 node:zlib 의 같은 형식을 쓴다
// (설계 01ab 4절 "프레임 deflate"). React Native 에는 zlib 도 CompressionStream 도 없다.

import { Inflate, deflateSync } from 'fflate'
import type { FrameCodec } from '../../../shared/remoteFraming.ts'

/** 입력을 이만큼씩 넣으며 푼다 — 한 번에 불어나는 양을 묶어, 상한을 넘는 것을 다 풀기 전에 그만둔다 */
const INFLATE_STEP = 2048

export const fflateCodec: FrameCodec = {
  deflate: (data) => deflateSync(data, { level: 6 }),
  inflate(data, maxBytes) {
    const chunks: Uint8Array[] = []
    let size = 0
    const inflater = new Inflate((chunk) => {
      size += chunk.length
      chunks.push(chunk)
    })
    for (let at = 0; at < data.length || at === 0; at += INFLATE_STEP) {
      inflater.push(data.subarray(at, at + INFLATE_STEP), at + INFLATE_STEP >= data.length)
      if (size > maxBytes) throw new Error(`inflated past ${maxBytes} bytes`)
    }
    const whole = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      whole.set(chunk, offset)
      offset += chunk.length
    }
    return whole
  },
}
