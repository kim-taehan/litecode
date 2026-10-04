import fs from 'node:fs/promises'
import path from 'node:path'
import { ATTACHMENT_LIMITS } from '../../shared/attachments.ts'
import type { AttachmentKind, AttachmentPick, PickedAttachment } from '../../shared/contract.ts'
import { tr } from '../i18n.ts'
import { reference } from '../triggers/at.ts'
import type { ChatImage } from './llm.ts'
import type { PastedImages } from './pastedImages.ts'

// 메시지 첨부 (이슈 #44, 실측 _workspace/01y_attachments.md — opencode 1.18.18 레거시). 화면은 경로만 들고 읽기는 여기(메인)서 한다.
// - **이미지**: 앱이 읽어 ctx.llm 에 바이트로 넘긴다(ctx.llm 이 data: file 파트로 싣는다). file:// 로 넘기지 않는 이유 — 없는 파일·깨진
//   이미지·svg 는 opencode 에서 user 메시지도 idle 도 없이 session.error 하나만 온다. 그래서 확장자가 아니라 매직 바이트로 png·jpeg 만 받는다
//   (gif·webp 는 실측하지 않았다)
// - **글 파일은 file 파트로 보내지 않는다**: mime 이 `application/json`·`octet-stream` 이면 그 세션의 모든 턴이 실패한다(12/12). 확장자 →
//   mime 추측에 세션 생사를 걸지 않는다. 프로젝트 안이면 `@경로` 글자(`@` 트리거와 같은 모양 — 모델이 read 도구로 읽는다), 밖이면 읽어서 글로
// - 칩을 만들 때(pickAttachments)와 보낼 때(outgoing) 두 번 거른다 — 그 사이에 파일이 바뀌거나 사라질 수 있다

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG = [0xff, 0xd8, 0xff]

/** 매직 바이트로 본 이미지 종류 — png·jpeg 가 아니면 undefined */
export function imageMime(data: Uint8Array): ChatImage['mime'] | undefined {
  const startsWith = (magic: number[]) => data.length >= magic.length && magic.every((byte, index) => data[index] === byte)
  if (startsWith(PNG)) return 'image/png'
  if (startsWith(JPEG)) return 'image/jpeg'
  return undefined
}

/** 머리에서 읽은 가로·세로 (전체를 풀지 않는다) — png 는 IHDR, jpeg 는 첫 SOF 조각. 못 읽으면 undefined */
export function imageSize(data: Uint8Array): { width: number; height: number } | undefined {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const mime = imageMime(data)
  if (mime === 'image/png') {
    // [서명 8][길이 4]['IHDR' 4][가로 4][세로 4]
    if (data.length < 24 || String.fromCharCode(...data.subarray(12, 16)) !== 'IHDR') return undefined
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (mime !== 'image/jpeg') return undefined
  // 조각: ff <표식> [길이 2 — 자신 포함] … SOF(c0~cf 중 c4·c8·cc 제외)는 [길이 2][정밀도 1][세로 2][가로 2]
  let at = 2
  while (at + 4 <= data.length) {
    if (data[at] !== 0xff) return undefined
    const marker = data[at + 1]!
    if (marker === 0xff) {
      at++ // 채움 바이트
      continue
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return at + 9 <= data.length ? { width: view.getUint16(at + 7), height: view.getUint16(at + 5) } : undefined
    }
    if (marker === 0xd9 || marker === 0xda) return undefined // 끝·압축 본문 — SOF 없이 여기까지 왔다
    at += 2 + (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) ? 0 : view.getUint16(at + 2)) // 길이 없는 표식
  }
  return undefined
}

/** 글자 파일인가 — NUL 바이트가 없고 UTF-8 로 읽힌다 */
export function isText(data: Uint8Array): boolean {
  if (data.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data)
    return true
  } catch {
    return false
  }
}

