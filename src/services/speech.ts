import { Context, Service } from 'cordis'
import './settings.ts'
import { tr } from '../i18n.ts'
import {
  SPEECH_CHUNK_MAX_SAMPLES,
  SPEECH_MAX_SAMPLES,
  SPEECH_MAX_SECONDS,
  SPEECH_SAMPLE_RATE,
  isSpeechLanguage,
  speechLanguage,
  type SpeechErrorCode,
  type SpeechLanguage,
  type SpeechPartial,
  type SpeechReply,
  type SpeechStatus,
  type SpeechTranscript,
} from '../../shared/speech.ts'
import { checkSpeechAssets, type AssetCheck } from './speech/assets.ts'
import type { WorkerReply, WorkerRequest } from './speech/audio.ts'

// 음성 입력 — 받아쓰기 (ctx.speech, 기능 `voice` · 기본 꺼짐). 실측·설계 _workspace/01ag_voice_input.md, dsh speech-to-text-sensevoice 를
// 참조했다(코드는 새로 썼다). 화면이 녹음을 16kHz mono PCM16 으로 줄여 보내면, 동봉한 엔진(sherpa-onnx-node + SenseVoiceSmall int8 +
// Silero VAD)으로 글을 돌려준다. 글은 돌려주기만 한다 — 대화 기록·엔진(opencode)을 모른다.
// 길은 둘이다: transcribe(녹음이 끝난 뒤 한 번에)와 openStream(**실시간** — 녹음하는 동안 조각을 받아 확정 글·임시 글을 돌려준다, speech/stream.ts).
//
// - 엔진은 따로 뜬 프로세스(워커)에 있다 — 네이티브 추론이 죽어도 메인이 살고, 중간에 멈출 길이 프로세스를 죽이는 것뿐이라서다.
//   **처음 쓸 때 띄우고, 5분 쉬면 내린다** (엔진 프로세스 메모리 0.7~1.0GB — 실측). 취소·기한 초과는 워커를 죽이고 다음 요청 때 다시 띄운다
// - 한 번에 하나, 대기 2개까지 (넘으면 busy). 기한은 차례가 온 때부터 60초 (엔진 뜨는 시간 포함)
// - 실시간 받아쓰기는 줄을 서지 않는다 — 다른 것이 돌거나 기다리면 busy, 도는 동안 온 다른 요청도 busy. 워커에는 **앞 조각의 답을 받은 뒤에만**
//   다음을 보내고 그사이 온 조각은 하나로 합친다 (인식이 밀려도 워커 앞에 조각이 쌓이지 않고, 임시 글은 늘 가장 최근 소리까지 본다).
//   녹음 상한 120초를 넘는 조각은 버린다. 기한은 연 때부터 상한 + 60초(정지를 안 부른 스트림을 거둔다), 정지 뒤 60초. 취소는 워커를 죽이지 않는다
//   (조각 하나의 인식은 짧다 — 워커가 멈췄으면 다음 요청의 기한이 죽인다)
// - Electron 을 모른다: 워커 띄우기·묻기·죽이기는 host 로 받는다 (electron/speechHost.ts 가 utilityProcess 로, 단위 테스트는 가짜로)
// - 생성자는 던지지 않는다. 파일 대조(239MB 를 읽는다)는 뜰 때 한 번 뒤에서 돌고, 그 사이 온 요청은 대조를 기다린다

/** 뜬 워커 하나 */
export interface SpeechWorkerHandle {
  post(request: WorkerRequest): void
  /** 곧바로 죽인다 (추론 중이어도). 죽은 뒤의 exit 알림은 와도 되고 안 와도 된다 */
  kill(): void
}

/** 워커 쪽 — 메인이 Electron 으로 채운다 */
export interface SpeechHost {
  /** root(엔진·모델 폴더)로 워커를 띄운다. 워커의 말과 끝남은 on 으로 */
  start(root: string, on: { message(reply: WorkerReply): void; exit(): void }): SpeechWorkerHandle
}

