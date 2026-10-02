import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listDirectory, MAX_ENTRIES } from '../../src/services/fileTree.ts'
import { readHtmlAssets } from '../../src/services/filePreview.ts'

// 오른쪽 패널 Files 탭(이슈 #29) — 메인이 지키는 것: 프로젝트 안 폴더만, 밖을 가리키는 링크는 목록에서 빠짐, 한 폴더 항목 수 상한.
// HTML 미리보기의 같은 폴더 리소스도 프로젝트 안 파일만

let tmp: string
let project: string
let outside: string

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-tree-')))
  project = path.join(tmp, 'project')
  outside = path.join(tmp, 'outside')
  await fs.mkdir(path.join(project, 'src', 'deep'), { recursive: true })
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret\n')
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('listDirectory', () => {
  it('루트 — 폴더 먼저, 이름은 자연 순서(대소문자 무시), 숨김 파일도 보인다(dsh 처럼)', async () => {
    await fs.writeFile(path.join(project, 'b10.ts'), '')
    await fs.writeFile(path.join(project, 'b2.ts'), '')
    await fs.writeFile(path.join(project, 'A.md'), '')
    await fs.writeFile(path.join(project, '.env'), '')
    await fs.mkdir(path.join(project, 'zeta'))
    expect(await listDirectory(project, '')).toEqual({
      status: 'ok',
      absolute: project,
      entries: [
        { name: 'src', type: 'directory' },
        { name: 'zeta', type: 'directory' },
        { name: '.env', type: 'file' },
        { name: 'A.md', type: 'file' },
        { name: 'b2.ts', type: 'file' },
        { name: 'b10.ts', type: 'file' },
      ],
      truncated: false,
    })
  })

  it('하위 폴더는 프로젝트 기준 상대 경로로', async () => {
    await fs.writeFile(path.join(project, 'src', 'a.ts'), '')
    const listed = await listDirectory(project, 'src')
    expect(listed).toEqual({
      status: 'ok',
      absolute: path.join(project, 'src'),
      entries: [{ name: 'deep', type: 'directory' }, { name: 'a.ts', type: 'file' }],
      truncated: false,
    })
  })

  it('밖을 가리키는 링크(파일·폴더)는 목록에 없다 — 안을 가리키는 링크는 가리키는 종류로', async () => {
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(project, 'leak.txt'))
    await fs.symlink(outside, path.join(project, 'out'))
    await fs.symlink(path.join(project, 'src'), path.join(project, 'src-link'))
    await fs.symlink(path.join(project, 'nope'), path.join(project, 'dangling'))
    const listed = await listDirectory(project, '')
    expect(listed.status === 'ok' && listed.entries).toEqual([
      { name: 'src', type: 'directory' },
      { name: 'src-link', type: 'directory' },
    ])
  })

  it('밖·없는 폴더·파일·링크로 밖·등록 폴더 자체가 없음은 unavailable', async () => {
    await fs.symlink(outside, path.join(project, 'out'))
    await fs.writeFile(path.join(project, 'a.ts'), '')
    expect(await listDirectory(project, '..')).toEqual({ status: 'unavailable' })
    expect(await listDirectory(project, outside)).toEqual({ status: 'unavailable' })
    expect(await listDirectory(project, 'out')).toEqual({ status: 'unavailable' })
    expect(await listDirectory(project, 'nope')).toEqual({ status: 'unavailable' })
    expect(await listDirectory(project, 'a.ts')).toEqual({ status: 'unavailable' })
    expect(await listDirectory(path.join(tmp, 'gone'), '')).toEqual({ status: 'unavailable' })
    expect(await listDirectory(project, 'a\u0000b')).toEqual({ status: 'unavailable' })
  })

  it(`한 폴더 항목은 ${MAX_ENTRIES}개까지 — 넘으면 잘렸다고 알린다`, async () => {
    const many = path.join(project, 'many')
    await fs.mkdir(many)
    await Promise.all(Array.from({ length: MAX_ENTRIES + 5 }, (_, index) => fs.writeFile(path.join(many, `f${index}.txt`), '')))
    const listed = await listDirectory(project, 'many')
    expect(listed.status === 'ok' && listed.entries.length).toBe(MAX_ENTRIES)
    expect(listed.status === 'ok' && listed.truncated).toBe(true)
  })
})

describe('readHtmlAssets', () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(project, 'site', 'js'), { recursive: true })
    await fs.writeFile(path.join(project, 'site', 'index.html'), '<p>hi</p>')
    await fs.writeFile(path.join(project, 'site', 'js', 'app.js'), 'document.body.dataset.ok = "1"')
    await fs.writeFile(path.join(project, 'site', 'style.css'), 'body { color: red }')
    await fs.writeFile(path.join(project, 'site', 'dot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await fs.writeFile(path.join(project, 'top.js'), 'top')
  })

  it('HTML 파일 폴더 기준 — 스크립트·스타일은 글, 이미지는 data: 주소. 쿼리·조각은 떼고 읽는다', async () => {
    expect(await readHtmlAssets(project, 'site/index.html', ['js/app.js?v=1', 'style.css#x', 'dot.png', '../top.js'])).toEqual([
      { reference: 'js/app.js?v=1', text: 'document.body.dataset.ok = "1"' },
      { reference: 'style.css#x', text: 'body { color: red }' },
      { reference: 'dot.png', dataUrl: 'data:image/png;base64,iVBORw==' },
      { reference: '../top.js', text: 'top' },
    ])
  })

  it('프로젝트 밖·링크로 밖·절대 경로·스킴·없는 파일은 빠진다', async () => {
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(project, 'site', 'leak.js'))
    const refs = ['../../outside/secret.txt', 'leak.js', '/etc/hosts', 'https://example.com/a.js', 'data:text/javascript,1', 'nope.js', '']
    expect(await readHtmlAssets(project, 'site/index.html', refs)).toEqual([])
  })

  it('HTML 파일 자체가 프로젝트 밖이면 아무것도 읽지 않는다', async () => {
    await fs.writeFile(path.join(outside, 'a.js'), 'x')
    await fs.writeFile(path.join(outside, 'page.html'), '')
    expect(await readHtmlAssets(project, '../outside/page.html', ['a.js'])).toEqual([])
  })
})
