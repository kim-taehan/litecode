import { useCallback, useSyncExternalStore } from 'react'
import type { Settings } from '../shared/ipc.ts'
import { DEFAULT_LANGUAGE, isBuiltinLanguage, translate, type LocaleMessages, type MessageKey } from '../shared/i18n/index.ts'
import { chatFontVars } from '../shared/fontSize.ts'

// 화면 쪽 설정 — 정본은 메인의 ctx.settings. 첫 그림 전에 한 번 읽고(main.tsx), 바꾸면 메인이 저장한 값을 받아 그린다
// (dsh: 보이는 값은 저장된 설정을 따르고 클릭을 미리 반영하지 않는다). 테마는 여기서 다루지 않는다 — 메인이 nativeTheme 에 넣으면
// CSS 미디어 쿼리가 따라온다. 언어는 <html lang>, 글자 크기는 :root 의 CSS 변수로 내린다.
// 언어 팩(이슈 #525): 언어가 팩 언어면 그 사전을 메인에서 받아(extensions:read-locale) 설정과 함께 바꾼다 — 사전이 오기 전에 반쯤 바뀐 화면을 그리지 않는다.
// 확장 목록이 바뀌면(extensions:changed) 설정을 다시 읽는다 — 팩이 지워지거나 꺼지면 메인이 언어를 기본으로 되돌려 두었다. 팩을 못 읽으면 en.

let current: Settings
/** 팩 언어의 사전 — 내장 언어면 undefined */
let pack: LocaleMessages | undefined
let applying = 0
let following = false
const listeners = new Set<() => void>()

async function apply(next: Settings): Promise<void> {
  const mine = ++applying
  const nextPack = isBuiltinLanguage(next.language) ? undefined : await readPack(next.language)
  if (mine !== applying) return // 그사이 더 새 설정이 왔다
  current = next
  pack = nextPack
  const root = document.documentElement
  root.lang = isBuiltinLanguage(next.language) || nextPack ? next.language : DEFAULT_LANGUAGE
  for (const [name, value] of Object.entries(chatFontVars(next.fontSize))) root.style.setProperty(name, value)
  for (const listener of listeners) listener()
}

async function readPack(language: string): Promise<LocaleMessages | undefined> {
  const result = await window.litecode.readLocalePack(language).catch(() => undefined)
  return result?.ok ? result.messages : undefined
}

export async function loadSettings(): Promise<void> {
  if (!following) {
    following = true
    window.litecode.onExtensionsChanged(() => void window.litecode.getSettings().then(apply, () => {}))
  }
  await apply(await window.litecode.getSettings())
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  await apply(await window.litecode.setSettings(patch))
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, () => current)
}

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string

/** 지금 언어의 번역 함수 — 언어나 팩 사전이 바뀌면 새 함수라 그 컴포넌트가 다시 그려진다 */
export function useT(): Translate {
  const { language } = useSettings()
  const messages = useSyncExternalStore(subscribe, () => pack)
  return useCallback<Translate>((key, vars) => translate(language, key, vars, messages), [language, messages])
}
