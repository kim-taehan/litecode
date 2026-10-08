import { SPEECH_SAMPLE_RATE } from '../../../shared/speech.ts'
import type { SpeechLanguage } from '../../../shared/speech.ts'

// 음성 워커(electron/speechWorker.ts)의 순수한 부분과 메인 ↔ 워커 메시지 — sherpa·Electron 을 모른다 (단위 테스트가 닿는 자리).
// 인식 순서는 실측한 그대로다 (_workspace/01ag_voice_input.md §2.2, probe-01ag/bench-sherpa.mjs):
// 앞에 무음 300ms 붙이기 → VAD 로 말 구간 자르기 → 구간마다 인식 → 공백으로 잇기.

/** 앞에 붙이는 무음 — 녹음이 0초부터 말로 시작하면 VAD 가 첫 음절을 자른다 ("데이터베이스" → "터베스", 실측) */
export const LEAD_SILENCE_MS = 300

/** 확정 인식이 구간 말고도 구간 **앞** 소리를 함께 보는 폭(0.5초) — VAD 는 발음 경계에 구간을 팍 자른다(감지는
 *  말 시작된 0.25~0.3초 뒤에), SenseVoice 는 말 시작 전 소리가 없는 인식에선 첫 음절을 못 쓴다. 그래서 첫 구간이
 *  아닌 구원의 앞 음절이 빠졌다 (실측 2026-10-08, _workspace/probe-voicechat — "두번째 문장": 구간만 "번 개문." /
 *  구간 앞 0.5초 진본 포함 "두 …문장."; 한 문장 "중간에 잘리는데" → "잘리는데"). 같은 길이여도 진본(마이크 무음)이
 *  0.0 제로보다 낫다 — 모델 반응이 달랐다 */
export const SEGMENT_LEAD = SPEECH_SAMPLE_RATE / 2
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
  /** 지금 말소리 구간 안인가 (아직 안 끝난 구간) — 실시간 받아쓰기(stream.ts)가 임시 글을 낼지 정한다 */
  isDetected(): boolean
  /** false = 복사본으로 받는다 — Electron 의 V8 메모리 케이지는 외부 버퍼를 못 받는다 (dsh·실측). start = reset 뒤 넣은 표본 기준 구간의 시작 */
  front(enableExternalBuffer: boolean): { samples: Float32Array; start?: number }
  pop(): void
  flush(): void
}

/** VAD 로 말 구간을 잘라 구간마다 decode 하고 잇는다. 말이 없으면 빈 문자열.
 *  구간은 **구간 앞의 SEGMENT_LEAD (진본)** 까지 인식에 넣는다 — 앞 음절 유실을 막기 위해 (위 상수 참고) */
export function transcribeSamples(vad: VadLike, decode: (samples: Float32Array) => string, samples: Float32Array): string {
  const texts: string[] = []
  let fedSoFar = 0
  let solidUntil = 0
  const drain = (fedEnd: number): void => {
    while (!vad.isEmpty()) {
      const segment = vad.front(false)
      const start = segment.start ?? fedEnd - segment.samples.length
      const end = start + segment.samples.length
      const from = Math.max(start - SEGMENT_LEAD, solidUntil, 0)
      solidUntil = Math.max(solidUntil, end)
      texts.push(decode(samples.slice(from, end)))
      vad.pop()
    }
  }
  vad.reset()
  for (let at = 0; at < samples.length; at += VAD_WINDOW) {
    const take = Math.min(VAD_WINDOW, samples.length - at)
    vad.acceptWaveform(samples.subarray(at, at + take))
    fedSoFar += take
    drain(fedSoFar)
  }
  vad.flush()
  drain(samples.length)
  return joinPieces(texts)
}

/** 메인 → 워커. transcribe: 녹음 하나를 한 번에. stream-*: 실시간 받아쓰기(stream.ts) — start 뒤 feed 를 **답(partial)을 받은 다음에만** 다음 것을
 *  보내고(밀린 조각은 메인이 합친다), stop(남은 조각을 실어도 된다)의 답은 result, cancel 은 답이 없다 */
export type WorkerRequest =
  | { type: 'transcribe'; id: number; pcm: Int16Array; language: SpeechLanguage }
  | { type: 'stream-start'; id: number; language: SpeechLanguage }
  | { type: 'stream-feed'; id: number; pcm: Int16Array }
  | { type: 'stream-stop'; id: number; pcm?: Int16Array }
  | { type: 'stream-cancel'; id: number }

/** 워커 → 메인. ready: 엔진·모델을 읽었다 · fatal: 못 읽었다(워커는 곧 끝난다) · result/error: 그 id 의 답 ·
 *  partial: stream-feed 의 답 — 지금까지 확정된 글 전부와 말하고 있는 구간의 임시 글, VAD 가 말소리로 보는지와 꺼진 뒤 지난 시간 */
export type WorkerReply =
  | { type: 'ready'; loadMs: number }
  | { type: 'fatal'; message: string }
  | { type: 'result'; id: number; text: string; inferMs: number }
  | { type: 'partial'; id: number; final: string; tentative: string; speaking: boolean; silentMs: number; inferMs: number }
  | { type: 'error'; id: number; message: string }
