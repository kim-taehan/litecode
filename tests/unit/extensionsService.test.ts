import { Context } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsService } from '../../src/services/settings.ts'
import { ExtensionsService, type ExtensionsOptions } from '../../src/services/extensions.ts'
import { EXTENSION_LIMITS } from '../../src/services/extensions/limits.ts'
import { ExtensionStore } from '../../src/services/extensions/store.ts'
import type { ExtensionSummary } from '../../shared/extensions.ts'
import { makeZip, type ZipItem } from './support/zipWriter.ts'

// ctx.extensions (이슈 #482, 설계 docs/superpowers/specs/2026-10-19-extension-install-design.md 5절) — 부팅 때 보류 적용 → 목록,
// 켜짐 값(settings.extensions), 설치 흐름 위임(pick·install·cancel·remove — 이슈 #511 부터 그 호출 안에서 곧바로 적용), 진입 HTML 읽기(readEntry, #511),
// mount 주입 자리의 올리고 내리기. 재시작은 같은 root·설정 파일로 새 Context 를 띄워 흉내 낸다. 루트·설정 파일은 임시 폴더

const APP = '1.0.0'

/** 한 파일짜리 HTML 패널 확장 (이슈 #511) — 진입 파일의 글은 htmlOf(id, version) */
function zipItems(id: string, version: string, entry = 'index.html'): ZipItem[] {
  return [
    { name: 'extension.json', data: JSON.stringify({ id, name: `${id} 이름`, description: `${id} 설명`, version, entry }) },
    { name: entry, data: htmlOf(id, version) },
  ]
}
const htmlOf = (id: string, version: string) => `<!doctype html><p>${id} ${version} 한글</p>`

let dir: string
let root: string
let settingsFile: string
let zipCount = 0

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-ext-service-'))
  root = path.join(dir, 'extensions')
  settingsFile = path.join(dir, 'settings.json')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function zipFile(items: readonly ZipItem[]): Promise<string> {
  const file = path.join(dir, `pick-${zipCount++}.zip`)
  await fs.writeFile(file, makeZip(items))
  return file
}

/** 앱 한 번 실행 — 설정 + 확장 서비스. events 는 extensions/changed 로 받은 목록들 */
async function boot(options: Partial<ExtensionsOptions> = {}) {
  const ctx = new Context()
  const events: ExtensionSummary[][] = []
  ctx.on('extensions/changed', (list) => void events.push(list))
  ctx.plugin(SettingsService, { file: settingsFile })
  ctx.plugin(ExtensionsService, { root, appVersion: APP, ...options })
  const ready = await new Promise<Context>((resolve) => ctx.inject(['extensions', 'settings'], (injected) => resolve(injected)))
  return { ctx, ext: ready.extensions, settings: ready.settings, events }
}

/** 보류 설치를 저장소로 직접 만든다 (지난 실행의 설치 흉내) */
async function pendInstall(id: string, version: string): Promise<void> {
  const store = new ExtensionStore(root)
  const staged = await store.stage(await zipFile(zipItems(id, version)), APP)
  expect(await store.install(staged.token!, APP)).toMatchObject({ ok: true })
}

/** 항목을 직접 준 보류 설치 → 곧바로 적용 */
async function pendInstallItems(items: readonly ZipItem[]): Promise<void> {
  const store = new ExtensionStore(root)
  const staged = await store.stage(await zipFile(items), APP)
  expect(await store.install(staged.token!, APP)).toMatchObject({ ok: true })
  await store.applyPending()
}

/** 한 실행에 보류 설치 → 다음 실행에 설치됨 */
async function installed(...ids: string[]): Promise<void> {
  for (const id of ids) await pendInstall(id, '1.0.0')
  await new ExtensionStore(root).applyPending()
}

const pick = (file: string | undefined) => async () => file