/** 파일 하나를 읽어 붙일 수 있는지 본다 — 못 붙이면 지금 언어의 사유 */
async function inspect(kind: AttachmentKind, file: string): Promise<{ item: PickedAttachment; data: Buffer } | { error: string }> {
  const name = path.basename(file)
  const image = kind === 'image'
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) return { error: tr('attach.notFile', { name }) }
    if (image && stat.size > ATTACHMENT_LIMITS.imageBytes) return { error: tr('attach.imageTooLarge', { name, max: ATTACHMENT_LIMITS.imageBytes / 1024 / 1024 }) }
    if (!image && stat.size > ATTACHMENT_LIMITS.fileBytes) return { error: tr('attach.fileTooLarge', { name, max: ATTACHMENT_LIMITS.fileBytes / 1024 }) }
    const data = await fs.readFile(file)
    if (image ? !imageMime(data) : !isText(data)) return { error: tr(image ? 'attach.notImage' : 'attach.notText', { name }) }
    // 가로·세로를 못 읽은 이미지는 전처럼 둔다 — 여기서 거르는 것은 "읽어 보니 너무 큰" 것뿐이다
    const size = image ? imageSize(data) : undefined
    if (size && (Math.max(size.width, size.height) > ATTACHMENT_LIMITS.imageSide || size.width * size.height > ATTACHMENT_LIMITS.imagePixels)) {
      return { error: tr('attach.imageTooManyPixels', { name, width: size.width, height: size.height, side: ATTACHMENT_LIMITS.imageSide }) }
    }
    return { item: { kind, path: file, name, size: data.length }, data }
  } catch {
    return { error: tr('attach.unreadable', { name }) }
  }
}

/** OS 파일 고르기가 준 경로들 → 칩. held 는 그 메시지에 이미 붙은 같은 종류의 수 — 합쳐 상한을 넘는 것은 칩을 만들지 않는다 */
export async function pickAttachments(kind: AttachmentKind, files: readonly string[], held: number): Promise<AttachmentPick> {
  const max = kind === 'image' ? ATTACHMENT_LIMITS.images : ATTACHMENT_LIMITS.files
  const picked: PickedAttachment[] = []
  const rejected: string[] = []
  let over = false
  for (const file of new Set(files)) {
    const result = await inspect(kind, file)
    if ('error' in result) rejected.push(result.error)
    else if (held + picked.length >= max) over = true
    else picked.push(result.item)
  }
  if (over) rejected.push(tr(kind === 'image' ? 'attach.tooManyImages' : 'attach.tooManyFiles', { max }))
  return { picked, rejected }
}

// 붙여넣기·끌어다 놓기 (이슈 #80) — 파일 고르기와 달리 종류를 사용자가 고르지 않는다. 메인이 파일을 보고 정한 뒤 고르기와 같은 검사(inspect)를 한다

/** png·jpeg 가 아닌 이미지 확장자 — 글 파일로 보면 "글자 파일만" 으로 거절되므로 이미지로 봐서 "PNG·JPEG 만" 사유가 나오게 한다 */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.heif', '.tif', '.tiff', '.avif', '.ico'])

/** 놓인 파일의 종류 — 머리 바이트가 png·jpeg 이거나 이름이 이미지 확장자면 이미지, 아니면 글 파일 */
export function droppedKind(name: string, head: Uint8Array): AttachmentKind {
  return imageMime(head) || IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()) ? 'image' : 'file'
}

/** 파일 머리 8바이트 — 못 읽으면(폴더·없는 파일) 빈 것. 사유는 뒤의 inspect 가 낸다 */
async function headOf(file: string): Promise<Uint8Array> {
  const handle = await fs.open(file, 'r').catch(() => undefined)
  if (!handle) return new Uint8Array()
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(PNG.length), 0, PNG.length, 0)
    return buffer.subarray(0, bytesRead)
  } catch {
    return new Uint8Array()
  } finally {
    await handle.close()
  }
}

const maxOf = (kind: AttachmentKind): number => (kind === 'image' ? ATTACHMENT_LIMITS.images : ATTACHMENT_LIMITS.files)

/** 놓거나 붙여넣은 경로들 → 칩. held 는 그 메시지에 이미 붙은 종류별 수, imageInput 은 그 대화의 모델이 이미지를 받는가 —
 *  안 받으면 이미지는 칩을 만들지 않는다(사유 한 번). 폴더·바이너리·상한은 고르기와 같은 사유 */
