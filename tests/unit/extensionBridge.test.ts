import { Context } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsService } from '../../src/services/settings.ts'
import { ExtensionsService, type ExtensionsOptions } from '../../src/services/extensions.ts'
import { EXTENSION_LIMITS } from '../../src/services/extensions/limits.ts'
import { ExtensionStore } from '../../src/services/extensions/store.ts'
import type { KeyCipher } from '../../src/services/providers.ts'
import { makeZip } from './support/zipWriter.ts'

// 확장 ↔ 앱 통로의 메인 쪽 (이슈 #536) — ctx.extensions.call(id, method, params, project). 권한 검사(permission-missing), storage(권한 없음·상한),
// secrets(확장별 격리·safeStorage), network(허용 목록 → consent-required, allowOrigin/revokeOrigin), project(info·readFile·openFile), 지우면 자료도 지운다.
// network 의 요청 규칙(기한·크기·리다이렉트)은 extensionNetwork.test.ts — 여기서는 fetch 를 주입해 허용 목록만 본다

const APP = '1.0.0'

let dir: string
let root: string
let project: string
let zipCount = 0

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-ext-bridge-'))
  root = path.join(dir, 'extensions')
  project = path.join(dir, 'project')
  await fs.mkdir(project)
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** 패널 확장 하나를 설치해 둔다 */
async function install(id: string, permissions?: string[]): Promise<void> {
  const file = path.join(dir, `ext-${zipCount++}.zip`)
  const manifest = { id, name: `${id} 이름`, description: '설명', version: '1.0.0', entry: 'index.html', ...(permissions && { permissions }) }
  await fs.writeFile(file, makeZip([{ name: 'extension.json', data: JSON.stringify(manifest) }, { name: 'index.html', data: '<p>x</p>' }]))
  const store = new ExtensionStore(root)
  const staged = await store.stage(file, APP)
  expect(staged.result.problems).toEqual([])
  await store.install(staged.token!, APP)
  await store.applyPending()
}

/** 봉한 값이 평문과 다르게 보이는 가짜 safeStorage */
const cipher: KeyCipher = {
  available: () => true,
  encrypt: (plain) => Buffer.from(`sealed:${Buffer.from(plain).toString('hex')}`),
  decrypt: (sealed) => Buffer.from(sealed.toString().slice('sealed:'.length), 'hex').toString(),
}

async function boot(options: Partial<ExtensionsOptions> = {}) {
  const ctx = new Context()
  ctx.plugin(SettingsService, { file: path.join(dir, 'settings.json') })
  ctx.plugin(ExtensionsService, { root, appVersion: APP, cipher, ...options })
  const ready = await new Promise<Context>((resolve) => ctx.inject(['extensions'], (injected) => resolve(injected)))
  await ready.extensions.idle()
  return ready.extensions
}

const here = () => ({ directory: project, name: '내 프로젝트' })

describe('통로 — 공통', () => {
  it('모르는 메서드는 method-unknown, 꺼진·없는 확장은 not-on', async () => {
    await install('a-ext')
    const ext = await boot()
    expect(await ext.call('a-ext', 'fs.write', {})).toEqual({ ok: false, error: 'method-unknown' })
    expect(await ext.call('a-ext', 'constructor', {})).toEqual({ ok: false, error: 'method-unknown' })
    expect(await ext.call('no-ext', 'storage.get', { key: 'k' })).toEqual({ ok: false, error: 'not-on' })
    await ext.setEnabled('a-ext', false)
    expect(await ext.call('a-ext', 'storage.get', { key: 'k' })).toEqual({ ok: false, error: 'not-on' })
  })

  it('권한 없는 확장이 secrets·network·project 를 부르면 permission-missing', async () => {
    await install('bare-ext')
    const ext = await boot()
    const calls: [string, unknown][] = [
      ['secrets.get', { key: 'k' }],
      ['secrets.set', { key: 'k', value: 'v' }],
      ['secrets.delete', { key: 'k' }],
      ['network.fetch', { url: 'http://sonar.local/' }],
      ['project.info', undefined],
      ['project.readFile', { path: 'a.txt' }],
      ['project.openFile', { path: 'a.txt' }],
    ]
    for (const [method, params] of calls) expect(await ext.call('bare-ext', method, params, here()), method).toEqual({ ok: false, error: 'permission-missing' })
    expect(await ext.allowOrigin('bare-ext', 'http://sonar.local')).toEqual({ ok: false, error: 'permission-missing' })
  })
})

