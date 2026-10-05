import { SPEECH_SAMPLE_RATE } from '../shared/speech.ts'
import { RECORDING_FAILED, resampledLength, rms, toPcm16 } from './voiceView.ts'

// 마이크 녹음 한 번 (이슈 #109 2단계) — 실측한 길 그대로다(_workspace/01ag_voice_input.md §2.3, dsh client-ui-voice-input audio.ts 참조):
// getUserMedia → MediaRecorder(브라우저 기본 형식, webm/opus)로 통째로 받고 → 정지하면 decodeAudioData → OfflineAudioContext 로 16kHz mono 재표본
// → PCM16. AudioWorklet 은 쓰지 않는다. 음량은 AnalyserNode 의 RMS.
// **마이크 트랙은 어느 길로 끝나든 멈춘다**(정지·취소·실패·권한 창이 뒤늦게 승인된 경우) — 안 멈추면 OS 의 마이크 표시등이 남는다.

function failed(): Error {
  const error = new Error('recording failed')
  error.name = RECORDING_FAILED
  return error
}

export class VoiceRecording {
  private stream: MediaStream | undefined
  private recorder: MediaRecorder | undefined
  private context: AudioContext | undefined
  private analyser: AnalyserNode | undefined
  private readonly window = new Float32Array(256)
  private chunks: Blob[] = []
  private released = false

  /** 마이크를 열고 녹음을 시작한다. 권한 거절·장치 없음은 getUserMedia 의 DOMException 그대로 던진다(문구는 voiceView captureFailure).
   *  onBroken 은 녹음 도중 끊겼을 때(장치가 뽑힘 등) 한 번 */
  async start(onBroken: () => void): Promise<void> {
    if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined') throw failed()
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    // 기다리는 사이(권한 창) 취소됐다 — 방금 열린 마이크를 곧바로 놓는다
    if (this.released) {
      for (const track of stream.getTracks()) track.stop()
      return
    }
    this.stream = stream
    try {
      this.context = new AudioContext()
      this.analyser = this.context.createAnalyser()
      this.analyser.fftSize = this.window.length
      this.context.createMediaStreamSource(stream).connect(this.analyser)
      this.recorder = new MediaRecorder(stream)
      this.recorder.ondataavailable = (event) => {
        if (!this.released && event.data.size > 0) this.chunks.push(event.data)
      }
      this.recorder.onerror = () => {
        if (this.released) return
        this.dispose()
        onBroken()
      }
      for (const track of stream.getAudioTracks()) {
        track.onended = () => {
          if (this.released || this.recorder?.state !== 'recording') return
          this.dispose()
          onBroken()
        }
      }
      this.recorder.start()
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

  /** 녹음을 끝내고 16kHz mono PCM16 으로 — 마이크는 여기서 놓는다. 담긴 소리가 없으면 빈 배열, 못 풀면 던진다 */
  async stop(): Promise<Int16Array> {
    const { recorder, context } = this
    try {
      if (!recorder || !context || recorder.state !== 'recording') return new Int16Array(0)
      await new Promise<void>((resolve, reject) => {
        recorder.onstop = () => resolve()
        recorder.onerror = () => reject(failed())
        recorder.stop()
      })
      this.stopTracks() // 디코드를 기다리는 동안 표시등이 켜져 있지 않게 먼저
      const blob = new Blob(this.chunks, { type: recorder.mimeType })
      if (blob.size === 0) return new Int16Array(0)
      let decoded: AudioBuffer
      try {
        decoded = await context.decodeAudioData(await blob.arrayBuffer())
      } catch {
        throw failed()
      }
      const length = resampledLength(decoded.duration)
      if (length === 0) return new Int16Array(0)
      const offline = new OfflineAudioContext(1, length, SPEECH_SAMPLE_RATE)
      const source = offline.createBufferSource()
      source.buffer = decoded
      source.connect(offline.destination)
      source.start()
      return toPcm16((await offline.startRendering()).getChannelData(0))
    } finally {
      this.dispose()
    }
  }

  /** 마이크·녹음기·오디오 컨텍스트를 놓는다 — 여러 번 불러도 된다. 권한 창을 기다리는 중이면 승인되는 순간 놓인다 */
  dispose(): void {
    this.released = true
    if (this.recorder?.state === 'recording') {
      try {
        this.recorder.stop()
      } catch {
        // 이미 멈춘 녹음기 — 놓는 중이라 상관없다
      }
    }
    this.stopTracks()
    const context = this.context
    this.context = undefined
    this.analyser = undefined
    this.recorder = undefined
    this.chunks = []
    if (context && context.state !== 'closed') void context.close().catch(() => {})
  }

  private stopTracks(): void {
    for (const track of this.stream?.getTracks() ?? []) {
      track.onended = null
      track.stop()
    }
    this.stream = undefined
  }
}