export async function attachDropped(files: readonly string[], held: Record<AttachmentKind, number>, imageInput: boolean): Promise<AttachmentPick> {
  const picked: PickedAttachment[] = []
  const rejected: string[] = []
  const count = { file: Number(held.file) || 0, image: Number(held.image) || 0 }
  const over = new Set<AttachmentKind>()
  let blocked = false
  for (const file of new Set(files)) {
    const kind = droppedKind(path.basename(file), await headOf(file))
    if (kind === 'image' && !imageInput) {
      blocked = true
      continue
    }
    const result = await inspect(kind, file)
    if ('error' in result) rejected.push(result.error)
    else if (count[kind] >= maxOf(kind)) over.add(kind)
    else {
      picked.push(result.item)
      count[kind]++
    }
  }
  if (blocked) rejected.push(tr('plus.menu.image.blocked'))
  for (const kind of ['image', 'file'] as const) if (over.has(kind)) rejected.push(tr(kind === 'image' ? 'attach.tooManyImages' : 'attach.tooManyFiles', { max: maxOf(kind) }))
  return { picked, rejected }
}

/** 경로 없이 온 이미지 하나 (붙여넣은 스크린숏) — data 가 없으면 화면이 너무 커서 읽지 않고 넘긴 것 */
export interface PastedBlob {
  name: string
  data?: Uint8Array
}

/** 경로 없는 이미지 바이트 → 임시 파일(PastedImages) → 칩. png·jpeg 만. 칩이 못 된 것은 임시 파일을 남기지 않는다 */
export async function attachPasted(
  store: PastedImages,
  conversationId: string,
  blobs: readonly PastedBlob[],
  held: Record<AttachmentKind, number>,
  imageInput: boolean,
): Promise<AttachmentPick> {
  if (blobs.length === 0) return { picked: [], rejected: [] }
  if (!imageInput) return { picked: [], rejected: [tr('plus.menu.image.blocked')] }
  const early: string[] = []
  const stored: string[] = []
  for (const { name, data } of blobs) {
    if (!(data instanceof Uint8Array) || data.length > ATTACHMENT_LIMITS.imageBytes) {
      early.push(tr('attach.imageTooLarge', { name, max: ATTACHMENT_LIMITS.imageBytes / 1024 / 1024 }))
      continue
    }
    const mime = imageMime(data)
    if (!mime) early.push(tr('attach.notImage', { name }))
    else stored.push(await store.store(conversationId, data, mime))
  }
  const result = await attachDropped(stored, held, imageInput) // 픽셀·개수 상한은 고른 파일과 같은 검사로
  await store.discard(stored.filter((file) => !result.picked.some((item) => item.path === file)))
  return { picked: result.picked, rejected: [...early, ...result.rejected] }
}

/** 프로젝트 폴더 기준 상대 경로(`/` 구분) — 폴더 밖이면 undefined. 둘 다 realpath 한 값이어야 한다 (링크로 밖을 가리키면 밖이다) */
function insideOf(root: string, file: string): string | undefined {
  const relative = path.relative(root, file)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined
  return relative.split(path.sep).join('/')
}

/** 파일 이름을 머리로 한 코드 블록 — 울타리는 본문의 가장 긴 백틱 줄보다 길게 */
function fileBlock(name: string, content: string): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${name}:\n${fence}\n${content}${content.endsWith('\n') ? '' : '\n'}${fence}`
}

/** 보낼 글과 이미지 — 프로젝트 안 글 파일은 글 끝에 `@상대경로`, 밖의 글 파일은 그 뒤에 코드 블록으로, 이미지는 읽은 바이트로.
 *  다시 걸러서 못 붙이는 것이 있으면 그 사유로 거절한다(통째로 — 일부만 빠진 메시지를 보내지 않는다) */
export async function outgoing(directory: string, text: string, attachments: readonly PickedAttachment[]): Promise<{ text: string; images: ChatImage[] }> {
  const root = await fs.realpath(directory).catch(() => undefined) // 폴더가 없으면 ctx.llm 이 그 사유로 거절한다
  const mentions: string[] = []
  const blocks: string[] = []
  const images: ChatImage[] = []
  for (const attachment of attachments) {
    const kind: AttachmentKind = attachment.kind === 'image' ? 'image' : 'file'
    const result = await inspect(kind, String(attachment.path))
    if ('error' in result) throw new Error(result.error)
    const { item, data } = result
    if (kind === 'image') {
      images.push({ mime: imageMime(data)!, filename: item.name, data })
      continue
    }
    const relative = root && insideOf(root, await fs.realpath(item.path))
    if (relative) mentions.push(reference(relative))
    else blocks.push(fileBlock(item.name, data.toString('utf8')))
  }
  return { text: [text.trim(), mentions.join(' '), ...blocks].filter(Boolean).join('\n\n'), images }
}