describe('storage — 권한 없이, 확장별 JSON 값', () => {
  it('set → get → delete, 없는 키는 null. 재시작해도 남는다', async () => {
    await install('a-ext')
    let ext = await boot()
    expect(await ext.call('a-ext', 'storage.get', { key: 'server' })).toEqual({ ok: true, result: null })
    expect(await ext.call('a-ext', 'storage.set', { key: 'server', value: { url: 'http://sonar.local', n: 1 } })).toEqual({ ok: true, result: null })
    ext = await boot()
    expect(await ext.call('a-ext', 'storage.get', { key: 'server' })).toEqual({ ok: true, result: { url: 'http://sonar.local', n: 1 } })
    expect(await ext.call('a-ext', 'storage.delete', { key: 'server' })).toEqual({ ok: true, result: null })
    expect(await ext.call('a-ext', 'storage.get', { key: 'server' })).toEqual({ ok: true, result: null })
  })

  it('상한을 넘는 set 은 storage-full — 이전 값이 그대로', async () => {
    await install('a-ext')
    const ext = await boot()
    await ext.call('a-ext', 'storage.set', { key: 'keep', value: 'v' })
    expect(await ext.call('a-ext', 'storage.set', { key: 'big', value: 'x'.repeat(EXTENSION_LIMITS.storageBytes) })).toEqual({ ok: false, error: 'storage-full' })
    expect(await ext.call('a-ext', 'storage.get', { key: 'big' })).toEqual({ ok: true, result: null })
    expect(await ext.call('a-ext', 'storage.get', { key: 'keep' })).toEqual({ ok: true, result: 'v' })
  })

  it('키가 비었거나 글이 아니면·값이 없으면 params-invalid', async () => {
    await install('a-ext')
    const ext = await boot()
    for (const params of [undefined, {}, { key: '' }, { key: 1 }]) expect(await ext.call('a-ext', 'storage.get', params)).toEqual({ ok: false, error: 'params-invalid' })
    expect(await ext.call('a-ext', 'storage.set', { key: 'k' })).toEqual({ ok: false, error: 'params-invalid' })
  })

  it('다른 확장의 값은 보이지 않는다', async () => {
    await install('a-ext')
    await install('b-ext')
    const ext = await boot()
    await ext.call('a-ext', 'storage.set', { key: 'k', value: 'a 의 값' })
    expect(await ext.call('b-ext', 'storage.get', { key: 'k' })).toEqual({ ok: true, result: null })
  })
})

describe('secrets — secrets 권한, safeStorage 로 봉해 확장별로', () => {
  it('set → get → delete. 파일에는 평문이 없다', async () => {
    await install('a-ext', ['secrets'])
    const ext = await boot()
    expect(await ext.call('a-ext', 'secrets.set', { key: 'token', value: 'squ_비밀' })).toEqual({ ok: true, result: null })
    expect(await ext.call('a-ext', 'secrets.get', { key: 'token' })).toEqual({ ok: true, result: 'squ_비밀' })
    const files = await fs.readdir(path.join(root, 'data', 'a-ext'))
    for (const name of files) expect(await fs.readFile(path.join(root, 'data', 'a-ext', name), 'utf8')).not.toContain('squ_')
    expect(await ext.call('a-ext', 'secrets.delete', { key: 'token' })).toEqual({ ok: true, result: null })
    expect(await ext.call('a-ext', 'secrets.get', { key: 'token' })).toEqual({ ok: true, result: null })
  })

  it('확장 간 격리 — 같은 키라도 다른 확장의 비밀은 못 읽는다', async () => {
    await install('a-ext', ['secrets'])
    await install('b-ext', ['secrets'])
    const ext = await boot()
    await ext.call('a-ext', 'secrets.set', { key: 'token', value: 'a 의 비밀' })
    expect(await ext.call('b-ext', 'secrets.get', { key: 'token' })).toEqual({ ok: true, result: null })
  })

  it('값은 글만, safeStorage 를 쓸 수 없으면 secrets-unavailable', async () => {
    await install('a-ext', ['secrets'])
    let ext = await boot()
    expect(await ext.call('a-ext', 'secrets.set', { key: 'token', value: 1 })).toEqual({ ok: false, error: 'params-invalid' })
    ext = await boot({ cipher: { ...cipher, available: () => false } })
    expect(await ext.call('a-ext', 'secrets.set', { key: 'token', value: 'v' })).toEqual({ ok: false, error: 'secrets-unavailable' })
    ext = await boot({ cipher: undefined })
    expect(await ext.call('a-ext', 'secrets.get', { key: 'token' })).toEqual({ ok: false, error: 'secrets-unavailable' })
  })
})