describe('부팅', () => {
  it('root 가 없으면 빈 목록 — 폴더를 만들지 않는다', async () => {
    const { ext } = await boot()
    expect(await ext.list()).toEqual([])
    expect(await fs.stat(root).catch(() => undefined)).toBeUndefined()
  })

  it('보류 설치·업그레이드·삭제를 확장이 올라오기 전에 적용하고 목록을 읽는다', async () => {
    await installed('old-ext', 'up-ext')
    await pendInstall('up-ext', '2.0.0')
    await pendInstall('new-ext', '1.0.0')
    expect(await new ExtensionStore(root).remove('old-ext')).toEqual({ ok: true })

    const { ext } = await boot()
    expect(await ext.list()).toEqual([
      { id: 'new-ext', name: 'new-ext 이름', description: 'new-ext 설명', version: '1.0.0', enabled: true, state: 'on' },
      { id: 'up-ext', name: 'up-ext 이름', description: 'up-ext 설명', version: '2.0.0', enabled: true, state: 'on' },
    ])
  })

  it('깨진 설치 폴더가 있어도 뜬다 — 그 확장만 폴더 이름 id 로 failed(invalid), 나머지는 정상', async () => {
    await installed('good-ext')
    await fs.mkdir(path.join(root, 'installed', 'broken-ext'), { recursive: true })
    await fs.writeFile(path.join(root, 'installed', 'broken-ext', 'extension.json'), '{ not json')

    const { ext } = await boot()
    const list = await ext.list()
    expect(list.map((item) => [item.id, item.state])).toEqual([
      ['broken-ext', 'failed'],
      ['good-ext', 'on'],
    ])
    expect(list[0]).toMatchObject({ enabled: true, reason: { code: 'invalid', params: { problems: [{ code: 'manifest-invalid' }] } } })
    expect(list[0]!.name).toBeUndefined()
  })

  it('root 가 파일이어도 생성자가 던지지 않는다 — 빈 목록, pick 은 io-failed 로 돌려준다', async () => {
    await fs.writeFile(root, 'not a folder')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ext } = await boot({ pick: pick(await zipFile(zipItems('my-ext', '1.0.0'))) })
    expect(await ext.list()).toEqual([])
    expect(await ext.pick()).toMatchObject({ ok: false, failure: { code: 'io-failed' } })
    warn.mockRestore()
  })

  it('installed 폴더를 읽을 권한이 없어도 뜬다 — 빈 목록', async () => {
    await installed('my-ext')
    await fs.chmod(path.join(root, 'installed'), 0o000)
    try {
      const { ext } = await boot()
      expect(await ext.list()).toEqual([])
    } finally {
      await fs.chmod(path.join(root, 'installed'), 0o755)
    }
  })
})

