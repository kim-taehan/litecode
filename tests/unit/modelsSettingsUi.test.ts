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

  // 시안 A (이슈 #542): "모델" 제목 줄 오른쪽 [서버에서 가져오기](파란 글 버튼), 표 끝 점선 줄 "+ 모델 추가"
  it('[서버에서 가져오기] 는 모델 제목 줄의 글 버튼, [모델 추가] 는 표 끝 줄', () => {
    const head = html.slice(html.indexOf('models-section__head'), html.indexOf('model-table'))
    expect(head).toMatch(new RegExp(`<button type="button" class="models-text-button"[^>]*>(<svg.*?</svg>)${ko('models.fetch')}</button>`))
    const table = html.slice(html.indexOf('class="model-table"'), html.indexOf('models-section__hint'))
    expect(table).toMatch(new RegExp(`<button type="button" class="model-table__add"[^>]*><svg.*?</svg>${ko('models.addModel')}</button></div><p class="$`))
  })

  it('편집 끝 [취소][적용] 은 한 묶음(provider-editor__footer) 안에 취소 → 적용 순서', () => {
    const footer = html.slice(html.indexOf('provider-editor__footer'))
    expect(footer.indexOf(ko('models.cancel'))).toBeGreaterThan(-1)
    expect(footer.indexOf(ko('models.cancel'))).toBeLessThan(footer.indexOf(ko('models.apply')))
  })
})

// 이슈 #542 시안 A: 큰 제목(표시 이름) + `키 상태 · id · 모델 N개`, 연결(프로토콜|Base URL 한 줄, API 키 •••• [바꾸기])
describe('ProviderEditor — 머리·연결 (이슈 #542)', () => {
  const render = (props: Partial<Parameters<typeof ProviderEditor>[0]>) =>
    renderToStaticMarkup(createElement(ProviderEditor, { provider, taken: [provider], onDone: () => {}, ...props }))
  const top = (html: string) => html.slice(0, html.indexOf('models-section'))
  const meta = (html: string) => html.slice(html.indexOf('provider-head__meta'), html.indexOf('provider-conn'))

  it('머리 — 표시 이름 입력(큰 제목), 그 아래 키 상태 · id · 모델 N개', () => {
    const html = top(render({ provider: { ...provider, models: [{ id: 'a', displayName: '' }, { id: 'b', displayName: '' }] } }))
    expect(html).toMatch(new RegExp(`<input class="provider-head__name" aria-label="${ko('models.displayName')}"[^>]*value="사내 게이트웨이"`))
    const line = meta(html)
    const at = [ko('models.keySet'), '<span class="provider-head__id">gw</span>', `>${translate('ko', 'models.modelCount', { n: 2 })}</span>`].map((needle) => line.indexOf(needle))
    for (const found of at) expect(found).toBeGreaterThan(-1)
    expect(at).toEqual([...at].sort((a, b) => a - b))
    expect(translate('ko', 'models.modelCount', { n: 2 })).toBe('모델 2개')
  })

  it('상태는 키 유무만 — "연결됨" 같은 앱이 모르는 말은 없다', () => {
    expect(meta(render({}))).toContain('provider-head__status provider-head__status--ok')
    expect(meta(render({ provider: { ...provider, hasKey: false } }))).toContain(`${ko('models.keyNone')}</span>`)
    expect(render({})).not.toContain('연결됨')
  })

  it('새 provider 는 상태 없이, 이름 칸 placeholder 와 표시 이름에서 지을 id', () => {
    const html = top(render({ provider: undefined }))
    expect(html).not.toContain('provider-head__status')
    expect(html).toContain(`placeholder="${ko('models.newProvider')}"`)
    expect(meta(html)).toContain('<span class="provider-head__id">provider</span>')
  })

  it('연결 — "연결" 제목, 프로토콜 고르기와 Base URL 이 한 칸(provider-conn__endpoint)에 그 순서', () => {
    const html = top(render({}))
    expect(html).toContain(`<h3 class="models-label">${ko('models.connection')}</h3>`)
    const endpoint = html.slice(html.indexOf('provider-conn__endpoint'), html.indexOf('provider-conn__key'))
    expect(endpoint).toMatch(new RegExp(`<select class="provider-conn__protocol" aria-label="${ko('models.protocol')}"`))
    expect(endpoint.indexOf('<select')).toBeLessThan(endpoint.indexOf('aria-label="Base URL"'))
  })

  it('키가 있으면 •••• 설정됨 [바꾸기] — 입력칸은 없다', () => {
    const html = top(render({}))
    expect(html).toContain('••••••••')
    expect(html).toContain(`>${ko('models.keyStored')}</span>`)
    expect(buttonClass(html, ko('models.changeKey'))).toBe('models-text-button')
    expect(html).not.toContain('type="password"')
  })

  it('키가 없으면 바로 입력칸', () => {
    const html = top(render({ provider: { ...provider, hasKey: false } }))
    expect(html).toMatch(new RegExp(`<input class="settings-input provider-conn__key-input" aria-label="${ko('models.apiKey')}" type="password"`))
    expect(html).not.toContain(ko('models.changeKey'))
  })

  it('긴 설명 문단 대신 표 아래 한 줄 + 열 이름 툴팁', () => {
    const html = render({})
    expect(html).not.toContain(`>${translate('ko', 'models.contextLengthHint')}<`)
    expect(html).not.toContain(`>${translate('ko', 'models.maxOutputHint')}<`)
    expect(html).not.toContain(`${translate('ko', 'models.thinkingHint')} `)
    expect(html).toContain(`<p class="models-section__hint">${translate('ko', 'models.tableHint')}</p>`)
    expect(html).toContain(`title="${translate('ko', 'models.contextLengthHint')}"`)
    expect(html).toContain(`title="${translate('ko', 'models.maxOutputHint')}"`)
  })
})

