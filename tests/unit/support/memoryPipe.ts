import type { ByteLink } from '../../../shared/remoteFraming.ts'

// 메모리 파이프 — 블루투스 같은 느린 바이트 링크를 흉내 낸다 (이슈 #68, 설계 01ab 8절 ①). 순수 TS: 루트 단위 테스트와
// 모바일 코어 테스트(mobile/tests)가 같이 쓴다. 양 끝이 ByteLink 하나씩이다.
// - maxChunk: 한 번에 실을 수 있는 바이트(BLE 의 MTU−3). 넘겨 보내면 던진다 — 조각내기를 지켰는지 본다
// - bytesPerSecond: 방향마다 이 속도로 조인다. 조각 하나가 다 "전송"될 때까지 send 가 안 풀린다(되밀림). setTimeout 을 쓰므로
//   가짜 시계로 돌리면 실제 시간은 안 걸린다. 없으면 바로(다음 마이크로태스크에) 닿는다

export interface MemoryPipe {
  a: ByteLink
  b: ByteLink
  /** 링크가 끊겼다 — 양 끝의 onClose 가 불리고, 가던 조각은 사라진다 */
  cut(error?: unknown): void
  /** 지금까지 실어 나른 바이트 (방향별) */
  bytes: { aToB: number; bToA: number }
}

export function memoryPipe(options: { maxChunk?: number; bytesPerSecond?: number } = {}): MemoryPipe {
  const maxChunk = options.maxChunk ?? 512
  const bytes = { aToB: 0, bToA: 0 }
  let closed = false
  const ends = [0, 1].map(() => ({ data: [] as ((chunk: Uint8Array) => void)[], close: [] as ((error?: unknown) => void)[], tail: Promise.resolve() }))

  const cut = (error?: unknown): void => {
    if (closed) return
    closed = true
    for (const end of ends) for (const listener of end.close) listener(error)
  }

  const link = (self: number): ByteLink => {
    const mine = ends[self]!
    const other = ends[1 - self]!
    return {
      maxChunk,
      send(chunk) {
        if (closed) return Promise.reject(new Error('link closed'))
        if (chunk.length > maxChunk) throw new Error(`chunk ${chunk.length} > maxChunk ${maxChunk}`)
        const copy = chunk.slice()
        // 방향마다 한 줄 — 앞 조각이 다 간 뒤에 다음 조각이 간다
        const sent = mine.tail.then(async () => {
          if (options.bytesPerSecond) await new Promise((resolve) => setTimeout(resolve, (copy.length / options.bytesPerSecond!) * 1000))
          else await Promise.resolve()
          if (closed) throw new Error('link closed')
          if (self === 0) bytes.aToB += copy.length
          else bytes.bToA += copy.length
          for (const listener of other.data) listener(copy)
        })
        mine.tail = sent.catch(() => {})
        return sent
      },
      onData: (listener) => void mine.data.push(listener),
      onClose: (listener) => void mine.close.push(listener),
      close: () => cut(),
    }
  }
  return { a: link(0), b: link(1), cut, bytes }
}
