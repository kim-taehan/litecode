import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ATTACHMENT_LIMITS } from '../../shared/attachments.ts'
import { attachDropped, attachPasted, droppedKind } from '../../src/services/attachments.ts'
import { PastedImages } from '../../src/services/pastedImages.ts'
import { tr } from '../../src/i18n.ts'
import { carriesFiles, dragDepth, pasteIntent } from '../../renderer/dropPaste.ts'

// 첨부 붙여넣기·끌어다 놓기 (이슈 #80). 파일 고르기와 달리 종류를 사용자가 고르지 않는다 — 메인이 파일을 보고 정한다.
// 경로 없는 이미지(스크린숏)는 메인이 앱 폴더에 임시 파일로 두고, 보냄·칩 삭제·대화 삭제·앱 시작/종료 때 지운다

/** 이 파일이 만든 임시 폴더 — 끝나면 이 경로만 지운다 */
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'litecode-droppaste-')))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46])
const write = (name: string, data: string | Buffer): string => {
  const file = path.join(root, name)
  fs.writeFileSync(file, data)
  return file
}
const none = { file: 0, image: 0 }

describe('droppedKind — 놓인 파일의 종류', () => {
  it('png·jpeg 매직 바이트면 이미지 (확장자와 달라도)', () => {
    expect(droppedKind('shot.png', PNG)).toBe('image')
    expect(droppedKind('notes.txt', JPEG)).toBe('image')
  })

  it('그 밖의 이미지 확장자도 이미지로 본다 — "PNG·JPEG 만" 사유로 거절되게', () => {
    for (const name of ['a.gif', 'b.WEBP', 'c.heic', 'd.bmp', 'e.png']) expect(droppedKind(name, Buffer.from('GIF89a'))).toBe('image')
  })

  it('나머지는 글 파일 (svg 는 글이다)', () => {
    expect(droppedKind('notes.md', Buffer.from('# hi'))).toBe('file')
    expect(droppedKind('icon.svg', Buffer.from('<svg/>'))).toBe('file')
    expect(droppedKind('Makefile', Buffer.alloc(0))).toBe('file')
  })
})

describe('attachDropped — 놓거나 붙여넣은 경로를 칩으로', () => {
  it('이미지와 글 파일을 섞어 놓으면 각자 종류의 칩', async () => {
    const image = write('shot.png', PNG)
    const text = write('notes.md', '# 메모\n')
    const result = await attachDropped([image, text], none, true)
    expect(result.picked).toEqual([
      { kind: 'image', path: image, name: 'shot.png', size: PNG.length },
      { kind: 'file', path: text, name: 'notes.md', size: Buffer.byteLength('# 메모\n') },
    ])
    expect(result.rejected).toEqual([])
  })

  it('폴더·바이너리·gif·없는 파일은 거절 — 고르기와 같은 사유', async () => {
    const folder = path.join(root, 'folder')
    fs.mkdirSync(folder)
    const result = await attachDropped([folder, write('blob.bin', Buffer.from([1, 0, 2])), write('anim.gif', 'GIF89a'), path.join(root, 'none.txt')], none, true)
    expect(result.picked).toEqual([])
    expect(result.rejected).toEqual([
      tr('attach.notFile', { name: 'folder' }),
      tr('attach.notText', { name: 'blob.bin' }),
      tr('attach.notImage', { name: 'anim.gif' }),
      tr('attach.unreadable', { name: 'none.txt' }),
    ])
  })

  it('이미지를 안 받는 모델이면 이미지는 칩이 안 되고 사유 한 번, 글 파일은 붙는다', async () => {
    const result = await attachDropped([write('m1.png', PNG), write('m2.jpg', JPEG), write('m.txt', 'x')], none, false)
    expect(result.picked.map((item) => item.name)).toEqual(['m.txt'])
    expect(result.rejected).toEqual([tr('plus.menu.image.blocked')])
  })

  it('개수 상한은 종류마다 이미 붙은 것과 합쳐 센다', async () => {
    const images = Array.from({ length: 3 }, (_, index) => write(`n${index}.png`, PNG))
    const texts = Array.from({ length: 2 }, (_, index) => write(`n${index}.txt`, 'x'))
    const result = await attachDropped([...images, ...texts], { image: 3, file: 4 }, true)
    expect(result.picked.map((item) => item.name)).toEqual(['n0.png', 'n1.png', 'n0.txt'])
    expect(result.rejected).toEqual([tr('attach.tooManyImages', { max: ATTACHMENT_LIMITS.images }), tr('attach.tooManyFiles', { max: ATTACHMENT_LIMITS.files })])
  })

  it('같은 파일을 두 번 놓으면 한 번만', async () => {
    const file = write('twice.txt', 'x')
    expect((await attachDropped([file, file], none, true)).picked).toHaveLength(1)
  })
})

