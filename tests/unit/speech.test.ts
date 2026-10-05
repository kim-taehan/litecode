import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from 'cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsService, type Settings } from '../../src/services/settings.ts'
import { FeaturesService } from '../../src/services/features.ts'
import { checkPcm, SpeechError, speechReply, SpeechService, type SpeechHost, type SpeechWorkerHandle } from '../../src/services/speech.ts'
import { bundledSpeechDir, checkSpeechAssets, devSpeechDir, runtimePackage, SPEECH_MODELS, speechTarget, type AssetCheck } from '../../src/services/speech/assets.ts'
import { joinPieces, LEAD_SILENCE_MS, toSamples, transcribeSamples, type VadLike, type WorkerReply, type WorkerRequest } from '../../src/services/speech/audio.ts'
import { SPEECH_MAX_SAMPLES, speechLanguage, type SpeechStatus } from '../../shared/speech.ts'
import { setMainLanguage } from '../../src/i18n.ts'

// 음성 입력 (ctx.speech, 기능 voice) — 서비스는 Electron·sherpa 를 모른다: 워커는 가짜 host 로, 파일 대조는 주입한 check 로, 시간은 가짜 시계로.
// 진짜 엔진(utilityProcess + sherpa-onnx-node)이 글을 내는지는 여기서 안 본다 — 그 확인은 받아 둔 build/vendor 로 수동이다.

class FakeWorker implements SpeechWorkerHandle {
  /** 종류와 상관없이 pcm·language 를 읽을 수 있게 */
  posts: (WorkerRequest & { pcm?: Int16Array; language?: string })[] = []
  killed = false
  constructor(private on: { message(reply: WorkerReply): void; exit(): void }) {}
  post(request: WorkerRequest): void {
    this.posts.push(request)
  }
  kill(): void {
    this.killed = true
  }
  ready(): void {
    this.on.message({ type: 'ready', loadMs: 500 })
  }
  fatal(message: string): void {
    this.on.message({ type: 'fatal', message })
  }
  /** 마지막으로 받은 요청에 답한다 */
  answer(text: string, inferMs = 100): void {
    this.on.message({ type: 'result', id: this.posts.at(-1)!.id, text, inferMs })
  }
  /** 마지막으로 받은 조각(stream-feed)에 답한다 */
  partial(final: string, tentative: string, inferMs = 10): void {
    this.on.message({ type: 'partial', id: this.posts.at(-1)!.id, final, tentative, inferMs })
  }
  exit(): void {
    this.on.exit()
  }
}

class FakeHost implements SpeechHost {
  workers: FakeWorker[] = []
  roots: string[] = []
  start(root: string, on: { message(reply: WorkerReply): void; exit(): void }): FakeWorker {
    const worker = new FakeWorker(on)
    this.workers.push(worker)
    this.roots.push(root)
    return worker
  }
  get last(): FakeWorker {
    return this.workers.at(-1)!
  }
}

const OK: AssetCheck = { ok: true }
/** 1초짜리 녹음 */
const pcm = (seconds = 1): Int16Array => new Int16Array(16_000 * seconds)
/** 밀린 마이크로태스크를 다 돌린다 (가짜 시계) */
const tick = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0)

let fibers: { dispose(): Promise<void> }[] = []

async function start(opts: { check?: () => Promise<AssetCheck>; root?: string | null; settings?: Partial<Settings> } = {}): Promise<{ ctx: Context; speech: SpeechService; host: FakeHost; seen: SpeechStatus[]; fiber: { dispose(): Promise<void> } }> {
  const ctx = new Context()
  const host = new FakeHost()
  const seen: SpeechStatus[] = []
  ctx.on('speech/changed', (status) => void seen.push(status))
  fibers.push(ctx.plugin(SettingsService, { defaults: { language: 'ko', ...opts.settings } }))
  const fiber = ctx.plugin(SpeechService, { host, root: opts.root === null ? undefined : (opts.root ?? '/speech'), check: opts.check ?? (async () => OK) })
  fibers.push(fiber)
  const ready = await new Promise<Context>((resolve) => ctx.inject(['settings', 'speech'], resolve))
  vi.useFakeTimers()
  await tick()
  return { ctx: ready, speech: ready.speech, host, seen, fiber }
}

/** 엔진이 떠 있고 쉬는 상태까지 — 한 번 받아쓴다 */
async function warm(speech: SpeechService, host: FakeHost): Promise<FakeWorker> {
  const done = speech.transcribe(pcm())
  await tick()
  const worker = host.last
  worker.ready()
  await tick()
  worker.answer('하나')
  await done
  return worker
}

afterEach(async () => {
  vi.useRealTimers()
  setMainLanguage('ko')
  const mounted = fibers.reverse()
  fibers = []
  for (const fiber of mounted) await Promise.resolve(fiber.dispose()).catch(() => {}) // 이미 내린 것은 undefined 를 돌려준다
})

