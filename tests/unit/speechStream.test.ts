import { describe, expect, it, vi } from 'vitest'
import { SpeechError, type SpeechService, type SpeechStream } from '../../src/services/speech.ts'
import { transcribeSamples, toSamples, VAD_WINDOW, type VadLike, type WorkerReply } from '../../src/services/speech/audio.ts'
import { speechBridgeStreams } from '../../src/services/speech/bridge.ts'
import { speechEngine, StreamDecoder, TENTATIVE_COST_FACTOR, TENTATIVE_MIN_MS } from '../../src/services/speech/stream.ts'
import type { SpeechPartial, SpeechStreamEvent, SpeechTranscript } from '../../shared/speech.ts'

// 실시간 받아쓰기의 워커 쪽 순수한 부분(speech/stream.ts)과 IPC 장부(speech/bridge.ts) — 가짜 VAD·가짜 인식기·가짜 시계로.
// 진짜 엔진으로 글이 나오는지·한 번에 받아쓴 글과 같은지는 여기서 안 본다 (수동 실측 — 숨긴 Electron·node 스크립트).

/** 소리가 있는 창(0 이 아닌 표본이 하나라도)이 오면 말소리 구간을 열고, 조용한 창이 오면 닫아 내놓는 VAD */
class FakeVad implements VadLike {
  windows: number[] = []
  resets = 0
  private fed = 0
  private open: { start: number; parts: Float32Array[] } | undefined
  private queue: { samples: Float32Array; start: number }[] = []
  reset(): void {
    this.resets++
    this.fed = 0
    this.open = undefined
    this.queue = []
  }
  acceptWaveform(samples: Float32Array): void {
    this.windows.push(samples.length)
    if (samples.some((sample) => sample !== 0)) (this.open ??= { start: this.fed, parts: [] }).parts.push(samples)
    else this.close()
    this.fed += samples.length
  }
  isEmpty(): boolean {
    return this.queue.length === 0
  }
  isDetected(): boolean {
    return this.open !== undefined
  }
  front(): { samples: Float32Array; start: number } {
    return this.queue[0]!
  }
  pop(): void {
    this.queue.shift()
  }
  flush(): void {
    this.close()
  }
  private close(): void {
    if (!this.open) return
    const samples = new Float32Array(this.open.parts.reduce((length, part) => length + part.length, 0))
    let at = 0
    for (const part of this.open.parts) {
      samples.set(part, at)
      at += part.length
    }
    this.queue.push({ samples, start: this.open.start })
    this.open = undefined
  }
}

/** 말소리 표본 값 → 글자. 인식한 글은 "글자×소리가 있는 표본 수" — 어느 소리를 얼마나 넣었는지 글로 보인다 */
const LETTERS: Record<number, string> = { 8192: '가', 16384: '나' }
function recognizer(): { decode(samples: Float32Array): string; calls: number[] } {
  const calls: number[] = []
  return {
    calls,
    decode(samples) {
      calls.push(samples.length)
      const loud = samples.filter((sample) => sample !== 0)
      return loud.length ? `${LETTERS[Math.round(loud[0]! * 32768)]}×${loud.length}` : ''
    },
  }
}
const speech = (mark: number, windows: number): Int16Array => new Int16Array(windows * VAD_WINDOW).fill(mark)
const silence = (windows: number): Int16Array => new Int16Array(windows * VAD_WINDOW)
function clock(): { now(): number; at: number } {
  const state = { at: 0, now: () => state.at }
  return state
}

