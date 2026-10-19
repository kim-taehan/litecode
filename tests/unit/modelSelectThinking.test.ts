import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { translate, type MessageKey } from '../../shared/i18n/index.ts'
import type { ProviderSummary } from '../../shared/ipc.ts'
import { engineModelId, type Thinking } from '../../shared/engineModelId.ts'
import { findModel, type ModelRef } from '../../renderer/modelChoice.ts'

// 이슈 #500 (시안: 모델 메뉴 안 Thinking, dsh ui-model-selection 참조) — Thinking 모델을 고른 동안 닫힌 칩에 값이 붙고, 메뉴는 루트 패널(Model / Thinking)로 열린다.
// DOM 이 없어서 useState 를 가로채 열림·패널을 정하고, 정적 마크업(renderToStaticMarkup)과 함수로 부른 요소 트리(클릭 처리기 직접 호출)로 본다
let overrides: unknown[] = []
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return {
    ...react,
    useState: (init: unknown) => [overrides.length > 0 ? overrides.shift() : typeof init === 'function' ? (init as () => unknown)() : init, vi.fn()],
    useRef: (init: unknown) => ({ current: init }),
    useEffect: () => {},
  }
})
vi.mock('../../renderer/settingsStore.ts', () => ({
  useT: () => (key: MessageKey, vars?: Record<string, string | number>) => translate('ko', key, vars),
}))
vi.mock('../../renderer/composerFocus.ts', () => ({ focusComposerInput: () => true }))

const { ModelSelect, openingPane } = await import('../../renderer/ModelSelect.tsx')
const { ThinkingPane, thinkingLabel } = await import('../../renderer/ThinkingPane.tsx')

const ko = (key: MessageKey, vars?: Record<string, string | number>) => translate('ko', key, vars)
const providers: ProviderSummary[] = [
  {
    id: 'gw',
    displayName: 'Gateway',
    baseURL: 'http://gw/v1',
    protocol: 'openai-chat-completions',
    custom: true,
    hasKey: false,
    models: [
      { id: 'qwen', displayName: 'Qwen3.8 27B', thinking: true },
      { id: 'glm', displayName: 'GLM-5.2' },
    ],
  },
]
const ref = (modelId: string): ModelRef => ({ providerId: 'gw', modelId })
const qwen = (thinking: Thinking) => ref(engineModelId({ id: 'qwen' }, thinking))

/** 열림·패널을 정해 그린 정적 마크업 */
function markup(value: ModelRef, open?: { pane: string }): string {
  overrides = open ? [true, open.pane] : []
  return renderToStaticMarkup(createElement(ModelSelect, { providers, value, onChange: () => {} }))
}

/** 요소 트리에서 맞는 첫 요소 (컴포넌트 요소는 펼치지 않는다) */
function find(node: ReactNode, match: (element: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, match)
      if (found) return found
    }
    return undefined
  }
  if (!isValidElement<Record<string, unknown>>(node)) return undefined
  if (match(node)) return node
  return find(node.props.children as ReactNode, match)
}

beforeEach(() => {
  overrides = []
})

describe('thinkingLabel', () => {
  it('세 값의 글자 (ko·en)', () => {
    const t = (key: MessageKey) => ko(key)
    expect((['default', 'on', 'off'] as const).map((value) => thinkingLabel(t, value))).toEqual(['디폴트', '켬', '끔'])
    expect((['default', 'on', 'off'] as const).map((value) => thinkingLabel((key) => translate('en', key), value))).toEqual(['Default', 'On', 'Off'])
  })
})

describe('openingPane — 루트 패널은 Thinking 모델을 고른 동안만', () => {
  it('Thinking 모델이면 세 키 모두 루트, 미선언 모델·못 찾는 선택은 모델 목록', () => {
    for (const thinking of ['default', 'on', 'off'] as const) expect(openingPane(findModel(providers, qwen(thinking)))).toBe('root')
    expect(openingPane(findModel(providers, ref('glm')))).toBe('model')
    expect(openingPane(findModel(providers, ref('gone')))).toBe('model')
  })
})

describe('ModelSelect — 닫힌 칩', () => {
  it('Thinking 모델은 이름 뒤에 연한 값 글자 · 디폴트/켬/끔, 접근성 이름에도 값', () => {
    for (const [thinking, word] of [['default', '디폴트'], ['on', '켬'], ['off', '끔']] as const) {
      const html = markup(qwen(thinking))
      expect(html).toContain('<span class="composer__model">Qwen3.8 27B</span><span class="model-select__thinking">· ' + word + '</span>')
      expect(html).toContain(`aria-label="${ko('model.labelThinking', { name: 'Qwen3.8 27B', value: word })}"`)
      expect(html).not.toContain('role="menu"')
    }
  })

  it('미선언 모델은 지금처럼 이름만', () => {
    const html = markup(ref('glm'))
    expect(html).toContain('<span class="composer__model">GLM-5.2</span>')
    expect(html).not.toContain('model-select__thinking')
    expect(html).toContain(`aria-label="${ko('model.label', { name: 'GLM-5.2' })}"`)
  })
})

