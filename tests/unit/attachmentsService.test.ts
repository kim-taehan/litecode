import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context, Service } from 'cordis'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { AttachmentsService, type AttachmentsHost, type ChooseFilesRequest } from '../../src/services/attachmentsService.ts'
import { tr } from '../../src/i18n.ts'

// ctx.attachments (이슈 #97) — 첨부를 칩으로 만드는 조립(고르기·놓기·붙여넣기)과 붙여넣은 이미지의 임시 파일을 서비스가 쥔다.
// 진짜 Cordis Context 에 올린다. OS 파일 고르기는 기록하는 host, ctx.chat 은 허용 목록·이미지 입력만 흉내 낸다.
// 종류·상한·사유 판정 자체는 attachments.test.ts·dropPaste.test.ts 가 지킨다 — 여기는 서비스가 그것을 잇는 방식만 본다

/** 이 파일이 만든 임시 폴더 — 끝나면 이 경로만 지운다 */
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'litecode-attachsvc-')))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const write = (name: string, data: string | Buffer): string => {
  const file = path.join(root, name)
  fs.writeFileSync(file, data)
  return file
}
const model = { providerId: 'p', modelId: 'm' }

class FakeChat extends Service {
  allowed: string[] = []
  images = true
  asked: unknown[] = []
  constructor(ctx: Context) {
    super(ctx, 'chat')
  }
  allowAttachments(paths: readonly string[]): void {
    this.allowed.push(...paths)
  }
  acceptsImages(asked: unknown): boolean {
    this.asked.push(asked)
    return this.images
  }
}

let seq = 0
const live: { dispose(): Promise<void> | undefined }[] = []
afterEach(async () => {
  for (const fiber of live.splice(0).reverse()) await Promise.resolve(fiber.dispose()).catch(() => {}) // 이미 내린 것은 undefined 를 준다
})

async function start(answer: string[] | undefined = undefined, seed?: (pastedDir: string) => void) {
  const pastedDir = path.join(root, `pasted-${++seq}`)
  seed?.(pastedDir)
  const calls: { request: ChooseFilesRequest; owner: unknown }[] = []
  const host: AttachmentsHost = {
    chooseFiles: async (request, owner) => {
      calls.push({ request, owner })
      return answer
    },
  }
  const ctx = new Context()
  const chatFiber = ctx.plugin(FakeChat)
  const fiber = ctx.plugin(AttachmentsService, { host, pastedDir })
  live.push(chatFiber, fiber)
  const attachments = await new Promise<AttachmentsService>((resolve) => ctx.inject(['attachments'], (ready) => resolve(ready.attachments)))
  return { ctx, attachments, chat: ctx.chat as unknown as FakeChat, calls, pastedDir, fiber }
}

/** 조건이 될 때까지 기다린다 — 이벤트 리스너의 지우기는 비동기다 */
async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !done(); tries++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(done()).toBe(true)
}

describe('pick — 파일 고르기', () => {
  it('취소하면 칩도 허용도 없다', async () => {
    const { attachments, chat, calls } = await start(undefined)
    expect(await attachments.pick('file', root, 0)).toEqual({ picked: [], rejected: [] })
    expect(calls).toHaveLength(1)
    expect(chat.allowed).toEqual([])
  })

  it('글 파일 — 프로젝트 폴더에서 열고, 칩이 된 경로만 ctx.chat 에 허용으로 적는다', async () => {
    const text = write('notes.md', '# 메모\n')
    const binary = write('blob.bin', Buffer.from([1, 0, 2]))
    const owner = { window: 1 }
    const { attachments, chat, calls } = await start([text, binary])
    const result = await attachments.pick('file', root, 0, owner)
    expect(calls).toEqual([{ request: { defaultPath: root }, owner }])
    expect(result.picked).toEqual([{ kind: 'file', path: text, name: 'notes.md', size: Buffer.byteLength('# 메모\n') }])
    expect(result.rejected).toEqual([tr('attach.notText', { name: 'blob.bin' })])
    expect(chat.allowed).toEqual([text])
  })

  it('폴더가 글자가 아니면 처음 열 폴더를 주지 않는다', async () => {
    const { attachments, calls } = await start(undefined)
    await attachments.pick('file', undefined, 0)
    expect(calls[0]!.request).toEqual({})
  })

  it('이미지 — png·jpeg 거르개로 열고(폴더는 주지 않는다), 이미 붙은 수와 합쳐 상한을 본다', async () => {
    const image = write('shot.png', PNG)
    const { attachments, chat, calls } = await start([image])
    expect((await attachments.pick('image', root, 0)).picked).toEqual([{ kind: 'image', path: image, name: 'shot.png', size: PNG.length }])
    expect(calls[0]!.request).toEqual({ filters: [{ name: tr('attach.imageFilter'), extensions: ['png', 'jpg', 'jpeg'] }] })
    expect(chat.allowed).toEqual([image])
    const full = await attachments.pick('image', root, 5)
    expect(full.picked).toEqual([])
    expect(full.rejected).toHaveLength(1)
    expect(chat.allowed).toEqual([image])
  })

  it('종류가 image 가 아니면 글 파일로, held 가 수가 아니면 0 으로 본다', async () => {
    const text = write('plain.txt', 'hi')
    const { attachments } = await start([text])
    const result = await attachments.pick('other' as never, root, 'x')
    expect(result.picked.map((item) => item.kind)).toEqual(['file'])
  })
})

