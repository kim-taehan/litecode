import { describe, expect, it } from 'vitest'
import type { GitFile } from '../../shared/git.ts'
import {
  buildTree,
  entryKind,
  entryStat,
  entryState,
  groupState,
  isFoldOpen,
  SECTION_UNTRACKED,
  splitChanges,
  toggleAction,
  toggleAllFolds,
  toggleFold,
  treeFolders,
  treeRows,
  type ChangeEntry,
  type TreeFolder,
} from '../../renderer/gitTree.ts'

// Git 탭 '변경' 의 폴더 트리 (#388) — 순수 규칙

const m = (path: string, extra: Partial<GitFile> = {}): GitFile => ({ path, kind: 'M', ...extra })
const off = (path: string): ChangeEntry => ({ path, changed: m(path) })
const on = (path: string): ChangeEntry => ({ path, staged: m(path) })
const mix = (path: string): ChangeEntry => ({ path, staged: m(path), changed: m(path) })

/** 트리를 읽기 쉬운 줄로 — 폴더는 `name/ (N)`, 파일은 이름, 들여쓰기 두 칸 */
function draw(root: TreeFolder, open: (folder: TreeFolder) => boolean = () => true): string[] {
  return treeRows(root, open).map((row) =>
    row.kind === 'folder' ? `${'  '.repeat(row.depth)}${row.folder.name}/ (${row.folder.all.length})` : `${'  '.repeat(row.depth)}${row.entry.path.split('/').pop()}`,
  )
}

describe('splitChanges — 두 구역', () => {
  it('stage 된 것과 안 된 것을 경로로 합치고(일부 stage 는 한 줄), untracked 는 새 파일 구역으로', () => {
    const { tracked, untracked } = splitChanges({
      staged: [m('src/a.ts'), m('b.ts', { kind: 'A' })],
      changed: [m('src/a.ts', { added: 1, removed: 0 }), m('c.ts'), { path: 'new.txt', kind: 'U' }],
    })
    expect(tracked.map((entry) => [entry.path, entryState(entry)])).toEqual([
      ['src/a.ts', 'mix'],
      ['b.ts', 'on'],
      ['c.ts', 'off'],
    ])
    expect(untracked).toEqual([{ path: 'new.txt', changed: { path: 'new.txt', kind: 'U' } }])
  })

  it('상태 글자는 stage 쪽 먼저(새로 더한 뒤 고친 파일은 A), 줄 수는 두 쪽을 더한다, 모르면 없음', () => {
    const entry: ChangeEntry = { path: 'x', staged: m('x', { kind: 'A', added: 10, removed: 0 }), changed: m('x', { added: 2, removed: 3 }) }
    expect(entryKind(entry)).toBe('A')
    expect(entryStat(entry)).toEqual({ added: 12, removed: 3 })
    expect(entryStat({ path: 'n', changed: { path: 'n', kind: 'U' } })).toBeUndefined()
    expect(entryKind({ path: 'n', changed: { path: 'n', kind: 'U' } })).toBe('U')
  })
})

describe('체크 3상태와 stage/unstage 경로', () => {
  it('전부 켜짐 → 켜짐, 전부 없음 → 없음, 섞이거나 일부 stage 파일이 있으면 일부', () => {
    expect(groupState([on('a'), on('b')])).toBe('on')
    expect(groupState([off('a'), off('b')])).toBe('off')
    expect(groupState([on('a'), off('b')])).toBe('mix')
    expect(groupState([on('a'), mix('b')])).toBe('mix')
    expect(groupState([])).toBe('off')
  })

  it('켜짐을 누르면 모두 unstage, 일부·없음을 누르면 아직 안 올린 쪽(작업 트리 변경이 있는 경로)만 stage', () => {
    expect(toggleAction([on('a'), on('b')])).toEqual({ kind: 'unstage', paths: ['a', 'b'] })
    expect(toggleAction([on('a'), off('b'), mix('c')])).toEqual({ kind: 'stage', paths: ['b', 'c'] })
    expect(toggleAction([off('a')])).toEqual({ kind: 'stage', paths: ['a'] })
    expect(toggleAction([mix('a')])).toEqual({ kind: 'stage', paths: ['a'] })
  })
})