export interface SpeechOptions {
  host: SpeechHost
  /** 엔진·모델 폴더 (speech/assets.ts 의 자리). 없으면 — 이 판용 엔진이 없다 — 준비 안 됨 */
  root?: string
  /** 파일 대조 — 단위 테스트가 바꾼다 */
  check?: (root: string) => Promise<AssetCheck>
}

declare module 'cordis' {
  interface Context {
    speech: SpeechService
  }
  interface Events {
    /** status() 가 바뀌었다 */
    'speech/changed'(status: SpeechStatus): void
  }
}

/** 차례를 기다리는 요청 (지금 도는 것 말고) */
const MAX_WAITING = 2
const DEADLINE_MS = 60_000
/** 실시간 받아쓰기를 연 때부터의 기한 — 녹음 상한 + 마지막 인식 */
const STREAM_DEADLINE_MS = SPEECH_MAX_SECONDS * 1000 + DEADLINE_MS
const IDLE_MS = 5 * 60_000

/** 받아쓰기 실패 — code 로 화면이 문구·다음 행동을 고른다 */
export class SpeechError extends Error {
  constructor(
    readonly code: SpeechErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SpeechError'
  }
}

const MESSAGE = {
  invalid: 'speech.error.invalid',
  'too-long': 'speech.error.tooLong',
  unavailable: 'speech.error.unavailable',
  busy: 'speech.error.busy',
  timeout: 'speech.error.timeout',
  cancelled: 'speech.error.cancelled',
  failed: 'speech.error.failed',
} as const

function fail(code: SpeechErrorCode, detail?: string): SpeechError {
  const text = tr(MESSAGE[code], { seconds: code === 'timeout' ? DEADLINE_MS / 1000 : SPEECH_MAX_SECONDS })
  return new SpeechError(code, detail ? `${text} (${detail})` : text)
}

/** 화면이 보낸 것이 받아쓸 수 있는 PCM 인가 — 16kHz mono PCM16, 0 < 길이 ≤ 120초. 화면이 오염됐을 수 있어 메인이 다시 본다 */
export function checkPcm(pcm: unknown): Int16Array {
  if (!(pcm instanceof Int16Array) || pcm.length === 0) throw fail('invalid')
  if (pcm.length > SPEECH_MAX_SAMPLES) throw fail('too-long')
  return pcm
}

/** IPC 로 돌려줄 모양 — 던지지 않는다 */
export function speechReply(work: Promise<SpeechTranscript>): Promise<SpeechReply> {
  return work.then(
    (transcript) => ({ ok: true, ...transcript }),
    (error: unknown) =>
      error instanceof SpeechError ? { ok: false, code: error.code, message: error.message } : { ok: false, code: 'failed', message: fail('failed', (error as Error)?.message).message },
  )
}

/** 실시간 받아쓰기 한 번 (openStream) */
export interface SpeechStream {
  /** 녹음 조각 (16kHz mono PCM16, 0 < 길이 ≤ 1초) — 모양이 틀리면 SpeechError(invalid). 끝난 스트림·상한을 넘은 조각은 조용히 버린다 */
  write(pcm: unknown): void
  /** 녹음이 끝났다 — 남은 구간까지 확정한 글. done 과 같은 약속이다 */
  stop(): Promise<SpeechTranscript>
  /** 버린다 — done 은 cancelled 로 끝난다 */
  cancel(): void
  /** 어느 길로든 끝나면 — 글, 또는 SpeechError(엔진이 죽음·기한·취소·서비스가 내려감) */
  readonly done: Promise<SpeechTranscript>
}

interface StreamState {
  /** 워커에 아직 안 보낸 조각 */
  pending: Int16Array[]
  /** 받은 표본 수 (상한까지) */
  total: number
  /** 워커에 stream-start 를 보냈다 */
  open: boolean
  /** 보낸 조각의 답을 기다리는 중 */
  awaiting: boolean
  stopping: boolean
  inferMs: number
  partial(partial: SpeechPartial): void
}

