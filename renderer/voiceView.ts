import type { TurnOutcome } from '../shared/chat.ts'
import type { MessageKey } from '../shared/i18n/index.ts'
import { SPEECH_MAX_SAMPLES, SPEECH_MAX_SECONDS, type SpeechErrorCode, type SpeechPartial, type SpeechStatus } from '../shared/speech.ts'

// 음성 입력 화면(이슈 #109 2단계)의 순수 규칙 — 녹음 상태 기계 · PCM 변환 · 받아쓴 글을 초안에 넣는 자리 · 실패 문구 · 경과 초 · 음량 막대.
// 마이크·오디오 API 는 voiceRecorder.ts, 그림은 VoiceInput.tsx. 동작은 dsh client-ui-voice-input 참조(토글 녹음, 녹음 뒤 한 번에 인식,
// 결과는 입력창에 넣기만). dsh 와 다른 점: 초안이 바뀌었으면 "넣기" 버튼 대신 지금 커서 자리에, 대화를 바꿨으면 버리지 않고 시작한 대화의 초안에.
// 3단계(실시간 받아쓰기): 말하는 동안 받아쓴 글(확정 + 임시)을 상태에 쥐고 띠 아래에 보인다 — 입력창에는 정지 뒤에 한 번에 넣는다 (말하는 중에 커서가 튀지 않게).
// 음성 대화 모드 1단계(#238, 실측 _workspace/01aq_voice_chat_feasibility.md): 같은 상태 기계에 chat 표시를 단다 — 듣는 중(recording) → 말을 멈추면 카운트다운
// (countdown) → 보내는 중(transcribing) → 다시 듣기(listen). 보낼 수 없으면 입력창에 넣고 사유를 남기고 끈다(대기 + notice).
// 계속 듣기(#240): 답이 오는 동안에도 마이크를 닫지 않는다 — 보내는 중에도 마이크는 열려 있고, 도는 턴이 있으면 보낸 말은 메인의 대기열에 쌓인다.
// 버튼 하나(#244): 받아쓰기(정지를 눌러야 입력창에 넣는 녹음)를 없앴다 — 녹음은 늘 음성 대화로 시작한다(start 가 chat 을 단다).

// ── 상태 기계 ────────────────────────────────────────────────────────────────

/** idle: 대기 · requesting: 마이크를 여는 중(권한 창 포함) · recording: 녹음 중 · transcribing: 받아쓰는 중 (대화 모드는 보내는 중 — 마이크는 열려 있다) */
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
  /** 말하는 동안 받아쓴 글 — 녹음 중·받아쓰는 중에만. 보여 주기만 한다 (입력창에 넣는 글은 정지의 답) */
  live?: VoiceLiveText
  /** 대화 모드 (#238) — 대기로 돌아가면 꺼진다 */
  chat?: true
  /** 대화 모드의 말 끝 카운트다운이 끝나는 때 (performance.now) — 듣는 중에만 */
  countdown?: number
}

/** 띠 아래에 보이는 글 — 엔진이 같이 싣는 말 끝 신호(speaking·silentMs)는 상태에 넣지 않는다 (조각마다 다시 그리지 않게) */
export type VoiceLiveText = Pick<SpeechPartial, 'final' | 'tentative'>

export type VoiceEvent =
  /** 음성 버튼 — 대기일 때만, 늘 대화 모드로 (#244). run 은 앞 번호보다 커야 한다 */
  | { type: 'start'; run: number; sessionId: string }
  /** 마이크가 열렸다 */
  | { type: 'granted'; run: number }
  /** 말하는 동안의 글이 바뀌었다 — 녹음 중·받아쓰는 중(정지 직전에 보낸 조각의 답)일 때만 */
  | { type: 'partial'; run: number; live: VoiceLiveText }
  /** 대화 모드 — 말 끝을 보고 카운트다운을 시작했다 (until 에 보낸다). 듣는 중일 때만 */
  | { type: 'countdown'; run: number; until: number }
  /** 대화 모드 — 카운트다운 중에 다시 말했다. 그대로 이어서 듣는다 */
  | { type: 'resume'; run: number }
  /** 대화 모드 — 보냈다(또는 들은 글이 비었다·대기열에 넣었다). 열린 마이크로 다시 듣는다 */
  | { type: 'listen'; run: number }
  /** 대화 모드를 끈다 — 어느 단계든 대기로, 사유를 남긴다 (대기면 사유만) */
  | { type: 'end'; notice?: VoiceNotice }
  /** 정지(말 끝·끄기) — 녹음 중일 때만 */
  | { type: 'stop'; run: number }
  /** 인식이 끝났다 (입력창에 넣고 껐다) — notice 는 멈춘 사유·"다른 대화에 넣음" */
  | { type: 'done'; run: number; notice?: VoiceNotice }
  /** 마이크·녹음·인식 실패 */
  | { type: 'failed'; run: number; notice: VoiceNotice }
  /** 취소(✕·Esc·대화 삭제·기능 끔) — 어느 단계든 대기로, 띠의 글도 지운다 */
  | { type: 'cancel' }
  | { type: 'dismiss' }

