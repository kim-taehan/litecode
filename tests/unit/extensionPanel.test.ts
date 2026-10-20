import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { translate, type MessageKey } from '../../shared/i18n/index.ts'
import type { ExtensionSummary } from '../../shared/extensions.ts'
import {
  closeExtensionTabs,
  closeTab,
  extensionFrameKey,
  extensionIdOf,
  extensionTabKey,
  getPanelState,
  isExtensionTab,
  isFileTab,
  openExtensionTab,
  openFilePreview,
  closeFilePreview,
  selectTab,
} from '../../renderer/filePreviewStore.ts'
import { HTML_PREVIEW_CSP } from '../../renderer/htmlPreview.ts'
import { ExtensionTabBody } from '../../renderer/FilePreview.tsx'
import { menuExtensions, TabAddMenu } from '../../renderer/TabAddMenu.tsx'
import { ExtensionCard, ExtensionInstalledNotice } from '../../renderer/ExtensionsSettings.tsx'
import { FeaturesPage } from '../../renderer/FeaturesSettings.tsx'
import { cardKind } from '../../renderer/extensionsView.ts'

// 패널 확장 (이슈 #511, 시안 _workspace/mock-extension-panel Panel·Installed) — 오른쪽 패널의 확장 탭(저장소 규칙), `+` 메뉴의 "확장" 구분,
// 확장 탭 본문의 격리(iframe sandbox), 설정 카드의 [열기]·설치 직후 안내, 옛 보류 UI 가 없어진 것. 클릭·포커스·실제 렌더는 jsdom 이 없어 못 본다 —
// 정적 마크업과 저장소 함수를 직접 부른다

const store = vi.hoisted(() => ({ extensions: [] as ExtensionSummary[] }))
vi.mock('../../renderer/settingsStore.ts', async (original) => ({
  ...(await original<typeof import('../../renderer/settingsStore.ts')>()),
  useT: () => (key: MessageKey, vars?: Record<string, string | number>) => translate('ko', key, vars),
  useSettings: () => ({}),
  updateSettings: async () => undefined,
}))
vi.mock('../../renderer/featuresStore.ts', async (original) => ({
  ...(await original<typeof import('../../renderer/featuresStore.ts')>()),
  useFeatureStatuses: () => ({}),
}))
vi.mock('../../renderer/extensionsStore.ts', () => ({ useExtensions: () => store.extensions }))

const ko = (key: MessageKey, vars?: Record<string, string | number>) => translate('ko', key, vars)
const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element)
const read = getPanelState

const ext = (patch: Partial<ExtensionSummary> & { id: string }): ExtensionSummary => ({ name: `${patch.id} 이름`, description: '설명', version: '1.0.0', enabled: true, state: 'on', ...patch })