describe('drop — 놓기·붙여넣기', () => {
  it('놓은 경로와 경로 없는 이미지를 한 결과로 — 붙여넣은 것은 임시 파일이 되고 둘 다 허용에 적힌다', async () => {
    const text = write('drop.md', 'x')
    const { attachments, chat, pastedDir } = await start()
    const result = await attachments.drop('c1', { paths: [text], blobs: [{ name: 'image.png', data: new Uint8Array(PNG) }] }, undefined, model)
    expect(result.rejected).toEqual([])
    expect(result.picked.map((item) => item.kind)).toEqual(['file', 'image'])
    const stored = result.picked[1]!.path
    expect(path.dirname(stored)).toBe(pastedDir)
    expect(fs.readFileSync(stored)).toEqual(PNG)
    expect(chat.allowed).toEqual([text, stored])
    expect(chat.asked).toEqual([model])
  })

  it('모양이 틀린 입력은 버린다 — 상대 경로·글자가 아닌 것·배열이 아닌 것', async () => {
    const { attachments, chat } = await start()
    expect(await attachments.drop('c1', { paths: ['relative.md', 3, null], blobs: 'no' }, undefined, model)).toEqual({ picked: [], rejected: [] })
    expect(await attachments.drop('c1', undefined, undefined, model)).toEqual({ picked: [], rejected: [] })
    expect(chat.allowed).toEqual([])
  })

  it('모델이 이미지를 안 받으면(또는 모델이 없으면) 이미지는 칩이 안 되고 사유는 한 번, 임시 파일도 없다', async () => {
    const image = write('blocked.png', PNG)
    const { attachments, chat, pastedDir } = await start()
    chat.images = false
    const blocked = { picked: [], rejected: [tr('plus.menu.image.blocked')] }
    expect(await attachments.drop('c1', { paths: [image], blobs: [{ name: 'image.png', data: new Uint8Array(PNG) }] }, undefined, model)).toEqual(blocked)
    chat.images = true
    expect(await attachments.drop('c1', { paths: [image] }, undefined, undefined)).toEqual(blocked)
    expect(chat.asked).toEqual([model]) // 모델이 없으면 ctx.chat 에 묻지도 않는다
    expect(chat.allowed).toEqual([])
    expect(fs.existsSync(pastedDir) ? fs.readdirSync(pastedDir) : []).toEqual([])
  })

  it('이미 붙은 수 + 놓은 경로 + 붙여넣은 것을 합쳐 상한을 본다', async () => {
    const image = write('fifth.png', PNG)
    const { attachments, pastedDir } = await start()
    const result = await attachments.drop('c1', { paths: [image], blobs: [{ name: 'image.png', data: new Uint8Array(PNG) }] }, { image: 4 }, model)
    expect(result.picked.map((item) => item.path)).toEqual([image])
    expect(result.rejected).toHaveLength(1)
    expect(fs.readdirSync(pastedDir)).toEqual([]) // 칩이 못 된 붙여넣기는 파일을 남기지 않는다
  })
})

describe('붙여넣은 이미지의 임시 파일 정리', () => {
  const paste = async (attachments: AttachmentsService, conversationId: string): Promise<string> =>
    (await attachments.drop(conversationId, { blobs: [{ name: 'image.png', data: new Uint8Array(PNG) }] }, undefined, model)).picked[0]!.path

  it('뜰 때 앞 실행이 남긴 폴더를 비운다 (붙여넣기는 그 뒤에 파일을 둔다)', async () => {
    let leftover = ''
    const { attachments, pastedDir } = await start(undefined, (dir) => {
      fs.mkdirSync(dir, { recursive: true })
      leftover = path.join(dir, 'pasted-old.png')
      fs.writeFileSync(leftover, PNG)
    })
    const stored = await paste(attachments, 'c1')
    expect(fs.readdirSync(pastedDir)).toEqual([path.basename(stored)])
    expect(fs.existsSync(leftover)).toBe(false)
  })

  it('discard — 칩을 빼면 이 서비스가 만든 것만 지운다 (고른 파일·모양이 틀린 입력은 그대로)', async () => {
    const mine = write('keep.png', PNG)
    const { attachments } = await start()
    const stored = await paste(attachments, 'c1')
    await attachments.discard([stored, mine, 7])
    await attachments.discard('nope')
    expect(fs.existsSync(stored)).toBe(false)
    expect(fs.existsSync(mine)).toBe(true)
  })

  it("보낸 뒤 ('chat/attachments-read') 그 파일을 지운다", async () => {
    const { ctx, attachments } = await start()
    const sent = await paste(attachments, 'c1')
    const draft = await paste(attachments, 'c1')
    ctx.emit('chat/attachments-read', [sent])
    await until(() => !fs.existsSync(sent))
    expect(fs.existsSync(draft)).toBe(true)
  })

  it("대화를 지우면 ('sessions/removed') 그 대화의 것만 지운다", async () => {
    const { ctx, attachments } = await start()
    const gone = await paste(attachments, 'c1')
    const kept = await paste(attachments, 'c2')
    ctx.emit('sessions/removed', ['c1'])
    await until(() => !fs.existsSync(gone))
    expect(fs.existsSync(kept)).toBe(true)
  })

  it('서비스가 내려가면 폴더째 비운다', async () => {
    const { ctx, attachments, pastedDir, fiber } = await start()
    await paste(attachments, 'c1')
    await fiber.dispose()
    await until(() => !fs.existsSync(pastedDir))
    expect(ctx.get('attachments')).toBeUndefined()
  })
})
