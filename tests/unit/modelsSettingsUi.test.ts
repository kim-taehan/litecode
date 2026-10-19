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

// 이슈 #477: 모델마다 카드 하나 — 윗줄 id·표시 이름·삭제, 아랫줄 컨텍스트 길이·최대 출력·알약 토글(이미지 입력·Thinking 모델).
// 체크 둘이 한 줄에 늘어 id·이름 칸이 잘려 보였다 (시안 A "카드형 두 줄", _workspace/mock-model-row/OptionA.dc.html).
// 토글은 <button aria-pressed> — 저장된 값이 눌림 상태로 보이고, 두 토글은 서로 독립이다
describe('ProviderEditor — 모델 카드 두 줄', () => {
  const ko = (key: MessageKey, n: number) => translate('ko', key, { n })
  const render = (models: ProviderSummary['models']) =>
    renderToStaticMarkup(createElement(ProviderEditor, { provider: { ...provider, models }, taken: [provider], onDone: () => {} }))
  /** aria-label 이 `label` 인 요소의 여는 태그 */
  const tag = (html: string, label: string) => html.match(new RegExp(`<[a-z]+ [^>]*aria-label="${label}"[^>]*>`))?.[0]
  /** n 번째 카드의 줄들 (줄마다 HTML 조각) */
  const rows = (html: string, n: number) => {
    const card = html.split('<div class="model-card">')[n]!
    return card.split('<div class="model-card__row">').slice(1)
  }

  it('모델마다 카드 하나에 줄 둘', () => {
    const html = render([{ id: 'm1', displayName: 'M1' }, { id: 'm2', displayName: 'M2' }])
    expect(html.split('<div class="model-card">').length - 1).toBe(2)
    expect(rows(html, 1)).toHaveLength(2)
  })

  it('윗줄은 id → 표시 이름 → 삭제, 아랫줄은 컨텍스트 길이 → 최대 출력 → 이미지 입력 → Thinking 모델', () => {
    const [top, bottom] = rows(render([{ id: 'm1', displayName: 'M1' }]), 1)
    const order = (part: string, keys: MessageKey[]) => keys.map((key) => part.indexOf(`aria-label="${ko(key, 1)}"`))
    const topAt = order(top!, ['models.modelId', 'models.modelName', 'models.removeModel'])
    const bottomAt = order(bottom!, ['models.contextLength', 'models.maxOutput', 'models.imageInput', 'models.thinking'])
    for (const at of [...topAt, ...bottomAt]) expect(at).toBeGreaterThan(-1)
    expect(topAt).toEqual([...topAt].sort((a, b) => a - b))
    expect(bottomAt).toEqual([...bottomAt].sort((a, b) => a - b))
  })

  it('이미지 입력·Thinking 모델은 알약 버튼(aria-pressed) — 켠 모델만 눌려 있고, 둘은 독립', () => {
    const html = render([
      { id: 'm1', displayName: 'M1', thinking: true },
      { id: 'm2', displayName: 'M2', imageInput: true },
      { id: 'm3', displayName: 'M3' },
    ])
    const pressed = (key: MessageKey, n: number) => {
      const found = tag(html, ko(key, n))
      expect(found).toMatch(/^<button /)
      expect(found).toContain('class="model-card__toggle"')
      return found!.match(/aria-pressed="(true|false)"/)?.[1]
    }
    expect([pressed('models.imageInput', 1), pressed('models.thinking', 1)]).toEqual(['false', 'true'])
    expect([pressed('models.imageInput', 2), pressed('models.thinking', 2)]).toEqual(['true', 'false'])
    expect([pressed('models.imageInput', 3), pressed('models.thinking', 3)]).toEqual(['false', 'false'])
  })

  // 이슈 #500: 겹침은 저장 검증과 같은 키 기준 — 같은 id, 그리고 Thinking 모델 x 의 파생 키(x--think·x--nothink)와 같은 진짜 id
  it('키가 겹치는 항목만 id 칸이 빨간 테두리(model-card__id--clash, aria-invalid)', () => {
    const html = render([
      { id: 'qwen', displayName: 'Q' },
      { id: ' qwen ', displayName: 'Q2', thinking: true },
      { id: 'x', displayName: 'X', thinking: true },
      { id: 'x--nothink', displayName: 'Real' },
      { id: 'y--think', displayName: 'Y real' },
      { id: 'y', displayName: 'Y' },
      { id: '', displayName: '' },
      { id: '', displayName: '' },
    ])
    const clash = (n: number) => /model-card__id--clash/.test(tag(html, ko('models.modelId', n))!) && /aria-invalid="true"/.test(tag(html, ko('models.modelId', n))!)
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(clash)).toEqual([true, true, true, true, false, false, false, false])
  })

  it('알약 글자는 라벨 키, 체크박스는 더 없다', () => {
    const html = render([{ id: 'm1', displayName: 'M1' }])
    expect(html).not.toContain('type="checkbox"')
    expect(html).toContain(`>${translate('ko', 'models.imageInputLabel')}</button>`)
    expect(html).toContain(`>${translate('ko', 'models.thinkingLabel')}</button>`)
  })

  it('켠 알약에만 체크 아이콘', () => {
    const [bottom] = rows(render([{ id: 'm1', displayName: 'M1', imageInput: true }]), 1).slice(1)
    const buttons = [...bottom!.matchAll(/<button [^>]*class="model-card__toggle"[^>]*>.*?<\/button>/g)].map((match) => match[0])
    expect(buttons).toHaveLength(2)
    expect(buttons[0]).toContain('<svg')
    expect(buttons[1]).not.toContain('<svg')
  })

  // 시안 H: Thinking 모델 안내 한 줄 → 컨텍스트 길이·최대 출력 안내 순서. #497 의 같은 id 두 항목 안내는 없다
  it('안내문 — Thinking 모델 한 줄이 컨텍스트 길이·최대 출력 안내 앞에 있다', () => {
    const html = render([{ id: 'm1', displayName: 'M1' }])
    const hint = html.indexOf(translate('ko', 'models.thinkingHint'))
    expect(html).toContain(`>${translate('ko', 'models.thinkingLabel')}</strong>`)
    expect(hint).toBeGreaterThan(-1)
    expect(hint).toBeLessThan(html.indexOf(translate('ko', 'models.contextLengthHint')))
    expect(html).toContain(translate('ko', 'models.maxOutputHint'))
    expect(html).not.toContain('사고 켬·끔 두 항목')
  })

  it('안내 문구는 시안 H 그대로 (ko), 겹침 문구는 #497 이전으로', () => {
    expect(translate('ko', 'models.thinkingLabel')).toBe('Thinking 모델')
    expect(translate('en', 'models.thinkingLabel')).toBe('Thinking model')
    expect(translate('ko', 'models.thinkingHint')).toBe(
      '답하기 전에 생각하는 과정이 있는 모델이면 켜 두세요. 켜면 입력창에서 대화마다 Thinking 을 디폴트·켬·끔 중에서 고를 수 있습니다. 서버가 이 설정을 따르지 않는 모델에는 켜지 마세요.',
    )
    expect(translate('ko', 'error.modelIdDuplicate')).toBe('모델 id 가 겹칩니다')
    expect(translate('en', 'error.modelIdDuplicate')).toBe('Model ids overlap')
  })
})

// 이슈 #231: 키체인이 키를 안 풀어 주면 채팅만 실패하고 설정에는 아무 표시가 없었다 — 모델 페이지 위쪽에 노란 안내 한 줄
describe('ModelsPage — 키 저장소 안내', () => {
  const escaped = (text: string) => text.replace(/'/g, '&#x27;').replace(/"/g, '&quot;')

  it('저장된 키를 읽을 수 없는 provider 가 있으면 설명 아래에 안내 한 줄(role=status)', () => {
    const html = renderToStaticMarkup(createElement(ModelsPage, { providers: [{ ...provider, keyLocked: true }], onProvidersChange: () => {} }))
    const notice = `<p class="settings-notice" role="status">${escaped(ko('models.keyStoreLocked'))}</p>`
    expect(html).toContain(notice)
    expect(html.indexOf(notice)).toBeGreaterThan(html.indexOf('models-page__hint'))
    expect(html.indexOf(notice)).toBeLessThan(html.indexOf('provider-card'))
  })

  it('없으면 안내도 없다', () => {
    const html = renderToStaticMarkup(createElement(ModelsPage, { providers: [provider], onProvidersChange: () => {} }))
    expect(html).not.toContain('settings-notice')
  })
})
