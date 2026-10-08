import { SPEECH_SAMPLE_RATE, type SpeechLanguage } from '../../../shared/speech.ts'
import { joinPieces, LEAD_SILENCE_MS, SEGMENT_LEAD, toSamples, transcribeSamples, VAD_WINDOW, type VadLike, type WorkerReply, type WorkerRequest } from './audio.ts'

// 실시간 받아쓰기의 워커 쪽 순수한 부분 — sherpa·Electron 을 모른다 (단위 테스트가 닿는 자리).
// SenseVoice 는 스트리밍 모델이 아니다. 그래서 **말소리 구간 단위로 흉내 낸다**: 녹음 조각을 받는 대로 VAD 에 넣고
// - 끝난 구간은 한 번 인식해 **확정**한다 — 한 번에 받아쓰기(audio.ts transcribeSamples)와 같은 순서(앞 무음 300ms · 512 창 · 구간마다 인식 · 잇기)라
//   같은 녹음이면 정지 뒤의 글이 한 번에 받아쓴 글과 글자까지 같다 (실측 2026-10-05, 합성 한국어 20초·24초)
// - 말하고 있는 구간은 처음부터 다시 인식해 **임시** 글로 낸다. 인식은 길이에 비례해 든다(M4 Pro 스레드 2: 약 15ms + 15ms/초 — 5초 85ms, 20초 300ms) —
//   그래서 주기는 "직전 임시 인식에 걸린 시간의 4배 이상, 최소 0.6초" 로 스스로 늦춘다 (느린 PC 에서도 인식이 CPU 의 1/4 을 넘지 않게).
//   구간은 VAD 가 30초에서 끊는다(speechWorker 의 maxSpeechDuration) — 임시 인식 한 번이 그보다 길어지지 않는다
// 임시 인식에 넣는 소리는 "마지막 확정 구간 뒤 ~ 지금" 이다. 말이 없는 동안엔 마지막 1초만 남긴다 — VAD 는 말이 시작되고 0.3초쯤 뒤에야
// 알아채고 구간은 그보다 앞에서 시작하므로(실측) 그 앞부분을 쥐고 있어야 임시 글의 첫 음절이 안 잘린다.

/** 임시 인식 사이의 최소 간격 */
export const TENTATIVE_MIN_MS = 600
/** 임시 인식 간격 ≥ 직전 임시 인식에 걸린 시간 × 이 값 */
export const TENTATIVE_COST_FACTOR = 4
/** 이보다 짧은 소리는 임시로 인식하지 않는다 (한두 음절뿐이라 글이 흔들린다) */
const TENTATIVE_MIN_SAMPLES = SPEECH_SAMPLE_RATE / 2
/** 말이 없는 동안 쥐고 있는 소리 */
const KEEP_SILENT_SAMPLES = SPEECH_SAMPLE_RATE

export interface StreamPartial {
  /** 확정된 글 전부 (구간을 이은 것) */
  final: string
  /** 말하고 있는 구간의 지금까지 글 — 다음 인식에서 통째로 바뀔 수 있다. 말이 없으면 빈 문자열 */
  tentative: string
  /** VAD 가 지금 말소리로 보고 있다 (isDetected) */
  speaking: boolean
  /** VAD 가 마지막으로 말소리로 본 창 뒤에 넣은 소리의 길이(ms) — 스트림을 연 뒤 말이 없었으면 연 뒤부터. 말하는 중이면 0.
   *  VAD 는 말이 끝나고 minSilenceDuration(0.5초, 실측 0.57초) 뒤에 꺼지므로 실제 무음은 이 값 + 약 0.5초다 (음성 대화 #238 이 말 끝 판정에 쓴다) */
  silentMs: number
}

/** 실시간 받아쓰기 한 번 — 조각을 feed 로 넣고 stop 으로 끝낸다 */
export class StreamDecoder {
  private readonly window = new Float32Array(VAD_WINDOW)
  private filled = 0
  /** 마지막 확정 구간 뒤의 소리 (말이 없으면 마지막 1초) */
  private tail = new Float32Array(SPEECH_SAMPLE_RATE * 8)
  private tailLength = 0
  /** VAD 에 넣은 표본 수 — 구간의 start 와 같은 기준 */
  private fed = 0
  private readonly texts: string[] = []
  private tentative = ''
  private tentativeAt = -Infinity
  private tentativeCost = 0
  /** VAD 가 마지막으로 말소리로 본 때의 fed — 앞에 넣은 무음은 세지 않는다 (연 때부터) */
  private voicedAt: number
  /** 확정 인식이 이미 본 소리의 끝(fed) — 구간 앞 진본이 이 앞의 소리(이미 확정된 앞 구간)를 다시 넣지 않게 한다 */
  private solidUntil = 0

  constructor(
    private readonly vad: VadLike,
    private readonly decode: (samples: Float32Array) => string,
    private readonly now: () => number = () => performance.now(),
  ) {
    vad.reset()
    this.push(toSamples(new Int16Array(0), LEAD_SILENCE_MS))
    this.voicedAt = this.fed
  }

  feed(pcm: Int16Array): StreamPartial {
    this.push(toSamples(pcm, 0))
    const at = this.now()
    if (this.vad.isDetected() && this.tailLength >= TENTATIVE_MIN_SAMPLES && at - this.tentativeAt >= Math.max(TENTATIVE_MIN_MS, TENTATIVE_COST_FACTOR * this.tentativeCost)) {
      this.tentative = this.decode(this.tail.slice(0, this.tailLength)).trim()
      this.tentativeAt = this.now()
      this.tentativeCost = this.tentativeAt - at
    }
    const speaking = this.vad.isDetected()
    return { final: joinPieces(this.texts), tentative: this.tentative, speaking, silentMs: speaking ? 0 : Math.round(((this.fed - this.voicedAt) * 1000) / SPEECH_SAMPLE_RATE) }
  }