describe('network — 허용 목록', () => {
  const okFetch = (seen: string[]): typeof fetch => async (url) => {
    seen.push(String(url))
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
  }

  it('허용 목록에 없는 origin → consent-required(요청하지 않는다). 허용하면 목록에 남아 다음엔 묻지 않는다, 재시작해도', async () => {
    await install('sonar-ext', ['network'])
    const seen: string[] = []
    let ext = await boot({ fetch: okFetch(seen) })
    expect(await ext.call('sonar-ext', 'network.fetch', { url: 'http://sonar.local:9000/api/x' })).toEqual({ ok: false, error: 'consent-required', origin: 'http://sonar.local:9000' })
    expect(seen).toEqual([])

    expect(await ext.allowOrigin('sonar-ext', 'http://sonar.local:9000')).toEqual({ ok: true, result: null })
    expect(await ext.call('sonar-ext', 'network.fetch', { url: 'http://sonar.local:9000/api/x' })).toEqual({
      ok: true,
      result: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' },
    })
    expect(seen).toEqual(['http://sonar.local:9000/api/x'])
    expect((await ext.list())[0]).toMatchObject({ id: 'sonar-ext', origins: ['http://sonar.local:9000'] })

    ext = await boot({ fetch: okFetch(seen) })
    expect(await ext.call('sonar-ext', 'network.fetch', { url: 'http://sonar.local:9000/api/y' })).toMatchObject({ ok: true })
    // 다른 포트·scheme 은 다른 origin — 다시 묻는다
    expect(await ext.call('sonar-ext', 'network.fetch', { url: 'https://sonar.local:9000/' })).toEqual({ ok: false, error: 'consent-required', origin: 'https://sonar.local:9000' })
  })

  it('거두면 목록에서 빠지고 다시 묻는다 — 목록이 비면 origins 키도 없다', async () => {
    await install('sonar-ext', ['network'])
    const ext = await boot({ fetch: okFetch([]) })
    await ext.allowOrigin('sonar-ext', 'http://sonar.local')
    expect(await ext.revokeOrigin('sonar-ext', 'http://sonar.local')).toEqual({ ok: true })
    expect(await ext.call('sonar-ext', 'network.fetch', { url: 'http://sonar.local/' })).toMatchObject({ ok: false, error: 'consent-required' })
    expect((await ext.list())[0]).not.toHaveProperty('origins')
    expect(await ext.revokeOrigin('no-ext', 'http://sonar.local')).toEqual({ ok: false, failure: { code: 'not-installed', params: { id: 'no-ext' } } })
  })

  it('origin 이 아닌 값은 허용하지 않는다 — url-invalid', async () => {
    await install('sonar-ext', ['network'])
    const ext = await boot()
    for (const origin of ['file:///', 'http://sonar.local/path', 'sonar.local', 'ftp://sonar.local']) {
      expect(await ext.allowOrigin('sonar-ext', origin), origin).toEqual({ ok: false, error: 'url-invalid' })
    }
  })

  it('http/https 가 아닌 주소는 묻지도 않고 url-invalid', async () => {
    await install('sonar-ext', ['network'])
    const ext = await boot()
    expect(await ext.call('sonar-ext', 'network.fetch', { url: 'file:///etc/passwd' })).toEqual({ ok: false, error: 'url-invalid' })
  })
})

