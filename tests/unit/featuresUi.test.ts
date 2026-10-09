import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { translate, type MessageKey } from '../../shared/i18n/index.ts'
import { ko } from '../../shared/i18n/ko.ts'
import { en } from '../../shared/i18n/en.ts'
import { CHOOSABLE_FEATURES, FEATURE_REQUIRES, MOBILE_PATH_FEATURES, type FeatureId, type FeatureStatuses, type FeatureSwitches } from '../../shared/features.ts'
import { FeaturesPage } from '../../renderer/FeaturesSettings.tsx'

// 설정 > 기능 — 한 줄에 기능 하나, 줄을 누르면 아래로 자세한 설명 (시안 _workspace/mock-features Main·Detail).
// 저장된 기능 값은 테스트마다 바꿔 끼운다 (settingsStore 목킹 — reportUi.test.ts 방식)
const store = vi.hoisted(() => ({ features: {} as FeatureSwitches, statuses: {} as FeatureStatuses }))
vi.mock('../../renderer/settingsStore.ts', () => ({
  useT: () => (key: MessageKey, vars?: Record<string, string | number>) => translate('ko', key, vars),
  useSettings: () => ({ features: store.features }),
  updateSettings: async () => undefined,
}))
// 기능 상태(이슈 #224)는 메인(ctx.features)이 밀어 준다 — 테스트마다 바꿔 끼운다
vi.mock('../../renderer/featuresStore.ts', () => ({
  useFeatureStatuses: () => store.statuses,
}))

function render(features: FeatureSwitches = {}, initialExpanded: FeatureId | undefined = undefined, statuses: FeatureStatuses = {}): string {
  store.features = features
  store.statuses = statuses
  return renderToStaticMarkup(createElement(FeaturesPage, { initialExpanded }))
}

// 설정 > 기능에 카드가 있는 기능 — 모바일 연결의 길(사내망·블루투스)은 설정 > 모바일 에만 있다
const CARDS = CHOOSABLE_FEATURES.filter((feature) => !MOBILE_PATH_FEATURES.includes(feature))

const count = (html: string, needle: string): number => html.split(needle).length - 1