describe('조각을 받아 확정·임시 글로 (StreamDecoder)', () => {
  it('앞에 무음 300ms 를 넣고, 조각이 어떻게 잘려 오든 512 표본 창으로 VAD 에 넣는다', () => {
    const vad = new FakeVad()
    const decoder = new StreamDecoder(vad, () => '', clock().now)
    expect(vad.resets).toBe(1)
    expect(vad.windows).toEqual(Array(9).fill(512)) // 4800 = 9창 + 192
    decoder.feed(new Int16Array(100))
    decoder.feed(new Int16Array(219)) // 192 + 319 = 511 — 아직 한 창이 안 된다
    expect(vad.windows).toHaveLength(9)
    decoder.feed(new Int16Array(1))
    expect(vad.windows).toHaveLength(10)
    decoder.feed(new Int16Array(1600))
    expect(vad.windows).toEqual(Array(13).fill(512))
    decoder.stop()
    expect(vad.windows.at(-1)).toBe(64) // 남은 끝은 정지 때
  })

  it('말하는 동안엔 그 구간을 처음부터 다시 인식해 임시 글로, 구간이 끝나면 한 번 인식해 확정한다', () => {
    const vad = new FakeVad()
    const { decode, calls } = recognizer()
    const time = clock()
    const decoder = new StreamDecoder(vad, decode, time.now)
    expect(decoder.feed(silence(10))).toMatchObject({ final: '', tentative: '' }) // 말 끝 신호(speaking·silentMs)는 아래 따로
    expect(calls).toHaveLength(0) // 말이 없으면 인식하지 않는다
    time.at += 1000
    // 앞 무음이 9창 + 192 표본이라 창이 192 만큼 어긋나 있다 — 창을 못 채운 끝 192 표본은 다음 조각을 기다린다
    expect(decoder.feed(speech(8192, 20))).toMatchObject({ final: '', tentative: '가×10048' })
    time.at += 1000
    expect(decoder.feed(speech(8192, 10))).toMatchObject({ final: '', tentative: '가×15168' }) // 처음부터 다시
    time.at += 1000
    expect(decoder.feed(silence(3))).toMatchObject({ final: '가×15360', tentative: '' })
    expect(calls.at(-1)).toBe(31 * 512) // 확정은 VAD 가 자른 구간 그대로 (소리가 걸친 창 31개 — 임시 인식의 꼬리가 아니다)
    time.at += 1000
    expect(decoder.feed(speech(16384, 20))).toMatchObject({ final: '가×15360', tentative: '나×10048' }) // 앞 구간의 소리는 임시 인식에 안 들어간다
    time.at += 1000
    expect(decoder.feed(silence(2))).toMatchObject({ final: '가×15360 나×10240', tentative: '' })
  })

  it('말 끝 신호 (#238) — VAD 가 켜져 있으면 speaking·silentMs 0, 꺼지면 마지막으로 켜졌던 창 뒤에 넣은 소리만큼 silentMs 가 는다', () => {
    const vad = new FakeVad()
    const decoder = new StreamDecoder(vad, recognizer().decode, clock().now)
    // 연 뒤 말이 없으면 연 때부터 센다 — 앞에 넣은 무음 300ms 는 세지 않는다 (앞 무음의 끝 192 표본 + 1408 = 3창 넣음)
    expect(decoder.feed(new Int16Array(1408))).toMatchObject({ speaking: false, silentMs: 96 })
    expect(decoder.feed(speech(8192, 10))).toMatchObject({ speaking: true, silentMs: 0 })
    // 말소리가 걸친 창까지는 켜져 있고(창이 64 표본 어긋나 있어 다음 조각의 첫 창에 말소리 끝이 걸친다), 그 뒤 조용한 창 수만큼 (창 하나 32ms)
    expect(decoder.feed(silence(1))).toMatchObject({ speaking: true, silentMs: 0 })
    expect(decoder.feed(silence(10))).toMatchObject({ speaking: false, silentMs: 320 })
    expect(decoder.feed(silence(25))).toMatchObject({ speaking: false, silentMs: 1120, final: '가×5120' })
    // 다시 말하면 0 으로 — 확정 글은 그대로 이어진다 (카운트다운 중에 다시 말하면 이어서 받아쓴다)
    const resumed = decoder.feed(speech(16384, 3))
    expect(resumed).toMatchObject({ speaking: true, silentMs: 0, final: '가×5120' })
    expect(decoder.feed(silence(2)).silentMs).toBe(32)
  })

  it('임시 인식에는 말이 시작되기 전 1초까지만 넣는다 (오래 조용했어도)', () => {
    const vad = new FakeVad()
    const { decode, calls } = recognizer()
    const time = clock()
    const decoder = new StreamDecoder(vad, decode, time.now)
    for (let second = 0; second < 30; second++) decoder.feed(new Int16Array(16_000))
    time.at += 1000
    decoder.feed(speech(8192, 20))
    expect(calls).toEqual([expect.any(Number)])
    expect(calls[0]).toBeGreaterThan(10_240)
    expect(calls[0]).toBeLessThanOrEqual(16_000 + 10_240)
  })

  it('임시 인식은 0.6초에 한 번까지 — 그사이 조각은 VAD 에만 넣고 앞의 임시 글을 그대로 돌려준다', () => {
    const vad = new FakeVad()
    const { decode, calls } = recognizer()
    const time = clock()
    const decoder = new StreamDecoder(vad, decode, time.now)
    time.at = 5000
    decoder.feed(speech(8192, 20))
    expect(calls).toHaveLength(1)
    time.at += TENTATIVE_MIN_MS - 1
    expect(decoder.feed(speech(8192, 3)).tentative).toBe('가×10048')
    expect(calls).toHaveLength(1)
    time.at += 1
    expect(decoder.feed(speech(8192, 3)).tentative).toBe('가×13120')
    expect(calls).toHaveLength(2)
  })

  it('느린 PC — 임시 인식 간격을 직전 인식에 걸린 시간의 4배 이상으로 스스로 늦춘다', () => {
    const vad = new FakeVad()
    const time = clock()
    let cost = 500
    let calls = 0
    const decoder = new StreamDecoder(
      vad,
      () => {
        calls++
        time.at += cost
        return 'x'
      },
      time.now,
    )
    time.at = 5000
    decoder.feed(speech(8192, 20)) // 0.5초 걸렸다
    expect(calls).toBe(1)
    time.at += TENTATIVE_COST_FACTOR * 500 - 1
    decoder.feed(speech(8192, 1))
    expect(calls).toBe(1)
    time.at += 1
    cost = 50 // 다시 빨라지면
    decoder.feed(speech(8192, 1))
    expect(calls).toBe(2)
    time.at += TENTATIVE_MIN_MS
    decoder.feed(speech(8192, 1)) // 최소 간격으로 돌아온다
    expect(calls).toBe(3)
  })

  it('한두 음절뿐인 소리(0.5초 미만)는 임시로 인식하지 않는다', () => {
    const vad = new FakeVad()
    const { decode, calls } = recognizer()
    const decoder = new StreamDecoder(vad, decode, () => 99_999)
    expect(decoder.feed(speech(8192, 4)).tentative).toBe('') // 무음 4800 은 말이 아니라 1초 안쪽으로 남아 있다 — 4800 + 2048 < 8000
    expect(calls).toHaveLength(0)
  })

  it('정지 — 남은 소리를 넣고 열려 있던 구간을 닫아 확정한다. 마지막 조각을 실어도 된다', () => {
    const vad = new FakeVad()
    const { decode } = recognizer()
    const decoder = new StreamDecoder(vad, decode, clock().now)
    decoder.feed(speech(8192, 10))
    decoder.feed(silence(2))
    decoder.feed(speech(16384, 5))
    expect(decoder.stop(new Int16Array(300).fill(16384))).toBe(`가×5120 나×${5 * 512 + 300}`)
  })

  it('같은 소리면 한 번에 받아쓴 글과 같다 — 조각 크기와 상관없이', () => {
    const pcm = new Int16Array([...silence(7), ...speech(8192, 13), ...new Int16Array(700), ...speech(16384, 9), ...new Int16Array(1234).fill(16384)])
    const once = transcribeSamples(new FakeVad(), recognizer().decode, toSamples(pcm))
    expect(once).not.toBe('')
    for (const size of [1600, 333, 4096, pcm.length]) {
      const decoder = new StreamDecoder(new FakeVad(), recognizer().decode, () => 0)
      for (let at = 0; at < pcm.length; at += size) decoder.feed(pcm.subarray(at, at + size))
      expect(decoder.stop(), `조각 ${size}`).toBe(once)
    }
  })
})

