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

  // 시안 E (이슈 #542): "모델 N" 줄 오른쪽에 [서버에서 가져오기](파란 글 버튼) · [+ 모델](검정)
  it('[서버에서 가져오기] 는 글 버튼, [+ 모델] 은 검정 — 모델 제목 줄 안에 그 순서', () => {
    const head = html.slice(html.indexOf('models-section__head'), html.indexOf('model-grid'))
    expect(head).toMatch(new RegExp(`<button type="button" class="models-text-button"[^>]*>(<svg.*?</svg>)${ko('models.fetch')}</button>`))
    expect(buttonClass(head, ko('models.addModel'))).toBe('models-dark-button')
    expect(head.indexOf(ko('models.fetch'))).toBeLessThan(head.indexOf(ko('models.addModel')))
  })

  it('편집 끝 [취소][적용] 은 한 묶음(provider-editor__footer) 안에 취소 → 적용 순서', () => {
    const footer = html.slice(html.indexOf('provider-editor__footer'))
    expect(footer.indexOf(ko('models.cancel'))).toBeGreaterThan(-1)
    expect(footer.indexOf(ko('models.cancel'))).toBeLessThan(footer.indexOf(ko('models.apply')))
  })
})

// 이슈 #542 시안 E: 흰 상자 안 머리(이니셜 타일·이름·id · 프로토콜·상태 알약)와 연결(프로토콜|Base URL 한 줄, API 키 •••• [바꾸기])
describe('ProviderEditor — 머리·연결 상자 (이슈 #542)', () => {
  const render = (props: Partial<Parameters<typeof ProviderEditor>[0]>) =>
    renderToStaticMarkup(createElement(ProviderEditor, { provider, taken: [provider], onDone: () => {}, ...props }))
  const box = (html: string) => html.slice(html.indexOf('provider-box'), html.indexOf('models-section'))

  it('머리 — 이니셜 타일, 표시 이름 입력, 그 아래 id · 프로토콜 이름', () => {
    const html = box(render({}))
    expect(html).toContain('<span class="provider-box__tile" aria-hidden="true">사게</span>')
    expect(html).toMatch(new RegExp(`<input class="provider-box__name" aria-label="${ko('models.displayName')}"[^>]*value="사내 게이트웨이"`))
    expect(html).toContain('<span class="provider-box__sub">gw · OpenAI Chat</span>')
  })

  it('상태 알약은 키 유무만 — "연결됨" 같은 앱이 모르는 말은 없다', () => {
    expect(box(render({}))).toContain(`${ko('models.keySet')}</span>`)
    expect(box(render({}))).toContain('provider-box__status provider-box__status--ok')
    expect(box(render({ provider: { ...provider, hasKey: false } }))).toContain(`${ko('models.keyNone')}</span>`)
    expect(render({})).not.toContain('연결됨')
  })

  it('새 provider 는 알약 없이, 이름 칸 placeholder 와 표시 이름에서 지을 id', () => {
    const html = box(render({ provider: undefined }))
    expect(html).not.toContain('provider-box__status')
    expect(html).toContain(`placeholder="${ko('models.newProvider')}"`)
    expect(html).toContain('<span class="provider-box__tile" aria-hidden="true">+</span>')
    expect(html).toContain('<span class="provider-box__sub">provider · OpenAI Chat</span>')
  })

  it('연결 — "연결" 제목, 프로토콜 고르기와 Base URL 이 한 칸(provider-box__endpoint)에 그 순서', () => {
    const html = box(render({}))
    expect(html).toContain(`<h3 class="models-label">${ko('models.connection')}</h3>`)
    const endpoint = html.slice(html.indexOf('provider-box__endpoint'), html.indexOf('provider-box__key'))
    expect(endpoint).toMatch(new RegExp(`<select class="provider-box__protocol" aria-label="${ko('models.protocol')}"`))
    expect(endpoint.indexOf('<select')).toBeLessThan(endpoint.indexOf('aria-label="Base URL"'))
  })

  it('키가 있으면 •••• 설정됨 [바꾸기] — 입력칸은 없다', () => {
    const html = box(render({}))
    expect(html).toContain('••••••••')
    expect(html).toContain(`>${ko('models.keyStored')}</span>`)
    expect(buttonClass(html, ko('models.changeKey'))).toBe('models-text-button')
    expect(html).not.toContain('type="password"')
  })

  it('키가 없으면 바로 입력칸', () => {
    const html = box(render({ provider: { ...provider, hasKey: false } }))
    expect(html).toMatch(new RegExp(`<input class="settings-input provider-box__key-input" aria-label="${ko('models.apiKey')}" type="password"`))
    expect(html).not.toContain(ko('models.changeKey'))
  })

  it('긴 설명 문단은 없다', () => {
    const html = render({ initialOpen: 0 })
    expect(html).not.toContain(`>${translate('ko', 'models.contextLengthHint')}<`)
    expect(html).not.toContain(`>${translate('ko', 'models.maxOutputHint')}<`)
    expect(html).not.toContain(translate('ko', 'models.thinkingHint') + ' ')
  })
})

