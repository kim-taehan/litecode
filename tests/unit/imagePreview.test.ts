import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IMAGE_PREVIEW_LIMIT, previewFile } from '../../src/services/filePreview.ts'

// 오른쪽 패널의 이미지·PDF (이슈 #214) — 메인이 지키는 것: 종류는 확장자 + 머리 바이트가 둘 다 맞을 때만, 이미지는 data: 주소로만
// (바깥 요청 0 — 화면은 이 주소를 <img> 로만 그린다), 큰 이미지는 읽지 않고 tooLarge, PDF 는 내용 없이, 경로 검사는 글 파일과 같은 projectFile

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16])
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1')
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')])
const PDF = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>alert(1)</script><rect width="4" height="4"/></svg>\n'

let tmp: string
let project: string
let outside: string

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-imgpreview-')))
  project = path.join(tmp, 'project')
  outside = path.join(tmp, 'outside')
  await fs.mkdir(path.join(project, 'img'), { recursive: true })
  await fs.mkdir(outside)
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const put = (relative: string, data: string | Buffer) => fs.writeFile(path.join(project, relative), data)

describe('previewFile — 이미지', () => {
  it('png — data: 주소(base64)·종류·크기·상대 경로·realpath', async () => {
    await put('img/a.png', PNG)
    expect(await previewFile(project, 'img/a.png')).toEqual({
      status: 'image',
      path: path.join('img', 'a.png'),
      absolute: path.join(project, 'img', 'a.png'),
      size: PNG.length,
      mime: 'image/png',
      dataUrl: `data:image/png;base64,${PNG.toString('base64')}`,
    })
  })

  it('jpg·jpeg·gif·webp 도 머리 바이트가 맞으면 이미지 (확장자 대소문자 무관)', async () => {
    await put('a.jpg', JPEG)
    await put('b.JPEG', JPEG)
    await put('c.gif', GIF)
    await put('d.webp', WEBP)
    expect(await previewFile(project, 'a.jpg')).toMatchObject({ status: 'image', mime: 'image/jpeg' })
    expect(await previewFile(project, 'b.JPEG')).toMatchObject({ status: 'image', mime: 'image/jpeg' })
    expect(await previewFile(project, 'c.gif')).toMatchObject({ status: 'image', mime: 'image/gif' })
    expect(await previewFile(project, 'd.webp')).toMatchObject({ status: 'image', mime: 'image/webp' })
  })

  it('확장자만 이미지고 내용이 아니면 이미지로 보지 않는다 — 글이면 글, 아니면 이진', async () => {
    await put('fake.png', 'not an image\n')
    await put('wrong.gif', PNG) // png 바이트에 gif 이름 — 종류가 엇갈리면 이미지가 아니다
    expect(await previewFile(project, 'fake.png')).toMatchObject({ status: 'text', text: 'not an image\n' })
    expect(await previewFile(project, 'wrong.gif')).toMatchObject({ status: 'binary' })
  })

  it('svg — data:image/svg+xml 주소로만 준다(화면은 <img> 로 그려 스크립트가 돌지 않는다). 원문 보기용 글도 함께', async () => {
    await put('logo.svg', SVG)
    const result = await previewFile(project, 'logo.svg')
    expect(result).toMatchObject({ status: 'image', mime: 'image/svg+xml', source: SVG })
    expect(result.status === 'image' && result.dataUrl).toBe(`data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`)
  })

  it('svg 인데 <svg 가 없거나 글자가 아니면 이미지가 아니다', async () => {
    await put('plain.svg', 'hello\n')
    await put('binary.svg', Buffer.from([0x3c, 0x73, 0x76, 0x67, 0, 1, 2]))
    expect(await previewFile(project, 'plain.svg')).toMatchObject({ status: 'text' })
    expect(await previewFile(project, 'binary.svg')).toMatchObject({ status: 'binary' })
  })

  it('상한을 넘는 이미지는 읽지 않고 tooLarge (크기·상한을 알린다). 기본 상한은 20MB', async () => {
    expect(IMAGE_PREVIEW_LIMIT).toBe(20 * 1024 * 1024)
    await put('big.png', Buffer.concat([PNG, Buffer.alloc(100)]))
    expect(await previewFile(project, 'big.png', undefined, 50)).toEqual({
      status: 'tooLarge',
      path: 'big.png',
      absolute: path.join(project, 'big.png'),
      size: PNG.length + 100,
      limit: 50,
    })
  })

  it('프로젝트 밖·밖을 가리키는 링크의 이미지는 unavailable — 글 파일과 같은 경로 검사', async () => {
    await fs.writeFile(path.join(outside, 'secret.png'), PNG)
    await fs.symlink(path.join(outside, 'secret.png'), path.join(project, 'leak.png'))
    await fs.symlink(outside, path.join(project, 'out'))
    expect(await previewFile(project, '../outside/secret.png')).toEqual({ status: 'unavailable' })
    expect(await previewFile(project, path.join(outside, 'secret.png'))).toEqual({ status: 'unavailable' })
    expect(await previewFile(project, 'leak.png')).toEqual({ status: 'unavailable' })
    expect(await previewFile(project, 'out/secret.png')).toEqual({ status: 'unavailable' })
  })
})

describe('previewFile — PDF', () => {
  it('%PDF- 로 시작하는 .pdf 는 내용 없이 pdf (화면이 다른 앱에서 열기로 넘긴다)', async () => {
    await put('doc.pdf', PDF)
    expect(await previewFile(project, 'doc.pdf')).toEqual({ status: 'pdf', path: 'doc.pdf', absolute: path.join(project, 'doc.pdf'), size: PDF.length })
  })

  it('이름만 .pdf 면 pdf 가 아니다', async () => {
    await put('fake.pdf', 'just text\n')
    expect(await previewFile(project, 'fake.pdf')).toMatchObject({ status: 'text' })
  })

  it('프로젝트 밖을 가리키는 링크의 pdf 는 unavailable', async () => {
    await fs.writeFile(path.join(outside, 'secret.pdf'), PDF)
    await fs.symlink(path.join(outside, 'secret.pdf'), path.join(project, 'leak.pdf'))
    expect(await previewFile(project, 'leak.pdf')).toEqual({ status: 'unavailable' })
  })
})