describe('상태', () => {
  it('파일 대조가 끝나기 전엔 "확인 중", 끝나면 준비됨 — 바뀔 때 알린다. 엔진은 아직 안 띄운다', async () => {
    let finish!: (check: AssetCheck) => void
    const { speech, host, seen } = await start({ check: () => new Promise((resolve) => (finish = resolve)) })
    expect(speech.status()).toEqual({ state: 'unavailable', reason: 'checking', language: 'ko' })
    finish(OK)
    await tick()
    expect(speech.status()).toEqual({ state: 'ready', language: 'ko' })
    expect(seen).toEqual([{ state: 'ready', language: 'ko' }])
    expect(host.workers).toHaveLength(0)
  })

  it('파일이 없거나 대조가 틀리면 준비 안 됨 — 요청은 엔진을 띄우지 않고 거절된다', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const reason of ['missing', 'mismatch'] as const) {
      const { speech, host } = await start({ check: async () => ({ ok: false, reason, file: 'models/model.int8.onnx' }) })
      expect(speech.status()).toEqual({ state: 'unavailable', reason, language: 'ko' })
      expect(await speechReply(speech.transcribe(pcm()))).toMatchObject({ ok: false, code: 'unavailable' })
      expect(host.workers).toHaveLength(0)
      vi.useRealTimers()
    }
  })

  it('이 판용 엔진 자리가 없거나(root 없음) 대조가 던져도 서비스는 뜬다 — 준비 안 됨', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const none = await start({ root: null })
    expect(none.speech.status()).toMatchObject({ state: 'unavailable', reason: 'missing' })
    vi.useRealTimers()
    const thrown = await start({ check: async () => Promise.reject(new Error('EACCES')) })
    expect(thrown.speech.status()).toMatchObject({ state: 'unavailable', reason: 'missing' })
  })

  it('언어 힌트 기본은 화면 언어, 설정에 고른 값이 있으면 그것 — 바뀌면 알린다', async () => {
    expect(speechLanguage({ language: 'en' })).toBe('en')
    expect(speechLanguage({ language: 'en', speechLanguage: 'auto' })).toBe('auto')
    const { ctx, speech, seen } = await start({ settings: { language: 'en' } })
    expect(speech.status().language).toBe('en')
    ctx.settings.set({ speechLanguage: 'ko' })
    expect(speech.status().language).toBe('ko')
    expect(seen.at(-1)).toEqual({ state: 'ready', language: 'ko' })
    expect(() => ctx.settings.set({ speechLanguage: 'ja' as never })).toThrow()
  })
})