describe('ModelSelect — 열린 메뉴', () => {
  it('루트 패널: Model·Thinking 두 줄(menuitem) — 라벨, 지금 값, ›', () => {
    const html = markup(qwen('off'), { pane: 'root' })
    const cells = [...html.matchAll(/<button [^>]*role="menuitem"[^>]*>(.*?)<\/button>/g)].map((match) => match[1])
    expect(cells).toEqual([
      '<span class="model-menu__cell-label">Model</span><span class="model-menu__cell-value">Qwen3.8 27B</span><span class="model-menu__cell-chevron" aria-hidden="true">›</span>',
      '<span class="model-menu__cell-label">Thinking</span><span class="model-menu__cell-value">끔</span><span class="model-menu__cell-chevron" aria-hidden="true">›</span>',
    ])
    expect(html).not.toContain('menuitemradio')
  })

  it('미선언 모델은 루트 패널을 그리지 않는다 (모델 목록만)', () => {
    expect(markup(ref('glm'), { pane: 'root' })).not.toContain('role="menuitem"')
    const list = markup(ref('glm'), { pane: 'model' })
    expect(list).not.toContain('role="menuitem"')
    expect([...list.matchAll(/role="menuitemradio"[^>]*aria-checked="(true|false)"[^>]*>([^<]*)</g)].map((match) => [match[2], match[1]])).toEqual([
      ['Qwen3.8 27B', 'false'],
      ['GLM-5.2', 'true'],
    ])
  })

  it('모델 목록의 체크는 항목 단위 — Thinking 켬·끔 키도 그 모델 줄, 줄은 항목당 하나', () => {
    const list = markup(qwen('on'), { pane: 'model' })
    expect([...list.matchAll(/role="menuitemradio"[^>]*aria-checked="(true|false)"[^>]*>([^<]*)</g)].map((match) => [match[2], match[1]])).toEqual([
      ['Qwen3.8 27B', 'true'],
      ['GLM-5.2', 'false'],
    ])
  })

  it('Thinking 패널: 머리줄 ‹ Thinking, 세 줄(제목 + 시안 설명), 지금 값에 체크', () => {
    const html = markup(qwen('on'), { pane: 'thinking' })
    expect(html).toMatch(/<button type="button" class="model-menu__back"[^>]*><span aria-hidden="true">‹<\/span>Thinking<\/button>/)
    const options = [...html.matchAll(/role="menuitemradio"[^>]*aria-checked="(true|false)"[^>]*><span class="model-menu__option"><span class="model-menu__option-title">([^<]*)<\/span><span class="model-menu__option-hint">([^<]*)</g)].map(
      (match) => [match[2], match[3], match[1]],
    )
    expect(options).toEqual([
      ['디폴트', '아무 값도 보내지 않습니다. 서버 설정을 따릅니다.', 'false'],
      ['켬', '답하기 전에 충분히 생각하도록 켜서 보냅니다.', 'true'],
      ['끔', '생각을 건너뛰도록 꺼서 보냅니다. 더 빠르지만 어려운 작업은 정확도가 내려갈 수 있습니다.', 'false'],
    ])
  })
})

describe('ModelSelect — 고르기', () => {
  /** 열림·패널을 정하고 함수로 불러 나온 요소 트리 */
  function tree(value: ModelRef, pane: string, onChange: (next: ModelRef) => void): ReactNode {
    overrides = [true, pane]
    return (ModelSelect as (props: unknown) => ReactNode)({ providers, value, onChange })
  }

  it('Thinking 패널에서 고르면 선택 모델의 키만 바꿔 onChange(chooseModel) — 같은 값이면 부르지 않는다', () => {
    for (const [from, to] of [['default', 'off'], ['off', 'on'], ['on', 'default']] as const) {
      const onChange = vi.fn()
      const pane = find(tree(qwen(from), 'thinking', onChange), (element) => element.type === ThinkingPane)
      ;(pane!.props.onPick as (next: Thinking) => void)(to)
      expect(onChange.mock.calls).toEqual([[qwen(to)]])
    }
    const same = vi.fn()
    const pane = find(tree(qwen('on'), 'thinking', same), (element) => element.type === ThinkingPane)
    ;(pane!.props.onPick as (next: Thinking) => void)('on')
    expect(same).not.toHaveBeenCalled()
  })

  it('ThinkingPane 의 줄을 누르면 그 값으로 onPick', () => {
    const onPick = vi.fn()
    const rows = (ThinkingPane as (props: unknown) => ReactNode)({ t: (key: MessageKey) => ko(key), value: 'default', onBack: () => {}, onPick })
    const off = find(rows, (element) => element.props.role === 'menuitemradio' && element.key === 'off')
    ;(off!.props.onClick as () => void)()
    expect(onPick).toHaveBeenCalledWith('off')
  })

  it('다른 모델을 고르면 그 모델의 디폴트 키로 시작한다 — 같은 모델이면 키(Thinking 값)를 그대로 둔다', () => {
    const onChange = vi.fn()
    const row = (value: ModelRef, name: string) =>
      find(tree(value, 'model', onChange), (element) => element.props.role === 'menuitemradio' && element.props.children === name)
    ;(row(ref('glm'), 'Qwen3.8 27B')!.props.onClick as () => void)()
    expect(onChange.mock.calls).toEqual([[ref('qwen')]])
    onChange.mockClear()
    ;(row(qwen('off'), 'Qwen3.8 27B')!.props.onClick as () => void)()
    expect(onChange).not.toHaveBeenCalled()
    ;(row(qwen('off'), 'GLM-5.2')!.props.onClick as () => void)()
    expect(onChange.mock.calls).toEqual([[ref('glm')]])
  })
})
