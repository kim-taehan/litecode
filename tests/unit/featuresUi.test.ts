import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { translate, type MessageKey } from '../../shared/i18n/index.ts'
import { ko } from '../../shared/i18n/ko.ts'
import { en } from '../../shared/i18n/en.ts'
import { CHOOSABLE_FEATURES, FEATURE_FIXED, FEATURE_GROUPS, FEATURE_REQUIRES, MOBILE_PATH_FEATURES, type FeatureId, type FeatureStatuses, type FeatureSwitches } from '../../shared/features.ts'
import { FeaturesPage } from '../../renderer/FeaturesSettings.tsx'
import { ALWAYS_ON_FEATURES } from '../../renderer/featuresView.ts'

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

function render(features: FeatureSwitches = {}, initialExpanded: FeatureId | undefined = undefined, statuses: FeatureStatuses = {}, initialQuery = ''): string {
  store.features = features
  store.statuses = statuses
  return renderToStaticMarkup(createElement(FeaturesPage, { initialExpanded, initialQuery }))
}

// 설정 > 기능에 카드가 있는 기능 — 모바일 연결의 길(사내망·블루투스)은 설정 > 모바일 에만 있다
const CARDS = CHOOSABLE_FEATURES.filter((feature) => !MOBILE_PATH_FEATURES.includes(feature))

const count = (html: string, needle: string): number => html.split(needle).length - 1

/** 줄의 펼침 버튼 (항상 켜짐 소묶음의 펼침 버튼은 세지 않는다) */
const ROW_CLOSED = 'class="feature-row__toggle" aria-expanded="false"'
const ROW_OPEN = 'class="feature-row__toggle" aria-expanded="true"'