describe('워커가 메시지 하나에 하는 일 (speechEngine)', () => {
  function engine(): { ask: ReturnType<typeof speechEngine>; languages: string[]; prepared: string[]; time: { at: number } } {
    const languages: string[] = []
    const prepared: string[] = []
    const time = clock()
    const { decode } = recognizer()
    const ask = speechEngine({
      vad: new FakeVad(),
      now: time.now,
      prepare: (language) => void prepared.push(language),
      recognize(language, samples) {
        languages.push(language)
        time.at += 7
        return decode(samples)
      },
    })
    return { ask, languages, prepared, time }
  }

  it('한 번에 받아쓰기 — 글과 걸린 시간', () => {
    const { ask, languages } = engine()
    expect(ask({ type: 'transcribe', id: 3, pcm: speech(8192, 10), language: 'en' })).toEqual({ type: 'result', id: 3, text: '가×5120', inferMs: 7 })
    expect(languages).toEqual(['en'])
  })

  it('스트림 — start 는 답이 없고, feed 마다 partial, stop 은 result', () => {
    const { ask, languages, prepared, time } = engine()
    expect(ask({ type: 'stream-start', id: 5, language: 'ko' })).toBeUndefined()
    expect(prepared).toEqual(['ko']) // 인식기는 열 때 만들어 둔다 — 첫 임시 인식의 걸린 시간에 섞이지 않게
    time.at = 1000
    expect(ask({ type: 'stream-feed', id: 5, pcm: speech(8192, 20) })).toEqual({ type: 'partial', id: 5, final: '', tentative: '가×10048', speaking: true, silentMs: 0, inferMs: 7 })
    expect(ask({ type: 'stream-feed', id: 5, pcm: silence(2) })).toEqual({ type: 'partial', id: 5, final: '가×10240', tentative: '', speaking: false, silentMs: 32, inferMs: 7 })
    expect(ask({ type: 'stream-feed', id: 5, pcm: silence(2) })).toMatchObject({ type: 'partial', inferMs: 0 }) // 인식할 것이 없어도 답한다 (메인이 답을 기다린다)
    expect(ask({ type: 'stream-stop', id: 5, pcm: speech(16384, 4) })).toEqual({ type: 'result', id: 5, text: '가×10240 나×2048', inferMs: 7 })
    expect(languages).toEqual(['ko', 'ko', 'ko'])
  })

  it('취소한 스트림·모르는 번호의 조각과 정지는 답이 없다', () => {
    const { ask } = engine()
    ask({ type: 'stream-start', id: 1, language: 'ko' })
    expect(ask({ type: 'stream-cancel', id: 1 })).toBeUndefined()
    expect(ask({ type: 'stream-feed', id: 1, pcm: speech(8192, 20) })).toBeUndefined()
    expect(ask({ type: 'stream-stop', id: 1 })).toBeUndefined()
    ask({ type: 'stream-start', id: 2, language: 'ko' })
    expect(ask({ type: 'stream-cancel', id: 1 })).toBeUndefined() // 옛 번호의 취소가 새 스트림을 버리지 않는다
    expect(ask({ type: 'stream-stop', id: 2, pcm: speech(8192, 2) })).toMatchObject({ type: 'result', text: '가×1024' })
    expect(ask({ type: 'stream-stop', id: 2 })).toBeUndefined() // 끝난 스트림
  })

  it('새 스트림은 앞 스트림의 소리를 이어받지 않는다', () => {
    const { ask } = engine()
    ask({ type: 'stream-start', id: 1, language: 'ko' })
    ask({ type: 'stream-feed', id: 1, pcm: speech(8192, 20) })
    ask({ type: 'stream-start', id: 2, language: 'ko' })
    expect(ask({ type: 'stream-stop', id: 2, pcm: speech(16384, 3) })).toMatchObject({ text: '나×1536' })
  })

  it('인식이 던지면 그 번호의 error — 스트림은 끝난다', () => {
    const ask = speechEngine({
      vad: new FakeVad(),
      now: () => 99_999,
      recognize() {
        throw new Error('onnx')
      },
    })
    expect(ask({ type: 'transcribe', id: 1, pcm: speech(8192, 4), language: 'ko' })).toEqual({ type: 'error', id: 1, message: 'onnx' })
    ask({ type: 'stream-start', id: 2, language: 'ko' })
    expect(ask({ type: 'stream-feed', id: 2, pcm: speech(8192, 20) })).toEqual({ type: 'error', id: 2, message: 'onnx' } satisfies WorkerReply)
    expect(ask({ type: 'stream-feed', id: 2, pcm: speech(8192, 20) })).toBeUndefined()
  })
})

