import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXTENSION_LIMITS, type ExtensionLimits } from '../../src/services/extensions/limits.ts'
import { inspectZip } from '../../src/services/extensions/zipInspect.ts'
import { makeZip, type ZipItem } from './support/zipWriter.ts'

// 확장 zip 검사 (이슈 #478, 설계 docs/superpowers/specs/2026-10-19-extension-install-design.md 3절 "zip 안전 검사") — 풀지 않고 항목 목록만 본다
// (extension.json 하나만 읽는다). zip 은 테스트가 코드로 만든다(support/zipWriter.ts). 크기 상한은 큰 파일을 만들지 않고 상한을 주입해서 본다

const APP = '1.0.0'
const MANIFEST = JSON.stringify({ id: 'my-ext', name: '내 확장', description: '설명', version: '1.2.0', entry: 'index.js' })
const MANIFEST_BYTES = Buffer.byteLength(MANIFEST)
const base: ZipItem[] = [
  { name: 'extension.json', data: MANIFEST },
  { name: 'index.js', data: 'export default {}' },
]

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-ext-zip-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function inspect(items: readonly ZipItem[], limits?: ExtensionLimits) {
  const file = path.join(dir, 'ext.zip')
  await fs.writeFile(file, makeZip(items))
  return inspectZip(file, APP, limits)
}

const codes = (result: { problems: { code: string }[] }) => result.problems.map((p) => p.code)

describe('inspectZip — 통과', () => {
  it('최상위에 extension.json 이 있는 zip', async () => {
    const result = await inspect([...base, { name: 'skills/' }, { name: 'skills/a.md', data: '# a' }])
    expect(result.problems).toEqual([])
    expect(result.manifest?.id).toBe('my-ext')
    expect(result.files).toEqual({ count: 3, totalBytes: MANIFEST_BYTES + 'export default {}'.length + 3 })
  })

  it('단일 폴더로 감싼 zip — entry 는 그 폴더 기준', async () => {
    const result = await inspect([{ name: 'my-ext/' }, ...base.map((item) => ({ ...item, name: `my-ext/${item.name}` }))])
    expect(result.problems).toEqual([])
    expect(result.manifest?.version).toBe('1.2.0')
  })
})

describe('inspectZip — 경로 (zip-slip)', () => {
  it.each([
    ['../x', 'parent'],
    ['/abs', 'absolute'],
    ['C:\\x', 'drive'],
    ['C:/x', 'drive'],
    ['a\\..\\..\\x', 'backslash'],
    ['a/\0.js', 'nul'],
    ['a/../../x', 'parent'],
  ])('%j → unsafe-path(%s)', async (name, reason) => {
    const result = await inspect([...base, { name, data: 'x' }])
    expect(result.problems).toEqual([{ code: 'unsafe-path', params: { path: name, reason } }])
  })

  it('Info-ZIP 유니코드 경로 필드에 숨긴 이름도 본다', async () => {
    const result = await inspect([...base, { name: 'safe.txt', unicodeName: '../evil', data: 'x' }])
    expect(result.problems).toEqual([{ code: 'unsafe-path', params: { path: '../evil', reason: 'parent' } }])
  })

  it('심볼릭 링크 항목은 거절', async () => {
    const result = await inspect([...base, { name: 'link', data: '/etc/passwd', mode: 0o120777 }])
    expect(result.problems).toEqual([{ code: 'symlink', params: { path: 'link' } }])
  })

  it('중복 경로 (대소문자만 다른 것 포함 — 대소문자를 안 가리는 디스크에서 덮어쓴다)', async () => {
    expect((await inspect([...base, { name: 'a.js' }, { name: 'a.js' }])).problems).toEqual([{ code: 'duplicate-path', params: { path: 'a.js' } }])
    expect(codes(await inspect([...base, { name: 'A.js' }, { name: 'a.js' }]))).toEqual(['duplicate-path'])
  })

  it('여러 사유를 한 번에 모은다', async () => {
    const result = await inspect([...base, { name: '../x' }, { name: 'l', mode: 0o120777 }, { name: '/y' }])
    expect(codes(result)).toEqual(['unsafe-path', 'symlink', 'unsafe-path'])
  })
})

