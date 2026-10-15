import type { GitAction, GitFile, GitStatus } from '../shared/git.ts'

// Git 탭 '변경' 의 폴더 트리 (#388, 시안 Git 탭 재설계 ① Main.dc.html) — 화면과 떨어진 순수 규칙.
// 시안은 stage 된 것과 안 된 것을 한 '변경' 구역에 섞고 체크로 stage 를 보인다. 새 파일(untracked)은 따로 '새 파일' 구역.
// 한 파일이 둘 다(일부만 stage)일 수 있다 — 그 줄의 체크는 '일부'(−), 누르면 나머지를 stage 한다.

/** 경로 하나 — stage 된 쪽·작업 트리 쪽 중 있는 것 (둘 다면 일부만 stage) */
export interface ChangeEntry {
  path: string
  staged?: GitFile
  changed?: GitFile
}

/** 체크 3상태 — 켜짐(전부 stage)·일부·없음 */
export type CheckState = 'on' | 'mix' | 'off'

export interface TreeFolder {
  /** 저장소 루트 기준 경로 (루트는 '') */
  path: string
  /** 보이는 이름 — 단일 자식 폴더 체인은 `a/b/c` 로 합친다 */
  name: string
  folders: TreeFolder[]
  files: ChangeEntry[]
  /** 이 폴더 아래 모든 파일 (체크·개수) */
  all: ChangeEntry[]
}

export type TreeRow = { kind: 'folder'; folder: TreeFolder; depth: number; open: boolean } | { kind: 'file'; entry: ChangeEntry; depth: number }

/** 상태 → 두 구역. 변경 = stage 된 것 ∪ 작업 트리 변경(경로로 합침), 새 파일 = untracked(U). 충돌은 따로(view.conflicts) */
export function splitChanges(view: Pick<GitStatus, 'staged' | 'changed'>): { tracked: ChangeEntry[]; untracked: ChangeEntry[] } {
  const byPath = new Map<string, ChangeEntry>()
  const untracked: ChangeEntry[] = []
  for (const file of view.staged) byPath.set(file.path, { path: file.path, staged: file })
  for (const file of view.changed) {
    if (file.kind === 'U') {
      untracked.push({ path: file.path, changed: file })
      continue
    }
    const entry = byPath.get(file.path)
    if (entry) entry.changed = file
    else byPath.set(file.path, { path: file.path, changed: file })
  }
  return { tracked: [...byPath.values()], untracked }
}

export function entryState(entry: ChangeEntry): CheckState {
  if (!entry.staged) return 'off'
  return entry.changed ? 'mix' : 'on'
}

/** 여러 파일의 체크 — 전부 켜짐이면 켜짐, 전부 없음이면 없음, 그 밖은 일부 */
export function groupState(entries: readonly ChangeEntry[]): CheckState {
  let on = 0
  let off = 0
  for (const entry of entries) {
    const state = entryState(entry)
    if (state === 'on') on++
    else if (state === 'off') off++
    else return 'mix'
  }
  if (on > 0 && off > 0) return 'mix'
  return on > 0 ? 'on' : 'off'
}

/** 체크를 누르면 할 일 — 켜짐이면 모두 unstage, 일부·없음이면 아직 stage 안 된 쪽을 모두 stage */
export function toggleAction(entries: readonly ChangeEntry[]): GitAction {
  if (groupState(entries) === 'on') return { kind: 'unstage', paths: entries.filter((entry) => entry.staged).map((entry) => entry.path) }
  return { kind: 'stage', paths: entries.filter((entry) => entry.changed).map((entry) => entry.path) }
}

/** 줄에 보일 상태 글자 — stage 된 쪽이 있으면 그것(새로 더한 뒤 고친 파일은 A) */
export function entryKind(entry: ChangeEntry): GitFile['kind'] {
  return (entry.staged ?? entry.changed)!.kind
}