describe('buildTree — 폴더 묶기·체인 합치기·정렬', () => {
  it('시안의 모양 — src/services(파일 하나여도 폴더 줄)·renderer(두 파일), 폴더 먼저 이름 순', () => {
    const root = buildTree([off('src/services/git.ts'), on('renderer/Git.tsx'), on('renderer/git.css')])
    expect(draw(root)).toEqual(['renderer/ (2)', '  Git.tsx', '  git.css', 'src/services/ (1)', '  git.ts'])
    expect(root.folders.map((folder) => [folder.path, groupState(folder.all)])).toEqual([
      ['renderer', 'on'],
      ['src/services', 'off'],
    ])
  })

  it('파일 없이 폴더 하나뿐인 체인만 합친다 — 갈라지는 곳·파일이 있는 곳에서 멈춘다, 루트 파일은 폴더 뒤', () => {
    const root = buildTree([off('a/b/c/d.ts'), off('a/b/e.ts'), off('a/x/y/z.ts'), off('README.md'), off('p/q/r.ts')])
    expect(draw(root)).toEqual(['a/ (3)', '  b/ (2)', '    c/ (1)', '      d.ts', '    e.ts', '  x/y/ (1)', '    z.ts', 'p/q/ (1)', '  r.ts', 'README.md'])
    expect(treeFolders(root).map((folder) => folder.path)).toEqual(['a', 'a/b', 'a/b/c', 'a/x/y', 'p/q'])
  })

  it('접힌 폴더의 안은 그리지 않는다 (개수는 그대로)', () => {
    const root = buildTree([off('a/b.ts'), off('a/c/d.ts'), off('e/f.ts')])
    expect(draw(root, (folder) => folder.path !== 'a')).toEqual(['a/ (2)', 'e/ (1)', '  f.ts'])
  })

  it('파일 수백 개 — 폴더마다 모두 묶이고 개수·체크가 맞는다', () => {
    const entries: ChangeEntry[] = []
    for (let folder = 0; folder < 40; folder++) for (let file = 0; file < 25; file++) entries.push((file % 2 ? on : off)(`pkg/m${folder}/src/f${file}.ts`))
    const started = performance.now()
    const root = buildTree(entries)
    const rows = treeRows(root, () => true)
    expect(performance.now() - started).toBeLessThan(500)
    expect(root.all).toHaveLength(1000)
    expect(root.folders.map((folder) => folder.name)).toEqual(['pkg'])
    expect(root.folders[0]!.folders).toHaveLength(40)
    expect(root.folders[0]!.folders[0]!.name).toBe('m0/src')
    expect(rows.filter((row) => row.kind === 'file')).toHaveLength(1000)
    expect(groupState(root.folders[0]!.all)).toBe('mix')
  })
})

describe('접힘 — 기본(폴더 펼침·새 파일 접힘)·하나·모두', () => {
  it('기본값, 하나를 누르면 그것만, 모두 접기 뒤 하나를 누르면 그것만 다시 펼침', () => {
    expect(isFoldOpen(undefined, 'c:src')).toBe(true)
    expect(isFoldOpen(undefined, SECTION_UNTRACKED)).toBe(false)
    const one = toggleFold(undefined, 'c:src')
    expect(isFoldOpen(one, 'c:src')).toBe(false)
    expect(isFoldOpen(one, 'c:other')).toBe(true)
    const closed = toggleAllFolds(one, ['c:src', 'c:other', SECTION_UNTRACKED])
    expect(['c:src', 'c:other', SECTION_UNTRACKED].map((key) => isFoldOpen(closed, key))).toEqual([false, false, false])
    const reopened = toggleFold(closed, 'c:other')
    expect(isFoldOpen(reopened, 'c:other')).toBe(true)
    expect(isFoldOpen(reopened, 'c:src')).toBe(false)
  })

  it('모두 접기·펴기 — 하나라도 펼쳐져 있으면 모두 접고, 모두 접혀 있으면 모두 편다', () => {
    const closed = toggleAllFolds(undefined, ['c:a', SECTION_UNTRACKED])
    expect(closed.all).toBe(false)
    const opened = toggleAllFolds(closed, ['c:a', SECTION_UNTRACKED])
    expect(isFoldOpen(opened, 'c:a')).toBe(true)
    expect(isFoldOpen(opened, SECTION_UNTRACKED)).toBe(true)
  })
})