describe('설치 흐름', () => {
  it('pick → install → 그 호출 안에서 적용된다: 목록에 on·보류 없음, 재시작 없이 readEntry 가 HTML 을 돌려준다', async () => {
    const first = await boot({ pick: pick(await zipFile(zipItems('my-ext', '1.0.0'))) })
    const picked = await first.ext.pick()
    expect(picked).toMatchObject({ ok: true, preview: { manifest: { id: 'my-ext', version: '1.0.0' }, files: { count: 2 }, problems: [] } })
    if (!picked.ok || !picked.preview?.token) throw new Error('token 없음')
    expect(picked.preview.existing).toBeUndefined()

    expect(await first.ext.install(picked.preview.token)).toEqual({ ok: true, id: 'my-ext', version: '1.0.0' })
    const row = { id: 'my-ext', name: 'my-ext 이름', description: 'my-ext 설명', version: '1.0.0', enabled: true, state: 'on' }
    expect(await first.ext.list()).toEqual([row])
    expect(first.events.at(-1)).toEqual([row])
    expect(await first.ext.readEntry('my-ext')).toEqual({ ok: true, html: htmlOf('my-ext', '1.0.0'), version: '1.0.0' })
    // 보류로 남은 것이 없다 — 다음 부팅도 같은 목록
    expect(new ExtensionStore(root).pendingState()).toEqual({})
    const second = await boot()
    expect(await second.ext.list()).toEqual([row])
  })

  it('업그레이드도 곧바로 — 같은 실행에서 readEntry 가 새 버전의 HTML 을 돌려준다', async () => {
    await installed('my-ext')
    const { ext, events } = await boot({ pick: pick(await zipFile(zipItems('my-ext', '2.0.0'))) })
    expect(await ext.readEntry('my-ext')).toMatchObject({ ok: true, version: '1.0.0', html: htmlOf('my-ext', '1.0.0') })
    const picked = await ext.pick()
    expect(await ext.install(picked.ok ? picked.preview!.token! : '')).toEqual({ ok: true, id: 'my-ext', version: '2.0.0' })
    expect(await ext.list()).toMatchObject([{ id: 'my-ext', version: '2.0.0', state: 'on' }])
    expect(events.at(-1)).toMatchObject([{ id: 'my-ext', version: '2.0.0' }])
    expect(await ext.readEntry('my-ext')).toEqual({ ok: true, html: htmlOf('my-ext', '2.0.0'), version: '2.0.0' })
  })

  it('적용이 실패하면 install 은 apply-failed 를 돌려주고(던지지 않는다) 이전 버전이 그대로 남는다', async () => {
    await installed('my-ext')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ext } = await boot({ pick: pick(await zipFile(zipItems('my-ext', '2.0.0'))) })
    const picked = await ext.pick()
    // installed/ 에 쓸 수 없게 — installed/my-ext 를 옆으로 옮기는 rename 이 실패한다
    await fs.chmod(path.join(root, 'installed'), 0o555)
    try {
      const result = await ext.install(picked.ok ? picked.preview!.token! : '')
      expect(result).toMatchObject({ ok: false, failure: { code: 'apply-failed', params: { message: expect.any(String) } } })
    } finally {
      await fs.chmod(path.join(root, 'installed'), 0o755)
    }
    expect(await ext.list()).toMatchObject([{ id: 'my-ext', version: '1.0.0', state: 'on' }])
    expect(await ext.readEntry('my-ext')).toMatchObject({ ok: true, version: '1.0.0', html: htmlOf('my-ext', '1.0.0') })
    expect(new ExtensionStore(root).pendingState()).toEqual({})
    warn.mockRestore()
  })

  it('이미 있는 id 를 고르면 미리보기에 그 버전 (업그레이드 확인 카드)', async () => {
    await installed('my-ext')
    const { ext } = await boot({ pick: pick(await zipFile(zipItems('my-ext', '2.0.0'))) })
    expect(await ext.pick()).toMatchObject({ ok: true, preview: { existing: { version: '1.0.0' } } })
  })

  it('나쁜 zip — 미리보기에 사유, token 없음', async () => {
    const { ext } = await boot({ pick: pick(await zipFile([...zipItems('my-ext', '1.0.0'), { name: '../evil', data: 'x' }])) })
    const picked = await ext.pick()
    expect(picked).toMatchObject({ ok: true, preview: { problems: [{ code: 'unsafe-path' }] } })
    expect(picked.ok && picked.preview?.token).toBeFalsy()
  })

  it('대화상자 취소(undefined) — preview 없이 ok, 아무 파일도 만들지 않는다', async () => {
    const { ext } = await boot({ pick: pick(undefined) })
    expect(await ext.pick()).toEqual({ ok: true })
    expect(await fs.stat(root).catch(() => undefined)).toBeUndefined()
  })

  it('pick 이 주입되지 않았으면 취소와 같다', async () => {
    const { ext } = await boot()
    expect(await ext.pick()).toEqual({ ok: true })
  })

  it('대화상자가 던져도 던지지 않고 io-failed', async () => {
    const { ext } = await boot({ pick: async () => { throw new Error('dialog broke') } })
    expect(await ext.pick()).toEqual({ ok: false, failure: { code: 'io-failed', params: { message: 'dialog broke' } } })
  })

  it('pick 의 owner(요청한 창)를 대화상자에 넘긴다', async () => {
    const seen: unknown[] = []
    const { ext } = await boot({ pick: async (owner) => void seen.push(owner) })
    await ext.pick('window-1')
    expect(seen).toEqual(['window-1'])
  })

  it('cancel 하면 그 token 으로는 설치할 수 없다 — 구조화된 실패', async () => {
    const { ext } = await boot({ pick: pick(await zipFile(zipItems('my-ext', '1.0.0'))) })
    const picked = await ext.pick()
    const token = picked.ok ? picked.preview!.token! : ''
    expect(await ext.cancel(token)).toEqual({ ok: true })
    expect(await ext.install(token)).toEqual({ ok: false, failure: { code: 'token-unknown', params: {} } })
    expect(await ext.list()).toEqual([])
  })

  it('remove 는 곧바로 적용된다 — 목록에서 사라지고 settings 값도 지운다, 재시작해도 그대로', async () => {
    await installed('my-ext', 'other-ext')
    const first = await boot()
    expect(await first.ext.setEnabled('my-ext', false)).toEqual({ ok: true })
    expect(await first.ext.setEnabled('other-ext', false)).toEqual({ ok: true })
    expect(await first.ext.remove('my-ext')).toEqual({ ok: true })
    expect((await first.ext.list()).map((item) => item.id)).toEqual(['other-ext'])
    expect(first.events.at(-1)?.map((item) => item.id)).toEqual(['other-ext'])
    expect(first.settings.get().extensions).toEqual({ 'other-ext': false })
    expect(JSON.parse(await fs.readFile(settingsFile, 'utf8')).extensions).toEqual({ 'other-ext': false })
    expect(await fs.stat(path.join(root, 'installed', 'my-ext')).catch(() => undefined)).toBeUndefined()
    expect(await first.ext.readEntry('my-ext')).toEqual({ ok: false, failure: { code: 'not-installed', params: { id: 'my-ext' } } })

    const second = await boot()
    expect((await second.ext.list()).map((item) => item.id)).toEqual(['other-ext'])
  })

  it('삭제 적용이 실패하면 apply-failed — 확장은 남는다', async () => {
    await installed('my-ext')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ext } = await boot()
    await fs.chmod(path.join(root, 'installed'), 0o555)
    try {
      expect(await ext.remove('my-ext')).toMatchObject({ ok: false, failure: { code: 'apply-failed' } })
    } finally {
      await fs.chmod(path.join(root, 'installed'), 0o755)
    }
    expect(await ext.list()).toMatchObject([{ id: 'my-ext', state: 'on' }])
    warn.mockRestore()
  })

  it('방금 설치한 확장을 remove 하면 곧바로 목록에서 빠진다', async () => {
    await installed('my-ext')
    const { ext } = await boot({ pick: pick(await zipFile(zipItems('new-ext', '1.0.0'))) })
    const picked = await ext.pick()
    expect(await ext.install(picked.ok ? picked.preview!.token! : '')).toMatchObject({ ok: true })
    expect((await ext.list()).map((item) => item.id)).toEqual(['my-ext', 'new-ext'])
    expect(await ext.remove('new-ext')).toEqual({ ok: true })
    expect((await ext.list()).map((item) => item.id)).toEqual(['my-ext'])
  })

  it('remove 실패도 던지지 않는다 — 없는 id·잘못된 id', async () => {
    const { ext } = await boot()
    expect(await ext.remove('no-such')).toEqual({ ok: false, failure: { code: 'not-installed', params: { id: 'no-such' } } })
    expect(await ext.remove('../x')).toEqual({ ok: false, failure: { code: 'id-invalid', params: { value: '../x' } } })
  })
})

