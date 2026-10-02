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

/** UTF-8 글이면 그 문자열, 이진이면 undefined. 잘린 끝(cut)의 덜 끝난 글자는 이진으로 보지 않고 버린다 */
function decodeText(bytes: Buffer, cut: boolean): string | undefined {
  if (bytes.subarray(0, SNIFF).includes(0)) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: cut })
  } catch {
    return undefined
  }
}
