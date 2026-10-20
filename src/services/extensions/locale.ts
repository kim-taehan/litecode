import type { LocaleMessages, MessageKey } from '../../../shared/i18n/index.ts'
import { ko } from '../../../shared/i18n/ko.ts'
import { EXTENSION_LIMITS, type ExtensionLimits } from './limits.ts'

// 언어 팩 번들 읽기 (이슈 #525) — 설치 검사(zipInspect)·설치 폴더 재검증·언어 전환 때 같은 규칙으로 거른다.
// 받는 것은 { 키: 문자열 } 뿐: 내장 사전(ko — 키 정본)에 있는 키만, 문자열만, 길이 상한 안의 값만 남기고 나머지는 말없이 버린다(그 키는 en 으로 보인다).
// 키는 내장 키 목록을 돌며 Object.hasOwn 으로 꺼낸다 — 번들의 `__proto__`·`constructor` 같은 키가 결과 객체의 모양을 바꾸지 못한다.
// 값은 화면이 글로만 그린다(React 텍스트 — HTML 로 해석하지 않는다). 키가 너무 많거나 JSON 객체가 아니면 번들 전체를 거절한다

const KEYS = Object.keys(ko) as MessageKey[]

export function parseLocaleBundle(text: string, limits: ExtensionLimits = EXTENSION_LIMITS): { messages: LocaleMessages } | { error: string } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: 'not a JSON object' }
  const raw = value as Record<string, unknown>
  const count = Object.keys(raw).length
  if (count > limits.localeKeys) return { error: `${count} keys, limit ${limits.localeKeys}` }
  const messages: LocaleMessages = {}
  for (const key of KEYS) {
    if (!Object.hasOwn(raw, key)) continue
    const text = raw[key]
    if (typeof text === 'string' && text.length <= limits.localeValueLength) messages[key] = text
  }
  return { messages }
}
