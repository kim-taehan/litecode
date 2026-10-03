import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

// 오른쪽 패널 Files 탭 (이슈 #29) — 대화 프로젝트 폴더를 한 단계씩 나열한다. dsh ui-sidebar-files + api/workspace-files 참조(동작만,
// 코드는 새로 씀): 펼칠 때 그 폴더만 읽고, 숨김 파일·.git·node_modules 도 다른 항목과 같이 보인다(큰 폴더는 펼치기 전엔 읽지 않으므로
// 비용이 없다), 한 폴더 항목 수 상한(dsh maxEntries 2000)을 넘으면 잘렸다고 알린다. 다른 점: dsh 는 링크를 가리키는 종류로 보이고
// 읽기만 거부하지만, 여기서는 프로젝트 밖을 가리키는 링크는 목록에서 아예 뺀다(밖에 무엇이 있는지 알려 주지 않는다 — 칩 판정과 같은 원칙).

/** 한 폴더에서 주는 최대 항목 수 (dsh workspace-files maxEntries 기본값) */
export const MAX_ENTRIES = 2_000

export interface DirectoryEntry {
  name: string
  /** 링크는 가리키는 것의 종류. 일반 파일·폴더가 아니면(소켓 등) other — 보이되 열 수 없다 */
  type: 'file' | 'directory' | 'other'
}

export type DirectoryListing =
  /** 프로젝트 밖·없는 폴더·파일·링크로 밖 — 이유를 가르지 않는다 */
  | { status: 'unavailable' }
  /** absolute 는 그 폴더의 realpath. entries 는 폴더 먼저, 이름 자연 순서(대소문자 무시) */
  | { status: 'ok'; absolute: string; entries: DirectoryEntry[]; truncated: boolean }

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** relative 는 프로젝트 기준 상대 경로('' = 루트). 풀린 경로가 프로젝트 안의 폴더일 때만 나열한다 */
export async function listDirectory(directory: string, relative: string): Promise<DirectoryListing> {
  if (typeof directory !== 'string' || typeof relative !== 'string') return { status: 'unavailable' }
  if (relative.length > 1_000 || /[\u0000-\u001f]/.test(relative)) return { status: 'unavailable' }
  try {
    const root = await fs.realpath(directory)
    const target = await fs.realpath(path.resolve(root, relative))
    if (target !== root && !target.startsWith(root + path.sep)) return { status: 'unavailable' }
    if (!(await fs.stat(target)).isDirectory()) return { status: 'unavailable' }
    const dirents = await fs.readdir(target, { withFileTypes: true })
    const typed = await Promise.all(dirents.map((dirent) => entryOf(root, target, dirent)))
    const entries = typed
      .filter((entry): entry is DirectoryEntry => entry !== undefined)
      .sort((left, right) => Number(right.type === 'directory') - Number(left.type === 'directory') || byName.compare(left.name, right.name))
    return { status: 'ok', absolute: target, entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES }
  } catch {
    return { status: 'unavailable' }
  }
}

/** 링크는 풀어서 — 프로젝트 밖이거나 끊긴 링크면 undefined(목록에서 뺀다) */
async function entryOf(root: string, parent: string, dirent: Dirent): Promise<DirectoryEntry | undefined> {
  if (!dirent.isSymbolicLink()) return { name: dirent.name, type: dirent.isDirectory() ? 'directory' : dirent.isFile() ? 'file' : 'other' }
  try {
    const real = await fs.realpath(path.join(parent, dirent.name))
    if (real !== root && !real.startsWith(root + path.sep)) return undefined
    const stat = await fs.stat(real)
    return { name: dirent.name, type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other' }
  } catch {
    return undefined
  }
}
