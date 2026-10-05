import type { MessageKey } from '../shared/i18n/index.ts'
import { SPEECH_MAX_SAMPLES, SPEECH_MAX_SECONDS, SPEECH_SAMPLE_RATE, type SpeechErrorCode, type SpeechStatus } from '../shared/speech.ts'

// 음성 입력 화면(이슈 #109 2단계)의 순수 규칙 — 녹음 상태 기계 · PCM 변환 · 받아쓴 글을 초안에 넣는 자리 · 실패 문구 · 경과 초 · 음량 막대.
// 마이크·오디오 API 는 voiceRecorder.ts, 그림은 VoiceInput.tsx. 동작은 dsh client-ui-voice-input 참조(토글 녹음, 녹음 뒤 한 번에 인식,
// 결과는 입력창에 넣기만). dsh 와 다른 점: 초안이 바뀌었으면 "넣기" 버튼 대신 지금 커서 자리에, 대화를 바꿨으면 버리지 않고 시작한 대화의 초안에.

// ── 상태 기계 ────────────────────────────────────────────────────────────────

/** idle: 대기 · requesting: 마이크를 여는 중(권한 창 포함) · recording: 녹음 중 · transcribing: 받아쓰는 중 */
export type VoicePhase = 'idle' | 'requesting' | 'recording' | 'transcribing'

/** 녹음 띠에 남는 한 줄 — info 는 잠깐 보이고 사라지고, error 는 닫거나 다시 녹음할 때까지 남는다 */
export interface VoiceNotice {
  tone: 'info' | 'error'
  key: MessageKey
}

export interface VoiceState {
  phase: VoicePhase
  /** 이번 녹음의 번호 — 취소된 녹음의 늦은 사건(권한 승인·인식 결과)을 번호로 가려 버린다 */
  run: number
  /** 녹음을 시작한 대화 — 결과는 이 대화의 초안에 들어간다 (대화를 바꿔도) */
  sessionId?: string
  notice?: VoiceNotice
}

export type VoiceEvent =
  /** 마이크 버튼 — 대기일 때만. run 은 앞 번호보다 커야 한다 */
  | { type: 'start'; run: number; sessionId: string }
  /** 마이크가 열렸다 */
  | { type: 'granted'; run: number }
  /** 정지(버튼·상한) — 녹음 중일 때만 */
  | { type: 'stop'; run: number }
  /** 인식이 끝났다 — notice 는 "말소리 없음"·"다른 대화에 넣음" */
  | { type: 'done'; run: number; notice?: VoiceNotice }
  /** 마이크·녹음·인식 실패 */
  | { type: 'failed'; run: number; notice: VoiceNotice }
  /** 취소(✕·Esc·대화 삭제·기능 끔) — 어느 단계든 대기로, 띠의 글도 지운다 */
  | { type: 'cancel' }
  /** 준비 안 된 엔진처럼 녹음을 시작하지 않고 알리는 것 — 대기일 때만 */
  | { type: 'notify'; notice: VoiceNotice }
  | { type: 'dismiss' }

export const VOICE_IDLE: VoiceState = { phase: 'idle', run: 0 }

export function voiceReducer(state: VoiceState, event: VoiceEvent): VoiceState {
  switch (event.type) {
    case 'start':
      if (state.phase !== 'idle' || event.run <= state.run) return state
      return { phase: 'requesting', run: event.run, sessionId: event.sessionId }
    case 'granted':
      return state.phase === 'requesting' && event.run === state.run ? { ...state, phase: 'recording' } : state
    case 'stop':
      return state.phase === 'recording' && event.run === state.run ? { ...state, phase: 'transcribing' } : state
    case 'done':
      if (state.phase !== 'transcribing' || event.run !== state.run) return state
      return { phase: 'idle', run: state.run, ...(event.notice && { notice: event.notice }) }
    case 'failed':
      if (state.phase === 'idle' || event.run !== state.run) return state
      return { phase: 'idle', run: state.run, notice: event.notice }
    case 'cancel':
      return state.phase === 'idle' && !state.notice ? state : { phase: 'idle', run: state.run }
    case 'notify':
      return state.phase === 'idle' ? { phase: 'idle', run: state.run, notice: event.notice } : state
    case 'dismiss':
      return state.notice ? { phase: state.phase, run: state.run, ...(state.sessionId !== undefined && { sessionId: state.sessionId }) } : state
  }
}

/** 마이크를 쥐고 있거나 답을 기다리는 중 — 버튼이 눌린 모양이고 Esc 가 취소다 */
export function voiceBusy(state: VoiceState): boolean {
  return state.phase !== 'idle'
}

/** info 줄이 떠 있는 시간 */
export const VOICE_NOTICE_MS = 4000

// ── PCM ──────────────────────────────────────────────────────────────────────