// 이슈 #477 → #542 시안 E: 모델마다 카드 하나(2열) — 이름·id·숫자·막대(눌러 펼친다)·⋯ 메뉴, 아래 알약 토글(이미지 입력·Thinking 모델).
// 카드를 누르면 아래에 그 모델의 편집 영역(id·표시 이름, 컨텍스트 + 빠른 버튼, 최대 출력, 삭제·접기), 한 번에 하나.
// 토글은 <button aria-pressed> — 저장된 값이 눌림 상태로 보이고, 두 토글은 서로 독립이다
describe('ProviderEditor — 모델 카드와 편집 영역', () => {
  const ko = (key: MessageKey, n: number) => translate('ko', key, { n })
  const render = (models: ProviderSummary['models'], initialOpen?: number) =>
    renderToStaticMarkup(createElement(ProviderEditor, { provider: { ...provider, models }, taken: [provider], onDone: () => {}, initialOpen }))
  /** aria-label 이 `label` 인 요소의 여는 태그 */
  const tag = (html: string, label: string) => html.match(new RegExp(`<[a-z]+ [^>]*aria-label="${label}"[^>]*>`))?.[0]
  /** 모델 카드들 (카드마다 HTML 조각) */
  const cards = (html: string) => html.split('<article class="model-card').slice(1).map((card) => card.slice(0, card.indexOf('</article>')))
  const edit = (html: string) => html.slice(html.indexOf('<div class="model-edit"'), html.indexOf('provider-editor__footer'))

  it('모델마다 카드 하나, 2열 격자 안 — 제목 줄에 모델 수', () => {
    const html = render([{ id: 'm1', displayName: 'M1' }, { id: 'm2', displayName: 'M2' }])
    expect(cards(html)).toHaveLength(2)
    expect(html).toContain('<div class="model-grid">')
    expect(html).toContain(`${translate('ko', 'models.models')} <span class="models-label__count">2</span>`)
  })

  it('카드 — 표시 이름(비면 id) · 모델 id · 펼침 버튼(aria-expanded) · ⋯ 메뉴(aria-label)', () => {
    const [first, second] = cards(render([{ id: 'qwen3.8-27b', displayName: 'Qwen3.8 27B' }, { id: 'raw', displayName: '' }]))
    expect(first).toContain('<span class="model-card__name">Qwen3.8 27B</span><span class="model-card__model-id">qwen3.8-27b</span>')
    expect(first).toMatch(/<button type="button" class="model-card__open" aria-expanded="false"/)
    expect(first).toContain(`aria-label="${translate('ko', 'models.modelMenu', { name: 'Qwen3.8 27B' })}"`)
    expect(second).toContain('<span class="model-card__name">raw</span>')
  })

  it('편집 영역은 처음엔 없고, 펼친 카드만 파란 테두리(model-card--open)·aria-expanded', () => {
    const models = [{ id: 'm1', displayName: 'M1' }, { id: 'm2', displayName: 'M2' }]
    expect(render(models)).not.toContain('model-edit')
    const html = render(models, 1)
    const [first, second] = cards(html)
    expect(first).toMatch(/^">/)
    expect(second).toMatch(/^ model-card--open">/)
    expect(second).toContain('aria-expanded="true" aria-controls="model-edit"')
    expect(edit(html)).toContain(`>${translate('ko', 'models.editModel', { name: 'M2' })}</span>`)
  })

  it('숫자와 막대 — 컨텍스트 100K · 출력 25K 자동 · 75% 지점 "▲ 75K 넘으면 요약"', () => {
    const [card] = cards(render([{ id: 'm1', displayName: 'M1', contextLength: 100_000 }]))
    expect(card).toContain('<b>100K</b>')
    expect(card).toContain('<b>25K</b>')
    expect(card).toContain(translate('ko', 'models.auto'))
    expect(card).toContain('<span class="model-budget__chat" style="width:75%"></span>')
    expect(card).toContain(`>${translate('ko', 'models.summarizeAt', { n: '75K' })}</span>`)
  })

  it('최대 출력을 적으면 "자동" 없이 그 값', () => {
    const [card] = cards(render([{ id: 'm1', displayName: 'M1', contextLength: 131_072, maxOutput: 8_192 }]))
    expect(card).toContain('<b>8K</b>')
    expect(card).not.toContain(translate('ko', 'models.auto'))
  })

  it('컨텍스트가 비면 빗금 막대 + "거절될 때만 요약"', () => {
    const [card] = cards(render([{ id: 'm1', displayName: 'M1' }]))
    expect(card).toContain('model-budget__bar model-budget__bar--unknown')
    expect(card).toContain(`>${translate('ko', 'models.summarizeOnReject')}</span>`)
    expect(card).not.toContain('model-budget__chat')
  })

  it('편집 영역 칸 순서 — id → 표시 이름 → 컨텍스트 → 빠른 버튼 32K·128K·256K → 최대 출력 → 이 모델 삭제 → 접기', () => {
    const area = edit(render([{ id: 'm1', displayName: 'M1' }], 0))
    const at = [
      `aria-label="${ko('models.modelId', 1)}"`,
      `aria-label="${ko('models.modelName', 1)}"`,
      `aria-label="${ko('models.contextLength', 1)}"`,
      '>32K</button>',
      '>128K</button>',
      '>256K</button>',
      `aria-label="${ko('models.maxOutput', 1)}"`,
      `>${translate('ko', 'models.deleteThisModel')}</button>`,
      `>${translate('ko', 'models.collapse')}</button>`,
    ].map((needle) => area.indexOf(needle))
    for (const found of at) expect(found).toBeGreaterThan(-1)
    expect(at).toEqual([...at].sort((a, b) => a - b))
  })

  it('빠른 버튼은 지금 값과 같은 것만 눌림, 최대 출력 placeholder 는 "자동 <값>"', () => {
    const area = edit(render([{ id: 'm1', displayName: 'M1', contextLength: 131_072 }], 0))
    const pressed = [...area.matchAll(/class="model-edit__preset" aria-pressed="(true|false)"[^>]*>([^<]*)</g)].map((match) => [match[2], match[1]])
    expect(pressed).toEqual([['32K', 'false'], ['128K', 'true'], ['256K', 'false']])
    expect(area).toContain(`placeholder="${translate('ko', 'models.maxOutputAuto', { n: '32K' })}"`)
    expect(translate('ko', 'models.maxOutputAuto', { n: '32K' })).toBe('자동 32K')
  })

  it('긴 설명은 칸 이름의 title 툴팁으로', () => {
    const area = edit(render([{ id: 'm1', displayName: 'M1' }], 0))
    expect(area).toContain(`title="${translate('ko', 'models.contextLengthHint')}"`)
    expect(area).toContain(`title="${translate('ko', 'models.maxOutputHint')}"`)
  })

  it('컨텍스트 낮음 경고는 그 모델 편집 영역 안에(role=status)', () => {
    const low = render([{ id: 'small', displayName: 'S', contextLength: 20_000 }], 0)
    expect(edit(low)).toContain(`role="status">${translate('ko', 'models.contextLengthLow', { model: 'small', min: 16_000 })}</p>`)
    expect(render([{ id: 'big', displayName: 'B', contextLength: 131_072 }], 0)).not.toContain('context-length-hint--warn')
  })

  it('Thinking 모델을 편집할 때만 끌 때 안내 한 줄', () => {
    expect(edit(render([{ id: 'm1', displayName: 'M1', thinking: true }], 0))).toContain(translate('ko', 'models.thinkingOffHint'))
    expect(edit(render([{ id: 'm1', displayName: 'M1' }], 0))).not.toContain(translate('ko', 'models.thinkingOffHint'))
  })

  it('이미지 입력·Thinking 모델은 알약 버튼(aria-pressed) — 켠 모델만 눌려 있고, 둘은 독립, 이미지 → Thinking 순서', () => {
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
    const [first] = cards(html)
    expect(first!.indexOf(ko('models.imageInput', 1))).toBeLessThan(first!.indexOf(ko('models.thinking', 1)))
  })

  // 이슈 #500: 겹침은 저장 검증과 같은 키 기준 — 같은 id, 그리고 Thinking 모델 x 의 파생 키(x--think·x--nothink)와 같은 진짜 id
  it('키가 겹치는 항목만 카드가 빨간 표시(model-card--clash), 펼친 편집 영역의 id 칸은 model-card__id--clash·aria-invalid', () => {
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
    expect(cards(render(models)).map((card) => card.startsWith(' model-card--clash'))).toEqual([true, true, true, true, false, false, false, false])
    const idInput = (n: number) => tag(edit(render(models, n - 1)), ko('models.modelId', n))!
    expect(idInput(1)).toMatch(/model-card__id--clash/)
    expect(idInput(1)).toMatch(/aria-invalid="true"/)
    expect(idInput(5)).not.toMatch(/model-card__id--clash|aria-invalid/)
  })

  it('알약 글자는 라벨 키, 체크박스는 더 없다', () => {
    const html = render([{ id: 'm1', displayName: 'M1' }])
    expect(html).not.toContain('type="checkbox"')
    expect(html).toContain(`>${translate('ko', 'models.imageInputLabel')}</button>`)
    expect(html).toContain(`>${translate('ko', 'models.thinkingLabel')}</button>`)
  })

  it('켠 알약에만 체크 아이콘 (글 뒤)', () => {
    const [card] = cards(render([{ id: 'm1', displayName: 'M1', imageInput: true }]))
    const buttons = [...card!.matchAll(/<button [^>]*class="model-card__toggle"[^>]*>.*?<\/button>/g)].map((match) => match[0])
    expect(buttons).toHaveLength(2)
    expect(buttons[0]).toMatch(new RegExp(`>${translate('ko', 'models.imageInputLabel')}<svg`))
    expect(buttons[1]).not.toContain('<svg')
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