describe('FeaturesPage — 접힌 첫 그림', () => {
  it('고르는 기능마다 한 줄: 펼침 버튼(aria-expanded=false) + 이름 + 한 줄 요약 + 스위치', () => {
    const html = render()
    expect(count(html, 'role="switch"')).toBe(CARDS.length)
    expect(count(html, ROW_CLOSED)).toBe(CARDS.length) // 항상 켜짐 줄은 접힌 묶음 안이라 없다
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
    const html = render({}, 'terminal')
    expect(count(html, ROW_OPEN)).toBe(1) // 한 번에 펼칠 수 있는 줄은 하나 (#251)
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

// 이슈 #277 — 항상 켜짐 줄·찾기 (보고서 _workspace/report-plugins/builtin-plugins.html 4절). 앱 전체/대화마다 큰 묶음·모드 표는 #281 에서 없앴다
/** 항상 켜짐 소묶음 머리의 펼침 버튼 */
const headToggle = (open: boolean, disabled = false): string =>
  `class="feature-scope__toggle" aria-expanded="${open}"${disabled ? ' disabled=""' : ''}>`

describe('FeaturesPage — 묶음 (#281 큰 묶음 없음)', () => {
  it('앱 전체/대화마다 큰 묶음과 모드 줄이 없다', () => {
    const html = render()
    expect(html).not.toContain('data-feature-scope=')
    expect(html).not.toContain('앱 전체 (Global)')
    expect(html).not.toContain('대화마다 (Session)')
    expect(html).not.toContain('data-mode=')
    expect(html).not.toContain('<table')
  })

  it('네 소묶음이 평평하게 놓이고 맨 아래에 접힌 "항상 켜짐" 소묶음 — 고르는 줄은 전부 그 위', () => {
    const html = render()
    const order = [...FEATURE_GROUPS.map((group) => group.id), 'alwaysOn'].map((id) => html.indexOf(`data-feature-group="${id}"`))
    expect(order.every((at) => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    const alwaysOnAt = html.indexOf('data-feature-group="alwaysOn"')
    for (const feature of CARDS) expect(html.indexOf(`data-feature="${feature}"`)).toBeLessThan(alwaysOnAt)
    const alwaysOn = html.slice(alwaysOnAt)
    expect(count(html, 'class="feature-scope__toggle"')).toBe(1) // 접기 버튼은 항상 켜짐 하나뿐
    expect(alwaysOn).toContain(headToggle(false))
    expect(alwaysOn).toContain('>항상 켜짐<')
    expect(alwaysOn).not.toContain('data-always-on') // 접혀 있다
  })
})

describe('FeaturesPage — 항상 켜짐 (필수 기능 읽기 전용)', () => {
  it('늘 켜진 기능은 FEATURE_FIXED 의 여섯', () => {
    expect([...ALWAYS_ON_FEATURES].sort()).toEqual(Object.keys(FEATURE_FIXED).sort())
    expect(ALWAYS_ON_FEATURES).toHaveLength(6)
  })

  it('펼치면 여섯 줄 — 이름·한 줄 요약·"항상 켜짐" 알약, 스위치는 없다', () => {
    const html = render({}, 'at')
    const alwaysOn = html.slice(html.indexOf('data-feature-group="alwaysOn"'))
    expect(alwaysOn).toContain(headToggle(true))
    expect(count(alwaysOn, 'data-always-on=""')).toBe(6)
    for (const feature of ALWAYS_ON_FEATURES) {
      expect(alwaysOn).toContain(`data-feature="${feature}"`)
      expect(alwaysOn).toContain(translate('ko', `feature.${feature}` as MessageKey))
      expect(alwaysOn).toContain(translate('ko', `feature.${feature}.description` as MessageKey))
    }
    expect(count(alwaysOn, 'class="feature-row__status feature-row__status--fixed">항상 켜짐<')).toBe(6)
    expect(alwaysOn).not.toContain('role="switch"')
    expect(count(html, 'role="switch"')).toBe(CARDS.length) // 스위치는 고르는 기능에만
  })

  it('항상 켜짐 줄을 펼치면 자세한 설명·필요·쓰는 곳 — 기본값 칩은 없다', () => {
    const html = render({}, 'bang')
    const bang = html.slice(html.indexOf('data-feature="bang"'), html.indexOf('data-feature="shell"'))
    expect(bang).toContain('class="feature-row__toggle" aria-expanded="true"')
    expect(bang).toContain('>필요: !명령 실행<')
    expect(bang).toContain(`>${translate('ko', 'feature.bang.where')}<`)
    expect(bang).not.toContain('기본값:')
  })
})

describe('FeaturesPage — 찾기', () => {
  it('찾기 칸은 맨 위, 기능 찾기 문구를 단다', () => {
    const html = render()
    expect(html).toContain('aria-label="기능 찾기"')
    expect(html).toContain('placeholder="기능 이름·설명 찾기"')
    expect(html.indexOf('session-search__input')).toBeLessThan(html.indexOf('data-feature-group='))
  })

  it('찾는 동안은 접힌 "항상 켜짐" 도 펼쳐지고 일치하는 줄만 보인다 — 일치 없는 소묶음 제목은 숨긴다 (앞뒤 공백 무시)', () => {
    const html = render({}, undefined, {}, '  명령 ')
    expect(html).toContain(headToggle(true, true))
    const shown = [...html.matchAll(/data-feature="(\w+)"/g)].map((match) => match[1]).sort()
    expect(shown).toEqual(['bang', 'hooks', 'shell', 'slash'])
    expect(html).not.toContain('data-mode=')
    expect(html).toContain('data-feature-group="automation"')
    expect(html).toContain('data-feature-group="alwaysOn"')
    for (const hidden of ['screen', 'ai', 'devices']) expect(html).not.toContain(`data-feature-group="${hidden}"`)
    expect(html).not.toContain('일치하는 기능이 없습니다.')
  })

  it('대소문자를 가리지 않는다 — mcp 는 MCP 가 든 줄을 찾는다', () => {
    const html = render({}, undefined, {}, 'mcp')
    const shown = [...html.matchAll(/data-feature="(\w+)"/g)].map((match) => match[1]).sort()
    expect(shown).toEqual(['appMcp', 'browser', 'mcp'].filter((feature) => translate('ko', `feature.${feature}` as MessageKey).includes('MCP') || translate('ko', `feature.${feature}.description` as MessageKey).includes('MCP')).sort())
    expect(shown).toContain('mcp')
  })

  it('하나도 없으면 "일치하는 기능이 없습니다." 한 줄만', () => {
    const html = render({}, undefined, {}, 'zzzz')
    expect(html).toContain('>일치하는 기능이 없습니다.<')
    expect(html).not.toContain('data-feature-group=')
    expect(html).not.toContain('data-feature=')
  })

  it('빈 찾기(공백만)는 거르지 않는다 — 처음 그림과 같다', () => {
    const list = (html: string): string => html.slice(html.indexOf('<section')) // 찾기 칸(글·지우기 버튼) 아래의 목록만
    expect(list(render({}, undefined, {}, '   '))).toBe(list(render()))
  })
})

describe('기능 화면 문구 (#277)', () => {
  it('늘 켜진 기능마다 이름·한 줄 요약·자세한 설명·쓰는 곳이 ko/en 둘 다 있다 — 요약은 한 줄', () => {
    for (const feature of ALWAYS_ON_FEATURES) {
      for (const suffix of ['', '.description', '.detail', '.where']) {
        const key = `feature.${feature}${suffix}`
        expect([key, key in ko && (ko as Record<string, string>)[key].length > 0]).toEqual([key, true])
        expect([key, key in en && (en as Record<string, string>)[key].length > 0]).toEqual([key, true])
      }
      for (const dict of [ko, en] as Record<string, string>[]) expect(dict[`feature.${feature}.description`]).not.toContain('\n')
    }
  })
})
