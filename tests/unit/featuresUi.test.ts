import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { translate, type MessageKey } from '../../shared/i18n/index.ts'
import { ko } from '../../shared/i18n/ko.ts'
import { en } from '../../shared/i18n/en.ts'
import { CHOOSABLE_FEATURES, FEATURE_FIXED, FEATURE_GROUPS, FEATURE_REQUIRES, FEATURE_SCREEN_HIDDEN, type ChoosableFeatureId, type FeatureId, type FeatureStatuses, type FeatureSwitches } from '../../shared/features.ts'
import { FeaturesPage } from '../../renderer/FeaturesSettings.tsx'

// 설정 > 기능 — 한 줄에 기능 하나, 줄을 누르면 아래로 자세한 설명 (시안 _workspace/mock-features Main·Detail).
// 저장된 기능 값은 테스트마다 바꿔 끼운다 (settingsStore 목킹 — reportUi.test.ts 방식)
const store = vi.hoisted(() => ({
  features: {} as FeatureSwitches,
  statuses: {} as FeatureStatuses,
  notifyChannels: undefined as undefined | { system?: boolean; app?: boolean },
}))
vi.mock('../../renderer/settingsStore.ts', () => ({
  useT: () => (key: MessageKey, vars?: Record<string, string | number>) => translate('ko', key, vars),
  useSettings: () => ({ features: store.features, notifyChannels: store.notifyChannels }),
  updateSettings: async () => undefined,
}))
// 기능 상태(이슈 #224)는 메인(ctx.features)이 밀어 준다 — 테스트마다 바꿔 끼운다
vi.mock('../../renderer/featuresStore.ts', () => ({
  useFeatureStatuses: () => store.statuses,
}))

function render(features: FeatureSwitches = {}, initialExpanded: ChoosableFeatureId | undefined = undefined, statuses: FeatureStatuses = {}, initialQuery = '', notifyChannels?: { system?: boolean; app?: boolean }): string {
  store.features = features
  store.statuses = statuses
  store.notifyChannels = notifyChannels
  return renderToStaticMarkup(createElement(FeaturesPage, { initialExpanded, initialQuery }))
}

// 설정 > 기능에 카드가 있는 기능 — 모바일 연결의 길(사내망·블루투스)은 설정 > 모바일 에만, 새 버전 알림(updates)은 잠정 숨김 (FEATURE_SCREEN_HIDDEN)
const CARDS = CHOOSABLE_FEATURES.filter((feature) => !FEATURE_SCREEN_HIDDEN.includes(feature))

const count = (html: string, needle: string): number => html.split(needle).length - 1

/** 줄의 펼침 버튼 */
const ROW_CLOSED = 'class="feature-row__toggle" aria-expanded="false"'
const ROW_OPEN = 'class="feature-row__toggle" aria-expanded="true"'

describe('FeaturesPage — 접힌 첫 그림', () => {
  it('고르는 기능마다 한 줄: 펼침 버튼(aria-expanded=false) + 이름 + 한 줄 요약 + 스위치', () => {
    const html = render()
    expect(count(html, 'role="switch"')).toBe(CARDS.length)
    expect(count(html, ROW_CLOSED)).toBe(CARDS.length)
    expect(html).not.toContain(ROW_OPEN)
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
    const row = html.slice(html.indexOf('data-feature="trajectory"'))
    const toggle = row.slice(0, row.indexOf('role="switch"'))
    expect(count(toggle, '</button>')).toBe(1) // 스위치 앞에서 펼침 버튼이 닫혔다 — 버튼 안에 버튼이 없다
    expect(html).toContain('aria-label="추론 과정"')
  })

  it('카드가 없는 기능(모바일 연결의 길 · 새 버전 알림)은 이 화면에 줄이 없다 — 모바일의 길은 설정 > 모바일 에서만 켜고 끈다', () => {
    const html = render({ remote: true })
    for (const feature of FEATURE_SCREEN_HIDDEN) expect(html).not.toContain(`data-feature="${feature}"`)
  })
})

