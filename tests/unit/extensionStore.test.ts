import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXTENSION_LIMITS } from '../../src/services/extensions/limits.ts'
import { ExtensionStore } from '../../src/services/extensions/store.ts'
import { unpackZip } from '../../src/services/extensions/unpack.ts'
import { makeZip, type ZipItem } from './support/zipWriter.ts'

// 확장 저장소 (이슈 #480, 설계 docs/superpowers/specs/2026-10-19-extension-install-design.md 4절 "풀기·교체는 보류로 쌓고 다음 부팅 때") —
// stage(복사·검사) → install(staging 복사본만 다시 검사하고 pending 에 풀기·op 기록) → applyPending(부팅 때 교체·롤백). 루트는 임시 폴더

const APP = '1.0.0'

function manifest(id: string, version: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ id, name: '확장', description: '설명', version, entry: 'index.js', ...extra })
}
/** 최상위 모양 zip 항목 */
function flat(id: string, version: string, code = `// ${id} ${version}`): ZipItem[] {
  return [
    { name: 'extension.json', data: manifest(id, version) },
    { name: 'index.js', data: code },
    { name: 'skills/' },
    { name: 'skills/a.md', data: '# a' },
  ]
}

let dir: string
let root: string
let store: ExtensionStore
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-ext-store-'))
  root = path.join(dir, 'extensions')
  store = new ExtensionStore(root)
})
afterEach(async () => {
  // 권한을 막은 시험이 실패해도 지울 수 있게 되돌린다
  await fs.chmod(path.join(root, 'pending', 'install'), 0o755).catch(() => {})
  await fs.rm(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

let zipCount = 0
async function zipFile(items: readonly ZipItem[]): Promise<string> {
  const file = path.join(dir, `pick-${zipCount++}.zip`)
  await fs.writeFile(file, makeZip(items))
  return file
}
async function stageItems(items: readonly ZipItem[]) {
  return store.stage(await zipFile(items), APP)
}
/** stage + install — 둘 다 통과해야 한다 */
async function installItems(items: readonly ZipItem[]) {
  const staged = await stageItems(items)
  expect(staged.result.problems).toEqual([])
  const installed = await store.install(staged.token!, APP)
  expect(installed).toMatchObject({ ok: true })
  return installed
}
async function exists(file: string): Promise<boolean> {
  return fs.lstat(file).then(() => true, () => false)
}
/** 폴더 아래 모든 파일(폴더 제외)의 상대 경로 */
async function filesUnder(folder: string): Promise<string[]> {
  const entries = await fs.readdir(folder, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => !entry.isDirectory()).map((entry) => path.relative(folder, path.join(entry.parentPath, entry.name)))
}
async function list(folder: string): Promise<string[]> {
  return (await fs.readdir(folder).catch(() => [] as string[])).sort()
}
const read = (file: string) => fs.readFile(file, 'utf8')
const installedDir = (id: string) => path.join(root, 'installed', id)
const pendingDir = (id: string) => path.join(root, 'pending', 'install', id)
const opsFile = () => path.join(root, 'pending', 'ops.json')
async function readOps(): Promise<unknown> {
  return JSON.parse(await read(opsFile()))
}

describe('stage', () => {
  it('나쁜 zip 은 사유만 돌려주고 아무 파일도 남기지 않는다 (검사한 복사본도 지운다)', async () => {
    const staged = await stageItems([...flat('my-ext', '1.0.0'), { name: '../evil', data: 'x' }])
    expect(staged.token).toBeUndefined()
    expect(staged.result.problems.map((p) => p.code)).toEqual(['unsafe-path'])
    expect(await filesUnder(root)).toEqual([])
  })

  it('복사본을 검사한다 — 검사와 복사 사이에 원본이 바뀌어도 카드에 보이는 것이 설치되는 것이다', async () => {
    const original = await zipFile(flat('harmless', '1.0.0'))
    const swapped = makeZip(flat('other-ext', '9.9.9'))
    const copyFile = fs.copyFile
    vi.spyOn(fs, 'copyFile').mockImplementation(async (from, to, mode) => {
      await fs.writeFile(original, swapped)
      return copyFile(from, to, mode)
    })
    const staged = await store.stage(original, APP)
    vi.restoreAllMocks()
    expect(staged.result.manifest).toMatchObject({ id: 'other-ext', version: '9.9.9' })
    expect(await store.install(staged.token!, APP)).toEqual({ ok: true, id: 'other-ext', version: '9.9.9' })
  })

  it('stage 때 본 id·version 과 staging 복사본의 것이 다르면 install 이 거절한다', async () => {
    const staged = await stageItems(flat('harmless', '1.0.0'))
    await fs.writeFile(path.join(root, 'staging', `${staged.token}.zip`), makeZip(flat('other-ext', '9.9.9')))
    expect(await store.install(staged.token!, APP)).toEqual({
      ok: false,
      failure: { code: 'staged-mismatch', params: { expected: 'harmless@1.0.0', actual: 'other-ext@9.9.9' } },
    })
    expect(await list(path.join(root, 'pending', 'install'))).toEqual([])

    const again = await stageItems(flat('harmless', '1.0.0'))
    await fs.writeFile(path.join(root, 'staging', `${again.token}.zip`), makeZip(flat('harmless', '1.0.1')))
    expect(await store.install(again.token!, APP)).toMatchObject({ ok: false, failure: { code: 'staged-mismatch' } })
  })

  it('정상 zip — token 을 주고 staging 에 복사본을 둔다. 원본은 이후 읽지 않는다', async () => {
    const original = await zipFile(flat('my-ext', '1.0.0'))
    const staged = await store.stage(original, APP)
    expect(staged.token).toMatch(/^[0-9a-f]{32}$/)
    expect(staged.existing).toBeUndefined()
    expect(staged.result.manifest?.id).toBe('my-ext')
    expect(await list(path.join(root, 'staging'))).toEqual([`${staged.token}.json`, `${staged.token}.zip`])

    await fs.rm(original)
    expect(await store.install(staged.token!, APP)).toEqual({ ok: true, id: 'my-ext', version: '1.0.0' })
  })

  it('같은 id 가 설치돼 있으면 existing 에 그 버전, 보류 설치가 있으면 그 버전', async () => {
    await installItems(flat('my-ext', '1.0.0'))
    expect((await stageItems(flat('my-ext', '2.0.0'))).existing).toEqual({ version: '1.0.0' })
    await store.applyPending()
    expect((await stageItems(flat('my-ext', '2.0.0'))).existing).toEqual({ version: '1.0.0' })
    await installItems(flat('my-ext', '1.5.0'))
    expect((await stageItems(flat('my-ext', '2.0.0'))).existing).toEqual({ version: '1.5.0' })
  })

  it('cancel 은 복사본과 기록을 지운다 — 그 token 으로는 설치할 수 없다', async () => {
    const staged = await stageItems(flat('my-ext', '1.0.0'))
    await store.cancel(staged.token!)
    expect(await list(path.join(root, 'staging'))).toEqual([])
    expect(await store.install(staged.token!, APP)).toEqual({ ok: false, failure: { code: 'token-unknown', params: {} } })
  })

  it('token 모양이 아니면 파일 경로로 쓰지 않는다', async () => {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'x.zip'), makeZip(flat('my-ext', '1.0.0')))
    expect(await store.install('../../x', APP)).toEqual({ ok: false, failure: { code: 'token-unknown', params: {} } })
    await store.cancel('../../x')
    expect(await exists(path.join(dir, 'x.zip'))).toBe(true)
  })
})

describe('install — 보류 설치', () => {
  it('최상위 모양 zip 을 pending/install/<id> 에 풀고 op 를 기록, staging 은 지운다', async () => {
    await installItems(flat('my-ext', '1.0.0'))
    expect(await list(pendingDir('my-ext'))).toEqual(['extension.json', 'index.js', 'skills'])
    expect(await read(path.join(pendingDir('my-ext'), 'skills', 'a.md'))).toBe('# a')
    expect(await readOps()).toEqual([{ op: 'install', id: 'my-ext', version: '1.0.0' }])
    expect(await list(path.join(root, 'staging'))).toEqual([])
    expect(await list(path.join(root, 'pending', 'install'))).toEqual(['my-ext'])
    expect(await exists(installedDir('my-ext'))).toBe(false)
    expect(store.pendingState()).toEqual({ 'my-ext': 'install' })
  })

  it('단일 래퍼 폴더 zip 은 래퍼를 벗겨서 푼다 (Finder 부산물은 건너뛴다)', async () => {
    await installItems([
      { name: 'wrap/' },
      ...flat('my-ext', '1.0.0').map((item) => ({ ...item, name: `wrap/${item.name}` })),
      { name: 'wrap/.DS_Store', data: 'ds' },
      { name: '__MACOSX/' },
      { name: '__MACOSX/wrap/._index.js', data: 'rsrc' },
    ])
    expect(await list(pendingDir('my-ext'))).toEqual(['extension.json', 'index.js', 'skills'])
    expect(await read(path.join(pendingDir('my-ext'), 'index.js'))).toBe('// my-ext 1.0.0')
  })

  it('stage 와 install 사이에 staging 복사본이 위험한 zip 으로 바뀌면 다시 검사해 거절한다', async () => {
    const staged = await stageItems(flat('my-ext', '1.0.0'))
    await fs.writeFile(path.join(root, 'staging', `${staged.token}.zip`), makeZip([...flat('my-ext', '1.0.0'), { name: '../../evil.js', data: 'x' }]))
    const result = await store.install(staged.token!, APP)
    expect(result).toMatchObject({ ok: false, failure: { code: 'rejected', params: { problems: [{ code: 'unsafe-path' }] } } })
    expect(await exists(path.join(dir, 'evil.js'))).toBe(false)
    expect(await exists(path.join(root, 'evil.js'))).toBe(false)
    expect(await list(path.join(root, 'pending', 'install'))).toEqual([])
    expect(await exists(opsFile())).toBe(false)
  })

  it('풀다 실패하면 만들던 임시 폴더와 staging 복사본을 지우고 사유를 돌려준다 (던지지 않는다)', async () => {
    // `a` 파일과 `a/b` — 검사는 통과하지만(서로 다른 이름) 풀 때 a 가 파일이라 a/ 폴더를 못 만든다
    const staged = await stageItems([...flat('my-ext', '1.0.0'), { name: 'a', data: 'file' }, { name: 'a/b', data: 'x' }])
    expect(staged.result.problems).toEqual([])
    const result = await store.install(staged.token!, APP)
    expect(result).toMatchObject({ ok: false, failure: { code: 'unpack-failed' } })
    expect(await list(path.join(root, 'pending', 'install'))).toEqual([])
    expect(await list(path.join(root, 'staging'))).toEqual([])
    expect(await exists(opsFile())).toBe(false)
  })

  it('deflate 항목도 푼다', async () => {
    await installItems(flat('my-ext', '1.0.0').map((item) => (item.name.endsWith('/') ? item : { ...item, deflate: true })))
    expect(await read(path.join(pendingDir('my-ext'), 'index.js'))).toBe('// my-ext 1.0.0')
    expect(await read(path.join(pendingDir('my-ext'), 'skills', 'a.md'))).toBe('# a')
  })

  // 회귀: yauzl 의 크기 검증 스트림은 어긋나도 오류·닫힘을 내지 않아 install 이 영영 안 끝났다 — 끝나지 않으면 테스트 타임아웃(5초)으로 실패한다
  it.each([
    ['선언보다 크다 (압축 폭탄 모양)', 'x'.repeat(100), 10],
    ['선언보다 작다', 'x'.repeat(10), 100],
  ])('deflate 항목의 실제 크기가 %s → unpack-failed 로 끝나고 임시물을 지운다', async (_label, data, declaredSize) => {
    const staged = await stageItems([...flat('size-lie', '1.0.0'), { name: 'blob.bin', data, deflate: true, declaredSize }])
    expect(staged.result.problems).toEqual([])
    const result = await store.install(staged.token!, APP)
    expect(result).toMatchObject({ ok: false, failure: { code: 'unpack-failed' } })
    expect(await list(path.join(root, 'pending', 'install'))).toEqual([])
    expect(await list(path.join(root, 'staging'))).toEqual([])
    expect(await exists(opsFile())).toBe(false)
  })

  it('실제로 흘러나온 바이트로 상한을 건다 (파일 하나·전체)', async () => {
    const file = path.join(dir, 'honest.zip')
    await fs.writeFile(file, makeZip([...flat('my-ext', '1.0.0'), { name: 'big.bin', data: 'x'.repeat(500), deflate: true }]))
    await expect(unpackZip(file, path.join(dir, 'out1'), { ...EXTENSION_LIMITS, fileBytes: 400 })).rejects.toThrow(/big\.bin exceeds 400 bytes/)
    await expect(unpackZip(file, path.join(dir, 'out2'), { ...EXTENSION_LIMITS, totalBytes: 300 })).rejects.toThrow(/total exceeds 300 bytes/)
  })

  // 내장 서버(이슈 #537)는 동봉한 Java 런타임(bin/java·lib/jspawnhelper)을 실행해야 한다 — 서버 확장만 zip 의 실행 비트를 살린다
  it('executable 을 주면 zip 의 실행 비트를 살린다 (아니면 실행 비트 없이 푼다)', async () => {
    const file = path.join(dir, 'exec.zip')
    await fs.writeFile(file, makeZip([...flat('my-ext', '1.0.0'), { name: 'bin/java', data: '#!', mode: 0o100755 }, { name: 'lib/a.jar', data: 'x', mode: 0o100644 }]))
    await unpackZip(file, path.join(dir, 'kept'), EXTENSION_LIMITS, { executable: true })
    expect((await fs.stat(path.join(dir, 'kept', 'bin', 'java'))).mode & 0o111).toBe(0o111)
    expect((await fs.stat(path.join(dir, 'kept', 'lib', 'a.jar'))).mode & 0o111).toBe(0)
    await unpackZip(file, path.join(dir, 'plain'))
    expect((await fs.stat(path.join(dir, 'plain', 'bin', 'java'))).mode & 0o111).toBe(0)
  })

  it('server 권한 확장을 설치하면 실행 비트가 남는다', async () => {
    const manifest = {
      id: 'srv-ext', name: 'n', description: 'd', version: '1.0.0', entry: 'index.html', permissions: ['server'],
      server: { command: 'bin/java', args: [], port: 9000, health: { path: '/s', field: 'status', ready: 'UP' } },
    }
    const staged = await stageItems([{ name: 'extension.json', data: JSON.stringify(manifest) }, { name: 'index.html', data: '<p>' }, { name: 'bin/java', data: '#!', mode: 0o100755 }])
    expect(staged.result.problems).toEqual([])
    expect(await store.install(staged.token!, APP)).toMatchObject({ ok: true })
    expect((await fs.stat(path.join(pendingDir('srv-ext'), 'bin', 'java'))).mode & 0o111).toBe(0o111)
  })

  it('보류 설치가 있는 id 를 다시 설치하면 새 것으로 바꾸고 op 는 하나만 남는다', async () => {
    await installItems(flat('my-ext', '1.0.0'))
    await installItems(flat('my-ext', '1.1.0'))
    expect(await readOps()).toEqual([{ op: 'install', id: 'my-ext', version: '1.1.0' }])
    expect(await read(path.join(pendingDir('my-ext'), 'index.js'))).toBe('// my-ext 1.1.0')
  })
})

describe('직렬화 — 같은 저장소의 install·remove·applyPending 은 한 줄로 선다', () => {
  it('동시 remove 둘 — 둘 다 op 가 남는다', async () => {
    await installItems(flat('aaa', '1.0.0'))
    await installItems(flat('bbb', '1.0.0'))
    await store.applyPending()
    expect(await Promise.all([store.remove('aaa'), store.remove('bbb')])).toEqual([{ ok: true }, { ok: true }])
    expect(store.pendingState()).toEqual({ aaa: 'remove', bbb: 'remove' })
  })

  it('같은 id 의 동시 install 둘 — 둘 다 성공하고 보류 폴더는 뒤 것으로 온전하다', async () => {
    const first = await stageItems(flat('same', '1.0.0'))
    const second = await stageItems(flat('same', '2.0.0'))
    expect(await Promise.all([store.install(first.token!, APP), store.install(second.token!, APP)])).toEqual([
      { ok: true, id: 'same', version: '1.0.0' },
      { ok: true, id: 'same', version: '2.0.0' },
    ])
    expect(await readOps()).toEqual([{ op: 'install', id: 'same', version: '2.0.0' }])
    expect(await list(pendingDir('same'))).toEqual(['extension.json', 'index.js', 'skills'])
    expect(await read(path.join(pendingDir('same'), 'index.js'))).toBe('// same 2.0.0')
    expect(await store.applyPending()).toMatchObject({ applied: [{ id: 'same', version: '2.0.0' }], failed: [] })
  })

  // 회귀(이슈 #484): extension.json 의 선언 크기 거짓으로 stage 가 멈추면 큐 뒤의 모든 작업이 멈췄다 — 끝나지 않으면 테스트 타임아웃(5초)
  it('extension.json 의 선언 크기가 거짓인 stage 는 사유로 끝나고 뒤의 stage·remove 가 이어진다', async () => {
    await installItems(flat('old-ext', '1.0.0'))
    await store.applyPending()
    const [lie, ...rest] = flat('size-lie', '1.0.0')
    const staged = await stageItems([{ ...lie!, deflate: true, declaredSize: 10 }, ...rest])
    expect(staged.token).toBeUndefined()
    expect(staged.result.problems.map((p) => p.code)).toEqual(['zip-unreadable'])
    expect((await stageItems(flat('next-ext', '1.0.0'))).token).toBeDefined()
    expect(await store.remove('old-ext')).toEqual({ ok: true })
  })

  it('applyPending 이 끝나기 전에 온 stage·install 은 기다린다 — 부팅 청소가 그 결과를 지우지 않는다', async () => {
    // (applyPending 전에 stage 한 token 은 부팅 청소가 지운다 — 부팅 뒤에 고른 zip 만 설치된다)
    await fs.mkdir(path.join(root, 'pending', 'install', 'old.tmp-x'), { recursive: true })
    const file = await zipFile(flat('my-ext', '1.0.0'))
    const [applied, installed] = await Promise.all([
      store.applyPending(),
      store.stage(file, APP).then((staged) => store.install(staged.token!, APP)),
    ])
    expect(applied).toEqual({ applied: [], failed: [] })
    expect(installed).toEqual({ ok: true, id: 'my-ext', version: '1.0.0' })
    expect(await list(pendingDir('my-ext'))).toEqual(['extension.json', 'index.js', 'skills'])
    expect(store.pendingState()).toEqual({ 'my-ext': 'install' })
  })
})

describe('remove', () => {
  it('id 형식이 아니면 거절 (경로로 쓰지 않는다)', async () => {
    expect(await store.remove('../x')).toEqual({ ok: false, failure: { code: 'id-invalid', params: { value: '../x' } } })
  })

  it('없는 id 는 not-installed', async () => {
    expect(await store.remove('nope-ext')).toEqual({ ok: false, failure: { code: 'not-installed', params: { id: 'nope-ext' } } })
  })

  it('설치된 것은 remove op 를 기록만 하고 다음 부팅 때 지운다', async () => {
    await installItems(flat('my-ext', '1.0.0'))
    await store.applyPending()
    expect(await store.remove('my-ext')).toEqual({ ok: true })
    expect(await readOps()).toEqual([{ op: 'remove', id: 'my-ext' }])
    expect(await exists(installedDir('my-ext'))).toBe(true)
    expect(store.pendingState()).toEqual({ 'my-ext': 'remove' })

    expect(await store.applyPending()).toEqual({ applied: [{ op: 'remove', id: 'my-ext' }], failed: [] })
    expect(await list(path.join(root, 'installed'))).toEqual([])
    expect(await readOps()).toEqual([])
  })

  it('보류 설치만 있는 id 의 remove 는 그 보류를 취소한다', async () => {
    await installItems(flat('my-ext', '1.0.0'))
    expect(await store.remove('my-ext')).toEqual({ ok: true })
    expect(await readOps()).toEqual([])
    expect(await list(path.join(root, 'pending', 'install'))).toEqual([])
    expect(store.pendingState()).toEqual({})
  })

  it('설치된 id 의 업그레이드 보류 뒤 remove — remove 만 남고 pending 폴더는 정리', async () => {
    await installItems(flat('my-ext', '1.0.0'))
    await store.applyPending()
    await installItems(flat('my-ext', '2.0.0'))
    expect(await store.remove('my-ext')).toEqual({ ok: true })
    expect(await readOps()).toEqual([{ op: 'remove', id: 'my-ext' }])
    expect(await list(path.join(root, 'pending', 'install'))).toEqual([])
    await store.applyPending()
    expect(await exists(installedDir('my-ext'))).toBe(false)
  })
})

describe('applyPending — 부팅 때 적용', () => {
  it('보류가 없으면 아무 일도 없다 (폴더가 없어도 던지지 않는다)', async () => {
    expect(await store.applyPending()).toEqual({ applied: [], failed: [] })
  })

  it('새 설치 — pending 이 installed/<id> 로 옮겨지고 ops 가 비워진다', async () => {
    await installItems(flat('my-ext', '1.0.0'))
    expect(await store.applyPending()).toEqual({ applied: [{ op: 'install', id: 'my-ext', version: '1.0.0' }], failed: [] })
    expect(await list(installedDir('my-ext'))).toEqual(['extension.json', 'index.js', 'skills'])
    expect(await list(path.join(root, 'pending', 'install'))).toEqual([])
    expect(await readOps()).toEqual([])
    expect(store.pendingState()).toEqual({})
  })

  it('업그레이드 — 옛 버전은 사라지고 새 버전만 남는다 (.old 도 남지 않는다)', async () => {
    await installItems([...flat('my-ext', '1.0.0'), { name: 'only-old.txt', data: 'x' }])
    await store.applyPending()
    await installItems(flat('my-ext', '2.0.0'))
    expect(await store.applyPending()).toMatchObject({ applied: [{ id: 'my-ext', version: '2.0.0' }], failed: [] })
    expect(await read(path.join(installedDir('my-ext'), 'index.js'))).toBe('// my-ext 2.0.0')
    expect(await exists(path.join(installedDir('my-ext'), 'only-old.txt'))).toBe(false)
    expect(await list(path.join(root, 'installed'))).toEqual(['my-ext'])
  })

  it('pending 폴더가 사라져 교체할 수 없으면 이전 버전이 그대로, failed 에 id, 나머지는 계속', async () => {
    await installItems(flat('my-ext', '1.0.0'))
    await store.applyPending()
    await installItems(flat('my-ext', '2.0.0'))
    await installItems(flat('other-ext', '1.0.0'))
    await fs.rm(pendingDir('my-ext'), { recursive: true })

    const result = await store.applyPending()
    expect(result.applied).toEqual([{ op: 'install', id: 'other-ext', version: '1.0.0' }])
    expect(result.failed).toEqual([{ id: 'my-ext', reason: expect.any(String) }])
    expect(await read(path.join(installedDir('my-ext'), 'index.js'))).toBe('// my-ext 1.0.0')
    expect(await list(path.join(root, 'installed'))).toEqual(['my-ext', 'other-ext'])
    // 실패한 op 도 지운다 — 부팅마다 되풀이되지 않게
    expect(await readOps()).toEqual([])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('옛 버전을 옮긴 뒤 새 버전을 못 옮기면 rename 을 되돌린다 (롤백)', async () => {
    await installItems(flat('my-ext', '1.0.0'))
    await store.applyPending()
    await installItems(flat('my-ext', '2.0.0'))
    // pending/install 에 쓰기 권한이 없으면 그 안의 폴더를 다른 곳으로 rename 할 수 없다 — installed/ 는 쓸 수 있으니 옛 버전은 .old 로 옮겨진 뒤다
    await fs.chmod(path.join(root, 'pending', 'install'), 0o555)

    const result = await store.applyPending()
    expect(result).toEqual({ applied: [], failed: [{ id: 'my-ext', reason: expect.any(String) }] })
    expect(await read(path.join(installedDir('my-ext'), 'index.js'))).toBe('// my-ext 1.0.0')
    expect(await list(path.join(root, 'installed'))).toEqual(['my-ext'])
  })

  it('ops.json 이 깨져 있으면 옆으로 옮기고 아무것도 적용하지 않는다 (던지지 않는다)', async () => {
    await installItems(flat('my-ext', '1.0.0'))
    await store.applyPending()
    await fs.writeFile(opsFile(), '{ not json')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await store.applyPending()).toEqual({ applied: [], failed: [] })
    expect(await exists(installedDir('my-ext'))).toBe(true)
    expect((await list(path.join(root, 'pending'))).some((name) => name.startsWith('ops.json.corrupt-'))).toBe(true)
  })

  it('ops.json 의 모양이 틀린 줄은 버린다 (id 형식이 아닌 것 포함 — 경로로 쓰지 않는다)', async () => {
    await installItems(flat('my-ext', '1.0.0'))
    await store.applyPending()
    await fs.writeFile(opsFile(), JSON.stringify([{ op: 'remove', id: '../../x' }, { op: 'bogus', id: 'my-ext' }, 3]))
    expect(await store.applyPending()).toEqual({ applied: [], failed: [] })
    expect(await exists(installedDir('my-ext'))).toBe(true)
  })

  it('같은 id 의 op 가 여럿이면 마지막 것만 적용한다', async () => {
    await installItems(flat('my-ext', '1.0.0'))
    await store.applyPending()
    await fs.writeFile(opsFile(), JSON.stringify([{ op: 'remove', id: 'my-ext' }, { op: 'install', id: 'my-ext', version: '9.0.0' }, { op: 'remove', id: 'my-ext' }]))
    expect(await store.applyPending()).toEqual({ applied: [{ op: 'remove', id: 'my-ext' }], failed: [] })
    expect(await exists(installedDir('my-ext'))).toBe(false)
  })

  it('비정상 종료 복구 — 옛 버전을 .old 로 옮긴 뒤 죽었으면(installed 없음) 되돌리고 보류를 다시 적용한다', async () => {
    await installItems(flat('my-ext', '1.0.0'))
    await store.applyPending()
    await installItems(flat('my-ext', '2.0.0'))
    await fs.rename(installedDir('my-ext'), path.join(root, 'installed', '.old-my-ext-1700000000000'))

    expect(await store.applyPending()).toMatchObject({ applied: [{ id: 'my-ext', version: '2.0.0' }], failed: [] })
    expect(await read(path.join(installedDir('my-ext'), 'index.js'))).toBe('// my-ext 2.0.0')
    expect(await list(path.join(root, 'installed'))).toEqual(['my-ext'])
  })

  it('비정상 종료 복구 — .old 만 있고 보류가 없으면 되돌린다', async () => {
    await installItems(flat('my-ext', '1.0.0'))
    await store.applyPending()
    await fs.rename(installedDir('my-ext'), path.join(root, 'installed', '.old-my-ext-1700000000000'))
    await store.applyPending()
    expect(await list(path.join(root, 'installed'))).toEqual(['my-ext'])
    expect(await read(path.join(installedDir('my-ext'), 'index.js'))).toBe('// my-ext 1.0.0')
  })

  it('비정상 종료 복구 — 새 버전으로 바꾼 뒤 .old 를 지우기 전에 죽었으면 .old 를 지우고, 이미 끝난 op 는 적용된 것으로 본다', async () => {
    await installItems(flat('my-ext', '1.0.0'))
    await store.applyPending()
    await installItems(flat('my-ext', '2.0.0'))
    await fs.rename(installedDir('my-ext'), path.join(root, 'installed', '.old-my-ext-1700000000000'))
    await fs.rename(pendingDir('my-ext'), installedDir('my-ext'))

    expect(await store.applyPending()).toEqual({ applied: [{ op: 'install', id: 'my-ext', version: '2.0.0' }], failed: [] })
    expect(await list(path.join(root, 'installed'))).toEqual(['my-ext'])
    expect(await read(path.join(installedDir('my-ext'), 'index.js'))).toBe('// my-ext 2.0.0')
  })

  it('비정상 종료 복구 — 같은 id 의 .old 가 여럿이면 가장 최근 것을 되돌리고 나머지는 지운다', async () => {
    await installItems(flat('my-ext', '1.0.0'))
    await store.applyPending()
    await fs.rename(installedDir('my-ext'), path.join(root, 'installed', '.old-my-ext-2000'))
    await fs.mkdir(path.join(root, 'installed', '.old-my-ext-1000'))
    await store.applyPending()
    expect(await list(path.join(root, 'installed'))).toEqual(['my-ext'])
    expect(await read(path.join(installedDir('my-ext'), 'index.js'))).toBe('// my-ext 1.0.0')
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('삭제가 중간에 실패해도 다음 부팅에 반쪽 폴더가 되살아나지 않고 마저 지운다', async () => {
    await installItems([...flat('half', '1.0.0'), { name: 'z/' }, { name: 'z/locked.txt', data: 'x' }])
    await store.applyPending()
    await store.remove('half')
    // z/ 에 쓰기 권한이 없으면 그 안의 파일을 못 지운다 — extension.json 등은 이미 지워진 반쪽이 남는다
    await fs.chmod(path.join(installedDir('half'), 'z'), 0o555)
    const deleting = path.join(root, 'installed')
    try {
      await store.applyPending()
      expect(await exists(installedDir('half'))).toBe(false)
      expect(await store.listInstalled(APP)).toEqual([])
    } finally {
      for (const name of await list(deleting)) await fs.chmod(path.join(deleting, name, 'z'), 0o755).catch(() => {})
    }
    await store.applyPending()
    expect(await list(path.join(root, 'installed'))).toEqual([])
    expect(await store.listInstalled(APP)).toEqual([])
  })

  it('비정상 종료 복구 — 삭제 도중 죽은 폴더(.del-*)는 되돌리지 않고 지운다', async () => {
    await installItems(flat('my-ext', '1.0.0'))
    await store.applyPending()
    await fs.rename(installedDir('my-ext'), path.join(root, 'installed', '.del-my-ext-1700000000000'))
    await fs.rm(path.join(root, 'installed', '.del-my-ext-1700000000000', 'extension.json'))
    expect(await store.applyPending()).toEqual({ applied: [], failed: [] })
    expect(await list(path.join(root, 'installed'))).toEqual([])
  })

  it('남은 임시물(pending/install 의 .tmp-*·staging/*)을 지운다', async () => {
    await fs.mkdir(path.join(root, 'pending', 'install', 'my-ext.tmp-abc'), { recursive: true })
    await fs.mkdir(path.join(root, 'staging'), { recursive: true })
    await fs.writeFile(path.join(root, 'staging', 'deadbeef.zip'), 'x')
    await fs.writeFile(path.join(root, 'staging', 'deadbeef.json'), '{}')
    expect(await store.applyPending()).toEqual({ applied: [], failed: [] })
    expect(await list(path.join(root, 'pending', 'install'))).toEqual([])
    expect(await list(path.join(root, 'staging'))).toEqual([])
  })
})

describe('listInstalled', () => {
  it('설치된 확장을 manifest 와 함께 — .old-*·점 폴더는 뺀다', async () => {
    await installItems(flat('my-ext', '1.0.0'))
    await installItems(flat('other-ext', '2.0.0'))
    await store.applyPending()
    await fs.mkdir(path.join(root, 'installed', '.old-my-ext-1'))
    await fs.mkdir(path.join(root, 'installed', '.hidden'))
    // .old 는 부팅 복구 대상이지 목록이 아니다 — 위에서 만든 것은 installed/my-ext 가 있으니 다음 부팅에 지워진다
    const items = await store.listInstalled(APP)
    expect(items.map((item) => [item.id, item.manifest?.version, item.problems])).toEqual([
      ['my-ext', '1.0.0', []],
      ['other-ext', '2.0.0', []],
    ])
  })

  it('폴더 하나가 깨져도 던지지 않고 그 항목만 problems', async () => {
    await installItems(flat('my-ext', '1.0.0'))
    await store.applyPending()
    await fs.mkdir(path.join(root, 'installed', 'no-manifest'))
    await fs.mkdir(path.join(root, 'installed', 'bad-json'))
    await fs.writeFile(path.join(root, 'installed', 'bad-json', 'extension.json'), '{')
    await fs.mkdir(path.join(root, 'installed', 'wrong-id'))
    await fs.writeFile(path.join(root, 'installed', 'wrong-id', 'extension.json'), manifest('my-ext', '1.0.0'))
    await fs.writeFile(path.join(root, 'installed', 'wrong-id', 'index.js'), '')
    await fs.mkdir(path.join(root, 'installed', 'no-entry'))
    await fs.writeFile(path.join(root, 'installed', 'no-entry', 'extension.json'), manifest('no-entry', '1.0.0'))

    const items = await store.listInstalled(APP)
    const byId = Object.fromEntries(items.map((item) => [item.id, item]))
    expect(byId['my-ext']).toMatchObject({ manifest: { version: '1.0.0' }, problems: [] })
    expect(byId['no-manifest']).toEqual({ id: 'no-manifest', problems: [{ code: 'manifest-missing', params: {} }] })
    expect(byId['bad-json']?.problems.map((p) => p.code)).toEqual(['manifest-invalid'])
    expect(byId['wrong-id']?.problems).toEqual([{ code: 'id-mismatch', params: { folder: 'wrong-id', id: 'my-ext' } }])
    expect(byId['no-entry']?.problems).toEqual([{ code: 'entry-missing', params: { entry: 'index.js' } }])
    expect(byId['bad-json']?.manifest).toBeUndefined()
  })

  it('installed 폴더가 없으면 빈 목록', async () => {
    expect(await store.listInstalled(APP)).toEqual([])
  })
})
