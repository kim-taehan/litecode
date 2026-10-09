// 음성 입력 (#271)의 순수 규칙 — 들은 글을 입력창 글에 합치기, Android 오류 코드를 문구 열쇠로. 네이티브 호출은 voiceInput.ts 에만.

/** 듣는 언어 — 앱 언어 설정이 아직 없어(한국어만) 고정 */
export const VOICE_LANGUAGE = 'ko-KR'

export type VoiceProblem = 'permission' | 'no-speech' | 'network' | 'language' | 'busy' | 'failed'

/**
 * 듣기 시작 때의 입력창 글(base) 뒤에 지금까지 들은 글(heard)을 붙인다. 부분 결과는 매번 그때까지 들은 전체라
 * 늘 base 에서 다시 합친다. 끝이 공백·줄바꿈이 아니면 한 칸 띄운다. 들은 것이 없으면 base 그대로.
 */
export function joinHeard(base: string, heard: string): string {
  const text = heard.trim()
  if (!text) return base
  if (!base || /\s$/.test(base)) return base + text
  return `${base} ${text}`
}

/** Android SpeechRecognizer.ERROR_* → 문구 열쇠. ERROR_CLIENT(5)는 우리가 멈추거나 버릴 때 오므로 보이지 않는다 */
export function voiceProblem(code: number): VoiceProblem | undefined {
  switch (code) {
    case 5:
      return undefined
    case 9:
      return 'permission'
    case 6:
    case 7:
      return 'no-speech'
    case 1:
    case 2:
    case 4:
    case 11:
      return 'network'
    case 12:
    case 13:
      return 'language'
    case 8:
      return 'busy'
    default:
      return 'failed'
  }
}