describe('readEntry — 확장 HTML 읽기 (이슈 #511)', () => {
  const entryFile = (id: string, entry = 'index.html') => path.join(root, 'installed', id, entry)

  it('켜진 정상 확장의 진입 HTML 과 버전 (UTF-8)', async () => {
    await installed('my-ext')
    const { ext } = await boot()
    expect(await ext.readEntry('my-ext')).toEqual({ ok: true, html: htmlOf('my-ext', '1.0.0'), version: '1.0.0' })
  })

  it('.htm 도 읽는다, 확장자는 대소문자를 가리지 않는다', async () => {
    await pendInstallItems(zipItems('htm-ext', '1.0.0', 'page/Index.HTM'))
    const { ext } = await boot()
    expect(await ext.readEntry('htm-ext')).toMatchObject({ ok: true, html: htmlOf('htm-ext', '1.0.0') })
  })

  it('꺼진 확장·깨진 확장은 not-on', async () => {
    await installed('my-ext')
    await fs.mkdir(path.join(root, 'installed', 'broken-ext'), { recursive: true })
    const { ext } = await boot()
    await ext.setEnabled('my-ext', false)
    expect(await ext.readEntry('my-ext')).toEqual({ ok: false, failure: { code: 'not-on', params: { id: 'my-ext' } } })
    expect(await ext.readEntry('broken-ext')).toEqual({ ok: false, failure: { code: 'not-on', params: { id: 'broken-ext' } } })
  })

  it('모르는 id 는 not-installed, id 형식 위반은 id-invalid', async () => {
    const { ext } = await boot()
    expect(await ext.readEntry('no-such')).toEqual({ ok: false, failure: { code: 'not-installed', params: { id: 'no-such' } } })
    expect(await ext.readEntry('../x')).toEqual({ ok: false, failure: { code: 'id-invalid', params: { value: '../x' } } })
    expect(await ext.readEntry('constructor')).toEqual({ ok: false, failure: { code: 'not-installed', params: { id: 'constructor' } } })
  })

  it('HTML 이 아닌 진입 파일(.js)은 entry-not-html', async () => {
    await pendInstallItems(zipItems('js-ext', '1.0.0', 'index.js'))
    const { ext } = await boot()
    expect(await ext.list()).toMatchObject([{ id: 'js-ext', state: 'on' }])
    expect(await ext.readEntry('js-ext')).toEqual({ ok: false, failure: { code: 'entry-not-html', params: { entry: 'index.js' } } })
  })

  it('진입 파일이 폴더 밖으로 가는 심볼릭 링크로 바뀌었으면 entry-unsafe — 밖의 글을 읽지 않는다', async () => {
    await installed('my-ext')
    const { ext } = await boot()
    await ext.idle() // 부팅 읽기가 끝난 뒤에 디스크를 바꾼다
    const outside = path.join(dir, 'secret.html')
    await fs.writeFile(outside, '<p>secret</p>')
    await fs.rm(entryFile('my-ext'))
    await fs.symlink(outside, entryFile('my-ext'))
    expect(await ext.readEntry('my-ext')).toEqual({ ok: false, failure: { code: 'entry-unsafe', params: { entry: 'index.html' } } })
  })

  it('진입 파일로 가는 길의 폴더가 밖을 가리키는 심볼릭 링크면 entry-unsafe', async () => {
    await pendInstallItems(zipItems('deep-ext', '1.0.0', 'ui/index.html'))
    const { ext } = await boot()
    await ext.idle()
    const outside = path.join(dir, 'elsewhere')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'index.html'), '<p>secret</p>')
    await fs.rm(path.join(root, 'installed', 'deep-ext', 'ui'), { recursive: true })
    await fs.symlink(outside, path.join(root, 'installed', 'deep-ext', 'ui'))
    expect(await ext.readEntry('deep-ext')).toEqual({ ok: false, failure: { code: 'entry-unsafe', params: { entry: 'ui/index.html' } } })
  })

  it('진입 자리가 폴더면 entry-unsafe (일반 파일만)', async () => {
    await installed('my-ext')
    const { ext } = await boot()
    await ext.idle()
    await fs.rm(entryFile('my-ext'))
    await fs.mkdir(entryFile('my-ext'))
    expect(await ext.readEntry('my-ext')).toEqual({ ok: false, failure: { code: 'entry-unsafe', params: { entry: 'index.html' } } })
  })

  it('상한(EXTENSION_LIMITS.entryBytes)을 넘으면 entry-too-large', async () => {
    await installed('my-ext')
    const { ext } = await boot()
    await ext.idle()
    const bytes = EXTENSION_LIMITS.entryBytes + 1
    await fs.writeFile(entryFile('my-ext'), 'a'.repeat(bytes))
    expect(await ext.readEntry('my-ext')).toEqual({ ok: false, failure: { code: 'entry-too-large', params: { bytes, limit: EXTENSION_LIMITS.entryBytes } } })
  })

  it('읽을 수 없으면(권한·사라짐) entry-unreadable — 던지지 않는다', async () => {
    await installed('my-ext', 'gone-ext')
    const { ext } = await boot()
    await ext.idle()
    await fs.chmod(entryFile('my-ext'), 0o000)
    try {
      expect(await ext.readEntry('my-ext')).toMatchObject({ ok: false, failure: { code: 'entry-unreadable', params: { message: expect.any(String) } } })
    } finally {
      await fs.chmod(entryFile('my-ext'), 0o644)
    }
    await fs.rm(entryFile('gone-ext'))
    expect(await ext.readEntry('gone-ext')).toMatchObject({ ok: false, failure: { code: 'entry-unreadable' } })
  })
})

