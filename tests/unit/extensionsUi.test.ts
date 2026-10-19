import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { translate, type MessageKey } from '../../shared/i18n/index.ts'
import type { ExtensionPreview, ExtensionSummary } from '../../shared/extensions.ts'
import { ExtensionCard, ExtensionConfirmDialog, ExtensionRejectDialog, ExtensionsNotice, ExtensionsSection } from '../../renderer/ExtensionsSettings.tsx'
import { FeaturesPage } from '../../renderer/FeaturesSettings.tsx'
import { problemLine } from '../../renderer/extensionsView.ts'

// 설정 > 기능의 확장 (이슈 #489, 시안 _workspace/mock-extension Main·Confirm·Reject) — 구조와 문구만 본다.
// 클릭 동작(토글·메뉴·설치·취소)은 jsdom 이 없어 여기서 못 본다
const store = vi.hoisted(() => ({ extensions: [] as ExtensionSummary[] }))
vi.mock('../../renderer/settingsStore.ts', () => ({
  useT: () => (key: MessageKey, vars?: Record<string, string | number>) => translate('ko', key, vars),
  useSettings: () => ({}),
  updateSettings: async () => undefined,
}))
vi.mock('../../renderer/featuresStore.ts', () => ({ useFeatureStatuses: () => ({}) }))
vi.mock('../../renderer/extensionsStore.ts', () => ({ useExtensions: () => store.extensions }))

const ko = (key: MessageKey, vars?: Record<string, string | number>) => translate('ko', key, vars)
const count = (html: string, needle: string): number => html.split(needle).length - 1
const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element)

const ON: ExtensionSummary = { id: 'code-review', name: '코드 리뷰 도우미', description: 'PR 변경분을 훑습니다', version: '1.2.0', enabled: true, state: 'on' }
const OFF: ExtensionSummary = { ...ON, id: 'off-one', name: '꺼진 확장', enabled: false, state: 'off' }
const FAILED: ExtensionSummary = { ...ON, id: 'log-tool', name: '로그 분석기', state: 'failed', reason: { code: 'mount-failed', params: { message: 'index.js 오류' } } }
const MOUNTING: ExtensionSummary = { ...ON, id: 'slow', name: '느린 확장', state: 'mounting' }
const PENDING_INSTALL: ExtensionSummary = { ...ON, id: 'approval', name: '사내 결재 도구', version: '1.0.0', state: 'off', pending: 'install' }
const PENDING_REMOVE: ExtensionSummary = { ...ON, id: 'old', name: '옛 확장', pending: 'remove' }

const card = (extension: ExtensionSummary, initialInfo = false) => html(createElement(ExtensionCard, { extension, initialInfo }))

describe('ExtensionCard — 다섯 상태', () => {
  it('켜짐: 퍼즐 타일 + 이름 + "확장" 뱃지 + 버전 + 설명 + ⋯ + 켜진 스위치', () => {
    const out = card(ON)
    expect(out).toContain('data-extension="code-review"')
    expect(out).toContain('data-kind="on"')
    expect(out).toContain('class="feature-row__tile extension-row__tile"')
    expect(out).toContain('<svg')
    expect(out).toContain('코드 리뷰 도우미')
    expect(out).toContain(`>${ko('extensions.badge')}</span>`)
    expect(out).toContain('v1.2.0')
    expect(out).toContain('PR 변경분을 훑습니다')
    expect(out).toContain(`aria-label="${ko('extensions.more', { name: '코드 리뷰 도우미' })}"`)
    expect(out).toContain('aria-haspopup="menu"')
    expect(out).toMatch(/role="switch"[^>]*aria-checked="true"/)
    expect(out).not.toMatch(/role="switch"[^>]*disabled/)
  })

  it('꺼짐: 스위치 aria-checked=false, 누를 수 있다', () => {
    const out = card(OFF)
    expect(out).toContain('data-kind="off"')
    expect(out).toMatch(/role="switch"[^>]*aria-checked="false"/)
    expect(out).not.toMatch(/role="switch"[^>]*disabled/)
  })

  it('failed: 설명 자리에 빨간 사유 한 줄 (설명은 안 보인다)', () => {
    const out = card(FAILED)
    expect(out).toContain('data-kind="failed"')
    expect(out).toContain('class="feature-row__summary extension-row__reason"')
    expect(out).toContain('올리지 못함 — index.js 오류')
    expect(out).not.toContain('PR 변경분을 훑습니다')
  })

  it('mounting: 작은 "올리는 중" 표시', () => {
    const out = card(MOUNTING)
    expect(out).toContain('data-kind="mounting"')
    expect(out).toContain(`>${ko('extensions.mounting')}</span>`)
  })

  it('보류 설치: 점선 카드(data-kind) · 스위치 비활성 · "앱을 다시 시작하면 올라옵니다"', () => {
    const out = card(PENDING_INSTALL)
    expect(out).toContain('data-kind="pending-install"')
    expect(out).toContain(ko('extensions.pending.install'))
    expect(out).toMatch(/role="switch"[^>]*disabled=""/)
    expect(out).toContain(`title="${ko('extensions.locked')}"`)
  })

  it('삭제 예정: 스위치 비활성 · "삭제 예정 — 앱을 다시 시작하면 사라집니다"', () => {
    const out = card(PENDING_REMOVE)
    expect(out).toContain('data-kind="pending-remove"')
    expect(out).toContain(ko('extensions.pending.remove'))
    expect(out).toMatch(/role="switch"[^>]*disabled=""/)
  })

  it('이름이 없는(깨진) 확장은 id 를 이름 자리에, 버전 없음', () => {
    const out = card({ id: 'broken-dir', enabled: true, state: 'failed', reason: { code: 'invalid', params: { problems: [problemSample] } } })
    expect(out).toContain('broken-dir')
    expect(out).not.toMatch(/>v\d/)
    expect(out).toContain('설치 폴더가 올바르지 않음 — 진입 파일이 없습니다 (index.js)')
  })

  it('정보 보기 패널: id · 버전 · 설명', () => {
    const out = card(ON, true)
    expect(out).toContain('class="feature-row__detail extension-row__info"')
    expect(out).toContain(`<dt>${ko('extensions.info.id')}</dt><dd><code>code-review</code></dd>`)
    expect(out).toContain(`<dt>${ko('extensions.info.version')}</dt><dd>1.2.0</dd>`)
    expect(out).toContain(`<dt>${ko('extensions.info.description')}</dt><dd>PR 변경분을 훑습니다</dd>`)
  })
})
const problemSample = { code: 'entry-missing' as const, params: { entry: 'index.js' } }