/** 디코드한 녹음(초)을 16kHz 로 다시 그릴 때의 샘플 수 — 상한(120초)에서 자른다. 0 이면 녹음이 비었다 */
export function resampledLength(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0
  return Math.min(SPEECH_MAX_SAMPLES, Math.floor(seconds * SPEECH_SAMPLE_RATE))
}

/** -1..1 샘플 → PCM16. 범위를 넘는 값은 자르고(NaN 은 0), 상한을 넘는 길이는 앞에서부터 상한까지만 */
export function toPcm16(samples: Float32Array): Int16Array {
  const length = Math.min(samples.length, SPEECH_MAX_SAMPLES)
  const pcm = new Int16Array(length)
  for (let i = 0; i < length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]! || 0))
    pcm[i] = Math.round(value * (value < 0 ? 32768 : 32767))
  }
  return pcm
}

// ── 음량 ─────────────────────────────────────────────────────────────────────

export const VOICE_BARS = 28

/** 시간 영역 샘플의 RMS */
export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!
  return Math.sqrt(sum / samples.length)
}

/** RMS → 막대 높이 0..1 (dsh Waveform 의 배율 — 보통 말소리가 절반쯤 찬다) */
export function barLevel(value: number): number {
  return Math.max(0, Math.min(1, value * 5))
}

/** 새 값을 오른쪽 끝에 넣고 왼쪽으로 민다 — 길이는 그대로 */
export function pushLevel(levels: readonly number[], level: number): number[] {
  return [...levels.slice(1), level]
}

// ── 경과 ─────────────────────────────────────────────────────────────────────

/** 녹음 경과 "0:07" — 상한을 넘겨 그리지 않는다 */
export function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.min(SPEECH_MAX_SECONDS, Math.floor(ms / 1000)))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

// ── 넣기 ─────────────────────────────────────────────────────────────────────

/** 녹음을 시작할 때의 입력창 — 글과 커서(선택이 있었으면 그 끝) */
export interface VoiceAnchor {
  text: string
  at: number
}

/**
 * 받아쓴 글을 초안에 넣는다.
 * - 초안이 녹음을 시작할 때 그대로면 그때의 커서 자리에 (선택해 둔 글은 지우지 않고 그 뒤에)
 * - 그사이 글이 바뀌었으면 지금 커서 자리(cursor)에, 모르면(다른 대화를 보고 있다) 끝에
 * - 앞뒤 글자가 공백이 아니면 공백 하나를 둔다. 받아쓴 글이 비면 그대로
 * @returns 바뀐 글과 넣은 글 바로 뒤의 커서 자리
 */
export function insertTranscript(draft: string, transcript: string, anchor: VoiceAnchor | undefined, cursor?: number): { text: string; cursor: number } {
  const said = transcript.trim()
  const kept = anchor !== undefined && anchor.text === draft ? anchor.at : (cursor ?? draft.length)
  const at = Math.max(0, Math.min(draft.length, kept))
  if (said === '') return { text: draft, cursor: at }
  const before = draft.slice(0, at)
  const after = draft.slice(at)
  const lead = before !== '' && !/\s$/.test(before) ? ' ' : ''
  const tail = after !== '' && !/^\s/.test(after) ? ' ' : ''
  return { text: before + lead + said + tail + after, cursor: before.length + lead.length + said.length }
}

// ── 실패 문구 ────────────────────────────────────────────────────────────────

/** 녹음이 망가졌을 때(데이터 없음·디코드 실패·중간에 끊김) voiceRecorder 가 던지는 이름 */
export const RECORDING_FAILED = 'RecordingFailed'

/** getUserMedia·녹음이 던진 것 → 문구. 권한 거절은 macOS 면 시스템 설정 자리까지 */
export function captureFailure(error: unknown, platform: string | undefined): MessageKey {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return platform === 'darwin' ? 'voice.error.permission.mac' : 'voice.error.permission'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'voice.error.noMicrophone'
  if (name === 'NotReadableError' || name === 'AbortError') return 'voice.error.microphoneBusy'
  return 'voice.error.recording'
}

const REPLY_FAILURE: Record<Exclude<SpeechErrorCode, 'cancelled'>, MessageKey> = {
  unavailable: 'voice.error.unavailable',
  busy: 'voice.error.busy',
  timeout: 'voice.error.timeout',
  'too-long': 'voice.error.tooLong',
  invalid: 'voice.error.recording',
  failed: 'voice.error.failed',
}

/** `speech:transcribe` 의 실패 코드 → 문구. 취소는 알리지 않는다 */
export function replyFailure(code: SpeechErrorCode): MessageKey | undefined {
  return code === 'cancelled' ? undefined : REPLY_FAILURE[code]
}

/** 마이크를 열기 전에 아는 "준비 안 됨" — 파일이 없거나 대조에 실패한 엔진. 대조 중(checking)은 막지 않는다(녹음이 끝날 때쯤 끝난다) */
export function notReady(status: SpeechStatus | undefined): MessageKey | undefined {
  return status?.state === 'unavailable' && status.reason !== 'checking' ? 'voice.error.unavailable' : undefined
}
