import { Context } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LANGUAGE, isBuiltinLanguage, isLanguage, LANGUAGES, translate, type LocaleMessages } from '../../shared/i18n/index.ts'
import { en } from '../../shared/i18n/en.ts'
import { ko } from '../../shared/i18n/ko.ts'
import { setMainLanguage, setMainLocalePack, tr } from '../../src/i18n.ts'
import { checkManifest } from '../../src/services/extensions/manifest.ts'
import { EXTENSION_LIMITS } from '../../src/services/extensions/limits.ts'
import { parseLocaleBundle } from '../../src/services/extensions/locale.ts'
import { inspectZip } from '../../src/services/extensions/zipInspect.ts'
import { ExtensionStore } from '../../src/services/extensions/store.ts'
import { ExtensionsService } from '../../src/services/extensions.ts'
import { SettingsService } from '../../src/services/settings.ts'
import { speechLanguage } from '../../shared/speech.ts'
import type { ExtensionSummary } from '../../shared/extensions.ts'
import { languageOptions, opensAfterInstall } from '../../renderer/extensionsView.ts'
import { menuExtensions } from '../../renderer/TabAddMenu.tsx'
import { makeZip, type ZipItem } from './support/zipWriter.ts'

// 언어 팩 확장 (이슈 #525, 검토 _workspace/05_zh_extension_review.md 접근안 A) — manifest 의 type: 'locale' + locale: { language, label },
// entry 는 JSON 번들. 번들은 { 키: 문자열 } 만 받고(내장 사전에 있는 키만, 문자열만, 길이 상한), 사전은 "내장 + 고른 팩" 병합 — 누락 키는 en 폴백.
// 팩이 삭제·꺼지면 언어 설정이 기본(en)으로 돌아간다. 설치만으로 언어가 바뀌지 않는다(설정 > 일반에서 고를 때 적용)

const APP = '1.0.0'
const LOCALE = { language: 'zh-CN', label: '中文(简体)' }
const localeManifest = { id: 'zh-cn-pack', name: '简体中文', description: '언어 팩', version: '1.0.0', type: 'locale', locale: LOCALE, entry: 'locale.json' }
const panelManifest = { id: 'my-ext', name: '내 확장', description: '한 줄', version: '1.0.0', entry: 'index.html' }