describe('ExtensionsSection — "설치한 확장" 구분선 + 카드들', () => {
  it('없으면 아무것도 그리지 않는다', () => {
    expect(html(createElement(ExtensionsSection, { extensions: [] }))).toBe('')
  })
  it('구분선 + 받은 순서대로 카드', () => {
    const out = html(createElement(ExtensionsSection, { extensions: [ON, FAILED] }))
    expect(out).toContain(ko('extensions.section'))
    expect(out.indexOf('data-extension="code-review"')).toBeLessThan(out.indexOf('data-extension="log-tool"'))
    expect(count(out, 'role="switch"')).toBe(2)
  })
})

describe('ExtensionsNotice — 보류가 있으면 노란 배너(버튼 없음)', () => {
  it('보류가 없으면 없다', () => {
    expect(html(createElement(ExtensionsNotice, { extensions: [ON, FAILED] }))).toBe('')
  })
  it('보류 설치·삭제 중 하나라도 있으면 문구만', () => {
    const out = html(createElement(ExtensionsNotice, { extensions: [ON, PENDING_REMOVE] }))
    expect(out).toContain('class="settings-notice extensions-notice"')
    expect(out).toContain(ko('extensions.notice'))
    expect(out).not.toContain('<button')
  })
})

const preview = (patch: Partial<ExtensionPreview> = {}, manifestPatch: Partial<NonNullable<ExtensionPreview['manifest']>> = {}): ExtensionPreview => ({
  manifest: { id: 'code-review-helper', name: '코드 리뷰 도우미', description: 'PR 을 훑습니다', version: '1.2.0', entry: 'index.js', ...manifestPatch },
  files: { count: 23, totalBytes: 84 * 1024 },
  problems: [],
  token: 'tok',
  ...patch,
})
const confirm = (p: ExtensionPreview) => html(createElement(ExtensionConfirmDialog, { preview: p, onClose: () => {} }))

