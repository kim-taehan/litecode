import type { Language } from './i18n/index.ts'

// 음성 입력(받아쓰기, 기능 `voice`)의 화면 ↔ 메인 계약 — 화면이 녹음을 16kHz mono PCM16 으로 줄여 보내고 메인(ctx.speech)이 글로 돌려준다.
// 실측·설계: _workspace/01ag_voice_input.md. 여기에 Node·Electron 을 아는 코드를 넣지 않는다 (화면도 읽는다).

export const SPEECH_SAMPLE_RATE = 16_000
/** 한 번에 받아쓰는 녹음의 상한 (dsh 와 같다) — 화면은 이 시간에 스스로 멈추고, 메인이 길이를 다시 본다 */
export const SPEECH_MAX_SECONDS = 120
export const SPEECH_MAX_SAMPLES = SPEECH_SAMPLE_RATE * SPEECH_MAX_SECONDS
/** 실시간 받아쓰기에서 화면이 보내는 녹음 조각의 길이 — 0.1초 */
export const SPEECH_CHUNK_SAMPLES = SPEECH_SAMPLE_RATE / 10
/** 조각 하나의 상한 (1초) — 메인이 다시 본다 */
export const SPEECH_CHUNK_MAX_SAMPLES = SPEECH_SAMPLE_RATE

/** 받아쓰기 언어 힌트. auto 는 한국어를 일본어로 볼 때가 있어(실측 합성 음성 1/5) 기본으로 쓰지 않는다 */
export const SPEECH_LANGUAGES = ['auto', 'ko', 'en'] as const
export type SpeechLanguage = (typeof SPEECH_LANGUAGES)[number]

export function isSpeechLanguage(value: unknown): value is SpeechLanguage {
  return (SPEECH_LANGUAGES as readonly unknown[]).includes(value)
}

/** 쓸 언어 힌트 — 설정에 고른 값이 없으면 화면 언어 (힌트가 ko 여도 영어 말은 영어로 적힌다 — 실측 2/2) */
export function speechLanguage(settings: { speechLanguage?: SpeechLanguage; language: Language }): SpeechLanguage {
  return settings.speechLanguage ?? settings.language
}

/** unavailable: 엔진·모델 파일을 못 쓴다 (reason) · ready: 받아쓸 수 있다 (엔진은 처음 쓸 때 뜬다) · starting: 엔진이 뜨는 중.
 *  기능이 꺼져 있으면 서비스가 없다 — 상태 대신 채널이 거절된다 (켜진 기능 목록으로 안다) */
export type SpeechState = 'unavailable' | 'ready' | 'starting'
/** checking: 파일 대조 중(앱을 켠 직후 잠깐) · missing: 엔진·모델 파일이 없다 · mismatch: 모델 파일의 크기·sha256 이 다르다 */
export type SpeechUnavailable = 'checking' | 'missing' | 'mismatch'

export interface SpeechStatus {
  state: SpeechState
  reason?: SpeechUnavailable
  /** 언어를 주지 않은 요청에 쓰는 힌트 (설정 > 화면 언어) */
  language: SpeechLanguage
}

export interface SpeechTranscript {
  /** 받아쓴 글 — 말이 없었으면 빈 문자열 */
  text: string
  audioSeconds: number
  inferSeconds: number
}

/** invalid: PCM 이 아니거나 비었다 · too-long: 상한 초과 · unavailable: 준비 안 됨 · busy: 대기열이 찼다 · timeout: 기한 초과 ·
 *  cancelled: 취소 · failed: 엔진이 못 떴거나 인식 중 죽었다 */
export type SpeechErrorCode = 'invalid' | 'too-long' | 'unavailable' | 'busy' | 'timeout' | 'cancelled' | 'failed'

/** `speech:transcribe` 의 답 — 오류는 IPC 를 지나면 글만 남으므로 던지지 않고 코드로 돌려준다 */
export type SpeechReply = ({ ok: true } & SpeechTranscript) | { ok: false; code: SpeechErrorCode; message: string }

/** 실시간 받아쓰기의 지금까지 글 — 메인 → 화면 `speech:partial`. 말하는 동안 보여 주기만 하고, 입력창에는 정지 뒤의 글(`speech:stream-stop` 의 답)이 들어간다 */
export interface SpeechPartial {
  /** 확정된 글 전부 (끝난 말소리 구간들) */
  final: string
  /** 말하고 있는 구간의 임시 글 — 다음에 통째로 바뀔 수 있다 */
  tentative: string
}

/** `speech:partial` 한 번. error 가 있으면 그 스트림은 끝났다 (엔진이 죽음·기한) — 화면은 녹음을 멈춘다 */
export interface SpeechStreamEvent extends SpeechPartial {
  stream: number
  error?: SpeechErrorCode
}

/** `speech:stream-start` 의 답 — stream 은 조각·정지·취소에 실어 보내는 번호 */
export type SpeechStreamOpened = { ok: true; stream: number } | { ok: false; code: SpeechErrorCode; message: string }