describe('확장 탭 — 저장소', () => {
  it('열쇠는 파일·터미널 탭과 겹치지 않고, 비교 보기 후보(파일 탭)가 아니다', () => {
    const key = extensionTabKey('tetris-demo')
    expect(isExtensionTab(key)).toBe(true)
    expect(extensionIdOf(key)).toBe('tetris-demo')
    expect(isExtensionTab('tetris-demo')).toBe(false)
    expect(extensionIdOf('a.ts')).toBeUndefined()
    expect(isFileTab(key)).toBe(false)
  })

  it('같은 확장은 한 탭 — 이미 있으면 그 탭으로. 패널이 닫혀 있으면 연다(파일 칩과 같은 길: open + focus 오름)', () => {
    openFilePreview('/ext', 'a.ts')
    expect(openExtensionTab('/ext', 'tetris-demo')).toBe(true)
    selectTab('a.ts')
    closeFilePreview()
    const focus = read()!.focus
    expect(openExtensionTab('/ext', 'tetris-demo')).toBe(true)
    expect(read()).toMatchObject({ directory: '/ext', open: true, tabs: ['a.ts', extensionTabKey('tetris-demo')], active: extensionTabKey('tetris-demo'), quiet: false })
    expect(read()!.focus).toBe(focus + 1)
  })

  it('프로젝트가 없으면(대화 없음) 열지 못한다 — false', () => {
    expect(openExtensionTab(undefined, 'tetris-demo')).toBe(false)
  })

  it('목록이 바뀌면 꺼졌거나·삭제됐거나·상태가 정상(on)이 아닌 확장의 탭을 닫는다 — 고른 탭이면 이웃으로', () => {
    openFilePreview('/close', 'a.ts')
    for (const id of ['keep-ext', 'off-ext', 'gone-ext', 'failed-ext', 'mount-ext']) openExtensionTab('/close', id)
    closeExtensionTabs([
      ext({ id: 'keep-ext' }),
      ext({ id: 'off-ext', enabled: false, state: 'off' }),
      ext({ id: 'failed-ext', state: 'failed', reason: { code: 'mount-failed', params: { message: 'x' } } }),
      ext({ id: 'mount-ext', state: 'mounting' }),
    ])
    expect(read()).toMatchObject({ tabs: ['a.ts', extensionTabKey('keep-ext')], active: extensionTabKey('keep-ext') })
    // 파일 탭은 건드리지 않는다, 바뀐 것이 없으면 그대로
    const before = read()
    closeExtensionTabs([ext({ id: 'keep-ext' })])
    expect(read()).toBe(before)
    closeTab(extensionTabKey('keep-ext'))
  })

  it('버전이 바뀌면 본문의 재마운트 key 가 바뀐다 (업그레이드 → 새 HTML 로 다시 그림)', () => {
    expect(extensionFrameKey('my-ext', '1.0.0')).toBe(extensionFrameKey('my-ext', '1.0.0'))
    expect(extensionFrameKey('my-ext', '1.0.0')).not.toBe(extensionFrameKey('my-ext', '2.0.0'))
    expect(extensionFrameKey('a-ext', '1.0.0')).not.toBe(extensionFrameKey('b-ext', '1.0.0'))
  })
})