describe('IPC 쪽 장부 (speechBridgeStreams)', () => {
  /** ctx.speech 의 openStream 만 흉내 — 연 스트림마다 손잡이를 남긴다 */
  function fakeSpeech(): { service: Pick<SpeechService, 'openStream'>; opened: { language: unknown; written: unknown[]; stopped: number; cancelled: number; partial(partial: SpeechPartial): void; resolve(transcript: SpeechTranscript): void; reject(error: unknown): void }[]; fail?: SpeechError } {
    const state: ReturnType<typeof fakeSpeech> = {
      opened: [],
      service: {
        openStream(opts, onPartial): SpeechStream {
          if (state.fail) throw state.fail
          let resolve!: (transcript: SpeechTranscript) => void
          let reject!: (error: unknown) => void
          const done = new Promise<SpeechTranscript>((yes, no) => {
            resolve = yes
            reject = no
          })
          done.catch(() => {})
          const handle = { language: opts.language, written: [] as unknown[], stopped: 0, cancelled: 0, partial: onPartial, resolve, reject }
          state.opened.push(handle)
          return {
            done,
            write(pcm) {
              if (!(pcm instanceof Int16Array)) throw new SpeechError('invalid', 'bad')
              handle.written.push(pcm)
            },
            stop() {
              handle.stopped++
              return done
            },
            cancel() {
              handle.cancelled++
              reject(new SpeechError('cancelled', 'cancelled'))
            },
          }
        },
      },
    }
    return state
  }
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  it('열면 번호를 주고, 그 번호의 조각만 스트림에 넣는다 — 모양이 틀린 조각은 버린다', () => {
    const speech = fakeSpeech()
    const streams = speechBridgeStreams(speech.service, () => {})
    const opened = streams.start('ko')
    expect(opened).toEqual({ ok: true, stream: 1 })
    streams.chunk(1, new Int16Array(1600))
    streams.chunk(2, new Int16Array(1600)) // 모르는 번호
    streams.chunk('1', new Int16Array(1600))
    expect(() => streams.chunk(1, 'pcm')).not.toThrow()
    expect(speech.opened[0]!.written).toHaveLength(1)
    expect(speech.opened[0]!.language).toBe('ko')
  })

  it('확정·임시 글을 번호와 함께 화면에 알린다', () => {
    const speech = fakeSpeech()
    const events: SpeechStreamEvent[] = []
    const streams = speechBridgeStreams(speech.service, (event) => void events.push(event))
    streams.start(undefined)
    speech.opened[0]!.partial({ final: '하나.', tentative: '', speaking: false, silentMs: 300 })
    expect(events).toEqual([{ stream: 1, final: '하나.', tentative: '', speaking: false, silentMs: 300 }]) // 말 끝 신호(#238)도 그대로 싣는다
  })

  it('정지 — 최종 글을 돌려주고 장부를 비운다. 정지 뒤의 조각·모르는 번호의 정지는 버린다', async () => {
    const speech = fakeSpeech()
    const streams = speechBridgeStreams(speech.service, () => {})
    streams.start(undefined)
    const reply = streams.stop(1)
    streams.chunk(1, new Int16Array(1600))
    expect(speech.opened[0]!.written).toHaveLength(0)
    speech.opened[0]!.resolve({ text: '끝', audioSeconds: 1, inferSeconds: 0.1 })
    expect(await reply).toEqual({ ok: true, text: '끝', audioSeconds: 1, inferSeconds: 0.1 })
    expect(await streams.stop(1)).toMatchObject({ ok: false, code: 'cancelled' })
    expect(await streams.stop(7)).toMatchObject({ ok: false, code: 'cancelled' })
    expect(speech.opened[0]!.stopped).toBe(1)
  })

  it('취소 — 그 번호일 때만 버리고, 화면엔 알리지 않는다. 번호 없이 부르면(다리가 내려갈 때) 열린 것을 버린다', async () => {
    const speech = fakeSpeech()
    const events: SpeechStreamEvent[] = []
    const streams = speechBridgeStreams(speech.service, (event) => void events.push(event))
    streams.start(undefined)
    streams.cancel(9)
    expect(speech.opened[0]!.cancelled).toBe(0)
    streams.cancel(1)
    expect(speech.opened[0]!.cancelled).toBe(1)
    streams.start(undefined)
    streams.cancel()
    expect(speech.opened[1]!.cancelled).toBe(1)
    await flush()
    expect(events).toEqual([])
  })

  it('열려 있는데 또 열면(화면 새로 고침) 앞의 것을 버리고 새 번호로 — 앞 번호의 조각·글은 버린다', async () => {
    const speech = fakeSpeech()
    const events: SpeechStreamEvent[] = []
    const streams = speechBridgeStreams(speech.service, (event) => void events.push(event))
    streams.start(undefined)
    expect(streams.start(undefined)).toEqual({ ok: true, stream: 2 })
    expect(speech.opened[0]!.cancelled).toBe(1)
    streams.chunk(1, new Int16Array(1600))
    speech.opened[0]!.partial({ final: '옛', tentative: '', speaking: false, silentMs: 0 })
    await flush()
    expect(speech.opened[0]!.written).toHaveLength(0)
    expect(events).toEqual([])
  })

  it('스트림이 스스로 죽으면(엔진 종료·기한) 화면에 error 로 알린다 — 정지를 기다리는 중이면 그 답이 사유를 준다', async () => {
    const speech = fakeSpeech()
    const events: SpeechStreamEvent[] = []
    const streams = speechBridgeStreams(speech.service, (event) => void events.push(event))
    streams.start(undefined)
    speech.opened[0]!.reject(new SpeechError('failed', 'engine exited'))
    await flush()
    expect(events).toEqual([{ stream: 1, final: '', tentative: '', speaking: false, silentMs: 0, error: 'failed' }])
    streams.chunk(1, new Int16Array(1600)) // 죽은 스트림
    expect(speech.opened[0]!.written).toHaveLength(0)

    streams.start(undefined)
    const reply = streams.stop(2)
    speech.opened[1]!.reject(new SpeechError('timeout', 'late'))
    expect(await reply).toMatchObject({ ok: false, code: 'timeout' })
    await flush()
    expect(events).toHaveLength(1)
  })

  it('못 열면(busy·준비 안 됨) 코드로 돌려준다 — 던지지 않는다', () => {
    const speech = fakeSpeech()
    speech.fail = new SpeechError('busy', '앞선 받아쓰기')
    const streams = speechBridgeStreams(speech.service, vi.fn())
    expect(streams.start(undefined)).toEqual({ ok: false, code: 'busy', message: '앞선 받아쓰기' })
    expect(() => streams.chunk(1, new Int16Array(1))).not.toThrow()
  })
})
