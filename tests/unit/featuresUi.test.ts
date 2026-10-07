import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { translate, type MessageKey } from '../../shared/i18n/index.ts'
import { ko } from '../../shared/i18n/ko.ts'
import { en } from '../../shared/i18n/en.ts'
import { CHOOSABLE_FEATURES, FEATURE_REQUIRES, type FeatureId, type FeatureSwitches } from '../../shared/features.ts'
import { FeaturesPage } from '../../renderer/FeaturesSettings.tsx'

// 설정 > 기능 — 한 줄에 기능 하나, 줄을 누르면 아래로 자세한 설명 (시안 _workspace/mock-features Main·Detail).
// 저장된 기능 값은 테스트마다 바꿔 끼운다 (settingsStore 목킹 — reportUi.test.ts 방식)
const store = vi.hoisted(() => ({ features: {} as FeatureSwitches }))
vi.mock('../../renderer/settingsStore.ts', () => ({
  useT: () => (key: MessageKey, vars?: Record<string, string | number>) => translate('ko', key, vars),
  useSettings: () => ({ features: store.features }),
  updateSettings: async () => undefined,
}))

function render(features: FeatureSwitches = {}, initialExpanded: readonly FeatureId[] = []): string {
  store.features = features
  return renderToStaticMarkup(createElement(FeaturesPage, { initialExpanded }))
}

const count = (html: string, needle: string): number => html.split(needle).length - 1

describe('FeaturesPage — 접힌 첫 그림', () => {
  it('고르는 기능마다 한 줄: 펼침 버튼(aria-expanded=false) + 이름 + 한 줄 요약 + 스위치', () => {
    const html = render()
    expect(count(html, 'role="switch"')).toBe(CHOOSABLE_FEATURES.length)
    expect(count(html, 'aria-expanded="false"')).toBe(CHOOSABLE_FEATURES.length)
    expect(html).not.toContain('aria-expanded="true"')
    for (const feature of CHOOSABLE_FEATURES) {
      expect(html).toContain(`data-feature="${feature}"`)
      expect(html).toContain(translate('ko', `feature.${feature}` as MessageKey))
      expect(html).toContain(translate('ko', `feature.${feature}.description` as MessageKey))
    }
    expect(html).not.toContain('feature-card') // 2열 카드는 없앴다
    expect(html).not.toContain('feature-row__detail') // 접힌 줄엔 자세한 설명이 없다
  })

  it('스위치는 펼침 버튼 밖의 따로 눌리는 요소이고 이름을 단다', () => {
    const html = render()
    const row = html.slice(html.indexOf('data-feature="terminal"'))
    const toggle = row.slice(0, row.indexOf('role="switch"'))
    expect(count(toggle, '</button>')).toBe(1) // 스위치 앞에서 펼침 버튼이 닫혔다 — 버튼 안에 버튼이 없다
    expect(html).toContain('aria-label="터미널 칸"')
  })

  it('필요한 기능이 꺼진 기능의 스위치는 꺼져 보인다 (모바일 연결이 꺼져 있으면 사내망 연결도 꺼짐)', () => {
    const html = render({ remote: false })
    const lan = html.slice(html.indexOf('data-feature="lan"'))
    expect(lan.slice(lan.indexOf('role="switch"') - 200, lan.indexOf('role="switch"') + 200)).toContain('aria-checked="false"')
  })
})

describe('FeaturesPage — 펼친 그림', () => {
  it('펼친 줄은 aria-expanded=true 이고 자세한 설명·불릿·칩(필요·기본값·쓰는 곳)을 보인다', () => {
    const html = render({ remote: true }, ['bluetooth'])
    expect(count(html, 'aria-expanded="true"')).toBe(1)
    expect(count(html, 'aria-expanded="false"')).toBe(CHOOSABLE_FEATURES.length - 1)
    const [paragraph, ...bullets] = translate('ko', 'feature.bluetooth.detail').split('\n')
    expect(html).toContain(paragraph)
    expect(bullets.length).toBeGreaterThan(0)
    for (const bullet of bullets) expect(html).toContain(`<li>${bullet}</li>`)
    expect(html).toContain('>필요: 모바일 연결<')
    expect(html).toContain('>기본값: 꺼짐<')
    expect(html).toContain(`>${translate('ko', 'feature.bluetooth.where').replaceAll('>', '&gt;')}<`)
  })

  it('필요한 기능이 꺼져 있으면 칩에 (꺼짐) 을 붙인다', () => {
    const html = render({}, ['lan'])
    expect(html).toContain('>필요: 모바일 연결 (꺼짐)<')
    expect(html).toContain('>기본값: 켜짐<')
  })

  it('필요한 기능이 없는 기능엔 필요 칩이 없다, 여러 줄을 함께 펼칠 수 있다', () => {
    const html = render({}, ['terminal', 'browser'])
    expect(count(html, 'aria-expanded="true"')).toBe(2)
    const terminal = html.slice(html.indexOf('data-feature="terminal"'), html.indexOf('data-feature="trajectory"'))
    expect(terminal).not.toContain('필요:')
    expect(terminal).toContain('>기본값: 켜짐<')
    const browser = html.slice(html.indexOf('data-feature="browser"'))
    expect(browser).toContain('>필요: MCP<') // MCP 는 고정(늘 켜짐)
  })
})

describe('기능 문구', () => {
  it('고르는 기능마다 이름·한 줄 요약·자세한 설명·쓰는 곳이 ko/en 둘 다 있다', () => {
    for (const feature of CHOOSABLE_FEATURES) {
      for (const suffix of ['', '.description', '.detail', '.where']) {
        const key = `feature.${feature}${suffix}`
        expect([key, key in ko && (ko as Record<string, string>)[key].length > 0]).toEqual([key, true])
        expect([key, key in en && (en as Record<string, string>)[key].length > 0]).toEqual([key, true])
      }
    }
  })

  it('필요 칩에 들어가는 기능(고정된 MCP 포함)도 이름이 있다', () => {
    for (const feature of CHOOSABLE_FEATURES) {
      for (const needed of FEATURE_REQUIRES[feature] ?? []) {
        expect([needed, `feature.${needed}` in ko, `feature.${needed}` in en]).toEqual([needed, true, true])
      }
    }
  })

  it('한 줄 요약은 줄바꿈이 없고, 자세한 설명은 요약보다 길다', () => {
    for (const dict of [ko, en] as Record<string, string>[]) {
      for (const feature of CHOOSABLE_FEATURES) {
        expect(dict[`feature.${feature}.description`]).not.toContain('\n')
        expect(dict[`feature.${feature}.detail`].length).toBeGreaterThan(dict[`feature.${feature}.description`].length)
      }
    }
  })
})