describe('확장 탭 본문 — 기존 HTML 미리보기의 격리 경로', () => {
  it('iframe 은 sandbox 가 정확히 allow-scripts (same-origin 없음), referrer 없음, srcdoc 맨 앞에 CSP', () => {
    const out = html(createElement(ExtensionTabBody, { name: '테트리스', result: { ok: true, html: '<p>게임</p>', version: '0.1.0' } }))
    const sandbox = /<iframe[^>]* sandbox="([^"]*)"/i.exec(out)?.[1]
    expect(sandbox).toBe('allow-scripts')
    expect(out).not.toContain('allow-same-origin')
    expect(out).toMatch(/<iframe[^>]* referrerPolicy="no-referrer"/i)
    expect(out).toContain('class="file-preview__frame"')
    expect(out).toContain(`title="테트리스"`)
    const srcdoc = /srcDoc="([^"]*)"/i.exec(out)?.[1] ?? ''
    expect(srcdoc.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`,
    )
  })

  it('읽기 전이면 불러오는 중, 실패하면 한 줄 오류(role=alert, 기존 미리보기의 빈 상태 모양)', () => {
    expect(html(createElement(ExtensionTabBody, { name: 'x', result: undefined }))).toContain(ko('filePreview.loading'))
    const out = html(createElement(ExtensionTabBody, { name: 'x', result: { ok: false, failure: { code: 'entry-not-html', params: { entry: 'index.js' } } } }))
    expect(out).toContain('class="file-preview__empty"')
    expect(out).toContain('role="alert"')
    expect(out).toContain(ko('extensions.tab.failed', { reason: `${ko('extensions.failure.entry-not-html')} (index.js)` }))
    expect(out).not.toContain('<iframe')
  })
})

describe('`+` 메뉴 — "확장" 구분', () => {
  const menu = (terminal: boolean, extensions: ExtensionSummary[]) =>
    html(createElement(TabAddMenu, { terminal, extensions: menuExtensions(extensions), onFiles() {}, onTerminal() {}, onExtension() {}, initialOpen: true }))

  it('메뉴에는 켜 둔 정상(on) 확장만, id 순', () => {
    expect(menuExtensions([ext({ id: 'b-ext' }), ext({ id: 'off-ext', enabled: false, state: 'off' }), ext({ id: 'a-ext' }), ext({ id: 'm-ext', state: 'mounting' })]).map((item) => item.id)).toEqual([
      'a-ext',
      'b-ext',
    ])
  })

  it('켜 둔 확장이 없으면 지금과 같다 — 파일 목록 / 새 터미널, 구분선·소제목 없음', () => {
    const out = menu(true, [])
    expect(out).toContain(`>${ko('filePreview.addTab')}</button>`)
    expect(out).toContain(`>${ko('terminal.newTerminal')}</button>`)
    expect(out).not.toContain('role="separator"')
    expect(out).not.toContain(ko('filePreview.extensions'))
  })

  it('켜 둔 확장이 있으면 구분선 + 소제목 "확장" 아래에 퍼즐 아이콘 + 이름', () => {
    const out = menu(true, [ext({ id: 'tetris-demo', name: '테트리스 (데모)' })])
    expect(out).toContain('role="separator"')
    expect(out).toContain(`>${ko('filePreview.extensions')}</div>`)
    expect(out).toMatch(/role="menuitem"[^>]*data-extension="tetris-demo"[^>]*>.*<svg.*테트리스 \(데모\)<\/span><\/button>/)
    expect(out.indexOf(ko('terminal.newTerminal'))).toBeLessThan(out.indexOf('테트리스 (데모)'))
  })

  it('터미널이 꺼져 있어도 켜 둔 확장이 있으면 메뉴가 뜬다 (새 터미널 줄은 없다)', () => {
    const out = menu(false, [ext({ id: 'tetris-demo', name: '테트리스 (데모)' })])
    expect(out).toContain('aria-haspopup="menu"')
    expect(out).toContain('role="menu"')
    expect(out).not.toContain(ko('terminal.newTerminal'))
    expect(out).toContain('테트리스 (데모)')
  })

  it('터미널도 확장도 없으면 메뉴 없이 곧바로 파일 목록 (지금과 같다)', () => {
    const out = menu(false, [])
    expect(out).not.toContain('aria-haspopup')
    expect(out).not.toContain('role="menu"')
  })
})

describe('설정 — 설치 직후 안내, [열기] 버튼·옛 보류 UI 없음', () => {
  it('카드에 [열기] 버튼이 없다 — 여는 길은 + 메뉴와 설치 직후 안내', () => {
    const open = '>열기</button>'
    expect(html(createElement(ExtensionCard, { extension: ext({ id: 'on-ext' }) }))).not.toContain(open)
    expect(html(createElement(ExtensionCard, { extension: ext({ id: 'on-ext' }) }))).not.toContain('extension-row__open')
  })

  it('설치 직후 초록 안내 한 줄 — "<이름> 를 설치했습니다." (탭을 자동으로 열지 않는다)', () => {
    const out = html(createElement(ExtensionInstalledNotice, { name: '테트리스 (데모)' }))
    expect(out).toContain('role="status"')
    expect(out).toContain('class="extensions-installed"')
    expect(ko('extensions.installed', { name: '테트리스 (데모)' })).toBe('테트리스 (데모) 를 설치했습니다.')
    expect(out).not.toContain('열렸습니다')
  })

  it('카드 상태는 on·off·mounting·failed 뿐 — 점선·삭제 예정·잠긴 스위치 없음', () => {
    const out = html(createElement(ExtensionCard, { extension: ext({ id: 'on-ext' }) }))
    expect(cardKind(ext({ id: 'on-ext' }))).toBe('on')
    expect(out).not.toContain('pending')
    expect(out).not.toMatch(/role="switch"[^>]*disabled/)
    expect(out).not.toContain('다시 시작')
  })

  it('기능 페이지에 "앱을 다시 시작하면 적용됩니다" 배너가 없다', () => {
    store.extensions = [ext({ id: 'on-ext' })]
    const out = html(createElement(FeaturesPage, {}))
    expect(out).toContain('data-extension="on-ext"')
    expect(out).not.toContain('다시 시작')
    expect(out).not.toContain('extensions-notice')
  })
})