// 이슈 #477 → #542 시안 A: 모델마다 표의 한 줄 — id · 표시 이름 · 컨텍스트 · 최대 출력 · 기능 아이콘(이미지 입력·Thinking 모델) · ×.
// 칸을 누르면 그 줄이 편집 줄(연한 파랑 + 왼쪽 선)이 되어 제자리에서 입력한다, 한 번에 한 줄.
// 토글은 <button aria-pressed> — 저장된 값이 눌림 상태로 보이고, 두 토글은 서로 독립이다
describe('ProviderEditor — 모델 표', () => {
  const ko = (key: MessageKey, n: number) => translate('ko', key, { n })
  const render = (models: ProviderSummary['models'], initialEditing?: number) =>
    renderToStaticMarkup(createElement(ProviderEditor, { provider: { ...provider, models }, taken: [provider], onDone: () => {}, initialEditing }))
  /** aria-label 이 `label` 인 요소의 여는 태그 */
  const tag = (html: string, label: string) => html.match(new RegExp(`<[a-z]+ [^>]*aria-label="${label}"[^>]*>`))?.[0]
  /** 모델 줄들 (머리줄 빼고, 줄마다 class 뒷부분부터의 HTML 조각) */
  const rows = (html: string) => html.split('<div class="model-row').slice(2)

  it('머리줄 열 순서 — 모델 id · 표시 이름 · 컨텍스트 · 최대 출력 · 기능', () => {
    const header = render([]).split('<div class="model-row')[1]!
    const at = ['models.modelIdPlaceholder', 'models.displayName', 'models.context', 'models.maxOutputPlaceholder', 'models.features'].map((key) =>
      header.indexOf(`>${translate('ko', key as MessageKey)}</span>`),
    )
    for (const found of at) expect(found).toBeGreaterThan(-1)
    expect(at).toEqual([...at].sort((a, b) => a - b))
  })

  it('모델마다 줄 하나 — 처음엔 편집 줄 없이 글 칸(눌러 고치는 버튼)', () => {
    const html = render([{ id: 'm1', displayName: 'M1' }, { id: 'm2', displayName: 'M2' }])
    expect(rows(html)).toHaveLength(2)
    expect(html).not.toContain('model-row--editing')
    expect(html).not.toContain(`aria-label="${ko('models.modelId', 1)}"`)
    expect(rows(html)[0]).toContain('<button type="button" class="model-row__cell model-card__id">m1</button>')
  })

  it('숫자 칸 — 컨텍스트 100K, 최대 출력이 비면 "자동 25K", 적으면 그 값, 컨텍스트 없으면 —', () => {
    const [auto, set, none] = rows(render([
      { id: 'a', displayName: 'A', contextLength: 100_000 },
      { id: 'b', displayName: 'B', contextLength: 131_072, maxOutput: 8_192 },
      { id: 'c', displayName: 'C' },
    ]))
    expect(auto).toContain('model-row__end model-row__cell--strong">100K</button>')
    expect(auto).toContain(`model-row__end model-row__cell--empty">${translate('ko', 'models.maxOutputAuto', { n: '25K' })}</button>`)
    expect(translate('ko', 'models.maxOutputAuto', { n: '25K' })).toBe('자동 25K')
    expect(set).toContain('>128K</button>')
    expect(set).toContain('model-row__end">8K</button>')
    expect(none!.match(/model-row__end model-row__cell--empty">—<\/button>/g)).toHaveLength(2)
  })

  it('편집 줄 — 연한 파랑(model-row--editing), 칸이 입력이 된다: id → 표시 이름 → 컨텍스트 → 최대 출력 → 이미지 → Thinking → ×', () => {
    const html = render([{ id: 'm1', displayName: 'M1' }, { id: 'm2', displayName: 'M2' }], 1)
    const [first, second] = rows(html)
    expect(first).toMatch(/^" role="row">/)
    expect(second).toMatch(/^ model-row--editing" role="row">/)
    const at = ['models.modelId', 'models.modelName', 'models.contextLength', 'models.maxOutput', 'models.imageInput', 'models.thinking', 'models.removeModel'].map((key) =>
      second!.indexOf(`aria-label="${ko(key as MessageKey, 2)}"`),
    )
    for (const found of at) expect(found).toBeGreaterThan(-1)
    expect(at).toEqual([...at].sort((a, b) => a - b))
    expect(tag(html, ko('models.modelId', 2))).toMatch(/^<input /)
  })

  it('최대 출력 입력의 placeholder 는 "자동 <값>", 컨텍스트가 없으면 "자동"', () => {
    const html = render([{ id: 'a', displayName: 'A', contextLength: 131_072 }, { id: 'b', displayName: 'B' }], 0)
    expect(tag(html, ko('models.maxOutput', 1))).toContain(`placeholder="${translate('ko', 'models.maxOutputAuto', { n: '32K' })}"`)
    expect(tag(render([{ id: 'b', displayName: 'B' }], 0), ko('models.maxOutput', 1))).toContain(`placeholder="${translate('ko', 'models.auto')}"`)
  })

  it('컨텍스트 낮음 경고는 그 줄 아래(role=status)', () => {
    const [low, big] = rows(render([{ id: 'small', displayName: 'S', contextLength: 20_000 }, { id: 'big', displayName: 'B', contextLength: 131_072 }]))
    expect(low).toContain(`role="status">${translate('ko', 'models.contextLengthLow', { model: 'small', min: 16_000 })}</p>`)
    expect(big).not.toContain('context-length-hint--warn')
  })

  it('Thinking 모델 줄을 편집할 때만 그 줄 아래 끌 때 안내 한 줄', () => {
    expect(render([{ id: 'm1', displayName: 'M1', thinking: true }], 0)).toContain(translate('ko', 'models.thinkingOffHint'))
    expect(render([{ id: 'm1', displayName: 'M1', thinking: true }])).not.toContain(translate('ko', 'models.thinkingOffHint'))
    expect(render([{ id: 'm1', displayName: 'M1' }], 0)).not.toContain(translate('ko', 'models.thinkingOffHint'))
  })

  it('이미지 입력·Thinking 모델은 아이콘 토글(aria-pressed) — 켠 모델만 눌려 있고, 둘은 독립', () => {
    const html = render([
      { id: 'm1', displayName: 'M1', thinking: true },
      { id: 'm2', displayName: 'M2', imageInput: true },
      { id: 'm3', displayName: 'M3' },
    ])
    const pressed = (key: MessageKey, n: number) => {
      const found = tag(html, ko(key, n))
      expect(found).toMatch(/^<button /)
      expect(found).toContain('class="model-row__toggle"')
      return found!.match(/aria-pressed="(true|false)"/)?.[1]
    }
    expect([pressed('models.imageInput', 1), pressed('models.thinking', 1)]).toEqual(['false', 'true'])
    expect([pressed('models.imageInput', 2), pressed('models.thinking', 2)]).toEqual(['true', 'false'])
    expect([pressed('models.imageInput', 3), pressed('models.thinking', 3)]).toEqual(['false', 'false'])
  })

  it('토글은 아이콘만(글자 없음, title 툴팁), 체크박스는 더 없다', () => {
    const html = render([{ id: 'm1', displayName: 'M1' }])
    expect(html).not.toContain('type="checkbox"')
    const buttons = [...rows(html)[0]!.matchAll(/<button [^>]*class="model-row__toggle"[^>]*>(.*?)<\/button>/g)]
    expect(buttons).toHaveLength(2)
    for (const [whole, inner] of buttons) {
      expect(inner).toMatch(/^<svg[^>]*aria-hidden="true".*<\/svg>$/)
      expect(whole).toMatch(/ title="[^"]+"/)
    }
  })

  it('× 는 줄마다(aria-label 모델 삭제 {n})', () => {
    const html = render([{ id: 'm1', displayName: 'M1' }, { id: 'm2', displayName: 'M2' }])
    expect(tag(html, ko('models.removeModel', 2))).toMatch(/^<button type="button" class="model-row__remove"/)
  })

  // 이슈 #500: 겹침은 저장 검증과 같은 키 기준 — 같은 id, 그리고 Thinking 모델 x 의 파생 키(x--think·x--nothink)와 같은 진짜 id
  it('키가 겹치는 항목만 빨간 표시 — 줄(model-row--clash), 편집 줄의 id 칸은 model-card__id--clash·aria-invalid', () => {
    const models = [
      { id: 'qwen', displayName: 'Q' },
      { id: ' qwen ', displayName: 'Q2', thinking: true },
      { id: 'x', displayName: 'X', thinking: true },
      { id: 'x--nothink', displayName: 'Real' },
      { id: 'y--think', displayName: 'Y real' },
      { id: 'y', displayName: 'Y' },
      { id: '', displayName: '' },
      { id: '', displayName: '' },
    ]
    expect(rows(render(models)).map((row) => row.startsWith(' model-row--clash'))).toEqual([true, true, true, true, false, false, false, false])
    expect(rows(render(models))[0]).toContain('model-row__cell--clash')
    const idInput = (n: number) => tag(render(models, n - 1), ko('models.modelId', n))!
    expect(idInput(1)).toMatch(/model-card__id--clash/)
    expect(idInput(1)).toMatch(/aria-invalid="true"/)
    expect(idInput(5)).not.toMatch(/model-card__id--clash|aria-invalid/)
  })

  it('안내 문구 (ko·en), 겹침 문구는 #497 이전으로', () => {
    expect(translate('ko', 'models.thinkingLabel')).toBe('Thinking 모델')
    expect(translate('en', 'models.thinkingLabel')).toBe('Thinking model')
    expect(translate('ko', 'models.thinkingHint')).toBe(
      '답하기 전에 생각하는 과정이 있는 모델이면 켜 두세요. 켜면 입력창에서 대화마다 Thinking 을 Default·On·Off 중에서 고를 수 있습니다. 서버가 이 설정을 따르지 않는 모델에는 켜지 마세요.',
    )
    // #503 (#502-2): 선언을 끄면 켬·끔으로 쓰던 대화의 키가 풀리지 않는다 — 다시 고르라는 안내 한 줄
    expect(translate('ko', 'models.thinkingOffHint')).toBe('끄면 이 모델을 Thinking On·Off 로 쓰던 대화는 입력창에서 모델을 다시 골라야 합니다.')
    expect(translate('en', 'models.thinkingOffHint')).toBe('If you turn it off, chats that used this model with Thinking On or Off need the model picked again in the input box.')
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
