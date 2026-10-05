import { SPEECH_SAMPLE_RATE } from '../../../shared/speech.ts'
import type { SpeechLanguage } from '../../../shared/speech.ts'

// 음성 워커(electron/speechWorker.ts)의 순수한 부분과 메인 ↔ 워커 메시지 — sherpa·Electron 을 모른다 (단위 테스트가 닿는 자리).
// 인식 순서는 실측한 그대로다 (_workspace/01ag_voice_input.md §2.2, probe-01ag/bench-sherpa.mjs):
// 앞에 무음 300ms 붙이기 → VAD 로 말 구간 자르기 → 구간마다 인식 → 공백으로 잇기.

/** 앞에 붙이는 무음 — 녹음이 0초부터 말로 시작하면 VAD 가 첫 음절을 자른다 ("데이터베이스" → "터베스", 실측) */
export const LEAD_SILENCE_MS = 300
/** Silero VAD 가 한 번에 받는 창 (표본 수) */
export const VAD_WINDOW = 512

/** PCM16 → 엔진이 받는 float(-1..1), 앞에 무음을 붙여서 */
export function toSamples(pcm: Int16Array, leadMs: number = LEAD_SILENCE_MS): Float32Array {
  const lead = Math.round((leadMs * SPEECH_SAMPLE_RATE) / 1000)
  const samples = new Float32Array(lead + pcm.length)
  for (let i = 0; i < pcm.length; i++) samples[lead + i] = pcm[i]! / 32768
  return samples
}

/** 구간마다 인식한 글을 한 줄로 — 빈 구간(숨소리·잡음)은 버리고 공백으로 잇는다 */
export function joinPieces(texts: readonly string[]): string {
  return texts
    .map((text) => text.trim())
    .filter(Boolean)
    .join(' ')
}

/** sherpa Vad 에서 쓰는 만큼 */
export interface VadLike {
  reset(): void
  acceptWaveform(samples: Float32Array): void
  isEmpty(): boolean
  /** false = 복사본으로 받는다 — Electron 의 V8 메모리 케이지는 외부 버퍼를 못 받는다 (dsh·실측) */
  front(enableExternalBuffer: boolean): { samples: Float32Array }
  pop(): void
  flush(): void
}

/** VAD 로 말 구간을 잘라 구간마다 decode 하고 잇는다. 말이 없으면 빈 문자열 */
export function transcribeSamples(vad: VadLike, decode: (samples: Float32Array) => string, samples: Float32Array): string {
  const texts: string[] = []
  const drain = (): void => {
    while (!vad.isEmpty()) {
      texts.push(decode(vad.front(false).samples))
      vad.pop()
    }
  }
  vad.reset()
  for (let at = 0; at < samples.length; at += VAD_WINDOW) {
    vad.acceptWaveform(samples.subarray(at, at + VAD_WINDOW))
    drain()
  }
  vad.flush()
  drain()
  return joinPieces(texts)
}

/** 메인 → 워커 */
export interface WorkerRequest {
  type: 'transcribe'
  id: number
  pcm: Int16Array
  language: SpeechLanguage
}

/** 워커 → 메인. ready: 엔진·모델을 읽었다 · fatal: 못 읽었다(워커는 곧 끝난다) · result/error: 그 id 의 답 */
export type WorkerReply =
  | { type: 'ready'; loadMs: number }
  | { type: 'fatal'; message: string }
  | { type: 'result'; id: number; text: string; inferMs: number }
  | { type: 'error'; id: number; message: string }