describe('manifest — type·locale (이슈 #525)', () => {
  it('type 을 생략하면 지금과 같은 패널 확장이다 (하위 호환)', () => {
    expect(checkManifest(panelManifest, APP)).toEqual({ manifest: panelManifest, problems: [] })
    expect(checkManifest({ ...panelManifest, type: 'panel' }, APP).problems).toEqual([])
  })

  it('정상 언어 팩 — locale 선언과 JSON entry', () => {
    expect(checkManifest(localeManifest, APP)).toEqual({ manifest: localeManifest, problems: [] })
  })

  it('모르는 type 은 type-invalid', () => {
    expect(checkManifest({ ...panelManifest, type: 'theme' }, APP).problems).toEqual([{ code: 'type-invalid', params: { value: 'theme' } }])
  })

  it('locale 종류인데 locale 선언이 없으면 field-missing, 패널인데 있으면 locale-unexpected', () => {
    const { locale: _locale, ...bare } = localeManifest
    expect(checkManifest(bare, APP).problems).toEqual([{ code: 'field-missing', params: { field: 'locale' } }])
    expect(checkManifest({ ...panelManifest, locale: LOCALE }, APP).problems).toEqual([{ code: 'locale-unexpected', params: {} }])
  })

  it.each(['zh_CN', 'Chinese', 'z', 'zh-', '', 'zh-CN-x-' + 'a'.repeat(40)])('언어 태그 모양이 틀리면 locale-invalid: %s', (language) => {
    expect(checkManifest({ ...localeManifest, locale: { ...LOCALE, language } }, APP).problems).toEqual([
      { code: 'locale-invalid', params: { field: 'locale.language', value: language } },
    ])
  })

  it.each(['ko', 'en', 'KO', 'En'])('내장 언어(%s)와 겹치면 locale-reserved', (language) => {
    expect(checkManifest({ ...localeManifest, locale: { ...LOCALE, language } }, APP).problems).toEqual([{ code: 'locale-reserved', params: { value: language } }])
  })

  it('label 은 비지 않은 짧은 글 — 넘으면 text-invalid(locale.label)', () => {
    const max = EXTENSION_LIMITS.localeLabelLength
    expect(checkManifest({ ...localeManifest, locale: { ...LOCALE, label: 'x'.repeat(max + 1) } }, APP).problems).toEqual([
      { code: 'text-invalid', params: { field: 'locale.label', max } },
    ])
    expect(checkManifest({ ...localeManifest, locale: { ...LOCALE, label: ' ' } }, APP).problems.map((p) => p.code)).toEqual(['text-invalid'])
  })

  it('locale 이 객체가 아니거나 모르는 칸이 있으면 locale-invalid / field-unknown', () => {
    expect(checkManifest({ ...localeManifest, locale: 'zh-CN' }, APP).problems).toEqual([{ code: 'locale-invalid', params: { field: 'locale', value: 'zh-CN' } }])
    expect(checkManifest({ ...localeManifest, locale: { ...LOCALE, base: 'en' } }, APP).problems).toEqual([{ code: 'field-unknown', params: { field: 'locale.base' } }])
  })

  it('언어 팩의 entry 는 .json 이어야 한다', () => {
    expect(checkManifest({ ...localeManifest, entry: 'index.html' }, APP).problems).toEqual([{ code: 'locale-invalid', params: { field: 'entry', value: 'index.html' } }])
  })
})

describe('번들 읽기 — parseLocaleBundle', () => {
  it('내장 사전에 있는 키의 문자열만 남긴다 — 문자열 아닌 값·모르는 키·너무 긴 값은 버린다', () => {
    const text = JSON.stringify({
      'sidebar.newChat': '+ 新对话',
      'sidebar.hide': 3,
      'sidebar.show': null,
      'sidebar.resize': { text: 'x' },
      'no.such.key': '没有',
      'sidebar.conversations': 'x'.repeat(EXTENSION_LIMITS.localeValueLength + 1),
      'sidebar.untitled': '<b>新对话</b>',
    })
    expect(parseLocaleBundle(text)).toEqual({ messages: { 'sidebar.newChat': '+ 新对话', 'sidebar.untitled': '<b>新对话</b>' } })
  })

  it('__proto__·constructor 같은 키로 사전 모양을 바꾸지 못한다', () => {
    const parsed = parseLocaleBundle('{"__proto__": {"sidebar.newChat": "polluted"}, "constructor": "x", "sidebar.hide": "隐藏"}')
    expect(parsed).toEqual({ messages: { 'sidebar.hide': '隐藏' } })
    if (!('messages' in parsed)) throw new Error('messages 없음')
    expect(Object.getPrototypeOf(parsed.messages)).toBe(Object.prototype)
    expect(parsed.messages['sidebar.newChat']).toBeUndefined()
  })

  it('JSON 이 아니거나 객체가 아니면 error', () => {
    for (const text of ['{ not json', '[]', '"x"', 'null']) expect(parseLocaleBundle(text)).toHaveProperty('error')
  })

  it('키 수 상한을 넘으면 error', () => {
    const limit = EXTENSION_LIMITS.localeKeys
    const big = Object.fromEntries(Array.from({ length: limit + 1 }, (_, i) => [`k${i}`, 'v']))
    expect(parseLocaleBundle(JSON.stringify(big))).toEqual({ error: expect.stringContaining(String(limit)) })
  })

  it('상한은 지금 사전이 넉넉히 들어가는 값이다', () => {
    expect(Object.keys(ko).length).toBeLessThan(EXTENSION_LIMITS.localeKeys)
    expect(Buffer.byteLength(JSON.stringify(ko))).toBeLessThan(EXTENSION_LIMITS.localeBytes)
    expect(Math.max(...Object.values(en).map((value) => value.length))).toBeLessThan(EXTENSION_LIMITS.localeValueLength)
  })
})