describe('inspectZip — Finder 로 만든 zip (이슈 #480)', () => {
  const wrapped: ZipItem[] = [{ name: 'my-ext/' }, ...base.map((item) => ({ ...item, name: `my-ext/${item.name}` }))]
  const finderJunk: ZipItem[] = [
    { name: 'my-ext/.DS_Store', data: 'ds' },
    { name: '__MACOSX/' },
    { name: '__MACOSX/my-ext/' },
    { name: '__MACOSX/my-ext/._extension.json', data: 'rsrc' },
    { name: '__MACOSX/my-ext/._index.js', data: 'rsrc' },
  ]

  it('__MACOSX/ 와 .DS_Store 가 딸린 래퍼 폴더 zip 이 통과 — 항목 수·크기에서도 빠진다', async () => {
    const result = await inspect([...wrapped, ...finderJunk])
    expect(result.problems).toEqual([])
    expect(result.manifest?.id).toBe('my-ext')
    expect(result.files).toEqual({ count: 2, totalBytes: MANIFEST_BYTES + 'export default {}'.length })
  })

  it('최상위 모양 zip 의 .DS_Store·__MACOSX 도 무시 (중복 판정에서도 빠진다)', async () => {
    const result = await inspect([...base, { name: '.DS_Store' }, { name: 'sub/.DS_Store' }, { name: '__MACOSX/._extension.json' }, { name: '__MACOSX/._index.js' }])
    expect(result.problems).toEqual([])
  })

  it('__MACOSX 아래의 위험한 이름은 여전히 거절', async () => {
    const result = await inspect([...base, { name: '__MACOSX/../x', data: 'x' }])
    expect(result.problems).toEqual([{ code: 'unsafe-path', params: { path: '__MACOSX/../x', reason: 'parent' } }])
  })

  it('__MACOSX 아래의 심볼릭 링크도 여전히 거절', async () => {
    expect(codes(await inspect([...base, { name: '__MACOSX/l', data: '/etc', mode: 0o120777 }]))).toEqual(['symlink'])
  })

  it('entry 가 무시되는 .DS_Store 를 가리키면 entry-missing (풀지 않는 파일이다)', async () => {
    const manifest = JSON.stringify({ id: 'my-ext', name: 'n', description: 'd', version: '1.0.0', entry: '.DS_Store' })
    expect(codes(await inspect([{ name: 'extension.json', data: manifest }, { name: '.DS_Store' }]))).toEqual(['entry-missing'])
  })
})

describe('inspectZip — 상한', () => {
  const small = (over: Partial<ExtensionLimits>): ExtensionLimits => ({ ...EXTENSION_LIMITS, ...over })

  it('기본 상한 값', () => {
    expect(EXTENSION_LIMITS).toMatchObject({ entries: 2000, totalBytes: 200 * 1024 * 1024, fileBytes: 50 * 1024 * 1024, zipBytes: 100 * 1024 * 1024 })
  })

  it('zip 파일 자체가 상한을 넘으면 읽지 않고 거절', async () => {
    const result = await inspect(base, small({ zipBytes: 100 }))
    expect(codes(result)).toEqual(['zip-too-large'])
    expect(result.manifest).toBeUndefined()
  })

  it('항목 수 상한 — 목록을 읽기 전에 거절', async () => {
    const result = await inspect([...base, { name: 'a' }], small({ entries: 2 }))
    expect(result.problems).toEqual([{ code: 'too-many-entries', params: { count: 3, limit: 2 } }])
  })

  it('파일 하나 크기 상한 (선언된 해제 크기)', async () => {
    const result = await inspect([...base, { name: 'big.bin', data: 'x'.repeat(500) }], small({ fileBytes: 400 }))
    expect(result.problems).toEqual([{ code: 'file-too-large', params: { path: 'big.bin', bytes: 500, limit: 400 } }])
  })

  it('총 해제 크기 상한', async () => {
    const result = await inspect([...base, { name: 'a.bin', data: 'x'.repeat(100) }], small({ totalBytes: 150 }))
    expect(codes(result)).toEqual(['total-too-large'])
  })

  it('extension.json 이 manifest 상한을 넘으면 읽지 않는다', async () => {
    const result = await inspect(base, small({ manifestBytes: 10 }))
    expect(result.problems).toEqual([{ code: 'manifest-too-large', params: { bytes: MANIFEST_BYTES, limit: 10 } }])
  })
})

