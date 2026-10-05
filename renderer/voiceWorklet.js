// 음성 입력의 마이크 캡처 — AudioWorkletGlobalScope 에서 돈다 (renderer/voiceRecorder.ts 가 `new URL('./voiceWorklet.js', import.meta.url)` 로 싣는다).
// 앱 코드를 import 하지 못하는 자리라 일부러 import 없는 JS 한 파일이다. vite 빌드는 이 크기(4KB 미만)면 data: URL 로 번들에 박고, 넘으면 assets 의
// 파일로 낸다 — 두 길 모두 file:// 로 뜬 화면에서 addModule 이 읽는다 (숨긴 Electron 33 실측 2026-10-05, 화면에 CSP 가 없어 막는 것이 없다).
// 오디오 스레드가 128 표본씩 주는 mono 소리를 chunk 표본(0.1초)씩 모아 화면으로 보낸다. 'flush' 를 받으면 남은 것을 보내고 null 로 끝을 알린다.
// 변환(PCM16)·IPC 는 화면 쪽이 한다 — 여기선 모으기만 (오디오 스레드를 오래 잡지 않는다).

class VoiceCapture extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.buffer = new Float32Array(options.processorOptions.chunk)
    this.filled = 0
    this.closed = false
    this.port.onmessage = () => {
      if (this.closed) return
      this.closed = true
      if (this.filled) this.port.postMessage(this.buffer.slice(0, this.filled))
      this.port.postMessage(null)
    }
  }

  process(inputs) {
    if (this.closed) return false
    const samples = inputs[0] && inputs[0][0]
    if (!samples) return true // 아직 이어지지 않았다
    let at = 0
    while (at < samples.length) {
      const take = Math.min(this.buffer.length - this.filled, samples.length - at)
      this.buffer.set(samples.subarray(at, at + take), this.filled)
      this.filled += take
      at += take
      if (this.filled === this.buffer.length) {
        this.port.postMessage(this.buffer.slice())
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('litecode-voice-capture', VoiceCapture)
