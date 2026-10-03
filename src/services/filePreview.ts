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

export type FilePreview =
  /** 프로젝트 밖·없는 파일·폴더·링크로 밖 — 이유를 가르지 않는다(밖에 무엇이 있는지 알려 주지 않으려고) */
  | { status: 'unavailable' }
  | { status: 'binary'; path: string; absolute: string; size: number }
  | { status: 'text'; path: string; absolute: string; size: number; text: string; truncated: boolean }

/** token 이 프로젝트 안의 파일이면 그 내용(앞 limit 바이트). path 는 프로젝트 기준 상대 경로, absolute 는 realpath */
export async function previewFile(directory: string, token: string, limit = PREVIEW_LIMIT): Promise<FilePreview> {
  if (typeof directory !== 'string' || typeof token !== 'string') return { status: 'unavailable' }
  const absolute = await projectFile(directory, token)
  if (!absolute) return { status: 'unavailable' }
  const relative = path.relative(await fs.realpath(directory), absolute)
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(absolute, 'r')
    const { size } = await handle.stat()
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
