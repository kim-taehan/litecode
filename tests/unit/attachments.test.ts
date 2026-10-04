import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ATTACHMENT_LIMITS } from '../../shared/attachments.ts'
import { imageMime, isText, outgoing, pickAttachments } from '../../src/services/attachments.ts'
import { tr } from '../../src/i18n.ts'
import { chipsOf, sizeLabel } from '../../renderer/attachmentsView.ts'

// 입력창 `+` 메뉴의 파일·이미지 추가 (이슈 #44, 실측 01y). 이미지는 매직 바이트로 png·jpeg 만 — svg·깨진 이미지는 opencode 에서 끝 신호 없는
// 거절이 된다. 글 파일은 file 파트로 안 보낸다(mime 하나 틀리면 그 세션이 망가진다) — 프로젝트 안이면 `@경로`, 밖이면 앱이 읽어 글로 싣는다

/** 이 파일이 만든 임시 폴더 — 끝나면 이 경로만 지운다 */
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'litecode-attachments-')))
const project = path.join(root, 'project')
const outside = path.join(root, 'outside')
fs.mkdirSync(path.join(project, 'src dir'), { recursive: true })
fs.mkdirSync(outside)
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46])
const write = (dir: string, name: string, data: string | Buffer): string => {
  const file = path.join(dir, name)
  fs.writeFileSync(file, data)
  return file
}