describe('ExtensionConfirmDialog — 설치 확인', () => {
  it('신규: 제목 · 이름·버전 카드 · id · 파일 · 앱 버전 제한 없음 · 권한 없음 · 이미 설치됨 줄 없음 · 경고 · [취소][설치]', () => {
    const out = confirm(preview())
    expect(out).toContain('role="dialog"')
    expect(out).toContain('aria-modal="true"')
    expect(out).toContain(ko('extensions.confirm.title'))
    expect(out).toContain('코드 리뷰 도우미')
    expect(out).toContain('v1.2.0')
    expect(out).toContain('<code>code-review-helper</code>')
    expect(out).toContain(ko('extensions.confirm.filesValue', { count: 23, size: '84 KB' }))
    expect(out).toContain(ko('extensions.confirm.appAny'))
    expect(out).toContain(ko('extensions.confirm.permissionsNone'))
    expect(out).not.toContain(ko('extensions.confirm.existing'))
    expect(out).toContain('class="settings-notice extension-confirm__warning"')
    expect(out).toContain(`>${ko('extensions.confirm.cancel')}</button>`)
    expect(out).toContain(`>${ko('extensions.confirm.install')}</button>`)
  })

  it('업그레이드: "v1.1.0 → v1.2.0 으로 업그레이드" + [업그레이드 설치]', () => {
    const out = confirm(preview({ existing: { version: '1.1.0' } }))
    expect(out).toContain(ko('extensions.confirm.existing'))
    expect(out).toContain(ko('extensions.confirm.upgrade', { from: '1.1.0', to: '1.2.0' }))
    expect(out).toContain(`>${ko('extensions.confirm.installUpgrade')}</button>`)
  })

  it('같은 버전·이전 버전: [다시 설치]', () => {
    const same = confirm(preview({ existing: { version: '1.2.0' } }))
    expect(same).toContain(ko('extensions.confirm.same', { version: '1.2.0' }))
    expect(same).toContain(`>${ko('extensions.confirm.reinstall')}</button>`)
    const older = confirm(preview({ existing: { version: '2.0.0' } }))
    expect(older).toContain(ko('extensions.confirm.downgrade', { from: '2.0.0', to: '1.2.0' }))
    expect(older).toContain(`>${ko('extensions.confirm.reinstall')}</button>`)
  })

  it('권한·앱 버전이 있으면: 권한 나열 + "0.9.0 이상"', () => {
    const out = confirm(preview({}, { permissions: ['fs.read', 'net'], litecode: '0.9.0' }))
    expect(out).toContain('<code>fs.read</code>')
    expect(out).toContain('<code>net</code>')
    expect(out).not.toContain(ko('extensions.confirm.permissionsNone'))
    expect(out).toContain(ko('extensions.confirm.appAtLeast', { version: '0.9.0' }))
    expect(out).toContain(ko('extensions.confirm.appMet'))
  })
})

describe('ExtensionRejectDialog — 설치 거절', () => {
  const lines = [
    problemLine({ code: 'unsafe-path', params: { path: '../../config/secret.json', reason: 'parent' } }),
    problemLine({ code: 'field-unknown', params: { field: 'permisions', suggestion: 'permissions' } }),
    problemLine({ code: 'zip-unreadable', params: { message: 'end of central directory not found' } }),
  ]
  const out = html(createElement(ExtensionRejectDialog, { lines, onClose: () => {} }))

  it('제목 · "아무것도 설치하지 않았습니다." · [닫기]', () => {
    expect(out).toContain('role="alertdialog"')
    expect(out).toContain(ko('extensions.reject.title'))
    expect(out).toContain(ko('extensions.reject.nothing'))
    expect(out).toContain(`>${ko('extensions.reject.close')}</button>`)
  })

  it('사유마다 한 줄: 굵은 제목 + 고정폭 경로·필드 + 보조 글', () => {
    expect(count(out, 'class="extension-reject__line"')).toBe(3)
    expect(out).toContain(`<b>${ko('extensions.problem.unsafe-path')}</b>`)
    expect(out).toContain('<code>../../config/secret.json</code>')
    expect(out).toContain(ko('extensions.unsafePath.parent'))
    expect(out).toContain('<code>permisions</code>')
    expect(out).toContain('혹시 permissions 인가요?')
    expect(out).toContain('end of central directory not found')
  })
})

describe('FeaturesPage 에 끼운 것', () => {
  it('검색창 옆 "확장 추가 (zip)" 버튼 — 확장이 없으면 구분선·배너 없음', () => {
    store.extensions = []
    const out = html(createElement(FeaturesPage, {}))
    expect(out).toContain(`>${ko('extensions.add')}</button>`)
    expect(out).not.toContain(ko('extensions.section'))
    expect(out).not.toContain(ko('extensions.notice'))
  })

  it('확장이 있으면 기능 카드 아래 구분선 + id 순 카드, 보류가 있으면 배너', () => {
    store.extensions = [PENDING_INSTALL, ON]
    const out = html(createElement(FeaturesPage, {}))
    expect(out).toContain(ko('extensions.notice'))
    expect(out.indexOf('data-feature=')).toBeLessThan(out.indexOf(ko('extensions.section')))
    expect(out.indexOf('data-extension="approval"')).toBeLessThan(out.indexOf('data-extension="code-review"'))
  })

  it('찾기는 확장 이름도 거른다 — 기능이 하나도 안 맞아도 "일치하는 기능이 없습니다" 를 띄우지 않는다', () => {
    store.extensions = [ON, FAILED]
    const out = html(createElement(FeaturesPage, { initialQuery: '로그 분석' }))
    expect(out).not.toContain('data-feature=')
    expect(out).toContain('data-extension="log-tool"')
    expect(out).not.toContain('data-extension="code-review"')
    expect(out).not.toContain(ko('settings.features.noMatch'))
  })

  it('아무것도 안 맞으면 "일치하는 기능이 없습니다"', () => {
    store.extensions = [ON]
    const out = html(createElement(FeaturesPage, { initialQuery: 'zzzz-없는-말' }))
    expect(out).toContain(ko('settings.features.noMatch'))
    expect(out).not.toContain('data-extension=')
  })
})
