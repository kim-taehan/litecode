import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { translate, type MessageKey } from '../../shared/i18n/index.ts'
import type { ModelCatalogEntry, ProviderSummary } from '../../shared/ipc.ts'

// 이슈 #497 (시안 E): 사고 끄기 알약은 그 항목의 thinkingOff 만 켜고 끈다 — #491 처럼 항목을 만들거나 id 를 바꾸지 않는다.
// DOM 없이 클릭을 보려고 useState 의 setter 만 가로채고 ProviderEditor 를 함수로 불러 나온 요소의 onToggle 을 직접 부른다
const setters: ((next: unknown) => void)[] = []
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return {
    ...react,
    useState: (init: unknown) => {
      const setter = vi.fn()
      setters.push(setter)
      return [typeof init === 'function' ? (init as () => unknown)() : init, setter]
    },
  }
})
vi.mock('../../renderer/settingsStore.ts', () => ({
  useT: () => (key: MessageKey, vars?: Record<string, string | number>) => translate('ko', key, vars),
  useSettings: () => ({}),
  updateSettings: async () => undefined,
}))
vi.mock('../../renderer/featuresStore.ts', () => ({ useFeatures: () => ({}) }))

const { ProviderEditor } = await import('../../renderer/Settings.tsx')

/** 요소 트리에서 props 가 맞는 첫 요소 */
function find(node: ReactNode, match: (props: Record<string, unknown>) => boolean): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, match)
      if (found) return found
    }
    return undefined
  }
  if (!isValidElement<Record<string, unknown>>(node)) return undefined
  if (match(node.props)) return node
  return find(node.props.children as ReactNode, match)
}

describe('ProviderEditor — 사고 끄기 알약 (이슈 #497)', () => {
  const models: ModelCatalogEntry[] = [
    { id: 'qwen', displayName: 'Q', contextLength: 32_768 },
    { id: 'llama', displayName: 'L', thinkingOff: true },
  ]
  const provider: ProviderSummary = { id: 'gw', displayName: 'GW', baseURL: 'http://gw/v1', protocol: 'openai-chat-completions', models, custom: true, hasKey: false }

  /** n 번째 카드의 알약을 눌러(on) 모델 목록 setter 에 넘어간 값을 지금 목록에 적용한 결과 */
  function toggle(n: number, on: boolean): ModelCatalogEntry[] {
    setters.length = 0
    const tree = (ProviderEditor as (props: unknown) => ReactNode)({ provider, taken: [provider], onDone: () => {} })
    const label = translate('ko', 'models.thinkingOff', { n })
    const pill = find(tree, (props) => props.ariaLabel === label)
    expect(pill).toBeDefined()
    ;(pill!.props.onToggle as (on: boolean) => void)(on)
    const calls = setters.flatMap((setter) => (setter as ReturnType<typeof vi.fn>).mock.calls.map(([next]) => next))
    expect(calls).toHaveLength(1)
    const next = calls[0]
    return typeof next === 'function' ? (next as (current: ModelCatalogEntry[]) => ModelCatalogEntry[])(models) : (next as ModelCatalogEntry[])
  }

  it('켜면 그 항목에 thinkingOff 만 붙는다 — 항목 수·id·다른 필드 그대로', () => {
    expect(toggle(1, true)).toEqual([
      { id: 'qwen', displayName: 'Q', contextLength: 32_768, thinkingOff: true },
      { id: 'llama', displayName: 'L', thinkingOff: true },
    ])
  })

  it('끄면 그 항목의 thinkingOff 만 빠진다', () => {
    const next = toggle(2, false)
    expect(next).toHaveLength(2)
    expect(next[0]).toEqual(models[0])
    expect(next[1]!.id).toBe('llama')
    expect(next[1]!.thinkingOff).not.toBe(true)
  })
})
