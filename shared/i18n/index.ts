import { en } from './en.ts'
import { ko, type MessageKey } from './ko.ts'

// 번역 — 라이브러리 없이 사전 둘 (01f 권고 구조). 화면(renderer/i18n.ts)과 메인(src/i18n.ts)이 함께 쓴다.

export type { MessageKey } from './ko.ts'
export type Language = 'ko' | 'en'

/** 언어 선택지 — 각 언어 자기 이름으로 보인다(번역하지 않는다, dsh LanguageRow) */
export const LANGUAGES: readonly { id: Language; label: string }[] = [
  { id: 'ko', label: '한국어' },
  { id: 'en', label: 'English' },
]

const dictionaries: Record<Language, Record<MessageKey, string>> = { ko, en }

export function isLanguage(value: unknown): value is Language {
  return value === 'ko' || value === 'en'
}

/** `{name}` 자리를 vars 로 채운다. 없는 변수는 자리표시자 그대로 둔다 */
export function translate(language: Language, key: MessageKey, vars?: Record<string, string | number>): string {
  const text = dictionaries[language][key]
  return vars ? text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole)) : text
}