describe('project — project 권한, 지금 프로젝트 안만', () => {
  it('프로젝트가 없으면 no-project', async () => {
    await install('p-ext', ['project'])
    const ext = await boot()
    expect(await ext.call('p-ext', 'project.info', undefined)).toEqual({ ok: false, error: 'no-project' })
    expect(await ext.call('p-ext', 'project.readFile', { path: 'a.txt' })).toEqual({ ok: false, error: 'no-project' })
  })

  it('info 는 이름만 (경로는 주지 않는다)', async () => {
    await install('p-ext', ['project'])
    const ext = await boot()
    expect(await ext.call('p-ext', 'project.info', undefined, here())).toEqual({ ok: true, result: { name: '내 프로젝트' } })
  })

  it('readFile — 프로젝트 안의 글 파일', async () => {
    await install('p-ext', ['project'])
    await fs.writeFile(path.join(project, 'sonar-project.properties'), 'sonar.projectKey=demo\n')
    const ext = await boot()
    expect(await ext.call('p-ext', 'project.readFile', { path: 'sonar-project.properties' }, here())).toEqual({ ok: true, result: 'sonar.projectKey=demo\n' })
  })

  it('readFile — `..`·절대 경로·밖을 가리키는 심볼릭 링크·폴더는 path-unsafe', async () => {
    await install('p-ext', ['project'])
    await fs.writeFile(path.join(dir, 'outside.txt'), '밖의 비밀')
    await fs.symlink(path.join(dir, 'outside.txt'), path.join(project, 'link.txt'))
    await fs.symlink(dir, path.join(project, 'up'))
    await fs.mkdir(path.join(project, 'sub'))
    const ext = await boot()
    for (const relPath of ['../outside.txt', 'sub/../../outside.txt', path.join(dir, 'outside.txt'), 'link.txt', 'up/outside.txt', 'sub', '']) {
      expect(await ext.call('p-ext', 'project.readFile', { path: relPath }, here()), relPath).toEqual({ ok: false, error: relPath === '' ? 'params-invalid' : 'path-unsafe' })
    }
  })

  it('readFile — 상한을 넘으면 file-too-large, UTF-8 이 아니면 not-text, 없으면 file-unreadable', async () => {
    await install('p-ext', ['project'])
    await fs.writeFile(path.join(project, 'big.txt'), 'x'.repeat(EXTENSION_LIMITS.projectFileBytes + 1))
    await fs.writeFile(path.join(project, 'bin.dat'), Buffer.from([0xff, 0xfe, 0x00, 0xc3]))
    const ext = await boot()
    expect(await ext.call('p-ext', 'project.readFile', { path: 'big.txt' }, here())).toEqual({ ok: false, error: 'file-too-large' })
    expect(await ext.call('p-ext', 'project.readFile', { path: 'bin.dat' }, here())).toEqual({ ok: false, error: 'not-text' })
    expect(await ext.call('p-ext', 'project.readFile', { path: 'none.txt' }, here())).toEqual({ ok: false, error: 'file-unreadable' })
  })

  it('openFile — 경로와 줄을 돌려준다(화면이 오른쪽 패널에 연다). `..` 는 path-unsafe, 줄은 1 이상의 정수', async () => {
    await install('p-ext', ['project'])
    const ext = await boot()
    expect(await ext.call('p-ext', 'project.openFile', { path: 'src/a.ts', line: 12 }, here())).toEqual({ ok: true, result: { path: 'src/a.ts', line: 12 } })
    expect(await ext.call('p-ext', 'project.openFile', { path: 'src/a.ts' }, here())).toEqual({ ok: true, result: { path: 'src/a.ts' } })
    expect(await ext.call('p-ext', 'project.openFile', { path: '../a.ts' }, here())).toEqual({ ok: false, error: 'path-unsafe' })
    for (const line of [0, 1.5, '3']) expect(await ext.call('p-ext', 'project.openFile', { path: 'a.ts', line }, here())).toEqual({ ok: false, error: 'params-invalid' })
  })
})

describe('지우면 자료도 지운다', () => {
  it('삭제하면 storage·secrets·허용 목록이 사라지고, 다시 설치해도 남아 있지 않다', async () => {
    await install('a-ext', ['secrets', 'network'])
    let ext = await boot()
    await ext.call('a-ext', 'storage.set', { key: 'k', value: 1 })
    await ext.call('a-ext', 'secrets.set', { key: 't', value: 's' })
    await ext.allowOrigin('a-ext', 'http://sonar.local')
    expect(await ext.remove('a-ext')).toEqual({ ok: true })
    expect(await fs.stat(path.join(root, 'data', 'a-ext')).catch(() => undefined)).toBeUndefined()

    await install('a-ext', ['secrets', 'network'])
    ext = await boot()
    expect(await ext.call('a-ext', 'storage.get', { key: 'k' })).toEqual({ ok: true, result: null })
    expect(await ext.call('a-ext', 'secrets.get', { key: 't' })).toEqual({ ok: true, result: null })
    expect((await ext.list())[0]).not.toHaveProperty('origins')
  })

  it('업그레이드(같은 id 재설치)는 자료를 남긴다', async () => {
    await install('a-ext')
    let ext = await boot()
    await ext.call('a-ext', 'storage.set', { key: 'k', value: 1 })
    await install('a-ext')
    ext = await boot()
    expect(await ext.call('a-ext', 'storage.get', { key: 'k' })).toEqual({ ok: true, result: 1 })
  })
})