describe('켜짐 값 (settings.extensions)', () => {
  it('끄면 false 만 저장, 다시 켜면 키를 지운다(기본 켜짐). 바뀔 때만 이벤트', async () => {
    await installed('my-ext')
    const { ext, settings, events } = await boot()
    await ext.idle()
    const before = events.length

    expect(await ext.setEnabled('my-ext', false)).toEqual({ ok: true })
    expect(settings.get().extensions).toEqual({ 'my-ext': false })
    expect(await ext.list()).toMatchObject([{ id: 'my-ext', enabled: false, state: 'off' }])
    expect(events.length).toBe(before + 1)

    expect(await ext.setEnabled('my-ext', false)).toEqual({ ok: true })
    expect(events.length).toBe(before + 1) // 같은 값 — 다시 내지 않는다

    expect(await ext.setEnabled('my-ext', true)).toEqual({ ok: true })
    expect(settings.get().extensions).toEqual({})
    expect(await ext.list()).toMatchObject([{ id: 'my-ext', enabled: true, state: 'on' }])
    expect(events.length).toBe(before + 2)
  })

  it('목록에 없는 id 는 not-installed — 설정을 건드리지 않는다', async () => {
    const { ext, settings } = await boot()
    expect(await ext.setEnabled('no-such', false)).toEqual({ ok: false, failure: { code: 'not-installed', params: { id: 'no-such' } } })
    expect(settings.get().extensions).toBeUndefined()
  })

  it('다른 설정만 바뀌면 이벤트를 내지 않는다', async () => {
    await installed('my-ext')
    const { ext, settings, events } = await boot()
    await ext.idle()
    const before = events.length
    settings.set({ fontSize: 15 })
    await ext.idle()
    expect(events.length).toBe(before)
  })
})

