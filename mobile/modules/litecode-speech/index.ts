// 음성 입력 (#271) — 폰 자체 음성 인식(Android SpeechRecognizer)의 얇은 다리. 네이티브는 android/ 의 SpeechModule.
// 폰은 폐쇄망이 아니라 기기의 인식 서비스(보통 구글 음성 서비스)를 쓴다. 모듈이 없는 빌드·시험에서는 speech 가 null — 마이크 버튼이 숨는다.

import { requireOptionalNativeModule } from 'expo'

export interface SpeechEvents {
  onPartial(event: { text: string }): void
  onFinal(event: { text: string }): void
  /** code 는 Android SpeechRecognizer.ERROR_* (src/app/voiceText.ts voiceProblem 이 문구로 바꾼다) */
  onError(event: { code: number }): void
  /** 한 번 듣기가 끝났다 (onFinal 또는 onError 뒤) */
  onEnd(event: Record<string, never>): void
}

export interface SpeechNative {
  /** 이 기기에 인식 서비스가 있나 */
  available(): boolean
  start(language: string): Promise<void>
  /** 그만 듣고 들은 데까지 최종 결과를 낸다 */
  stop(): Promise<void>
  /** 결과 없이 버린다 */
  cancel(): Promise<void>
  addListener<K extends keyof SpeechEvents>(event: K, listener: SpeechEvents[K]): { remove(): void }
}

export const speech = requireOptionalNativeModule<SpeechNative>('LitecodeSpeech')