interface Job {
  /** 실시간 받아쓰기면 — pcm 은 비어 있다 */
  stream?: StreamState
  pcm: Int16Array
  language: SpeechLanguage
  resolve(transcript: SpeechTranscript): void
  reject(error: SpeechError): void
  /** 취소 구독을 푼다 */
  unlisten(): void
  /** 워커에 보낸 번호 — 보내기 전엔 없다 */
  id?: number
  deadline?: ReturnType<typeof setTimeout>
}

interface Worker {
  handle: SpeechWorkerHandle
  up: boolean
  /** ready 를 기다리는 쪽 — 떴으면 undefined, 못 떴으면 사유 */
  waiters: ((failure?: string) => void)[]
}

export class SpeechService extends Service {
  static readonly inject = ['settings']

  /** 파일 대조 결과 — 끝나기 전엔 undefined */
  private assets?: AssetCheck
  private checked: Promise<AssetCheck>
  private worker?: Worker
  private running?: Job
  private waiting: Job[] = []
  private idle?: ReturnType<typeof setTimeout>
  private seq = 0
  private disposed = false
  private published = ''

  constructor(
    ctx: Context,
    private opts: SpeechOptions,
  ) {
    super(ctx, 'speech')
    const root = opts.root
    this.checked = (root ? (opts.check ?? checkSpeechAssets)(root) : Promise.resolve<AssetCheck>({ ok: false, reason: 'missing', file: '' }))
      .catch((): AssetCheck => ({ ok: false, reason: 'missing', file: '' }))
      .then((assets) => {
        if (!assets.ok) console.warn(`[speech] 엔진·모델을 못 쓴다 (${assets.reason}) ${root ?? '이 판용 엔진 없음'} ${assets.file}`)
        this.assets = assets
        this.publish()
        return assets
      })
    this.published = JSON.stringify(this.status())
    ctx.on('settings/changed', () => this.publish()) // 언어 힌트가 바뀐다
    ctx.effect(() => () => this.shutdown())
  }

  status(): SpeechStatus {
    const language = speechLanguage(this.ctx.settings.get())
    if (!this.assets) return { state: 'unavailable', reason: 'checking', language }
    if (!this.assets.ok) return { state: 'unavailable', reason: this.assets.reason, language }
    return { state: this.worker && !this.worker.up ? 'starting' : 'ready', language }
  }