describe('mount 주입 자리', () => {
  function recorder() {
    const log: string[] = []
    const mount: ExtensionsOptions['mount'] = ({ manifest, dir: folder }) => (ctx: Context) => {
      log.push(`mount ${manifest.id} ${path.basename(folder)}`)
      ctx.effect(() => () => void log.push(`dispose ${manifest.id}`))
    }
    return { log, mount }
  }

  it('켜진 확장은 부팅 때 올리고, 끄면 내리고, 켜면 다시 올린다. 꺼진 확장은 올리지 않는다', async () => {
    await installed('a-ext', 'b-ext')
    await fs.writeFile(settingsFile, JSON.stringify({ extensions: { 'b-ext': false } }))
    const { log, mount } = recorder()
    const { ext } = await boot({ mount })
    await ext.idle()
    expect(log).toEqual(['mount a-ext a-ext'])
    expect(await ext.list()).toMatchObject([{ id: 'a-ext', state: 'on' }, { id: 'b-ext', state: 'off' }])

    await ext.setEnabled('a-ext', false)
    expect(log).toEqual(['mount a-ext a-ext', 'dispose a-ext'])
    await ext.setEnabled('b-ext', true)
    await ext.setEnabled('a-ext', true)
    expect(log).toEqual(['mount a-ext a-ext', 'dispose a-ext', 'mount b-ext b-ext', 'mount a-ext a-ext'])
  })

  it('mount 가 던지면 그 확장만 failed(mount-failed) — 나머지는 on. 끄면 사유가 지워지고 다시 켜면 다시 시도한다', async () => {
    await installed('bad-ext', 'good-ext')
    let fail = true
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const mount: ExtensionsOptions['mount'] = ({ manifest }) => () => {
      if (manifest.id === 'bad-ext' && fail) throw new Error(`boom ${os.homedir()}/x`)
    }
    const { ext } = await boot({ mount })
    await ext.idle()
    expect(await ext.list()).toMatchObject([
      { id: 'bad-ext', state: 'failed', reason: { code: 'mount-failed', params: { message: 'boom ~/x' } } },
      { id: 'good-ext', state: 'on' },
    ])

    await ext.setEnabled('bad-ext', false)
    expect((await ext.list())[0]).toEqual(expect.objectContaining({ state: 'off' }))
    expect((await ext.list())[0]!.reason).toBeUndefined()
    fail = false
    await ext.setEnabled('bad-ext', true)
    expect((await ext.list())[0]).toMatchObject({ state: 'on' })
    error.mockRestore()
  })

  it('올리는 동안은 mounting — 이벤트로 보이고, 목록은 올리기가 끝나길 기다리지 않는다', async () => {
    await installed('my-ext')
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { ext, events } = await boot({ mount: () => async () => gate })
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject([{ id: 'my-ext', state: 'mounting' }]))
    expect(await ext.list()).toMatchObject([{ id: 'my-ext', state: 'mounting' }])
    release()
    await ext.idle()
    expect(events.at(-1)).toMatchObject([{ id: 'my-ext', state: 'on' }])
  })

  it('동시 호출은 한 줄로 선다 — 올리는 중에 끄면 다 올린 뒤에 내린다', async () => {
    await installed('my-ext')
    await fs.writeFile(settingsFile, JSON.stringify({ extensions: { 'my-ext': false } }))
    const log: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const mount: ExtensionsOptions['mount'] = () => async (ctx: Context) => {
      log.push('mount start')
      ctx.effect(() => () => void log.push('dispose'))
      await gate
      log.push('mount done')
    }
    const { ext } = await boot({ mount })
    await ext.idle()

    const on = ext.setEnabled('my-ext', true)
    const off = ext.setEnabled('my-ext', false)
    await vi.waitFor(() => expect(log).toEqual(['mount start']))
    let offDone = false
    void off.then(() => (offDone = true))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(offDone).toBe(false)
    release()
    expect(await on).toEqual({ ok: true })
    expect(await off).toEqual({ ok: true })
    expect(log).toEqual(['mount start', 'mount done', 'dispose'])
    expect(await ext.list()).toMatchObject([{ state: 'off', enabled: false }])
  })

  it('mount 가 없으면 상태만 on (A 층 단독 — 확장 코드는 실행되지 않는다)', async () => {
    await installed('my-ext')
    const { ext } = await boot()
    expect(await ext.list()).toMatchObject([{ id: 'my-ext', state: 'on' }])
  })
})

