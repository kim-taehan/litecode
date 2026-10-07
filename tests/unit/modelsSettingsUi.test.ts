import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { translate, type MessageKey } from '../../shared/i18n/index.ts'
import type { ProviderSummary } from '../../shared/ipc.ts'
import { ModelsPage, ProviderEditor } from '../../renderer/Settings.tsx'

// 설정 > 모델 — 카드 안 보조 버튼은 콤팩트(28/R8/12), 삭제는 테두리 없는 빨간 글 (이슈 #223, dsh ui-settings-models ModelsSection).
// 모양은 CSS 라 여기선 버튼이 그 클래스를 달았는지만 지킨다
vi.mock('../../renderer/settingsStore.ts', () => ({
  useT: () => (key: MessageKey, vars?: Record<string, string | number>) => translate('ko', key, vars),
  useSettings: () => ({}),
  updateSettings: async () => undefined,
}))
vi.mock('../../renderer/featuresStore.ts', () => ({ useFeatures: () => ({}) }))

const provider: ProviderSummary = {
  id: 'gw',
  displayName: '사내 게이트웨이',
  baseURL: 'https://gw.example/v1',
  protocol: 'openai-chat-completions',
  models: [{ id: 'm1', displayName: 'M1' }],
  custom: true,
  hasKey: true,
}

/** 글자가 `label` 인 button 의 class 값 */
function buttonClass(html: string, label: string): string | undefined {
  for (const match of html.matchAll(/<button[^>]*class="([^"]*)"[^>]*>([^<]*)<\/button>/g)) {
    if (match[2] === label) return match[1]
  }
  return undefined
}

const ko = (key: MessageKey) => translate('ko', key)

describe('ModelsPage — 카드 머리 버튼', () => {
  const html = renderToStaticMarkup(createElement(ModelsPage, { providers: [provider], onProvidersChange: () => {} }))

  it('[편집] 은 콤팩트 외곽선 버튼', () => {
    expect(buttonClass(html, ko('models.edit'))).toBe('settings-button settings-button--compact')
  })

  it('[삭제] 는 콤팩트 + 테두리 없는 빨간 글(settings-button--ghost-danger)', () => {
    expect(buttonClass(html, ko('models.delete'))).toBe('settings-button settings-button--compact settings-button--ghost-danger')
  })

  it('[provider 추가] 는 그대로 models-page__add (점선 빈 자리 모양은 CSS)', () => {
    expect(buttonClass(html, ko('models.addProvider'))).toBe('models-page__add')
  })
})

describe('ProviderEditor — 편집 안 버튼', () => {
  const html = renderToStaticMarkup(createElement(ProviderEditor, { provider, taken: [provider], onDone: () => {} }))

  it('[모델 추가]·[가져오기] 는 콤팩트', () => {
    expect(buttonClass(html, ko('models.addModel'))).toBe('settings-button settings-button--compact')
    expect(buttonClass(html, ko('models.fetch'))).toBe('settings-button settings-button--compact')
  })

  it('편집 끝 [취소][적용] 은 한 묶음(provider-editor__footer) 안에 취소 → 적용 순서', () => {
    const footer = html.slice(html.indexOf('provider-editor__footer'))
    expect(footer.indexOf(ko('models.cancel'))).toBeGreaterThan(-1)
    expect(footer.indexOf(ko('models.cancel'))).toBeLessThan(footer.indexOf(ko('models.apply')))
  })
})