export const VOICE_IDLE: VoiceState = { phase: 'idle', run: 0 }

export function voiceReducer(state: VoiceState, event: VoiceEvent): VoiceState {
  switch (event.type) {
    case 'start':
      if (state.phase !== 'idle' || event.run <= state.run) return state
      return { phase: 'requesting', run: event.run, sessionId: event.sessionId, chat: true }
    case 'granted':
      return state.phase === 'requesting' && event.run === state.run ? { ...state, phase: 'recording' } : state
    case 'partial':
      if ((state.phase !== 'recording' && state.phase !== 'transcribing') || event.run !== state.run) return state
      if (state.live?.final === event.live.final && state.live.tentative === event.live.tentative) return state
      return { ...state, live: { final: event.live.final, tentative: event.live.tentative } }
    case 'countdown':
      return state.phase === 'recording' && state.chat && event.run === state.run ? { ...state, countdown: event.until } : state
    case 'resume':
      return state.countdown !== undefined && event.run === state.run ? withoutCountdown(state) : state
    case 'listen':
      if (state.phase !== 'transcribing' || !state.chat || event.run !== state.run) return state
      return { phase: 'recording', run: state.run, ...(state.sessionId !== undefined && { sessionId: state.sessionId }), chat: true }
    case 'end':
      if (state.phase === 'idle') return event.notice ? { phase: 'idle', run: state.run, notice: event.notice } : state
      return { phase: 'idle', run: state.run, ...(event.notice && { notice: event.notice }) }
    case 'stop':
      return state.phase === 'recording' && event.run === state.run ? { ...withoutCountdown(state), phase: 'transcribing' } : state
    case 'done':
      if (state.phase !== 'transcribing' || event.run !== state.run) return state
      return { phase: 'idle', run: state.run, ...(event.notice && { notice: event.notice }) }
    case 'failed':
      if (state.phase === 'idle' || event.run !== state.run) return state
      return { phase: 'idle', run: state.run, notice: event.notice }
    case 'cancel':
      return state.phase === 'idle' && !state.notice ? state : { phase: 'idle', run: state.run }
    case 'dismiss': {
      if (!state.notice) return state
      const { notice: _, ...rest } = state
      return rest
    }
  }
}

function withoutCountdown(state: VoiceState): VoiceState {
  const { countdown: _, ...rest } = state
  return rest
}

/** 마이크를 쥐고 있거나 받아쓰기의 답을 기다리는 중 — Esc 가 취소다. 대화 모드는 답이 오는 동안에도 듣는다 — 그때의 Esc 도 음성 대화의 것이다 (#240) */
export function voiceBusy(state: VoiceState): boolean {
  return state.phase !== 'idle'
}

/** info 줄이 떠 있는 시간 */
export const VOICE_NOTICE_MS = 4000

// ── PCM ──────────────────────────────────────────────────────────────────────

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

/** 받아쓰기(`speech:stream-*`)의 실패 코드 → 문구. 취소는 알리지 않는다 */
export function replyFailure(code: SpeechErrorCode): MessageKey | undefined {
  return code === 'cancelled' ? undefined : REPLY_FAILURE[code]
}

/** 마이크를 열기 전에 아는 "준비 안 됨" — 파일이 없거나 대조에 실패한 엔진. 대조 중(checking)은 막지 않는다(녹음이 끝날 때쯤 끝난다) */
export function notReady(status: SpeechStatus | undefined): MessageKey | undefined {
  return status?.state === 'unavailable' && status.reason !== 'checking' ? 'voice.error.unavailable' : undefined
}

// ── 음성 대화 모드 (#238) ────────────────────────────────────────────────────