// QA 03_qa_ext_pr3 차단 — 보류 목록·settings.extensions 를 일반 객체로 읽으면 id 가 Object.prototype 의 이름(`constructor`)일 때
// 상속된 함수가 pending·enabled 자리에 들어가 목록을 IPC(structured clone)로 못 보낸다. 서비스는 자기 키만 읽어야 한다
describe('Object.prototype 이름의 id', () => {
  it('constructor — 설치·재시작·끄기·켜기·삭제 내내 목록이 맞고 목록·이벤트가 structuredClone 된다', async () => {
    const id = 'constructor'
    // 다른 확장을 껐다 켜서 settings.extensions 가 {} 인 상태도 함께 본다
    await installed('other-ext')
    const first = await boot({ pick: pick(await zipFile(zipItems(id, '1.0.0'))) })
    await first.ext.setEnabled('other-ext', false)
    await first.ext.setEnabled('other-ext', true)
    expect(first.settings.get().extensions).toEqual({})
    const picked = await first.ext.pick()
    expect(await first.ext.install(picked.ok ? picked.preview!.token! : '')).toMatchObject({ ok: true, id })
    const firstList = await first.ext.list()
    expect(firstList.find((item) => item.id === id)).toMatchObject({ enabled: true, state: 'on' })
    expect(structuredClone(firstList)).toEqual(firstList)

    const second = await boot()
    const row = () => second.ext.list().then((list) => list.find((item) => item.id === id))
    expect(await row()).toEqual({ id, name: `${id} 이름`, description: `${id} 설명`, version: '1.0.0', enabled: true, state: 'on' })
    expect(await second.ext.setEnabled(id, false)).toEqual({ ok: true })
    expect(await row()).toMatchObject({ enabled: false, state: 'off' })
    expect(await second.ext.setEnabled(id, true)).toEqual({ ok: true })
    expect(await row()).toMatchObject({ enabled: true, state: 'on' })
    expect(second.settings.get().extensions).toEqual({})
    expect(await second.ext.remove(id)).toEqual({ ok: true })
    expect(await row()).toBeUndefined()
    const list = await second.ext.list()
    expect(structuredClone(list)).toEqual(list)
    for (const event of [...first.events, ...second.events]) expect(structuredClone(event)).toEqual(event)

    const third = await boot()
    expect((await third.ext.list()).map((item) => item.id)).toEqual(['other-ext'])
  })

  it('constructor 가 아닌 Object.prototype 이름(toString·hasOwnProperty·valueOf)은 대문자라 id 규칙에서 막힌다 — 목록·설정에 들어올 수 없다', async () => {
    for (const name of ['toString', 'hasOwnProperty', 'valueOf']) {
      const { ext, settings } = await boot({ pick: pick(await zipFile(zipItems(name, '1.0.0'))) })
      expect(await ext.pick()).toMatchObject({ ok: true, preview: { problems: [{ code: 'id-invalid' }] } })
      expect(await ext.setEnabled(name, false)).toMatchObject({ ok: false, failure: { code: 'not-installed' } })
      expect(await ext.remove(name)).toMatchObject({ ok: false, failure: { code: 'id-invalid' } })
      expect(() => settings.set({ extensions: { [name]: false } })).toThrow()
    }
  })

  it('없는 id 로 켜짐 값을 물어도 상속 키를 읽지 않는다 — settings.extensions 가 {} 여도 다른 확장은 켜짐', async () => {
    await installed('my-ext')
    await fs.writeFile(settingsFile, JSON.stringify({ extensions: {} }))
    const { ext } = await boot()
    const list = await ext.list()
    expect(list).toEqual([{ id: 'my-ext', name: 'my-ext 이름', description: 'my-ext 설명', version: '1.0.0', enabled: true, state: 'on' }])
  })
})