describe('FeaturesPage — 펼친 그림', () => {
  it('펼친 줄은 aria-expanded=true 이고 자세한 설명·불릿·칩(필요·기본값·쓰는 곳)을 보인다', () => {
    const html = render({}, 'voice')
    expect(count(html, ROW_OPEN)).toBe(1)
    expect(count(html, ROW_CLOSED)).toBe(CARDS.length - 1)
    const [paragraph, ...bullets] = translate('ko', 'feature.voice.detail').split('\n')
    expect(html).toContain(paragraph.replaceAll('>', '&gt;'))
    expect(bullets.length).toBeGreaterThan(0)
    for (const bullet of bullets) expect(html).toContain(`<li>${bullet.replaceAll('>', '&gt;')}</li>`)
    expect(html).toContain('>기본값: 꺼짐<')
    expect(html).toContain(`>${translate('ko', 'feature.voice.where').replaceAll('>', '&gt;')}<`)
  })

  it('필요한 기능이 없는 기능엔 필요 칩이 없다', () => {
    const html = render({}, 'trajectory')
    expect(count(html, ROW_OPEN)).toBe(1) // 한 번에 펼칠 수 있는 줄은 하나 (#251)
    const trajectory = html.slice(html.indexOf('data-feature="trajectory"'), html.indexOf('data-feature="git"'))
    expect(trajectory).not.toContain('필요:')
    expect(trajectory).toContain('>기본값: 켜짐<')
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
    const html = render({ voice: true }, 'voice', { trajectory: { state: 'on' }, voice: { state: 'mounting' } })
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

  it('묶음마다 뱃지 이름이 ko/en 둘 다 있다 (#302)', () => {
    for (const group of FEATURE_GROUPS) {
      const key = `settings.features.group.${group.id}`
      expect([key, key in ko && key in en]).toEqual([key, true])
    }
  })
})

// 이슈 #372 — 알림 줄을 펼치면 외부(PC 알림·dock 배지)·내부(토스트) 채널 스위치가 둘 더 보인다
describe('FeaturesPage — 알림 채널 자 스위치 (#372)', () => {
  const rowOf = (html: string, feature: string): string => {
    const start = html.indexOf(`data-feature="${feature}"`)
    const next = html.indexOf('<li class="feature-row"', start)
    return html.slice(start, next < 0 ? undefined : next)
  }

  it('알림 줄을 펼치면 줄 스위치 + 외부·내부 스위치 3개, 기본 둘 다 켬', () => {
    const html = render({}, 'notifications')
    const row = rowOf(html, 'notifications')
    expect(count(row, 'role="switch"')).toBe(3)
    expect(row).toContain('aria-label="외부 알림"')
    expect(row).toContain('aria-label="내부 알림"')
    expect(count(row, 'aria-checked="true"')).toBe(2) // 채널 둘만 — 알림 기능이 기본 꺼짐이라 줄 스위치는 오프
  })

  it('꺼 둔 채널은 aria-checked=false 로 보인다', () => {
    const html = render({}, 'notifications', {}, '', { system: false })
    const row = rowOf(html, 'notifications')
    expect(row).toContain('aria-checked="false" aria-label="외부 알림"')
    expect(count(row, 'aria-checked="true"')).toBe(1) // 내부만 켜짐
  })
})

// 이슈 #302 — 평평한 한 목록 + 묶음 뱃지, 두 줄 줄, 고정 기능은 줄이 없다 (사용자 "구분하지 말고 뱃지로", "애들은 안 보여도 될 것 같아").
// 찾기는 #277 (보고서 _workspace/report-plugins/builtin-plugins.html 4절). 앱 전체/대화마다 큰 묶음·모드 표는 #281 에서 없앴다
const shownFeatures = (html: string): string[] => [...html.matchAll(/data-feature="(\w+)"/g)].map((match) => match[1])
const groupName = (id: string): string => translate('ko', `settings.features.group.${id}` as MessageKey)
/** 이름·한 줄 요약·뱃지 이름 중 하나에 든 줄 — 화면의 거르기와 같은 규칙 */
const matching = (needle: string): string[] =>
  FEATURE_GROUPS.flatMap((group) =>
    group.features.filter((feature) =>
      [translate('ko', `feature.${feature}` as MessageKey), translate('ko', `feature.${feature}.description` as MessageKey), groupName(group.id)].some((text) =>
        text.toLowerCase().includes(needle.toLowerCase()),
      ),
    ),
  )

describe('FeaturesPage — 평평한 목록 (#302)', () => {
  it('앱 전체/대화마다 큰 묶음과 모드 줄이 없다 (#281)', () => {
    const html = render()
    expect(html).not.toContain('data-feature-scope=')
    expect(html).not.toContain('data-mode=')
    expect(html).not.toContain('<table')
  })

  it('구역 제목·힌트 없이 목록 한 장 — 줄 순서는 묶음 순서를 이어 붙인 것', () => {
    const html = render()
    expect(count(html, '<ul class="feature-rows">')).toBe(1)
    expect(html).not.toContain('data-feature-group=')
    expect(html).not.toContain('feature-group')
    expect(html).not.toContain('<h3')
    expect(shownFeatures(html)).toEqual(FEATURE_GROUPS.flatMap((group) => group.features))
  })

  it('줄마다 두 줄: 첫 줄 = 이름 + 묶음 뱃지(이름 바로 옆), 둘째 줄 = 한 줄 요약', () => {
    const html = render()
    for (const group of FEATURE_GROUPS) {
      for (const feature of group.features) {
        const row = html.slice(html.indexOf(`data-feature="${feature}"`))
        const toggle = row.slice(0, row.indexOf('</button>'))
        expect(toggle).toContain(
          `<span class="feature-row__line"><span class="feature-row__title">${translate('ko', `feature.${feature}` as MessageKey)}</span><span class="feature-row__badge">${groupName(group.id)}</span></span><span class="feature-row__summary">`,
        )
      }
    }
    expect(count(html, 'class="feature-row__badge"')).toBe(CARDS.length)
  })

  it('고정된 필수 기능(훅 포함)은 줄이 없다 — "항상 켜짐" 구역도 없다', () => {
    expect(FEATURE_FIXED.hooks).toBe(true)
    const html = render({ hooks: false }) // 꺼 둔 저장값이 있어도 줄이 생기지 않는다
    for (const feature of Object.keys(FEATURE_FIXED)) expect(html).not.toContain(`data-feature="${feature}"`)
    expect(html).not.toContain('항상 켜짐')
    expect(html).not.toContain('data-always-on')
    expect(html).not.toContain('feature-scope__toggle')
  })
})

describe('FeaturesPage — 찾기', () => {
  it('찾기 칸은 목록 위, 기능 찾기 문구를 단다', () => {
    const html = render()
    expect(html).toContain('aria-label="기능 찾기"')
    expect(html).toContain('placeholder="기능 이름·설명 찾기"')
    expect(html.indexOf('session-search__input')).toBeLessThan(html.indexOf('class="feature-rows"'))
  })

  it('뱃지 이름으로도 찾는다 — "AI 도구" 는 그 묶음 줄을 모두 보인다', () => {
    const html = render({}, undefined, {}, 'AI 도구')
    expect(shownFeatures(html)).toEqual(matching('AI 도구'))
    for (const feature of FEATURE_GROUPS.find((group) => group.id === 'ai')!.features) expect(shownFeatures(html)).toContain(feature)
  })

  it('고정 기능은 찾아도 나오지 않는다 — "입력" 은 "! 입력"(고정) 없이 고르는 줄만 (앞뒤 공백 무시)', () => {
    const html = render({}, undefined, {}, '  입력 ')
    expect(shownFeatures(html)).toEqual(matching('입력'))
    expect(shownFeatures(html)).toContain('voice')
    for (const feature of Object.keys(FEATURE_FIXED)) expect(html).not.toContain(`data-feature="${feature}"`)
  })

  it('대소문자를 가리지 않는다 — mcp 는 MCP 가 든 줄을 찾는다', () => {
    const html = render({}, undefined, {}, 'mcp')
    expect(shownFeatures(html)).toEqual(matching('MCP'))
    expect(shownFeatures(html)).toContain('appMcp')
  })

  it('하나도 없으면 "일치하는 기능이 없습니다." 한 줄만', () => {
    const html = render({}, undefined, {}, 'zzzz')
    expect(html).toContain('>일치하는 기능이 없습니다.<')
    expect(html).not.toContain('class="feature-rows"')
    expect(html).not.toContain('data-feature=')
  })

  it('빈 찾기(공백만)는 거르지 않는다 — 처음 그림과 같다', () => {
    const list = (html: string): string => html.slice(html.indexOf('<ul class="feature-rows"')) // 찾기 칸(글·지우기 버튼) 아래의 목록만
    expect(list(render({}, undefined, {}, '   '))).toBe(list(render()))
  })
})
