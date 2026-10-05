import { SPEECH_CHUNK_SAMPLES, SPEECH_SAMPLE_RATE } from '../shared/speech.ts'
import { RECORDING_FAILED, rms, toPcm16 } from './voiceView.ts'

// 마이크 녹음 한 번 — 녹음하는 동안 **16kHz mono PCM16 조각(0.1초)을 흘린다** (실시간 받아쓰기, 이슈 #109 3단계).
// getUserMedia → 16kHz AudioContext(크롬이 마이크 표본율에서 다시 표본한다) → AudioWorklet(voiceWorklet.js)이 0.1초씩 모아 준다 → PCM16.
// 2단계는 MediaRecorder 로 통째로 받아 정지 뒤에 풀었다 — 그 길로는 말하는 동안 소리를 꺼낼 수 없다. 음량은 AnalyserNode 의 RMS.
// **마이크 트랙은 어느 길로 끝나든 멈춘다**(정지·취소·실패·권한 창이 뒤늦게 승인된 경우) — 안 멈추면 OS 의 마이크 표시등이 남는다.

function failed(): Error {
  const error = new Error('recording failed')
  error.name = RECORDING_FAILED
  return error
}

/** 정지 때 워크렛이 남은 조각을 넘겨주기를 기다리는 시간 — 오디오 스레드가 멈춰 있어도 정지는 끝나야 한다 */
const FLUSH_MS = 500

export class VoiceRecording {
  private stream: MediaStream | undefined
  private context: AudioContext | undefined
  private analyser: AnalyserNode | undefined
  private node: AudioWorkletNode | undefined
  private readonly window = new Float32Array(256)
  private flushed: (() => void) | undefined
  private released = false

  /** 마이크를 열고 녹음을 시작한다. 권한 거절·장치 없음은 getUserMedia 의 DOMException 그대로 던진다(문구는 voiceView captureFailure).
   *  onChunk 는 녹음하는 동안 0.1초마다(마지막은 정지 때 남은 만큼), onBroken 은 녹음 도중 끊겼을 때(장치가 뽑힘 등) 한 번 */
  async start(onBroken: () => void, onChunk: (pcm: Int16Array) => void): Promise<void> {
    if (!navigator.mediaDevices || typeof AudioWorkletNode === 'undefined') throw failed()
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    // 기다리는 사이(권한 창) 취소됐다 — 방금 열린 마이크를 곧바로 놓는다
    if (this.released) {
      for (const track of stream.getTracks()) track.stop()
      return
    }
    this.stream = stream
    try {
      const context = new AudioContext({ sampleRate: SPEECH_SAMPLE_RATE })
      this.context = context
      if (context.sampleRate !== SPEECH_SAMPLE_RATE) throw failed()
      await context.audioWorklet.addModule(new URL('./voiceWorklet.js', import.meta.url).href)
      if (this.released) return // 워크렛을 읽는 사이 취소됐다 — dispose 가 이미 놓았다
      const broken = (): void => {
        if (this.released) return
        this.dispose()
        onBroken()
      }
      const source = context.createMediaStreamSource(stream)
      this.analyser = context.createAnalyser()
      this.analyser.fftSize = this.window.length
      source.connect(this.analyser)
      // 출력 없는 노드 — 스피커로 이어지지 않아도 돈다. 스테레오 마이크는 mono 로 섞여 들어온다
      const node = new AudioWorkletNode(context, 'litecode-voice-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: { chunk: SPEECH_CHUNK_SAMPLES },
      })
      this.node = node
      node.port.onmessage = (event: MessageEvent<Float32Array | null>) => {
        if (this.released) return
        if (event.data === null) this.flushed?.()
        else if (event.data.length > 0) onChunk(toPcm16(event.data))
      }
      node.onprocessorerror = broken
      for (const track of stream.getAudioTracks()) track.onended = broken
      source.connect(node)
      if (context.state === 'suspended') await context.resume()
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  /** 지금 마이크 음량(RMS) — 녹음 중이 아니면 0 */
  level(): number {
    if (!this.analyser) return 0
    this.analyser.getFloatTimeDomainData(this.window)
    return rms(this.window)
  }

  /** 녹음을 끝낸다 — 남은 조각(0.1초 미만)까지 onChunk 로 넘긴 뒤 마이크를 놓는다 */
  async stop(): Promise<void> {
    const { node } = this
    try {
      if (!node || this.released) return
      await new Promise<void>((resolve) => {
        this.flushed = resolve
        setTimeout(resolve, FLUSH_MS)
        node.port.postMessage('flush')
      })
    } finally {
      this.dispose()
    }
  }

  /** 마이크·워크렛·오디오 컨텍스트를 놓는다 — 여러 번 불러도 된다. 권한 창을 기다리는 중이면 승인되는 순간 놓인다 */
  dispose(): void {
    this.released = true
    for (const track of this.stream?.getTracks() ?? []) {
      track.onended = null
      track.stop()
    }
    this.stream = undefined
    const { context, node } = this
    this.context = undefined
    this.analyser = undefined
    this.node = undefined
    if (node) {
      node.port.onmessage = null
      node.onprocessorerror = null
      node.disconnect()
    }
    if (context && context.state !== 'closed') void context.close().catch(() => {})
  }
}