describe('사전 병합 — translate', () => {
  const pack: LocaleMessages = { 'sidebar.newChat': '+ 新对话', 'sidebar.messageCount': '{count} 条消息' }

  it('내장 ko·en 은 지금과 같다 (팩을 줘도 쓰지 않는다)', () => {
    expect(translate('ko', 'sidebar.newChat')).toBe(ko['sidebar.newChat'])
    expect(translate('en', 'sidebar.newChat')).toBe(en['sidebar.newChat'])
    expect(translate('en', 'sidebar.newChat', undefined, pack)).toBe(en['sidebar.newChat'])
    expect(translate('ko', 'sidebar.messageCount', { count: 3 })).toBe(ko['sidebar.messageCount'].replace('{count}', '3'))
  })

  it('팩 언어는 팩 문구 → 없는 키는 en (ko 가 아니다), {name} 보간 유지', () => {
    expect(translate('zh-CN', 'sidebar.newChat', undefined, pack)).toBe('+ 新对话')
    expect(translate('zh-CN', 'sidebar.messageCount', { count: 3 }, pack)).toBe('3 条消息')
    expect(translate('zh-CN', 'sidebar.hide', undefined, pack)).toBe(en['sidebar.hide'])
  })

  it('팩을 아직 못 읽었거나 없는 언어면 전부 en', () => {
    expect(translate('zh-CN', 'sidebar.newChat')).toBe(en['sidebar.newChat'])
  })

  it('언어 판정 — 내장은 ko·en, 팩 언어는 BCP47 모양', () => {
    expect(LANGUAGES.map((language) => language.id)).toEqual(['ko', 'en'])
    expect(DEFAULT_LANGUAGE).toBe('en')
    expect([isBuiltinLanguage('ko'), isBuiltinLanguage('en'), isBuiltinLanguage('zh-CN')]).toEqual([true, true, false])
    for (const ok of ['ko', 'en', 'zh-CN', 'zh-Hans', 'pt-BR', 'yue']) expect(isLanguage(ok), ok).toBe(true)
    for (const bad of ['', 'zh_CN', 'Chinese', 3, undefined, 'x']) expect(isLanguage(bad), String(bad)).toBe(false)
  })
})

describe('메인 문구 — tr() 병합', () => {
  afterEach(() => {
    setMainLocalePack(undefined)
    setMainLanguage('ko')
  })

  it('팩 언어면 팩 문구, 없는 키는 en', () => {
    setMainLanguage('zh-CN')
    setMainLocalePack({ language: 'zh-CN', messages: { 'error.settingInvalid': '设置值 {name} 无效' } })
    expect(tr('error.settingInvalid', { name: 'x' })).toBe('设置值 x 无效')
    expect(tr('sidebar.hide')).toBe(en['sidebar.hide'])
  })

  it('다른 언어의 팩은 쓰지 않는다 — 언어만 바뀌고 팩이 아직 안 바뀐 사이', () => {
    setMainLocalePack({ language: 'zh-CN', messages: { 'sidebar.hide': '隐藏' } })
    setMainLanguage('ko')
    expect(tr('sidebar.hide')).toBe(ko['sidebar.hide'])
    setMainLanguage('ja')
    expect(tr('sidebar.hide')).toBe(en['sidebar.hide'])
  })
})

describe('받아쓰기 언어 — 팩 언어의 매핑', () => {
  it('zh 계열 화면 언어는 zh, 모르는 언어는 auto, 고른 값이 있으면 그것', () => {
    expect(speechLanguage({ language: 'zh-CN' })).toBe('zh')
    expect(speechLanguage({ language: 'zh-TW' })).toBe('zh')
    expect(speechLanguage({ language: 'fr' })).toBe('auto')
    expect(speechLanguage({ language: 'ko' })).toBe('ko')
    expect(speechLanguage({ language: 'zh-CN', speechLanguage: 'en' })).toBe('en')
  })
})

