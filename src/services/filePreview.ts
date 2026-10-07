import fs from 'node:fs/promises'
import path from 'node:path'
import { projectFile } from './fileMentions.ts'

// 파일 미리보기 패널 (이슈 #17) — 답의 파일 칩을 누르면 채팅 오른쪽에 그 파일 내용을 보인다. 읽기만 한다.
// 화면은 경로를 보내지 않고 칩과 같은 (프로젝트 폴더, 답에 적힌 글자) 만 보낸다. 판정은 칩과 같은 projectFile —
// realpath 로 풀어 프로젝트 안의 일반 파일일 때만(심볼릭 링크로 밖을 가리키면 거부). 칩이 그려진 뒤 파일이 링크로 바뀌어도 여기서 다시 걸린다.
// 큰 파일은 앞 PREVIEW_LIMIT 바이트만, 이진 파일(NUL 바이트·UTF-8 아님)은 내용을 주지 않는다.

/** 읽는 최대 바이트 — 넘으면 앞부분만 (dsh 미리보기도 한 번에 다 읽지 않는다) */
export const PREVIEW_LIMIT = 1024 * 1024
/** 이진 판정에 NUL 을 찾는 앞부분 (git 과 같은 8000 바이트) */
const SNIFF = 8_000

// 이미지·PDF (이슈 #214) — 종류는 확장자와 머리 바이트가 둘 다 맞을 때만(이름만 .png 인 글은 글로 보인다). 이미지는 data: 주소로만 준다:
// 화면은 그것을 <img> 로만 그린다 — 바깥 요청 0, SVG 도 이미지로 그려져 스크립트·외부 리소스가 돌지 않는다(인라인으로 넣지 않는다).
// 한 장이 IMAGE_PREVIEW_LIMIT 를 넘으면 읽지 않는다(tooLarge). PDF 는 내용을 주지 않는다 — 화면이 "기본 앱에서 열기"(ctx.openIn.openFile)로 넘긴다.
// 경로 검사는 글 파일과 같은 projectFile 그대로다.

/** 패널이 그리는 이미지 한 장의 상한 — 첨부 이미지(shared/attachments.ts imageBytes)와 같은 20MB */
export const IMAGE_PREVIEW_LIMIT = 20 * 1024 * 1024

export type PreviewImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/svg+xml'

const PANEL_KINDS: Record<string, PreviewImageMime | 'pdf'> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'pdf',
}

/** 머리 바이트가 그 종류인가 — svg 는 글이라 머리로 가르지 않는다(읽은 뒤 `<svg` 를 본다) */
function headMatches(kind: PreviewImageMime | 'pdf', head: Buffer): boolean {
  const at = (offset: number, magic: string | number[]) =>
    (typeof magic === 'string' ? Buffer.from(magic, 'latin1') : Buffer.from(magic)).equals(head.subarray(offset, offset + magic.length))
  switch (kind) {
    case 'image/png':
      return at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'image/jpeg':
      return at(0, [0xff, 0xd8, 0xff])
    case 'image/gif':
      return at(0, 'GIF87a') || at(0, 'GIF89a')
    case 'image/webp':
      return at(0, 'RIFF') && at(8, 'WEBP')
    case 'pdf':
      return at(0, '%PDF-')
    case 'image/svg+xml':
      return true
  }
}

export type FilePreview =
  /** 프로젝트 밖·없는 파일·폴더·링크로 밖 — 이유를 가르지 않는다(밖에 무엇이 있는지 알려 주지 않으려고) */
  | { status: 'unavailable' }
  | { status: 'binary'; path: string; absolute: string; size: number }
  | { status: 'text'; path: string; absolute: string; size: number; text: string; truncated: boolean }
  /** 이미지 — dataUrl 은 data:<mime>;base64. svg 면 source 에 원문(원문 보기) */
  | { status: 'image'; path: string; absolute: string; size: number; mime: PreviewImageMime; dataUrl: string; source?: string }
  /** 이미지인데 상한(limit)을 넘어 읽지 않았다 */
  | { status: 'tooLarge'; path: string; absolute: string; size: number; limit: number }
  /** PDF — 내용 없이 */
  | { status: 'pdf'; path: string; absolute: string; size: number }

