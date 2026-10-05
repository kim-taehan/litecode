import { createRequire } from 'node:module'
import path from 'node:path'
import { toSamples, transcribeSamples, type VadLike, type WorkerReply, type WorkerRequest } from '../src/services/speech/audio.ts'
import { SPEECH_SAMPLE_RATE, type SpeechLanguage } from '../shared/speech.ts'

// 음성 입력 엔진 프로세스 — Electron utilityProcess 안에서 돈다 (electron/speechHost.ts 가 띄운다, 주인은 ctx.speech).
// argv[2] = 엔진·모델 폴더(src/services/speech/assets.ts 의 자리). sherpa-onnx-node 는 앱의 의존성이 아니라 그 폴더에 실려 있어
// createRequire 로 읽는다 (N-API prebuilt — Electron 33 에서 재빌드 없이 로드, 실측 _workspace/01ag_voice_input.md §2.1·§2.3).
// 구성은 dsh·실측과 같다: SenseVoice(ITN — 숫자를 아라비아 숫자로) + Silero VAD(문턱 0.5·무음 0.5초·말 0.25초·조각 최대 30초·창 512), CPU 스레드 2.
// 요청은 한 번에 하나만 온다 (ctx.speech 가 줄 세운다). 추론은 동기라 도는 동안 메시지를 못 받는다 — 멈추려면 메인이 이 프로세스를 죽인다.

const THREADS = 2

interface OfflineStream {
  acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void
}
interface OfflineRecognizer {
  createStream(): OfflineStream
  decode(stream: OfflineStream): void
  getResult(stream: OfflineStream): { text: string }
}
interface Sherpa {
  OfflineRecognizer: new (config: unknown) => OfflineRecognizer
  Vad: new (config: unknown, bufferSizeInSeconds: number) => VadLike
}

const port = process.parentPort
const post = (reply: WorkerReply): void => port.postMessage(reply)

function boot(root: string): (request: WorkerRequest) => string {
  const sherpa = createRequire(path.join(root, 'package.json'))('sherpa-onnx-node') as Sherpa
  const model = (file: string): string => path.join(root, 'models', file)
  // 언어 힌트는 인식기 설정에 박힌다 — 언어가 바뀌면 인식기를 다시 만든다 (설정을 바꿨을 때뿐이라 드물다, 0.5초)
  const recognizerFor = (language: SpeechLanguage): OfflineRecognizer =>
    new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: SPEECH_SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        senseVoice: { model: model('model.int8.onnx'), language, useInverseTextNormalization: 1 },
        tokens: model('tokens.txt'),
        numThreads: THREADS,
        provider: 'cpu',
        debug: 0,
      },
    })
  const vad = new sherpa.Vad(
    {
      sileroVad: { model: model('silero_vad.onnx'), threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, maxSpeechDuration: 30, windowSize: 512 },
      sampleRate: SPEECH_SAMPLE_RATE,
      numThreads: THREADS,
      provider: 'cpu',
      debug: 0,
    },
    31.5,
  )
  let current: { language: SpeechLanguage; recognizer: OfflineRecognizer } | undefined
  return ({ pcm, language }) => {
    if (current?.language !== language) current = { language, recognizer: recognizerFor(language) }
    const { recognizer } = current
    return transcribeSamples(
      vad,
      (samples) => {
        const stream = recognizer.createStream()
        stream.acceptWaveform({ sampleRate: SPEECH_SAMPLE_RATE, samples })
        recognizer.decode(stream)
        return recognizer.getResult(stream).text
      },
      toSamples(pcm),
    )
  }
}

try {
  const started = performance.now()
  const transcribe = boot(process.argv[2] ?? '')
  port.on('message', ({ data }: { data: WorkerRequest }) => {
    const at = performance.now()
    try {
      post({ type: 'result', id: data.id, text: transcribe(data), inferMs: Math.round(performance.now() - at) })
    } catch (error) {
      post({ type: 'error', id: data.id, message: (error as Error).message })
    }
  })
  post({ type: 'ready', loadMs: Math.round(performance.now() - started) })
} catch (error) {
  post({ type: 'fatal', message: (error as Error).message })
  process.exit(1)
}