describe('화면 — 언어 선택지와 + 메뉴', () => {
  const ext = (patch: Partial<ExtensionSummary> & { id: string }): ExtensionSummary => ({ name: patch.id, description: '설명', version: '1.0.0', enabled: true, state: 'on', ...patch })
  const zh = ext({ id: 'zh-cn-pack', type: 'locale', locale: LOCALE })

  it('설정 > 일반 선택지 = 내장 + 켜진 정상 팩 (꺼짐·실패·패널 빼고, 같은 언어는 첫 팩만)', () => {
    const list = [
      ext({ id: 'tetris' }),
      zh,
      ext({ id: 'zh-other', type: 'locale', locale: { language: 'zh-CN', label: '另一个' } }),
      ext({ id: 'ja-pack', type: 'locale', locale: { language: 'ja', label: '日本語' }, enabled: false, state: 'off' }),
      ext({ id: 'fr-pack', type: 'locale', locale: { language: 'fr', label: 'Français' }, state: 'failed' }),
    ]
    expect(languageOptions(list)).toEqual([...LANGUAGES, { id: 'zh-CN', label: '中文(简体)' }])
    expect(languageOptions([])).toEqual([...LANGUAGES])
  })

  it('설치 직후 패널 확장은 탭을 열지만 언어 팩은 아무것도 열지 않는다', () => {
    const preview = (manifest: object) => ({ manifest, files: { count: 2, totalBytes: 10 }, problems: [] }) as unknown as Parameters<typeof opensAfterInstall>[0]
    expect(opensAfterInstall(preview(panelManifest))).toBe(true)
    expect(opensAfterInstall(preview(localeManifest))).toBe(false)
  })

  it('+ 메뉴의 확장 목록에는 언어 팩이 나오지 않는다 (열 것이 없다)', () => {
    expect(menuExtensions([ext({ id: 'tetris' }), zh]).map((item) => item.id)).toEqual(['tetris'])
  })
})

// --- zip·저장소·서비스 ---

let dir: string
let root: string
let settingsFile: string
let zipCount = 0

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-locale-pack-'))
  root = path.join(dir, 'extensions')
  settingsFile = path.join(dir, 'settings.json')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
  setMainLocalePack(undefined)
  setMainLanguage('ko')
})

const BUNDLE = { 'sidebar.newChat': '+ 新对话', 'error.settingInvalid': '设置值 {name} 无效' }
function packItems(patch: Record<string, unknown> = {}, bundle: string = JSON.stringify(BUNDLE)): ZipItem[] {
  return [
    { name: 'extension.json', data: JSON.stringify({ ...localeManifest, ...patch }) },
    { name: String(patch.entry ?? 'locale.json'), data: bundle },
  ]
}

async function zipFile(items: readonly ZipItem[]): Promise<string> {
  const file = path.join(dir, `pack-${zipCount++}.zip`)
  await fs.writeFile(file, makeZip(items))
  return file
}

async function installItems(items: readonly ZipItem[]): Promise<void> {
  const store = new ExtensionStore(root)
  const staged = await store.stage(await zipFile(items), APP)
  expect(staged.result.problems).toEqual([])
  expect(await store.install(staged.token!, APP)).toMatchObject({ ok: true })
  await store.applyPending()
}

async function boot() {
  const ctx = new Context()
  ctx.plugin(SettingsService, { file: settingsFile })
  ctx.plugin(ExtensionsService, { root, appVersion: APP })
  const ready = await new Promise<Context>((resolve) => ctx.inject(['extensions', 'settings'], (injected) => resolve(injected)))
  await ready.extensions.idle()
  return { ext: ready.extensions, settings: ready.settings }
}