describe('PastedImages — 경로 없는 이미지의 임시 파일', () => {
  const dir = path.join(root, 'pasted')
  const files = (): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir) : [])

  it('둔 파일은 그 폴더 안에 png·jpg 이름으로, 내용 그대로', async () => {
    const pasted = new PastedImages(dir)
    const file = await pasted.store('c1', PNG, 'image/png')
    expect(path.dirname(file)).toBe(dir)
    expect(path.basename(file)).toMatch(/^pasted-[0-9a-f]+\.png$/)
    expect(fs.readFileSync(file)).toEqual(PNG)
    expect(path.basename(await pasted.store('c1', JPEG, 'image/jpeg'))).toMatch(/\.jpg$/)
    await pasted.reset()
  })

  it('discard 는 자기가 만든 파일만 지운다 — 다른 경로는 건드리지 않는다', async () => {
    const pasted = new PastedImages(dir)
    const mine = await pasted.store('c1', PNG, 'image/png')
    const theirs = write('keep.png', PNG)
    const planted = path.join(dir, 'planted.png') // 같은 폴더여도 이 실행이 만들지 않은 것
    fs.writeFileSync(planted, PNG)
    await pasted.discard([mine, theirs, planted, path.join(dir, '..', 'keep.png')])
    expect(fs.existsSync(mine)).toBe(false)
    expect(fs.existsSync(theirs)).toBe(true)
    expect(fs.existsSync(planted)).toBe(true)
    await pasted.reset()
  })

  it('discardOf 는 그 대화의 것만 지운다', async () => {
    const pasted = new PastedImages(dir)
    const a = await pasted.store('c1', PNG, 'image/png')
    const b = await pasted.store('c2', PNG, 'image/png')
    await pasted.discardOf(['c1'])
    expect([fs.existsSync(a), fs.existsSync(b)]).toEqual([false, true])
    await pasted.reset()
  })

  it('reset 은 폴더를 비운다 (앱 시작·종료 — 앞 실행이 남긴 것 포함), 폴더가 없어도 된다', async () => {
    const pasted = new PastedImages(dir)
    await pasted.store('c1', PNG, 'image/png')
    fs.writeFileSync(path.join(dir, 'left-over.png'), PNG)
    await pasted.reset()
    expect(files()).toEqual([])
    await new PastedImages(path.join(root, 'never-made')).reset()
  })
})