// QA 03_qa_ext_pr3 경고 2 — cordis emit 은 리스너 예외를 부른 쪽으로 던진다. 알림(창으로 보내기) 실패가 요청 결과를 깨면 안 된다
describe('extensions/changed 리스너가 던질 때', () => {
  it('요청은 구조화된 결과를 돌려주고 상태는 바뀌며, 오류는 로그로만 남는다', async () => {
    await installed('my-ext')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ctx, ext } = await boot({ pick: pick(await zipFile(zipItems('new-ext', '1.0.0'))) })
    await ext.idle()
    ctx.on('extensions/changed', () => {
      throw new Error('send failed')
    })
    expect(await ext.setEnabled('my-ext', false)).toEqual({ ok: true })
    expect(await ext.list()).toMatchObject([{ id: 'my-ext', enabled: false, state: 'off' }])
    const picked = await ext.pick()
    expect(picked).toMatchObject({ ok: true, preview: { problems: [] } })
    expect(await ext.install(picked.ok ? picked.preview!.token! : '')).toEqual({ ok: true, id: 'new-ext', version: '1.0.0' })
    expect(await ext.remove('my-ext')).toEqual({ ok: true })
    expect(await ext.cancel('0'.repeat(32))).toEqual({ ok: true })
    expect(error).toHaveBeenCalledWith('[extensions] 바뀜 알림 실패', expect.objectContaining({ message: 'send failed' }))
    error.mockRestore()
  })
})