describe('zip 검사 — 번들', () => {
  it('정상 팩은 통과', async () => {
    expect((await inspectZip(await zipFile(packItems()), APP)).problems).toEqual([])
  })

  it('번들이 상한보다 크면 locale-too-large', async () => {
    const limits = { ...EXTENSION_LIMITS, localeBytes: 10 }
    expect((await inspectZip(await zipFile(packItems()), APP, limits)).problems).toEqual([
      { code: 'locale-too-large', params: { bytes: Buffer.byteLength(JSON.stringify(BUNDLE)), limit: 10 } },
    ])
  })

  it('번들이 JSON 객체가 아니면 locale-unreadable', async () => {
    expect((await inspectZip(await zipFile(packItems({}, '{ broken')), APP)).problems).toEqual([{ code: 'locale-unreadable', params: { message: expect.any(String) } }])
  })
})

describe('저장소 — readLocale', () => {
  it('설치된 팩의 번들을 걸러 읽는다', async () => {
    await installItems(packItems({}, JSON.stringify({ ...BUNDLE, 'sidebar.hide': 1, 'no.key': 'x' })))
    expect(await new ExtensionStore(root).readLocale('zh-cn-pack', 'locale.json')).toEqual({ ok: true, messages: BUNDLE })
  })

  it('번들이 폴더 밖을 가리키는 심볼릭 링크로 바뀌었으면 entry-unsafe — 밖의 글을 읽지 않는다', async () => {
    await installItems(packItems())
    const outside = path.join(dir, 'secret.json')
    await fs.writeFile(outside, JSON.stringify({ 'sidebar.newChat': 'secret' }))
    const bundle = path.join(root, 'installed', 'zh-cn-pack', 'locale.json')
    await fs.rm(bundle)
    await fs.symlink(outside, bundle)
    expect(await new ExtensionStore(root).readLocale('zh-cn-pack', 'locale.json')).toEqual({ ok: false, failure: { code: 'entry-unsafe', params: { entry: 'locale.json' } } })
  })
})