/** 말을 멈추고 이만큼 조용하면 보낸다 (시안) */
export const VOICE_CHAT_SILENCE_MS = 1200
/** 엔진의 VAD 가 꺼지기까지의 무음 — speechWorker 의 minSilenceDuration 0.5초 (실측 꺼짐 지연 0.57초, 01aq §2.2). VAD 설정은 건드리지 않는다 */
export const VAD_OFF_MS = 500
/** VAD 가 꺼진 뒤의 카운트다운 — 띠가 이만큼 차오른 뒤 보낸다. 다시 말하면 VAD 가 약 0.3초 뒤에 켜지므로 실제 여유는 약 0.9초 (01aq §2.5) */
export const VOICE_CHAT_COUNTDOWN_MS = VOICE_CHAT_SILENCE_MS - VAD_OFF_MS
/** 받아쓰기 한 번의 상한(120초) 전에 스트림을 닫고 다시 연다 — 그때까지 들은 글이 있으면 보내지 않고 입력창에 넣고 끈다 */
export const VOICE_CHAT_REOPEN_MS = (SPEECH_MAX_SECONDS - 10) * 1000

/** 재개 열 때의 말소리 감지 — 지금 순간 소리가 이보다 크면 재개를 2초만 미룬다. 엔진의 "소리 없음"(live)은
 *  0.3~0.9초 이전의 것이라서, 타이머가 한 발화 도중에 터면 그 앞 소리가 옛 스트림에 묻힌다 (실측 2026-10-08).
 *  RMS 기준 — 보통 말소리는 0.1 안팎(바가 절반), 밑은 배경이다 */
export const RESTREAM_MIN_LEVEL = 0.03
export const RESTREAM_DEFER_MS = 2000
export function restreamDelay(live: number): boolean {
  return live >= RESTREAM_MIN_LEVEL
}

/** 말 끝 카운트다운의 남은 시간 — VAD 가 꺼졌고 받아쓴 글이 있을 때만. 이미 지난 무음(silentMs)만큼 짧다. 아직 말하는 중이거나 들은 글이 없으면 undefined */
export function countdownLeft(partial: SpeechPartial): number | undefined {
  if (partial.speaking || partial.tentative !== '' || partial.final.trim() === '') return undefined
  return Math.max(0, VOICE_CHAT_COUNTDOWN_MS - partial.silentMs)
}

/** 대화 모드가 보내려는 대화의 지금 모양 */
export interface VoiceChatTarget {
  /** 입력창의 초안 */
  draft: string
  /** 입력 카드의 첨부 칩 수 */
  attachments: number
  /** 고른 모델이 설정에 있다 */
  model: boolean
  /** 쓸 수 있는 대화 (기록을 읽었고 폴더가 있다) */
  writable: boolean
  /** 승인·질문 카드가 떠 있다 */
  attention: boolean
}

/**
 * 자동 보내기 금지 표 (01aq §3.2) — 보낼 수 없으면 사유. 시작할 때는 transcript 없이 부른다.
 * 사용자가 친 글·첨부가 말과 섞여 나가지 않게, `/`·`!` 로 시작하는 말이 명령·셸로 실행되지 않게, 보내기가 말없이 돌아가지 않게.
 * 그 대화에 도는 턴은 막지 않는다 (#240) — 보내면 메인이 대기열에 쌓고 턴이 끝나면 차례로 보낸다
 */
export function voiceChatBlock(target: VoiceChatTarget, transcript?: string): MessageKey | undefined {
  if (target.attention) return 'voice.chat.stop.attention'
  if (target.draft.trim() !== '' || target.attachments > 0) return 'voice.chat.stop.draft'
  if (!target.model) return 'voice.chat.stop.noModel'
  if (!target.writable) return 'voice.chat.stop.cannotWrite'
  if (transcript !== undefined && /^\s*[/!]/.test(transcript)) return 'voice.chat.stop.trigger'
  return undefined
}

/** 대화 모드 중 그 대화의 턴이 끝났다 — 실패·중지면 멈춘다 (계속 들으면 같은 글이 또 막히거나, 사용자가 멈춘 것을 되돌린다) */
export function turnStopReason(outcome: TurnOutcome): MessageKey | undefined {
  return outcome === 'failed' ? 'voice.chat.stop.failed' : outcome === 'interrupted' ? 'voice.chat.stop.interrupted' : undefined
}

/** 보고 있는 대화의 턴 상태 — busy: 도는 턴·대기열·붙잡힌 대기열(띠의 "답변 중" 표시), attention: 승인·질문 카드 */
export interface VoiceChatActivity {
  busy: boolean
  attention: boolean
}

/**
 * 대화 모드에서 대화의 턴 상태가 바뀌었을 때 멈출 사유 — 승인·질문 카드가 뜨면 어느 단계든 멈춘다 (카드 중에 한 말이 답으로 쓰이면 안 된다).
 * 도는 턴은 멈출 사유가 아니다 (#240 — 듣는 중 보낸 말은 대기열로)
 */
export function voiceChatWatch(state: VoiceState, activity: VoiceChatActivity): MessageKey | undefined {
  return state.chat && activity.attention ? 'voice.chat.stop.attention' : undefined
}