/** 줄 수 — 양쪽이 다 있으면 더한다(일부만 stage). 모르면(새 파일·바이너리) undefined */
export function entryStat(entry: ChangeEntry): { added: number; removed: number } | undefined {
  const sides = [entry.staged, entry.changed].filter((file): file is GitFile => file?.added !== undefined)
  if (sides.length === 0) return undefined
  return { added: sides.reduce((sum, file) => sum + (file.added ?? 0), 0), removed: sides.reduce((sum, file) => sum + (file.removed ?? 0), 0) }
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** 경로 목록 → 폴더 트리. 폴더 먼저·파일 다음, 각자 이름 순(코드 포인트). 파일이 없고 폴더가 하나뿐인 폴더는 그 자식과 한 줄로 합친다 */
export function buildTree(entries: readonly ChangeEntry[]): TreeFolder {
  const root: TreeFolder = { path: '', name: '', folders: [], files: [], all: [...entries] }
  const index = new Map<string, TreeFolder>([['', root]])
  for (const entry of entries) {
    const parts = entry.path.split('/')
    let parent = root
    for (let depth = 0; depth < parts.length - 1; depth++) {
      const path = parts.slice(0, depth + 1).join('/')
      let folder = index.get(path)
      if (!folder) {
        folder = { path, name: parts[depth]!, folders: [], files: [], all: [] }
        index.set(path, folder)
        parent.folders.push(folder)
      }
      folder.all.push(entry)
      parent = folder
    }
    parent.files.push(entry)
  }
  const finish = (folder: TreeFolder): TreeFolder => {
    let merged = folder
    while (merged !== root && merged.files.length === 0 && merged.folders.length === 1) {
      const child = merged.folders[0]!
      merged = { ...child, name: `${merged.name}/${child.name}` }
    }
    merged.folders = merged.folders.map(finish).sort((a, b) => byName(a.name, b.name))
    merged.files.sort((a, b) => byName(baseName(a.path), baseName(b.path)))
    return merged
  }
  return finish(root)
}

/** 트리 → 그릴 줄 (접힌 폴더의 안은 뺀다). depth 는 들여쓰기 단계 — 루트의 파일·폴더가 0 */
export function treeRows(root: TreeFolder, isOpen: (folder: TreeFolder) => boolean): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (folder: TreeFolder, depth: number): void => {
    for (const child of folder.folders) {
      const open = isOpen(child)
      rows.push({ kind: 'folder', folder: child, depth, open })
      if (open) walk(child, depth + 1)
    }
    for (const entry of folder.files) rows.push({ kind: 'file', entry, depth })
  }
  walk(root, 0)
  return rows
}

/** 트리 안의 모든 폴더 (모두 접기·펴기) */
export function treeFolders(root: TreeFolder): TreeFolder[] {
  return root.folders.flatMap((folder) => [folder, ...treeFolders(folder)])
}

// ── 접힘 상태 (gitStore 가 폴더마다 쥔다) ──
// 열쇠: 구역 `section:untracked`, 변경 폴더 `c:<경로>`, 새 파일 폴더 `u:<경로>`. 기본은 폴더 펼침·새 파일 구역 접힘.
// '모두 접기·펴기' 는 낱낱의 값을 지우고 all 하나로 덮는다 — 그 뒤 하나를 누르면 그것만 다시 낱값

export interface Folds {
  all?: boolean
  keys: ReadonlyMap<string, boolean>
}

export const SECTION_UNTRACKED = 'section:untracked'
export const folderKey = (section: 'c' | 'u', path: string): string => `${section}:${path}`
const initiallyOpen = (key: string): boolean => key !== SECTION_UNTRACKED

export function isFoldOpen(folds: Folds | undefined, key: string): boolean {
  return folds?.keys.get(key) ?? folds?.all ?? initiallyOpen(key)
}

export function toggleFold(folds: Folds | undefined, key: string): Folds {
  return { ...(folds?.all !== undefined && { all: folds.all }), keys: new Map(folds?.keys).set(key, !isFoldOpen(folds, key)) }
}

/** 모두 접기·펴기 — 보이는 열쇠 중 하나라도 펼쳐져 있으면 모두 접고, 아니면 모두 편다 */
export function toggleAllFolds(folds: Folds | undefined, keys: readonly string[]): Folds {
  return { all: !keys.some((key) => isFoldOpen(folds, key)), keys: new Map() }
}