describe('서비스 — 목록·번들·언어 따라가기', () => {
  it('목록에 type·locale 이 실리고 패널 확장은 그대로(type 키 없음). 설치만으로 언어가 바뀌지 않는다', async () => {
    await installItems(packItems())
    const { ext, settings } = await boot()
    expect(await ext.list()).toEqual([
      { id: 'zh-cn-pack', name: '简体中文', description: '언어 팩', version: '1.0.0', type: 'locale', locale: LOCALE, enabled: true, state: 'on' },
    ])
    expect(settings.get().language).toBe('en')
  })

  it('readLocale(language) — 켜진 팩의 번들. 패널로 읽으려 하면 entry-not-html', async () => {
    await installItems(packItems())
    const { ext } = await boot()
    expect(await ext.readLocale('zh-CN')).toEqual({ ok: true, messages: BUNDLE, version: '1.0.0' })
    expect(await ext.readLocale('ja')).toEqual({ ok: false, failure: { code: 'locale-unavailable', params: { language: 'ja' } } })
    expect(await ext.readEntry('zh-cn-pack')).toMatchObject({ ok: false, failure: { code: 'entry-not-html' } })
  })

  it('팩 언어를 고르면 메인 문구(tr)가 팩을 쓴다 — 재시작 없이', async () => {
    await installItems(packItems())
    const { ext, settings } = await boot()
    settings.set({ language: 'zh-CN' })
    await ext.idle()
    expect(tr('error.settingInvalid', { name: 'x' })).toBe('设置值 x 无效')
    expect(tr('sidebar.hide')).toBe(en['sidebar.hide'])
  })

  it('고른 팩을 끄면 기본 언어(en)로 돌아가고, 꺼진 팩은 readLocale 에서 빠진다', async () => {
    await installItems(packItems())
    const { ext, settings } = await boot()
    settings.set({ language: 'zh-CN' })
    await ext.idle()
    expect(await ext.setEnabled('zh-cn-pack', false)).toEqual({ ok: true })
    await ext.idle()
    expect(settings.get().language).toBe(DEFAULT_LANGUAGE)
    expect(tr('error.settingInvalid', { name: 'x' })).toBe(en['error.settingInvalid'].replace('{name}', 'x'))
    expect(await ext.readLocale('zh-CN')).toMatchObject({ ok: false, failure: { code: 'locale-unavailable' } })
  })

  it('고른 팩을 지우면 기본 언어로 돌아간다', async () => {
    await installItems(packItems())
    const { ext, settings } = await boot()
    settings.set({ language: 'zh-CN' })
    await ext.idle()
    expect(await ext.remove('zh-cn-pack')).toEqual({ ok: true })
    await ext.idle()
    expect(settings.get().language).toBe(DEFAULT_LANGUAGE)
  })

  it('저장된 언어의 팩이 없으면 부팅 때 기본 언어로 — 조용히 깨지지 않는다', async () => {
    await fs.writeFile(settingsFile, JSON.stringify({ language: 'zh-CN' }))
    const { settings } = await boot()
    expect(settings.get().language).toBe(DEFAULT_LANGUAGE)
  })

  it('저장된 팩 언어는 다음 부팅에도 그대로 (팩이 있으면)', async () => {
    await installItems(packItems())
    await fs.writeFile(settingsFile, JSON.stringify({ language: 'zh-CN' }))
    const { settings } = await boot()
    expect(settings.get().language).toBe('zh-CN')
    expect(tr('sidebar.newChat')).toBe('+ 新对话')
  })

  it('설치 폴더의 번들이 깨졌으면 그 팩은 failed — 선택지에 안 나온다', async () => {
    await installItems(packItems())
    await fs.writeFile(path.join(root, 'installed', 'zh-cn-pack', 'locale.json'), '{ broken')
    const { ext } = await boot()
    expect(await ext.list()).toMatchObject([{ id: 'zh-cn-pack', state: 'failed', reason: { code: 'invalid', params: { problems: [{ code: 'locale-unreadable' }] } } }])
  })
})

describe('예제 팩 extensions/zh-cn-pack', () => {
  const folder = new URL('../../extensions/zh-cn-pack/', import.meta.url)

  it('manifest 가 통과하고 번들의 키는 모두 내장 사전에 있는 문자열이다', async () => {
    const manifest = JSON.parse(await fs.readFile(new URL('extension.json', folder), 'utf8')) as Record<string, unknown>
    expect(checkManifest(manifest, '99.0.0').problems).toEqual([])
    expect(manifest).toMatchObject({ type: 'locale', locale: { language: 'zh-CN' }, entry: 'locale.json' })
    expect(String(manifest.details)).toContain('中文(简体)')
    const raw = JSON.parse(await fs.readFile(new URL('locale.json', folder), 'utf8')) as Record<string, unknown>
    const parsed = parseLocaleBundle(JSON.stringify(raw))
    if (!('messages' in parsed)) throw new Error(parsed.error)
    expect(Object.keys(parsed.messages).sort()).toEqual(Object.keys(raw).sort())
    expect(Object.keys(raw).length).toBeGreaterThanOrEqual(80)
  })

  it('번역문의 {변수} 는 영어 원문의 변수와 같다', async () => {
    const raw = JSON.parse(await fs.readFile(new URL('locale.json', folder), 'utf8')) as Record<string, string>
    const vars = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    for (const [key, text] of Object.entries(raw)) expect(vars(text), key).toEqual(vars(en[key as keyof typeof en]))
  })

  it('zip 으로 묶은 것이 그대로 설치 검사를 통과한다', async () => {
    const zip = new URL('../../extensions/zh-cn-pack.zip', import.meta.url)
    expect((await inspectZip(zip.pathname, '99.0.0')).problems).toEqual([])
  })
})