  /** 받아쓴다. pcm 은 16kHz mono PCM16 (화면이 보낸 그대로 — 모양은 여기서 본다), language 를 빼면 설정 값(없으면 화면 언어).
   *  실패는 SpeechError(code). signal 로 취소하면 — 도는 중이면 워커를 죽이고 — cancelled 로 끝난다 */
  transcribe(pcm: unknown, opts: { language?: unknown } = {}, signal?: AbortSignal): Promise<SpeechTranscript> {
    return new Promise((resolve, reject) => {
      const samples = checkPcm(pcm)
      if (opts.language !== undefined && !isSpeechLanguage(opts.language)) throw fail('invalid')
      if (this.disposed) throw fail('unavailable')
      if (signal?.aborted) throw fail('cancelled')
      if (this.running?.stream || this.waiting.length >= MAX_WAITING) throw fail('busy')
      const onAbort = (): void => this.cancel(job)
      const job: Job = {
        pcm: samples,
        language: opts.language ?? speechLanguage(this.ctx.settings.get()),
        resolve,
        reject,
        unlisten: () => signal?.removeEventListener('abort', onAbort),
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiting.push(job)
      this.pump()
    })
  }

  /** 실시간 받아쓰기를 연다 — 조각은 write 로, 확정·임시 글은 onPartial 로, 끝은 stop(). 다른 받아쓰기가 돌거나 기다리면 busy 로 던진다.
   *  엔진이 뜨는 동안 온 조각은 쥐고 있다가 뜬 뒤에 보낸다 */
  openStream(opts: { language?: unknown }, onPartial: (partial: SpeechPartial) => void): SpeechStream {
    if (opts.language !== undefined && !isSpeechLanguage(opts.language)) throw fail('invalid')
    if (this.disposed) throw fail('unavailable')
    if (this.running || this.waiting.length) throw fail('busy')
    let job!: Job
    const done = new Promise<SpeechTranscript>((resolve, reject) => {
      job = {
        stream: { pending: [], total: 0, open: false, awaiting: false, stopping: false, inferMs: 0, partial: onPartial },
        pcm: new Int16Array(0),
        language: (opts.language as SpeechLanguage | undefined) ?? speechLanguage(this.ctx.settings.get()),
        resolve,
        reject,
        unlisten: () => {},
      }
    })
    done.catch(() => {}) // 끝을 안 듣는 쪽(취소만 하는 화면)이 있어도 처리 안 된 거절이 되지 않게
    this.waiting.push(job)
    this.pump()
    return {
      done,
      write: (pcm) => this.write(job, pcm),
      stop: () => {
        this.stopStream(job)
        return done
      },
      cancel: () => this.cancel(job),
    }
  }

  private write(job: Job, pcm: unknown): void {
    if (!(pcm instanceof Int16Array) || pcm.length === 0 || pcm.length > SPEECH_CHUNK_MAX_SAMPLES) throw fail('invalid')
    const stream = job.stream!
    const room = SPEECH_MAX_SAMPLES - stream.total
    if (this.running !== job || stream.stopping || room <= 0) return
    const chunk = pcm.length > room ? pcm.slice(0, room) : pcm
    stream.pending.push(chunk)
    stream.total += chunk.length
    this.flush(job)
  }

  private stopStream(job: Job): void {
    if (this.running !== job || job.stream!.stopping) return
    job.stream!.stopping = true
    clearTimeout(job.deadline)
    job.deadline = setTimeout(() => this.finish(job, fail('timeout'), true), DEADLINE_MS)
    this.flush(job)
  }

  /** 쥐고 있는 조각을 워커에 보낸다 — 앞 조각의 답을 기다리는 중이면 두고(답이 오면 다시 불린다), 여럿이면 하나로 합친다. 정지면 남은 것과 함께 stop */
  private flush(job: Job): void {
    const stream = job.stream!
    if (!stream.open || stream.awaiting || !this.worker) return
    if (!stream.stopping && !stream.pending.length) return
    const chunks = stream.pending.splice(0)
    let pcm = chunks[0]
    if (chunks.length > 1) {
      pcm = new Int16Array(chunks.reduce((length, chunk) => length + chunk.length, 0))
      let at = 0
      for (const chunk of chunks) {
        pcm.set(chunk, at)
        at += chunk.length
      }
    }
    stream.awaiting = true
    if (stream.stopping) this.worker.handle.post({ type: 'stream-stop', id: job.id!, ...(pcm && { pcm }) })
    else this.worker.handle.post({ type: 'stream-feed', id: job.id!, pcm: pcm! })
  }

  /** 다음 차례를 돌린다 — 한 번에 하나 */
  private pump(): void {
    if (this.running) return
    const job = this.waiting.shift()
    if (!job) return
    this.running = job
    clearTimeout(this.idle)
    job.deadline = setTimeout(() => this.finish(job, fail('timeout'), true), job.stream ? STREAM_DEADLINE_MS : DEADLINE_MS)
    void this.work(job)
  }

  private async work(job: Job): Promise<void> {
    const assets = await this.checked
    if (this.running !== job) return // 기다리는 사이 취소·기한
    if (!assets.ok) return this.finish(job, fail('unavailable'))
    const failure = await this.ensureWorker()
    if (this.running !== job) return
    if (failure !== undefined || !this.worker) return this.finish(job, fail('failed', failure))
    job.id = ++this.seq
    if (!job.stream) return this.worker.handle.post({ type: 'transcribe', id: job.id, pcm: job.pcm, language: job.language })
    this.worker.handle.post({ type: 'stream-start', id: job.id, language: job.language })
    job.stream.open = true
    this.flush(job)
  }

  /** 워커가 떠 있게 한다 — 못 떴으면 사유 */
  private ensureWorker(): Promise<string | undefined> {
    if (this.worker?.up) return Promise.resolve(undefined)
    if (!this.worker) {
      const worker: Worker = { up: false, waiters: [], handle: undefined as unknown as SpeechWorkerHandle }
      this.worker = worker
      try {
        worker.handle = this.opts.host.start(this.opts.root!, {
          message: (reply) => this.worker === worker && this.onReply(worker, reply),
          exit: () => this.worker === worker && this.dropWorker('engine exited'),
        })
      } catch (error) {
        this.worker = undefined
        return Promise.resolve((error as Error).message)
      }
      this.publish()
    }
    const worker = this.worker
    return new Promise((resolve) => worker.waiters.push(resolve))
  }

  private onReply(worker: Worker, reply: WorkerReply): void {
    if (reply.type === 'ready') {
      worker.up = true
      for (const wake of worker.waiters.splice(0)) wake()
      this.publish()
    } else if (reply.type === 'fatal') {
      this.dropWorker(reply.message)
    } else if (this.running && this.running.id === reply.id) {
      const job = this.running
      const stream = job.stream
      if (reply.type === 'error') return this.finish(job, fail('failed', reply.message))
      if (reply.type === 'partial') {
        if (!stream) return
        stream.awaiting = false
        stream.inferMs += reply.inferMs
        stream.partial({ final: reply.final, tentative: reply.tentative })
        return this.flush(job)
      }
      job.resolve({ text: reply.text, audioSeconds: (stream?.total ?? job.pcm.length) / SPEECH_SAMPLE_RATE, inferSeconds: ((stream?.inferMs ?? 0) + reply.inferMs) / 1000 })
      this.finish(job)
    }
  }

  /** 워커를 내린다 (죽었으면 치운다) — 뜨기를 기다리던 쪽과 답을 기다리던 요청은 why 로 실패한다 */
  private dropWorker(why?: string): void {
    const worker = this.worker
    if (!worker) return
    this.worker = undefined
    clearTimeout(this.idle)
    try {
      worker.handle?.kill()
    } catch {
      // 이미 죽었다
    }
    for (const wake of worker.waiters.splice(0)) wake(why ?? 'engine stopped')
    // 답을 기다리던 요청 (보낸 뒤 워커가 죽었다). 뜨기를 기다리던 요청은 위 wake 가 work() 에서 끝낸다
    if (this.running?.id !== undefined) this.finish(this.running, fail('failed', why))
    this.publish()
  }

  /** 도는 요청을 끝낸다 — error 가 없으면 이미 resolve 했다. kill 이면 워커도 죽인다 (추론은 중간에 못 멈춘다) */
  private finish(job: Job, error?: SpeechError, kill = false): void {
    if (this.running !== job) return
    this.running = undefined
    clearTimeout(job.deadline)
    job.unlisten()
    if (error) job.reject(error)
    if (kill) this.dropWorker()
    if (this.disposed) return
    if (this.worker && !this.waiting.length) this.idle = setTimeout(() => this.dropWorker(), IDLE_MS)
    this.pump()
  }

  private cancel(job: Job): void {
    const at = this.waiting.indexOf(job)
    if (at >= 0) {
      this.waiting.splice(at, 1)
      job.unlisten()
      job.reject(fail('cancelled'))
    } else if (job.stream) {
      // 실시간 받아쓰기는 워커를 살려 둔다 — 조각 하나의 인식은 짧고, 다음 녹음이 엔진을 다시 띄우지 않아도 된다
      if (this.running === job && job.stream.open) this.worker?.handle.post({ type: 'stream-cancel', id: job.id! })
      this.finish(job, fail('cancelled'))
    } else {
      this.finish(job, fail('cancelled'), true)
    }
  }

  private shutdown(): void {
    this.disposed = true
    for (const job of this.waiting.splice(0)) {
      job.unlisten()
      job.reject(fail('unavailable'))
    }
    if (this.running) this.finish(this.running, fail('unavailable'))
    this.dropWorker()
  }

  private publish(): void {
    if (this.disposed) return
    const status = this.status()
    const key = JSON.stringify(status)
    if (key === this.published) return
    this.published = key
    this.ctx.emit('speech/changed', status)
  }
}