describe('FeaturesPage — 접힌 첫 그림', () => {
  it('고르는 기능마다 한 줄: 펼침 버튼(aria-expanded=false) + 이름 + 한 줄 요약 + 스위치', () => {
    const html = render()
    expect(count(html, 'role="switch"')).toBe(CARDS.length)
    expect(count(html, 'aria-expanded="false"')).toBe(CARDS.length)
    expect(html).not.toContain('aria-expanded="true"')
    for (const feature of CARDS) {
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

  it('모바일 연결의 길(사내망·블루투스)은 이 화면에 줄이 없다 — 설정 > 모바일 에서만 켜고 끈다', () => {
    const html = render({ remote: true })
    for (const feature of MOBILE_PATH_FEATURES) expect(html).not.toContain(`data-feature="${feature}"`)
  })
})

describe('FeaturesPage — 펼친 그림', () => {
  it('펼친 줄은 aria-expanded=true 이고 자세한 설명·불릿·칩(필요·기본값·쓰는 곳)을 보인다', () => {
    const html = render({}, 'voice')
    expect(count(html, 'aria-expanded="true"')).toBe(1)
    expect(count(html, 'aria-expanded="false"')).toBe(CARDS.length - 1)
    const [paragraph, ...bullets] = translate('ko', 'feature.voice.detail').split('\n')
    expect(html).toContain(paragraph.replaceAll('>', '&gt;'))
    expect(bullets.length).toBeGreaterThan(0)
    for (const bullet of bullets) expect(html).toContain(`<li>${bullet.replaceAll('>', '&gt;')}</li>`)
    expect(html).toContain('>기본값: 꺼짐<')
    expect(html).toContain(`>${translate('ko', 'feature.voice.where').replaceAll('>', '&gt;')}<`)
  })

  it('필요한 기능이 없는 기능엔 필요 칩이 없다', () => {
    const html = render({}, 'terminal')
    expect(count(html, 'aria-expanded="true"')).toBe(1) // 한 번에 펼칠 수 있는 줄은 하나 (#251)
    const terminal = html.slice(html.indexOf('data-feature="terminal"'), html.indexOf('data-feature="trajectory"'))
    expect(terminal).not.toContain('필요:')
    expect(terminal).toContain('>기본값: 켜짐<')
  })

  it('필요한 기능이 있는 기능엔 필요 칩이 있다', () => {
    const html = render({}, 'browser')
    const browser = html.slice(html.indexOf('data-feature="browser"'))
    expect(browser).toContain('>필요: MCP<') // MCP 는 고정(늘 켜짐)
  })
})

// 이슈 #224 — 시안 _workspace/mock-features/Detail 의 줄: 줄 오른쪽 빨간 알약 "켜지 못함", 펼치면 맨 위에 빨간 상자 "켜지 못한 이유 — …"
describe('FeaturesPage — 기능 상태', () => {
  /** 그 기능의 줄 (다음 줄 앞까지) */
  const rowOf = (html: string, feature: FeatureId): string => {
    const start = html.indexOf(`data-feature="${feature}"`)
    const next = html.indexOf('<li class="feature-row"', start)
    return html.slice(start, next < 0 ? undefined : next)
  }

  it('정상 상태(on·mounting·없음)는 태그도 상자도 그리지 않는다', () => {
    const html = render({ voice: true }, 'voice', { terminal: { state: 'on' }, voice: { state: 'mounting' } })
    expect(html).not.toContain('feature-row__status')
    expect(html).not.toContain('feature-row__failure')
    expect(html).not.toContain('켜지 못함')
  })

  it('failed 면 줄 머리(스위치 앞)에 빨간 알약 "켜지 못함" — 접혀 있으면 사유 상자는 없다', () => {
    const html = render({ voice: true }, undefined, { voice: { state: 'failed', reason: 'radio gone' } }) // 접힌 첫 그림
    const row = rowOf(html, 'voice')
    const head = row.slice(0, row.indexOf('role="switch"'))
    expect(head).toContain('class="feature-row__status feature-row__status--failed"')
    expect(head).toContain('>켜지 못함<')
    expect(row).not.toContain('feature-row__failure')
    expect(count(html, 'class="feature-row__status ')).toBe(1) // 다른 줄엔 없다
  })

  it('펼치면 설명 맨 위에 빨간 상자 "켜지 못한 이유 — 사유" (글 사유)', () => {
    const html = render({ voice: true }, 'voice', { voice: { state: 'failed', reason: 'radio gone' } })
    const row = rowOf(html, 'voice')
    const detail = row.slice(row.indexOf('feature-row__detail'))
    expect(detail.indexOf('feature-row__failure')).toBeGreaterThan(-1)
    expect(detail.indexOf('feature-row__failure')).toBeLessThan(detail.indexOf('feature-row__paragraph'))
    expect(detail).toContain('<b>켜지 못한 이유</b> — radio gone')
    expect(detail).toContain('role="alert"')
  })

  it('사유가 문구 키면 번역해 보인다 (키 사유)', () => {
    const html = render({ voice: true }, 'voice', { voice: { state: 'failed', reason: { key: 'remote.bluetooth.unauthorized' } } })
    expect(html).toContain(`<b>켜지 못한 이유</b> — ${translate('ko', 'remote.bluetooth.unauthorized').replaceAll('>', '&gt;')}`)
  })
})

describe('기능 문구', () => {
  it('상태 문구가 ko/en 둘 다 있다', () => {
    for (const key of ['features.status.failed', 'features.status.failedReason', 'features.status.blocked']) {
      expect([key, key in ko, key in en]).toEqual([key, true, true])
    }
  })

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