describe('imageMime — 매직 바이트', () => {
  it('png·jpeg 만 알아본다', () => {
    expect(imageMime(PNG)).toBe('image/png')
    expect(imageMime(JPEG)).toBe('image/jpeg')
  })

  it('gif·svg·글자·빈 파일은 이미지가 아니다 (확장자를 믿지 않는다)', () => {
    expect(imageMime(Buffer.from('GIF89a'))).toBeUndefined()
    expect(imageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined()
    expect(imageMime(Buffer.from('hello'))).toBeUndefined()
    expect(imageMime(Buffer.alloc(0))).toBeUndefined()
  })
})

describe('isText', () => {
  it('UTF-8 글은 글이다 (한글·빈 파일 포함)', () => {
    expect(isText(Buffer.from('안녕 hello\n'))).toBe(true)
    expect(isText(Buffer.alloc(0))).toBe(true)
  })

  it('NUL 바이트가 있거나 UTF-8 이 아니면 글이 아니다', () => {
    expect(isText(Buffer.from([0x61, 0x00, 0x62]))).toBe(false)
    expect(isText(PNG)).toBe(false)
    expect(isText(Buffer.from([0xff, 0xfe, 0xfd]))).toBe(false)
  })
})

describe('pickAttachments — 칩을 만들 때 거른다', () => {
  it('이미지: png·jpeg 는 칩(이름·크기·경로), 확장자만 png 인 글자는 거절', async () => {
    const good = write(outside, 'shot.png', PNG)
    const jpg = write(outside, 'photo.jpg', JPEG)
    const fake = write(outside, 'fake.png', 'not an image')
    const result = await pickAttachments('image', [good, jpg, fake], 0)
    expect(result.picked).toEqual([
      { kind: 'image', path: good, name: 'shot.png', size: PNG.length },
      { kind: 'image', path: jpg, name: 'photo.jpg', size: JPEG.length },
    ])
    expect(result.rejected).toEqual([tr('attach.notImage', { name: 'fake.png' })])
  })

  it('파일: 글자 파일은 칩, 바이너리·폴더·없는 파일은 거절', async () => {
    const text = write(project, 'notes.md', '# 메모\n')
    const binary = write(project, 'blob.bin', Buffer.from([1, 0, 2]))
    const result = await pickAttachments('file', [text, binary, path.join(project, 'src dir'), path.join(project, 'none.txt')], 0)
    expect(result.picked).toEqual([{ kind: 'file', path: text, name: 'notes.md', size: Buffer.byteLength('# 메모\n') }])
    expect(result.rejected).toEqual([
      tr('attach.notText', { name: 'blob.bin' }),
      tr('attach.notFile', { name: 'src dir' }),
      tr('attach.unreadable', { name: 'none.txt' }),
    ])
  })

  it('크기 상한: 글 파일 한 개 200KB, 이미지 한 장 20MB', async () => {
    expect(ATTACHMENT_LIMITS).toEqual({ images: 5, imageBytes: 20 * 1024 * 1024, files: 5, fileBytes: 200 * 1024 })
    const edge = write(outside, 'edge.txt', 'a'.repeat(ATTACHMENT_LIMITS.fileBytes))
    const big = write(outside, 'big.txt', 'a'.repeat(ATTACHMENT_LIMITS.fileBytes + 1))
    const result = await pickAttachments('file', [edge, big], 0)
    expect(result.picked.map((item) => item.name)).toEqual(['edge.txt'])
    expect(result.rejected).toEqual([tr('attach.fileTooLarge', { name: 'big.txt', max: 200 })])

    const huge = write(outside, 'huge.png', Buffer.concat([PNG, Buffer.alloc(ATTACHMENT_LIMITS.imageBytes)]))
    expect((await pickAttachments('image', [huge], 0)).rejected).toEqual([tr('attach.imageTooLarge', { name: 'huge.png', max: 20 })])
  })

  it('개수 상한: 이미 붙은 것(held)과 합쳐 한 메시지 5개 — 넘는 것은 칩을 만들지 않고 사유 한 번', async () => {
    const files = Array.from({ length: 4 }, (_, index) => write(outside, `n${index}.png`, PNG))
    const result = await pickAttachments('image', files, 3)
    expect(result.picked.map((item) => item.name)).toEqual(['n0.png', 'n1.png'])
    expect(result.rejected).toEqual([tr('attach.tooManyImages', { max: 5 })])
    expect((await pickAttachments('file', [write(outside, 'six.txt', 'x')], 5)).rejected).toEqual([tr('attach.tooManyFiles', { max: 5 })])
  })

  it('같은 파일을 두 번 고르면 한 번만', async () => {
    const file = write(outside, 'twice.txt', 'x')
    expect((await pickAttachments('file', [file, file], 0)).picked).toHaveLength(1)
  })
})

describe('outgoing — 보낼 글과 이미지', () => {
  it('프로젝트 안 파일은 글 끝에 @상대경로 (`@` 트리거와 같은 모양 — 공백이 있으면 따옴표)', async () => {
    const a = write(project, 'a.ts', 'export {}\n')
    const b = write(path.join(project, 'src dir'), 'b c.md', '# b\n')
    const sent = await outgoing(project, '이것 봐 줘', [
      { kind: 'file', path: a, name: 'a.ts', size: 10 },
      { kind: 'file', path: b, name: 'b c.md', size: 4 },
    ])
    expect(sent).toEqual({ text: '이것 봐 줘\n\n@a.ts @"src dir/b c.md"', images: [] })
  })

  it('프로젝트 밖 파일은 앱이 읽어 파일 이름을 머리로 한 코드 블록으로 싣는다 — 본문의 ``` 보다 긴 울타리', async () => {
    const plain = write(outside, 'log.txt', 'line 1\nline 2')
    const fenced = write(outside, 'doc.md', '```js\n1\n```\n')
    const sent = await outgoing(project, 'see', [
      { kind: 'file', path: plain, name: 'log.txt', size: 13 },
      { kind: 'file', path: fenced, name: 'doc.md', size: 13 },
    ])
    expect(sent.text).toBe('see\n\nlog.txt:\n```\nline 1\nline 2\n```\n\ndoc.md:\n````\n```js\n1\n```\n````')
  })

  it('이름이 `..` 으로 시작하는 프로젝트 안 파일도 안이다, 링크로 밖을 가리키면 밖이다', async () => {
    const dotted = write(project, '..env.txt', 'A=1\n')
    const target = write(outside, 'real.txt', 'secret\n')
    const link = path.join(project, 'link.txt')
    fs.symlinkSync(target, link)
    expect((await outgoing(project, '', [{ kind: 'file', path: dotted, name: '..env.txt', size: 4 }])).text).toBe('@..env.txt')
    expect((await outgoing(project, '', [{ kind: 'file', path: link, name: 'link.txt', size: 7 }])).text).toBe('link.txt:\n```\nsecret\n```')
  })

  it('이미지는 읽은 바이트와 매직 바이트로 정한 mime 으로 (확장자와 달라도)', async () => {
    const image = write(outside, 'really-jpeg.png', JPEG)
    const sent = await outgoing(project, '', [{ kind: 'image', path: image, name: 'really-jpeg.png', size: JPEG.length }])
    expect(sent.text).toBe('')
    expect(sent.images).toEqual([{ mime: 'image/jpeg', filename: 'really-jpeg.png', data: JPEG }])
  })

  it('고른 뒤 바뀐 파일은 보낼 때 다시 거른다 — 사유로 거절', async () => {
    const image = write(outside, 'changed.png', PNG)
    const [picked] = (await pickAttachments('image', [image], 0)).picked
    fs.writeFileSync(image, '<svg/>')
    await expect(outgoing(project, 'x', [picked!])).rejects.toThrow(tr('attach.notImage', { name: 'changed.png' }))
    await expect(outgoing(project, 'x', [{ kind: 'file', path: path.join(outside, 'gone.txt'), name: 'gone.txt', size: 1 }])).rejects.toThrow(
      tr('attach.unreadable', { name: 'gone.txt' }),
    )
  })
})

describe('화면 칩', () => {
  it('크기 글자: B · KB · MB', () => {
    expect(sizeLabel(512)).toBe('512B')
    expect(sizeLabel(12 * 1024)).toBe('12KB')
    expect(sizeLabel(1536)).toBe('1.5KB')
    expect(sizeLabel(3 * 1024 * 1024)).toBe('3MB')
  })

  it('말풍선 칩은 경로 없이, 파일 먼저 이미지 나중 (다시 열었을 때와 같은 순서)', () => {
    expect(
      chipsOf([
        { kind: 'image', path: '/x/a.png', name: 'a.png', size: 9 },
        { kind: 'file', path: '/x/b.md', name: 'b.md', size: 3 },
      ]),
    ).toEqual([
      { kind: 'file', name: 'b.md', size: 3 },
      { kind: 'image', name: 'a.png', size: 9 },
    ])
  })
})
