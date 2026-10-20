import { en } from './en.ts'
import { ko, type MessageKey } from './ko.ts'

// 번역 — 라이브러리 없이 사전 둘 (01f 권고 구조). 화면(renderer/i18n.ts)과 메인(src/i18n.ts)이 함께 쓴다.
// 언어 팩 확장(이슈 #525)이 사전을 더한다 — 팩 언어의 사전은 "팩 문구 → 없는 키는 en". 팩 문구는 글로만 그린다(HTML 로 해석하지 않는다).

export type { MessageKey } from './ko.ts'
/** 앱에 들어 있는 사전 */
export type BuiltinLanguage = 'ko' | 'en'
/** 내장 언어(ko·en) 또는 설치한 언어 팩의 언어 태그 (BCP47 모양, 예: zh-CN) */
export type Language = string
/** 언어 팩의 사전 — 내장 사전에 있는 키만, 빠진 키는 en 으로 보인다 */
export type LocaleMessages = Partial<Record<MessageKey, string>>

/** 기본 언어 — 고른 언어 팩이 지워지거나 꺼지면 여기로 돌아간다 (사용자 결정 2026-10-01: 영어) */
export const DEFAULT_LANGUAGE: BuiltinLanguage = 'en'

/** 언어 선택지 — 각 언어 자기 이름으로 보인다(번역하지 않는다, dsh LanguageRow). 설치한 언어 팩은 화면이 이 뒤에 붙인다 */
export const LANGUAGES: readonly { id: BuiltinLanguage; label: string }[] = [
  { id: 'ko', label: '한국어' },
  { id: 'en', label: 'English' },
]

const dictionaries: Record<BuiltinLanguage, Record<MessageKey, string>> = { ko, en }

export function isBuiltinLanguage(value: unknown): value is BuiltinLanguage {
  return value === 'ko' || value === 'en'
}

/** BCP47 모양 — 소문자 2~3자 언어 + `-` 로 이은 2~8자 마디들 (zh-CN·zh-Hans·pt-BR). 그 팩이 실제로 있는지는 보지 않는다(ctx.extensions 가 따라간다) */
const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && value.length <= 35 && LANGUAGE_TAG.test(value)
}

/** `{name}` 자리를 vars 로 채운다. 없는 변수는 자리표시자 그대로 둔다. 팩 언어면 pack 의 문구, 없는 키(또는 pack 없음)는 en */
export function translate(language: Language, key: MessageKey, vars?: Record<string, string | number>, pack?: LocaleMessages): string {
  const text = isBuiltinLanguage(language) ? dictionaries[language][key] : packText(pack, key) ?? en[key]
  return vars ? text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole)) : text
}

function packText(pack: LocaleMessages | undefined, key: MessageKey): string | undefined {
  const text = pack && Object.hasOwn(pack, key) ? pack[key] : undefined
  return typeof text === 'string' ? text : undefined
}