  /** (마지막 조각 pcm 과) 남은 소리까지 넣고 열린 구간을 닫아 확정한다 — 받아쓴 글 전부 */
  stop(pcm?: Int16Array): string {
    if (pcm) this.push(toSamples(pcm, 0))
    if (this.filled) this.accept(this.window.slice(0, this.filled))
    this.filled = 0
    this.vad.flush()
    this.drain()
    return joinPieces(this.texts)
  }

  /** 512 표본 창으로 잘라 VAD 에 넣는다 — 창에 못 미친 끝은 다음 조각과 잇는다 */
  private push(samples: Float32Array): void {
    let at = 0
    while (at < samples.length) {
      const take = Math.min(VAD_WINDOW - this.filled, samples.length - at)
      this.window.set(samples.subarray(at, at + take), this.filled)
      this.filled += take
      at += take
      if (this.filled === VAD_WINDOW) {
        this.accept(this.window.slice())
        this.filled = 0
      }
    }
  }

  private accept(window: Float32Array): void {
    if (this.tailLength + window.length > this.tail.length) {
      const grown = new Float32Array(this.tail.length * 2)
      grown.set(this.tail.subarray(0, this.tailLength))
      this.tail = grown
    }
    this.tail.set(window, this.tailLength)
    this.tailLength += window.length
    this.fed += window.length
    this.vad.acceptWaveform(window)
    this.drain()
    if (this.vad.isDetected()) this.voicedAt = this.fed
    else {
      this.tentative = ''
      this.keep(KEEP_SILENT_SAMPLES)
    }
  }

  /** 끝난 구간을 확정한다 */
  private drain(): void {
    while (!this.vad.isEmpty()) {
      const segment = this.vad.front(false)
      this.texts.push(this.decode(this.segmentAudio(segment)))
      this.vad.pop()
      this.tentative = ''
      this.keep(segment.start === undefined ? 0 : this.fed - (segment.start + segment.samples.length))
    }
  }

  /** 확정 인식에 넣는 소리 — 구간 + 구간 앞의 SEGMENT_LEAD 만큼, tail 로 쥐고 있는 범위 안에서.
   *  스트림 연 때의 300ms 합성 무음도 tail 에 있으니 첫 구간 앞 진본이 되고 (한 번에 받아쓰기와 같은 위치),
   *  그 뒤 구간 앞 진본은 그 직전까지의 진본(마이크 무음·앞 말꼬리)이 된다 */
  private segmentAudio(segment: { samples: Float32Array; start?: number }): Float32Array {
    const start = segment.start ?? this.fed - segment.samples.length
    const end = start + segment.samples.length
    const from = Math.max(start - SEGMENT_LEAD, this.solidUntil, this.fed - this.tailLength)
    this.solidUntil = Math.max(this.solidUntil, end)
    return this.tail.slice(this.tailLength - (this.fed - from), this.tailLength - (this.fed - end))
  }

  /** tail 의 끝 count 표본만 남긴다 */
  private keep(count: number): void {
    const kept = Math.max(0, Math.min(this.tailLength, count))
    this.tail.copyWithin(0, this.tailLength - kept, this.tailLength)
    this.tailLength = kept
  }
}

export interface EngineParts {
  vad: VadLike
  /** 그 언어 힌트로 소리 하나를 글로 */
  recognize(language: SpeechLanguage, samples: Float32Array): string
  /** 그 언어의 인식기를 미리 만들어 둔다 (0.5초) — 스트림을 열 때 부른다. 첫 임시 인식에 인식기 만드는 시간이 섞이면 "걸린 시간의 4배" 규칙이
   *  다음 임시 글을 2초 늦춘다 (실측 — 숨긴 Electron 에서 첫 글 뒤 2.2초 멈춤) */
  prepare?(language: SpeechLanguage): void
  now?: () => number
}

/** 워커가 메시지 하나에 하는 일 — 답이 없으면(stream-cancel·끝난 스트림의 조각) undefined. VAD 가 하나라 한 번에 하나만 돈다 (ctx.speech 가 줄 세운다) */
export function speechEngine({ vad, recognize, prepare, now = () => performance.now() }: EngineParts): (request: WorkerRequest) => WorkerReply | undefined {
  let stream: { id: number; decoder: StreamDecoder } | undefined
  return (request) => {
    const at = now()
    const took = (): number => Math.round(now() - at)
    try {
      if (request.type === 'transcribe') {
        stream = undefined
        const text = transcribeSamples(vad, (samples) => recognize(request.language, samples), toSamples(request.pcm))
        return { type: 'result', id: request.id, text, inferMs: took() }
      }
      if (request.type === 'stream-start') {
        prepare?.(request.language)
        stream = { id: request.id, decoder: new StreamDecoder(vad, (samples) => recognize(request.language, samples), now) }
        return undefined
      }
      if (stream?.id !== request.id) return undefined
      const { decoder } = stream
      if (request.type === 'stream-feed') return { type: 'partial', id: request.id, ...decoder.feed(request.pcm), inferMs: took() }
      stream = undefined
      if (request.type === 'stream-cancel') return undefined
      return { type: 'result', id: request.id, text: decoder.stop(request.pcm), inferMs: took() }
    } catch (error) {
      if (request.type !== 'transcribe') stream = undefined
      return { type: 'error', id: request.id, message: (error as Error).message }
    }
  }
}