/** token 이 프로젝트 안의 파일이면 그 내용(앞 limit 바이트, 이미지는 imageLimit 까지 통째로). path 는 프로젝트 기준 상대 경로, absolute 는 realpath */
export async function previewFile(directory: string, token: string, limit = PREVIEW_LIMIT, imageLimit = IMAGE_PREVIEW_LIMIT): Promise<FilePreview> {
  if (typeof directory !== 'string' || typeof token !== 'string') return { status: 'unavailable' }
  const absolute = await projectFile(directory, token)
  if (!absolute) return { status: 'unavailable' }
  const relative = path.relative(await fs.realpath(directory), absolute)
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(absolute, 'r')
    const { size } = await handle.stat()
    const kind = PANEL_KINDS[path.extname(absolute).toLowerCase()]
    if (kind) {
      const head = Buffer.alloc(Math.min(size, 16))
      await handle.read(head, 0, head.length, 0)
      if (headMatches(kind, head)) {
        if (kind === 'pdf') return { status: 'pdf', path: relative, absolute, size }
        if (size > imageLimit) return { status: 'tooLarge', path: relative, absolute, size, limit: imageLimit }
        const bytes = Buffer.alloc(size)
        const { bytesRead } = await handle.read(bytes, 0, size, 0)
        const data = bytes.subarray(0, bytesRead)
        const source = kind === 'image/svg+xml' ? decodeText(data, false) : undefined
        // svg 라는 이름인데 글이 아니거나 <svg 가 없으면 아래의 글·이진 판정으로
        if (kind !== 'image/svg+xml' || (source !== undefined && /<svg[\s>]/i.test(source))) {
          return { status: 'image', path: relative, absolute, size, mime: kind, dataUrl: `data:${kind};base64,${data.toString('base64')}`, ...(source !== undefined && { source }) }
        }
      }
    }
    const buffer = Buffer.alloc(Math.min(size, limit))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const bytes = buffer.subarray(0, bytesRead)
    const text = decodeText(bytes, size > bytesRead)
    if (text === undefined) return { status: 'binary', path: relative, absolute, size }
    return { status: 'text', path: relative, absolute, size, text, truncated: size > bytesRead }
  } catch {
    return { status: 'unavailable' }
  } finally {
    await handle?.close()
  }
}

// HTML 미리보기의 같은 폴더 리소스 (이슈 #29) — dsh ui-sidebar-documentpreview html/pack·read-relative 참조: 문서가 직접 적은 상대 경로
// 스크립트·스타일시트만 읽어 iframe 안에서 바꿔 끼운다(iframe 은 파일을 직접 못 읽는다). 한도도 dsh 와 같다(하나 4MB, 합 32MB, 64개).
// 다른 점: 이미지(img src)도 data: 주소로 넣고, 못 읽은 리소스는 미리보기 전체를 실패시키지 않고 빼기만 한다(브라우저가 없는 파일을
// 만났을 때처럼). 판정은 칩·미리보기와 같은 projectFile — 프로젝트 밖·링크로 밖은 없는 파일과 똑같이 빠진다.

const MAX_ASSET_BYTES = 4 * 1024 * 1024
const MAX_ASSETS_BYTES = 32 * 1024 * 1024
const MAX_ASSETS = 64
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
}

/** 스크립트·스타일은 text, 이미지는 dataUrl. reference 는 문서에 적힌 글자 그대로 */
export type HtmlAsset = { reference: string; text: string } | { reference: string; dataUrl: string }

/** htmlToken(프로젝트 안 HTML 파일) 폴더 기준으로 references 를 읽는다. 읽은 것만 순서대로 */
export async function readHtmlAssets(directory: string, htmlToken: string, references: readonly unknown[]): Promise<HtmlAsset[]> {
  if (typeof directory !== 'string' || typeof htmlToken !== 'string' || !Array.isArray(references)) return []
  const html = await projectFile(directory, htmlToken)
  if (!html) return []
  const base = path.relative(await fs.realpath(directory), path.dirname(html))
  const assets: HtmlAsset[] = []
  let total = 0
  for (const reference of [...new Set(references)].slice(0, MAX_ASSETS)) {
    if (typeof reference !== 'string' || !isRelativeReference(reference)) continue
    const cut = reference.search(/[?#]/)
    let relative: string
    try {
      relative = decodeURIComponent(cut === -1 ? reference : reference.slice(0, cut))
    } catch {
      continue
    }
    if (!relative || relative.includes('\\') || relative.includes('\0')) continue
    const file = await projectFile(directory, path.join(base, relative))
    if (!file) continue
    try {
      const { size } = await fs.stat(file)
      if (size > MAX_ASSET_BYTES || total + size > MAX_ASSETS_BYTES) continue
      const bytes = await fs.readFile(file)
      total += bytes.length
      const image = IMAGE_TYPES[path.extname(file).toLowerCase()]
      if (image) {
        assets.push({ reference, dataUrl: `data:${image};base64,${bytes.toString('base64')}` })
        continue
      }
      const text = decodeText(bytes, false)
      if (text !== undefined) assets.push({ reference, text })
    } catch {
      // 읽는 사이 사라진 파일 — 뺀다
    }
  }
  return assets
}

/** 문서 폴더 기준으로 읽을 수 있는 글자인가 — 스킴(https:·data:)·절대 경로(/)·조각(#)·쿼리(?)로 시작하면 아니다 (dsh pack.ts 와 같은 판정) */
function isRelativeReference(reference: string): boolean {
  return reference.length > 0 && reference.length <= 1_000 && !/^(?:[a-z][a-z\d+.-]*:|[/\\#?])/i.test(reference) && !reference.includes('\0')
}

/** UTF-8 글이면 그 문자열, 이진이면 undefined. 잘린 끝(cut)의 덜 끝난 글자는 이진으로 보지 않고 버린다 */
function decodeText(bytes: Buffer, cut: boolean): string | undefined {
  if (bytes.subarray(0, SNIFF).includes(0)) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: cut })
  } catch {
    return undefined
  }
}