describe('attachPasted — 경로 없는 이미지 바이트', () => {
  const dir = path.join(root, 'pasted-bytes')
  const left = (): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir) : [])

  it('png 는 임시 파일이 되어 이미지 칩으로', async () => {
    const pasted = new PastedImages(dir)
    const result = await attachPasted(pasted, 'c1', [{ name: 'image.png', data: PNG }], none, true)
    expect(result.rejected).toEqual([])
    expect(result.picked).toHaveLength(1)
    expect(result.picked[0]).toMatchObject({ kind: 'image', size: PNG.length })
    expect(path.dirname(result.picked[0]!.path)).toBe(dir)
    await pasted.reset()
  })

  it('png·jpeg 가 아니거나, 너무 크거나, 모델이 이미지를 안 받으면 파일을 남기지 않고 거절', async () => {
    const pasted = new PastedImages(dir)
    const big = Buffer.concat([PNG, Buffer.alloc(ATTACHMENT_LIMITS.imageBytes)])
    expect((await attachPasted(pasted, 'c1', [{ name: 'a.gif', data: Buffer.from('GIF89a') }], none, true)).rejected).toEqual([tr('attach.notImage', { name: 'a.gif' })])
    expect((await attachPasted(pasted, 'c1', [{ name: 'big.png', data: big }], none, true)).rejected).toEqual([tr('attach.imageTooLarge', { name: 'big.png', max: 20 })])
    expect((await attachPasted(pasted, 'c1', [{ name: 'huge.png' }], none, true)).rejected).toEqual([tr('attach.imageTooLarge', { name: 'huge.png', max: 20 })]) // preload 가 읽지 않고 넘긴 것
    expect((await attachPasted(pasted, 'c1', [{ name: 'x.png', data: PNG }], none, false)).rejected).toEqual([tr('plus.menu.image.blocked')])
    expect(left()).toEqual([])
  })

  it('개수 상한을 넘은 것은 임시 파일도 지운다', async () => {
    const pasted = new PastedImages(dir)
    const result = await attachPasted(pasted, 'c1', [{ name: 'a.png', data: PNG }, { name: 'b.png', data: PNG }], { file: 0, image: ATTACHMENT_LIMITS.images - 1 }, true)
    expect(result.picked).toHaveLength(1)
    expect(result.rejected).toEqual([tr('attach.tooManyImages', { max: ATTACHMENT_LIMITS.images })])
    expect(left()).toEqual([path.basename(result.picked[0]!.path)])
    await pasted.reset()
  })
})

describe('화면 판정 (renderer/dropPaste.ts)', () => {
  it('carriesFiles — 끌고 있는 것에 파일이 있나 (글·링크 끌기는 아니다)', () => {
    expect(carriesFiles(['Files'])).toBe(true)
    expect(carriesFiles(['text/plain', 'Files'])).toBe(true)
    expect(carriesFiles(['text/plain', 'text/uri-list'])).toBe(false)
    expect(carriesFiles([])).toBe(false)
  })

  it('pasteIntent — 파일이 없으면 글 (지금처럼)', () => {
    expect(pasteIntent(['text/plain'], 0)).toBe('text')
    expect(pasteIntent([], 0)).toBe('text')
  })

  it('pasteIntent — 스크린숏·Finder 에서 복사한 파일·브라우저에서 복사한 이미지는 첨부', () => {
    expect(pasteIntent(['Files'], 1)).toBe('attach')
    expect(pasteIntent(['text/plain', 'Files'], 2)).toBe('attach') // Finder: 파일 이름이 글로 같이 온다
    expect(pasteIntent(['text/html', 'Files'], 1)).toBe('attach') // 이미지 복사: <img> 만 있고 글은 없다
  })

  it('pasteIntent — 문서 앱에서 복사한 글(글 + 서식 + 그림으로 본 모양)은 글', () => {
    expect(pasteIntent(['text/plain', 'text/html', 'Files'], 1)).toBe('text')
    expect(pasteIntent(['text/plain', 'text/rtf', 'Files'], 1)).toBe('text')
  })

  it('dragDepth — 들어온 만큼 나가야 끝난다, 놓으면 0, 0 아래로 안 간다', () => {
    expect(dragDepth(0, 'enter')).toBe(1)
    expect(dragDepth(2, 'leave')).toBe(1)
    expect(dragDepth(0, 'leave')).toBe(0)
    expect(dragDepth(3, 'drop')).toBe(0)
  })
})