describe('inspectZip — extension.json·entry', () => {
  it('extension.json 이 없으면 manifest-missing', async () => {
    expect(codes(await inspect([{ name: 'index.js' }]))).toEqual(['manifest-missing'])
  })

  it('최상위와 폴더 안 두 곳에 있으면 manifest-ambiguous', async () => {
    const result = await inspect([...base, { name: 'sub/extension.json', data: MANIFEST }])
    expect(result.problems).toEqual([{ code: 'manifest-ambiguous', params: { paths: 'extension.json, sub/extension.json' } }])
  })

  it('최상위 폴더가 여럿이고 그 안에 하나씩 있어도 manifest-ambiguous', async () => {
    const result = await inspect([
      { name: 'a/extension.json', data: MANIFEST },
      { name: 'b/extension.json', data: MANIFEST },
    ])
    expect(codes(result)).toEqual(['manifest-ambiguous'])
  })

  it('폴더 안에만 있는데 그 폴더 밖에도 항목이 있으면 manifest-misplaced', async () => {
    const result = await inspect([{ name: 'my-ext/extension.json', data: MANIFEST }, { name: 'my-ext/index.js' }, { name: 'README.md' }])
    expect(result.problems).toEqual([{ code: 'manifest-misplaced', params: { path: 'my-ext/extension.json' } }])
  })

  it('두 단계 아래의 extension.json 은 찾지 않는다', async () => {
    expect(codes(await inspect([{ name: 'a/b/extension.json', data: MANIFEST }]))).toEqual(['manifest-missing'])
  })

  it('진입 파일이 zip 안에 없으면 entry-missing', async () => {
    const result = await inspect([{ name: 'extension.json', data: MANIFEST }])
    expect(result.problems).toEqual([{ code: 'entry-missing', params: { entry: 'index.js' } }])
    expect(result.manifest?.id).toBe('my-ext')
  })

  it('진입 파일이 폴더 항목이면 entry-missing', async () => {
    expect(codes(await inspect([{ name: 'extension.json', data: MANIFEST }, { name: 'index.js/' }]))).toEqual(['entry-missing'])
  })

  it('manifest 사유와 zip 사유를 함께 모은다', async () => {
    const bad = JSON.stringify({ id: 'git', name: 'x', description: 'x', version: '1.0.0', entry: 'main.js', permisions: [] })
    const result = await inspect([{ name: 'extension.json', data: bad }, { name: '../x' }])
    expect(codes(result)).toEqual(['unsafe-path', 'field-unknown', 'id-reserved', 'entry-missing'])
    expect(result.manifest).toBeUndefined()
  })

  it('JSON 이 아니면 manifest-invalid', async () => {
    expect(codes(await inspect([{ name: 'extension.json', data: '{ id: ' }, { name: 'index.js' }]))).toEqual(['manifest-invalid'])
  })

  it('deflate 로 압축된 extension.json 도 읽는다', async () => {
    const result = await inspect(base.map((item) => ({ ...item, deflate: true })))
    expect(result.problems).toEqual([])
    expect(result.manifest?.id).toBe('my-ext')
  })

  // 회귀(이슈 #484): yauzl 의 크기 검증 스트림은 어긋나도 오류·닫힘을 내지 않아 검사가 영영 안 끝났다 — 끝나지 않으면 테스트 타임아웃(5초)으로 실패한다
  it.each([
    ['선언보다 크다', 10],
    ['선언보다 작다', MANIFEST_BYTES + 100],
  ])('deflate 로 압축된 extension.json 의 실제 크기가 %s → zip-unreadable', async (_label, declaredSize) => {
    const result = await inspect([{ name: 'extension.json', data: MANIFEST, deflate: true, declaredSize }, base[1]!])
    expect(codes(result)).toEqual(['zip-unreadable'])
    expect(result.manifest).toBeUndefined()
  })

  it('zip 이 아니면 zip-unreadable', async () => {
    const file = path.join(dir, 'not.zip')
    await fs.writeFile(file, 'hello')
    const result = await inspectZip(file, APP)
    expect(codes(result)).toEqual(['zip-unreadable'])
    expect(result.files).toEqual({ count: 0, totalBytes: 0 })
  })
})