describe('받아쓰기', () => {
  it('첫 요청이 엔진을 띄우고(뜨는 중 → 준비됨), 뜬 뒤에 PCM 을 보내 글·길이·걸린 시간을 돌려준다', async () => {
    const { speech, host, seen } = await start()
    const done = speech.transcribe(pcm(2))
    await tick()
    expect(host.roots).toEqual(['/speech'])
    expect(speech.status().state).toBe('starting')
    expect(host.last.posts).toHaveLength(0) // 뜨기 전엔 안 보낸다
    host.last.ready()
    await tick()
    expect(speech.status().state).toBe('ready')
    expect(host.last.posts).toHaveLength(1)
    expect(host.last.posts[0]).toMatchObject({ type: 'transcribe', language: 'ko' })
    expect(host.last.posts[0]!.pcm).toHaveLength(32_000)
    host.last.answer('안녕하세요', 250)
    expect(await done).toEqual({ text: '안녕하세요', audioSeconds: 2, inferSeconds: 0.25 })
    expect(seen.map((status) => status.state)).toEqual(['ready', 'starting', 'ready'])
  })

  it('언어를 주면 그 힌트로, 모르는 언어는 거절한다', async () => {
    const { speech, host } = await start()
    const worker = await warm(speech, host)
    const done = speech.transcribe(pcm(), { language: 'auto' })
    await tick()
    expect(worker.posts.at(-1)!.language).toBe('auto')
    worker.answer('')
    expect((await done).text).toBe('') // 말이 없으면 빈 글 (오류가 아니다)
    expect(await speechReply(speech.transcribe(pcm(), { language: 'ja' }))).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('한 번에 하나 — 앞의 것이 끝나야 다음을 보낸다. 대기는 2개까지, 넘으면 busy', async () => {
    const { speech, host } = await start()
    const worker = await warm(speech, host)
    const first = speech.transcribe(pcm(1))
    const second = speech.transcribe(pcm(2))
    const third = speech.transcribe(pcm(3))
    const fourth = speechReply(speech.transcribe(pcm(4)))
    await tick()
    expect(await fourth).toMatchObject({ ok: false, code: 'busy' })
    expect(worker.posts).toHaveLength(2) // warm + first
    worker.answer('첫째')
    expect((await first).text).toBe('첫째')
    await tick()
    expect(worker.posts).toHaveLength(3)
    expect(worker.posts.at(-1)!.pcm).toHaveLength(32_000)
    worker.answer('둘째')
    expect((await second).text).toBe('둘째')
    await tick()
    worker.answer('셋째')
    expect((await third).text).toBe('셋째')
    expect(host.workers).toHaveLength(1) // 같은 엔진으로
    expect(new Set(worker.posts.map((post) => post.id)).size).toBe(4)
  })

  it('옛 번호의 답은 버린다', async () => {
    const { speech, host } = await start()
    const worker = await warm(speech, host)
    const done = speech.transcribe(pcm())
    await tick()
    worker['on'].message({ type: 'result', id: worker.posts[0]!.id, text: '옛 답', inferMs: 1 })
    worker.answer('새 답')
    expect((await done).text).toBe('새 답')
  })

  it('기한 60초 — 답이 없으면 timeout 으로 끝내고 엔진을 죽인다. 다음 요청은 새 엔진을 띄운다', async () => {
    const { speech, host } = await start()
    const worker = await warm(speech, host)
    const stuck = speechReply(speech.transcribe(pcm()))
    await vi.advanceTimersByTimeAsync(59_999)
    expect(worker.killed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await stuck).toMatchObject({ ok: false, code: 'timeout' })
    expect(worker.killed).toBe(true)
    const next = speech.transcribe(pcm())
    await tick()
    expect(host.workers).toHaveLength(2)
    host.last.ready()
    await tick()
    host.last.answer('다시')
    expect((await next).text).toBe('다시')
  })

  it('엔진이 뜨다 멈춰도 기한이 끝낸다 (뜨는 시간 포함)', async () => {
    const { speech, host } = await start()
    const stuck = speechReply(speech.transcribe(pcm()))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await stuck).toMatchObject({ ok: false, code: 'timeout' })
    expect(host.last.killed).toBe(true)
    expect(speech.status().state).toBe('ready')
  })

  it('도는 요청을 취소하면 엔진을 죽이고 cancelled — 기다리던 다음 요청이 새 엔진으로 이어진다', async () => {
    const { speech, host } = await start()
    const worker = await warm(speech, host)
    const abort = new AbortController()
    const running = speechReply(speech.transcribe(pcm(), {}, abort.signal))
    const waiting = speech.transcribe(pcm(3))
    await tick()
    abort.abort()
    expect(await running).toMatchObject({ ok: false, code: 'cancelled' })
    expect(worker.killed).toBe(true)
    await tick()
    expect(host.workers).toHaveLength(2)
    host.last.ready()
    await tick()
    expect(host.last.posts[0]!.pcm).toHaveLength(48_000)
    host.last.answer('이어서')
    expect((await waiting).text).toBe('이어서')
  })

  it('기다리던 요청을 취소하면 그것만 빠진다 — 엔진은 그대로', async () => {
    const { speech, host } = await start()
    const worker = await warm(speech, host)
    const abort = new AbortController()
    const running = speech.transcribe(pcm())
    const waiting = speechReply(speech.transcribe(pcm(), {}, abort.signal))
    await tick()
    abort.abort()
    expect(await waiting).toMatchObject({ ok: false, code: 'cancelled' })
    expect(worker.killed).toBe(false)
    worker.answer('그대로')
    expect((await running).text).toBe('그대로')
    await tick()
    expect(worker.posts).toHaveLength(2) // 취소한 것은 보내지 않았다
  })

  it('이미 취소된 신호로는 시작하지 않는다', async () => {
    const { speech, host } = await start()
    const abort = new AbortController()
    abort.abort()
    expect(await speechReply(speech.transcribe(pcm(), {}, abort.signal))).toMatchObject({ ok: false, code: 'cancelled' })
    expect(host.workers).toHaveLength(0)
  })

  it('5분 쉬면 엔진을 내린다 — 그 사이 요청이 오면 다시 5분, 내린 뒤의 요청은 새로 띄운다', async () => {
    const { speech, host } = await start()
    const worker = await warm(speech, host)
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    const again = speech.transcribe(pcm())
    await tick()
    worker.answer('둘')
    await again
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    expect(worker.killed).toBe(false) // 마지막 요청부터 4분
    await vi.advanceTimersByTimeAsync(60_000)
    expect(worker.killed).toBe(true)
    expect(speech.status().state).toBe('ready')
    const next = speech.transcribe(pcm())
    await tick()
    expect(host.workers).toHaveLength(2)
    host.last.ready()
    await tick()
    host.last.answer('셋')
    expect((await next).text).toBe('셋')
  })

  it('엔진이 못 뜨면(fatal) failed 에 사유 — 다음 요청 때 다시 띄워 본다', async () => {
    const { speech, host } = await start()
    const first = speechReply(speech.transcribe(pcm()))
    await tick()
    host.last.fatal('Cannot find module sherpa-onnx-node')
    const reply = await first
    expect(reply).toMatchObject({ ok: false, code: 'failed' })
    expect(reply.ok === false && reply.message).toContain('Cannot find module sherpa-onnx-node')
    expect(speech.status().state).toBe('ready')
    void speechReply(speech.transcribe(pcm()))
    await tick()
    expect(host.workers).toHaveLength(2)
  })

  it('host 가 띄우다 던져도 failed 로 끝난다', async () => {
    const { speech, host } = await start()
    host.start = () => {
      throw new Error('fork failed')
    }
    expect(await speechReply(speech.transcribe(pcm()))).toMatchObject({ ok: false, code: 'failed' })
  })

  it('받아쓰는 중에 엔진이 죽으면 failed — 기다리던 요청은 새 엔진으로', async () => {
    const { speech, host } = await start()
    const worker = await warm(speech, host)
    const running = speechReply(speech.transcribe(pcm()))
    const waiting = speech.transcribe(pcm())
    await tick()
    worker.exit()
    expect(await running).toMatchObject({ ok: false, code: 'failed' })
    await tick()
    expect(host.workers).toHaveLength(2)
    host.last.ready()
    await tick()
    host.last.answer('살았다')
    expect((await waiting).text).toBe('살았다')
    worker.exit() // 죽인 엔진의 늦은 exit 는 새 엔진을 건드리지 않는다
    expect(host.last.killed).toBe(false)
  })

  it('내리면(dispose) 엔진을 거두고, 돌던 것·기다리던 것은 unavailable 로 끝난다. 쉬는 시계도 남지 않는다', async () => {
    const { speech, host, fiber } = await start()
    const worker = await warm(speech, host)
    const running = speechReply(speech.transcribe(pcm()))
    const waiting = speechReply(speech.transcribe(pcm()))
    await tick()
    vi.useRealTimers()
    await fiber.dispose()
    expect(worker.killed).toBe(true)
    expect(await running).toMatchObject({ ok: false, code: 'unavailable' })
    expect(await waiting).toMatchObject({ ok: false, code: 'unavailable' })
    expect(await speechReply(speech.transcribe(pcm()))).toMatchObject({ ok: false, code: 'unavailable' })
    expect(host.workers).toHaveLength(1)
  })
})

describe('실시간 받아쓰기 (openStream)', () => {
  /** 0.1초 조각 — 표본 값으로 어느 조각인지 가린다 */
  const chunk = (mark = 0, samples = 1600): Int16Array => new Int16Array(samples).fill(mark)

  it('엔진이 뜨는 동안 온 조각은 쥐고 있다가, 뜨면 stream-start 뒤에 하나로 합쳐 보낸다', async () => {
    const { speech, host } = await start()
    const stream = speech.openStream({}, () => {})
    stream.write(chunk(1))
    stream.write(chunk(2))
    await tick()
    expect(host.last.posts).toHaveLength(0)
    expect(speech.status().state).toBe('starting')
    host.last.ready()
    await tick()
    expect(host.last.posts.map((post) => post.type)).toEqual(['stream-start', 'stream-feed'])
    expect(host.last.posts[0]).toMatchObject({ language: 'ko' })
    const fed = host.last.posts[1]!.pcm!
    expect(fed).toHaveLength(3200)
    expect([fed[0], fed[1599], fed[1600], fed[3199]]).toEqual([1, 1, 2, 2])
    stream.cancel()
  })

  it('앞 조각의 답을 받은 뒤에만 다음을 보낸다 — 그사이 밀린 조각은 가장 최근 것까지 하나로. 답마다 확정·임시 글을 알린다', async () => {
    const { speech, host } = await start()
    const worker = await warm(speech, host)
    const seen: unknown[] = []
    const stream = speech.openStream({ language: 'en' }, (partial) => void seen.push(partial))
    await tick()
    const base = worker.posts.length // warm 의 transcribe + stream-start
    expect(worker.posts.at(-1)).toMatchObject({ type: 'stream-start', language: 'en' })
    stream.write(chunk(1))
    expect(worker.posts).toHaveLength(base + 1) // 떠 있는 엔진엔 곧바로
    stream.write(chunk(2))
    stream.write(chunk(3))
    stream.write(chunk(4))
    expect(worker.posts).toHaveLength(base + 1) // 답이 오기 전엔 더 안 보낸다
    worker.partial('', '안녕')
    expect(seen).toEqual([{ final: '', tentative: '안녕' }])
    expect(worker.posts).toHaveLength(base + 2)
    expect(worker.posts.at(-1)!.pcm).toHaveLength(4800)
    worker.partial('안녕하세요.', '')
    expect(seen.at(-1)).toEqual({ final: '안녕하세요.', tentative: '' })
    expect(worker.posts).toHaveLength(base + 2) // 밀린 것이 없으면 안 보낸다
    stream.cancel()
  })

  it('정지 — 남은 조각을 실어 stop 을 보내고, 그 답이 최종 글이다 (길이·걸린 시간은 스트림 전체)', async () => {
    const { speech, host } = await start()
    const worker = await warm(speech, host)
    const stream = speech.openStream({}, () => {})
    await tick()
    stream.write(chunk(1))
    stream.write(chunk(2))
    const done = stream.stop()
    expect(worker.posts.at(-1)!.type).toBe('stream-feed') // 앞 조각의 답을 아직 기다린다
    stream.write(chunk(9)) // 정지 뒤의 조각은 버린다
    worker.partial('하나', '', 40)
    expect(worker.posts.at(-1)).toMatchObject({ type: 'stream-stop' })
    expect(worker.posts.at(-1)!.pcm).toHaveLength(1600)
    expect(worker.posts.at(-1)!.pcm![0]).toBe(2)
    worker.answer('하나 둘', 60)
    expect(await done).toEqual({ text: '하나 둘', audioSeconds: 0.2, inferSeconds: 0.1 })
    expect(await stream.done).toMatchObject({ text: '하나 둘' })
    expect(worker.killed).toBe(false)
  })

  it('조각 없이 정지해도 끝난다 (말이 없으면 빈 글)', async () => {
    const { speech, host } = await start()
    const stream = speech.openStream({}, () => {})
    const done = stream.stop()
    await tick()
    host.last.ready()
    await tick()
    expect(host.last.posts.map((post) => post.type)).toEqual(['stream-start', 'stream-stop'])
    expect(host.last.posts[1]!.pcm).toBeUndefined()
    host.last.answer('')
    expect((await done).text).toBe('')
  })

  it('한 번에 하나 — 스트림 중의 다른 요청은 busy, 다른 것이 돌거나 기다리면 스트림도 busy', async () => {
    const { speech, host } = await start()
    const worker = await warm(speech, host)
    const stream = speech.openStream({}, () => {})
    expect(() => speech.openStream({}, () => {})).toThrowError(expect.objectContaining({ code: 'busy' }))
    expect(await speechReply(speech.transcribe(pcm()))).toMatchObject({ ok: false, code: 'busy' })
    stream.cancel()
    const running = speech.transcribe(pcm())
    expect(() => speech.openStream({}, () => {})).toThrowError(expect.objectContaining({ code: 'busy' }))
    await tick()
    worker.answer('끝')
    await running
    expect(() => speech.openStream({ language: 'ja' }, () => {})).toThrowError(expect.objectContaining({ code: 'invalid' }))
    speech.openStream({}, () => {}).cancel() // 끝난 뒤엔 열린다
  })

  it('취소 — 버리고 cancelled 로 끝난다. 엔진은 살려 두고(stream-cancel) 다음 녹음이 그대로 쓴다', async () => {
    const { speech, host } = await start()
    const worker = await warm(speech, host)
    const seen: unknown[] = []
    const stream = speech.openStream({}, (partial) => void seen.push(partial))
    await tick()
    stream.write(chunk(1))
    stream.cancel()
    await expect(stream.done).rejects.toMatchObject({ code: 'cancelled' })
    expect(worker.posts.at(-1)!.type).toBe('stream-cancel')
    expect(worker.killed).toBe(false)
    worker.partial('늦은 답', '') // 버린 스트림의 답은 알리지 않는다
    expect(seen).toEqual([])
    stream.write(chunk(2)) // 끝난 스트림에 쓴 조각도 버린다
    const next = speech.openStream({}, () => {})
    await tick()
    expect(host.workers).toHaveLength(1)
    expect(worker.posts.at(-1)!.type).toBe('stream-start')
    next.cancel()
  })

  it('엔진이 뜨기 전에 취소하면 워커에 아무것도 안 보낸다', async () => {
    const { speech, host } = await start()
    const stream = speech.openStream({}, () => {})
    stream.write(chunk())
    await tick()
    stream.cancel()
    host.last.ready()
    await tick()
    expect(host.last.posts).toHaveLength(0)
  })

  it('상한 120초 — 넘는 조각은 잘라 버린다. 조각 하나는 1초까지, 모양이 틀리면 invalid', async () => {
    const { speech, host } = await start()
    const worker = await warm(speech, host)
    const stream = speech.openStream({}, () => {})
    await tick()
    for (let second = 0; second < 119; second++) stream.write(chunk(0, 16_000))
    stream.write(chunk(0, 12_000))
    stream.write(chunk(7, 16_000)) // 4000 표본만 남았다
    stream.write(chunk(8)) // 꽉 찼다
    worker.partial('', '')
    const fed = worker.posts.at(-1)!.pcm!
    expect(fed).toHaveLength(SPEECH_MAX_SAMPLES - 16_000) // 첫 1초는 먼저 갔다
    expect(fed.at(-1)).toBe(7)
    const done = stream.stop()
    worker.partial('', '')
    expect(worker.posts.at(-1)!.pcm).toBeUndefined()
    worker.answer('끝')
    expect((await done).audioSeconds).toBe(120)
    const other = speech.openStream({}, () => {})
    for (const bad of [new Int16Array(0), new Int16Array(16_001), new Float32Array(1600), [1, 2], undefined]) {
      expect(() => other.write(bad)).toThrowError(expect.objectContaining({ code: 'invalid' }))
    }
    other.cancel()
  })

  it('기한 — 정지를 안 부른 스트림은 연 때부터 180초에, 정지 뒤엔 60초에 timeout 으로 끝내고 엔진을 죽인다', async () => {
    const { speech, host } = await start()
    const worker = await warm(speech, host)
    const left = speech.openStream({}, () => {})
    await vi.advanceTimersByTimeAsync(179_999)
    expect(worker.killed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(left.done).rejects.toMatchObject({ code: 'timeout' })
    expect(worker.killed).toBe(true)

    const stream = speech.openStream({}, () => {})
    await tick()
    host.last.ready()
    await tick()
    await vi.advanceTimersByTimeAsync(100_000)
    const stopped = speechReply(stream.stop())
    await vi.advanceTimersByTimeAsync(59_999)
    expect(host.last.killed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await stopped).toMatchObject({ ok: false, code: 'timeout' })
    expect(host.last.killed).toBe(true)
  })

  it('도는 동안엔 쉬는 시계가 안 돌고, 끝난 뒤 5분 쉬면 엔진을 내린다', async () => {
    const { speech, host } = await start()
    const worker = await warm(speech, host)
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    const stream = speech.openStream({}, () => {})
    await vi.advanceTimersByTimeAsync(2 * 60_000) // 쉰 지 6분이지만 스트림이 열려 있다
    expect(worker.killed).toBe(false)
    const done = stream.stop()
    worker.answer('끝')
    await done
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1)
    expect(worker.killed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(worker.killed).toBe(true)
  })

  it('스트림 중에 엔진이 죽거나 오류를 내면 failed 로 끝난다', async () => {
    const { speech, host } = await start()
    const worker = await warm(speech, host)
    const stream = speech.openStream({}, () => {})
    await tick()
    stream.write(chunk())
    worker.exit()
    await expect(stream.done).rejects.toMatchObject({ code: 'failed' })

    const next = speech.openStream({}, () => {})
    await tick()
    host.last.ready()
    await tick()
    next.write(chunk())
    host.last['on'].message({ type: 'error', id: host.last.posts.at(-1)!.id, message: 'onnx' })
    await expect(next.done).rejects.toMatchObject({ code: 'failed' })
  })

  it('내리면(dispose) 열려 있던 스트림은 unavailable 로 끝나고 엔진을 거둔다', async () => {
    const { speech, host, fiber } = await start()
    const worker = await warm(speech, host)
    const stream = speech.openStream({}, () => {})
    await tick()
    vi.useRealTimers()
    await fiber.dispose()
    await expect(stream.done).rejects.toMatchObject({ code: 'unavailable' })
    expect(worker.killed).toBe(true)
    expect(() => speech.openStream({}, () => {})).toThrowError(expect.objectContaining({ code: 'unavailable' }))
  })
})

describe('PCM 검증 — 화면이 보낸 것을 메인이 다시 본다', () => {
  it('Int16Array 이고 0 < 길이 ≤ 120초일 때만', () => {
    const code = (value: unknown): string => {
      try {
        checkPcm(value)
        return 'ok'
      } catch (error) {
        return (error as SpeechError).code
      }
    }
    expect(code(new Int16Array(1))).toBe('ok')
    expect(code(new Int16Array(SPEECH_MAX_SAMPLES))).toBe('ok')
    expect(SPEECH_MAX_SAMPLES).toBe(1_920_000)
    expect(code(new Int16Array(SPEECH_MAX_SAMPLES + 1))).toBe('too-long')
    expect(code(new Int16Array(0))).toBe('invalid')
    for (const value of [undefined, null, 'pcm', 16_000, [1, 2, 3], {}, new Float32Array(16_000), new Uint8Array(16_000), new ArrayBuffer(32), Buffer.alloc(32)]) {
      expect(code(value), String(value)).toBe('invalid')
    }
  })

  it('틀린 PCM 은 엔진을 띄우지 않고 거절하고, 문구는 메인의 지금 언어', async () => {
    const { speech, host } = await start()
    expect(await speechReply(speech.transcribe(new Float32Array(100)))).toEqual({ ok: false, code: 'invalid', message: '받아쓸 소리가 없습니다' })
    setMainLanguage('en')
    expect(await speechReply(speech.transcribe(new Int16Array(SPEECH_MAX_SAMPLES + 1)))).toEqual({ ok: false, code: 'too-long', message: 'The recording is too long (up to 120s)' })
    expect(host.workers).toHaveLength(0)
  })

  it('speechReply 는 모르는 오류도 failed 로 돌려준다 (던지지 않는다)', async () => {
    expect(await speechReply(Promise.reject(new Error('boom')))).toMatchObject({ ok: false, code: 'failed' })
    expect(await speechReply(Promise.resolve({ text: 'a', audioSeconds: 1, inferSeconds: 0.1 }))).toEqual({ ok: true, text: 'a', audioSeconds: 1, inferSeconds: 0.1 })
  })
})

describe('엔진·모델 자리와 대조', () => {
  let dir: string
  const models = [
    { file: 'model.int8.onnx', bytes: Buffer.from('model') },
    { file: 'tokens.txt', bytes: Buffer.from('tokens') },
  ]
  const manifest = models.map(({ file, bytes }) => ({ file, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }))
  const check = (): Promise<AssetCheck> => checkSpeechAssets(dir, { platform: 'darwin', arch: 'arm64', models: manifest })

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litecode-speech-'))
    fs.mkdirSync(path.join(dir, 'node_modules', 'sherpa-onnx-node'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'node_modules', 'sherpa-onnx-darwin-arm64'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'models'))
    fs.writeFileSync(path.join(dir, 'node_modules', 'sherpa-onnx-node', 'package.json'), '{}')
    fs.writeFileSync(path.join(dir, 'node_modules', 'sherpa-onnx-darwin-arm64', 'sherpa-onnx.node'), 'native')
    for (const { file, bytes } of models) fs.writeFileSync(path.join(dir, 'models', file), bytes)
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('다 있고 받은 그대로면 ok', async () => {
    expect(await check()).toEqual({ ok: true })
  })

  it('폴더가 없으면 missing (던지지 않는다)', async () => {
    expect(await checkSpeechAssets(path.join(dir, 'nope'))).toMatchObject({ ok: false, reason: 'missing' })
  })

  it('네이티브 모듈이 없으면 missing — 다른 판의 것은 치지 않는다', async () => {
    expect(await checkSpeechAssets(dir, { platform: 'win32', arch: 'x64', models: manifest })).toEqual({ ok: false, reason: 'missing', file: path.join('node_modules', 'sherpa-onnx-win-x64', 'sherpa-onnx.node') })
  })

  it('모델 파일이 없으면 missing', async () => {
    fs.rmSync(path.join(dir, 'models', 'tokens.txt'))
    expect(await check()).toEqual({ ok: false, reason: 'missing', file: path.join('models', 'tokens.txt') })
  })

  it('크기가 다르면(받다 끊겼다) mismatch', async () => {
    fs.writeFileSync(path.join(dir, 'models', 'model.int8.onnx'), 'mod')
    expect(await check()).toEqual({ ok: false, reason: 'mismatch', file: path.join('models', 'model.int8.onnx') })
  })

  it('크기는 같고 내용이 다르면(sha256) mismatch', async () => {
    fs.writeFileSync(path.join(dir, 'models', 'tokens.txt'), 'tokenz')
    expect(await check()).toEqual({ ok: false, reason: 'mismatch', file: path.join('models', 'tokens.txt') })
  })

  it('엔진이 있는 판은 mac arm64·x64, win x64 — 자리 이름은 electron-builder 의 os-arch', () => {
    expect(speechTarget('darwin', 'arm64')).toBe('mac-arm64')
    expect(speechTarget('darwin', 'x64')).toBe('mac-x64')
    expect(speechTarget('win32', 'x64')).toBe('win-x64')
    expect(speechTarget('win32', 'arm64')).toBeUndefined()
    expect(speechTarget('linux', 'x64')).toBeUndefined()
    expect(devSpeechDir('/repo', 'darwin', 'arm64')).toBe(path.join('/repo', 'build', 'vendor', 'speech', 'mac-arm64'))
    expect(devSpeechDir('/repo', 'linux', 'x64')).toBeUndefined()
    expect(bundledSpeechDir('/app/Resources')).toBe(path.join('/app/Resources', 'speech'))
    expect(runtimePackage('win32', 'x64')).toBe('sherpa-onnx-win-x64') // sherpa 는 win32 를 win 으로 부른다
    expect(runtimePackage('darwin', 'arm64')).toBe('sherpa-onnx-darwin-arm64')
  })

  it('앱이 대조하는 모델 값은 받기 스크립트(scripts/fetch-speech.mjs)의 값과 같다', () => {
    const script = fs.readFileSync(path.join(import.meta.dirname, '../../scripts/fetch-speech.mjs'), 'utf8')
    expect(SPEECH_MODELS.map((model) => model.file)).toEqual(['model.int8.onnx', 'tokens.txt', 'silero_vad.onnx'])
    for (const model of SPEECH_MODELS) {
      expect(script, model.file).toContain(`'${model.file}'`)
      expect(script, model.file).toContain(`size: ${model.size}`)
      expect(script, model.file).toContain(`sha256: '${model.sha256}'`)
    }
  })
})

describe('워커의 순수한 부분', () => {
  it('PCM16 을 float 로 바꾸고 앞에 무음 300ms 를 붙인다 (VAD 가 첫 음절을 자르지 않게)', () => {
    const samples = toSamples(new Int16Array([16384, -32768, 32767]))
    expect(LEAD_SILENCE_MS).toBe(300)
    expect(samples).toHaveLength(4800 + 3)
    expect(Array.from(samples.subarray(0, 4800)).every((sample) => sample === 0)).toBe(true)
    expect(samples[4800]).toBe(0.5)
    expect(samples[4801]).toBe(-1)
    expect(samples[4802]).toBeCloseTo(1, 4)
    expect(toSamples(new Int16Array([1]), 0)).toHaveLength(1)
  })

  it('조각 글은 다듬어 공백으로 잇고 빈 조각은 버린다', () => {
    expect(joinPieces([' 로그인 버튼을 ', '', '   ', '눌렀을 때'])).toBe('로그인 버튼을 눌렀을 때')
    expect(joinPieces([])).toBe('')
  })

  it('512 표본씩 VAD 에 넣고, 나온 말 구간마다 인식해 잇는다 — 끝에 남은 구간(flush)까지, 구간은 복사본으로 받는다', () => {
    const fed: number[] = []
    const fronts: boolean[] = []
    let queue: Float32Array[] = []
    let resets = 0
    const vad: VadLike = {
      reset: () => void resets++,
      acceptWaveform(samples) {
        fed.push(samples.length)
        if (fed.length === 2) queue.push(new Float32Array([1])) // 둘째 창 뒤에 구간 하나
      },
      isEmpty: () => queue.length === 0,
      isDetected: () => false,
      front(external) {
        fronts.push(external)
        return { samples: queue[0]! }
      },
      pop: () => void queue.shift(),
      flush: () => void (queue = [...queue, new Float32Array([2]), new Float32Array([3])]),
    }
    const text = transcribeSamples(vad, (samples) => ['', '첫 구간 ', '', '끝 구간'][samples[0]!]!, new Float32Array(1200))
    expect(fed).toEqual([512, 512, 176])
    expect(resets).toBe(1)
    expect(fronts).toEqual([false, false, false])
    expect(text).toBe('첫 구간 끝 구간') // 구간 2 는 빈 글이라 버렸다
  })

  it('말이 없으면 빈 글', () => {
    const silent: VadLike = { reset() {}, acceptWaveform() {}, isEmpty: () => true, isDetected: () => false, front: () => ({ samples: new Float32Array() }), pop() {}, flush() {} }
    expect(transcribeSamples(silent, () => 'x', new Float32Array(5000))).toBe('')
  })
})

describe('기능 voice — 기본 꺼짐', () => {
  it('꺼져 있으면 묶음(서비스·엔진)이 없고, 켜면 올라오고, 끄면 엔진까지 거둔다', async () => {
    const ctx = new Context()
    const host = new FakeHost()
    fibers.push(ctx.plugin(SettingsService, {}))
    fibers.push(ctx.plugin(FeaturesService, [{ id: 'voice', plugin: (ctx: Context) => void ctx.plugin(SpeechService, { host, root: '/speech', check: async () => OK }) }]))
    const ready = await new Promise<Context>((resolve) => ctx.inject(['settings', 'features'], resolve))
    await ready.features.idle()
    expect(ready.features.isEnabled('voice')).toBe(false)
    expect(ctx.get('speech')).toBeUndefined()

    ready.settings.set({ features: { voice: true } })
    await ready.features.idle()
    const speech = ctx.get('speech')!
    expect(speech).toBeDefined()
    const done = speech.transcribe(pcm())
    await vi.waitFor(() => expect(host.workers).toHaveLength(1))
    host.last.ready()
    await vi.waitFor(() => expect(host.last.posts).toHaveLength(1))
    host.last.answer('켜짐')
    expect((await done).text).toBe('켜짐')

    ready.settings.set({ features: {} })
    await ready.features.idle()
    expect(ctx.get('speech')).toBeUndefined()
    expect(host.last.killed).toBe(true)
  })
})
