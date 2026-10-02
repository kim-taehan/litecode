import { useCallback, useSyncExternalStore } from 'react'
import type { Settings } from '../shared/ipc.ts'
import { translate, type MessageKey } from '../shared/i18n/index.ts'
import { chatFontVars } from '../shared/fontSize.ts'

// 화면 쪽 설정 — 정본은 메인의 ctx.settings. 첫 그림 전에 한 번 읽고(main.tsx), 바꾸면 메인이 저장한 값을 받아 그린다
// (dsh: 보이는 값은 저장된 설정을 따르고 클릭을 미리 반영하지 않는다). 테마는 여기서 다루지 않는다 — 메인이 nativeTheme 에 넣으면
// CSS 미디어 쿼리가 따라온다. 언어는 <html lang>, 글자 크기는 :root 의 CSS 변수로 내린다.

let current: Settings
const listeners = new Set<() => void>()

function apply(next: Settings): void {
  current = next
  const root = document.documentElement
  root.lang = next.language
  for (const [name, value] of Object.entries(chatFontVars(next.fontSize))) root.style.setProperty(name, value)
  for (const listener of listeners) listener()
}

export async function loadSettings(): Promise<void> {
  apply(await window.litecode.getSettings())
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  apply(await window.litecode.setSettings(patch))
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, () => current)
}

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string

/** 지금 언어의 번역 함수 — 언어가 바뀌면 새 함수라 그 컴포넌트가 다시 그려진다 */
export function useT(): Translate {
  const { language } = useSettings()
  return useCallback<Translate>((key, vars) => translate(language, key, vars), [language])
}
