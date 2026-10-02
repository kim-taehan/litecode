import { describe, expect, it } from 'vitest'
import { toolDiffs } from '../../src/services/toolDiffs.ts'

// 도구 결과(레거시 state.metadata) → 파일별 변경. 모양은 이슈 #20 L2 실측 그대로 (opencode 1.18.18, edit·write·apply_patch(gpt-* 모델))

const ROOT = '/p'
/** jsdiff createTwoFilesPatch 모양 — 머리에 절대 경로 */
const header = (file: string) => `Index: ${file}\n===================================================================\n--- ${file}\n+++ ${file}\n`
const EDIT_PATCH = `${header('/p/a.txt')}@@ -1,5 +1,5 @@\n line1\n line2\n-line3\n+LINE3\n line4\n line5\n`

describe('toolDiffs', () => {
  it('edit: metadata.filediff — 절대 경로를 세션 폴더 기준 상대로, patch 는 머리째, 추가·삭제 수는 patch 에서', () => {
    const metadata = { diagnostics: {}, diff: EDIT_PATCH, filediff: { file: '/p/a.txt', patch: EDIT_PATCH, additions: 1, deletions: 1 } }
    expect(toolDiffs('edit', { filePath: '/p/a.txt', oldString: 'line3', newString: 'LINE3' }, metadata, ROOT)).toEqual([
      { path: 'a.txt', status: 'modified', added: 1, removed: 1, patch: EDIT_PATCH },
    ])
  })

  it('edit 로 새 파일(빈 oldString): @@ -0,0 이면 added', () => {
    const patch = `${header('/p/sub/n.txt')}@@ -0,0 +1,2 @@\n+a\n+b\n`
    expect(toolDiffs('edit', {}, { filediff: { file: '/p/sub/n.txt', patch, additions: 2, deletions: 0 } }, ROOT)).toEqual([
      { path: 'sub/n.txt', status: 'added', added: 2, removed: 0, patch },
    ])
  })

  it('apply_patch: metadata.files — 수정·추가·삭제. 삭제의 deletions(줄 수 + 1)는 믿지 않고 patch 에서 센다', () => {
    const metadata = {
      files: [
        { filePath: '/p/a.txt', relativePath: 'p/a.txt', type: 'update', patch: `${header('/p/a.txt')}@@ -1 +1 @@\n-a\n+A\n`, additions: 1, deletions: 1 },
        { filePath: '/p/b.txt', relativePath: 'p/b.txt', type: 'add', patch: `${header('/p/b.txt')}@@ -0,0 +1,2 @@\n+hello\n+world\n`, additions: 2, deletions: 0 },
        { filePath: '/p/c.txt', relativePath: 'p/c.txt', type: 'delete', patch: `${header('/p/c.txt')}@@ -1,1 +0,0 @@\n-gone\n`, additions: 0, deletions: 2 },
        { filePath: '/p/old.txt', movePath: '/p/new.txt', type: 'move', patch: `${header('/p/old.txt')}@@ -1 +1 @@\n-x\n+y\n`, additions: 1, deletions: 1 },
      ],
    }
    expect(toolDiffs('apply_patch', { patchText: '…' }, metadata, ROOT)?.map((diff) => [diff.path, diff.status, diff.added, diff.removed])).toEqual([
      ['a.txt', 'modified', 1, 1],
      ['b.txt', 'added', 2, 0],
      ['c.txt', 'deleted', 0, 1],
      ['new.txt', 'modified', 1, 1],
    ])
  })

  it('write 새 파일(exists:false): patch 가 없어 input.content 전부를 추가로 만든다', () => {
    const diffs = toolDiffs('write', { filePath: '/p/new.txt', content: 'x\ny\n' }, { diagnostics: {}, filepath: '/p/new.txt', exists: false, truncated: false }, ROOT)
    expect(diffs).toEqual([{ path: 'new.txt', status: 'added', added: 2, removed: 0, patch: '@@ -0,0 +1,2 @@\n+x\n+y\n' }])
  })

  it('write 덮어쓰기(exists:true): 이전 내용을 모른다 — 새 내용 전부를 추가로, unknownBefore', () => {
    const diffs = toolDiffs('write', { filePath: '/p/a.txt', content: 'only' }, { filepath: '/p/a.txt', exists: true }, ROOT)
    expect(diffs).toEqual([{ path: 'a.txt', status: 'modified', added: 1, removed: 0, patch: '@@ -0,0 +1,1 @@\n+only\n', unknownBefore: true }])
  })

  it('세션 폴더 밖의 파일은 절대 경로 그대로', () => {
    const diffs = toolDiffs('write', { content: 'x' }, { filepath: '/elsewhere/z.txt', exists: false }, ROOT)
    expect(diffs?.[0]?.path).toBe('/elsewhere/z.txt')
  })

  it('파일 변경이 없는 도구·결과가 없는 도구는 undefined', () => {
    expect(toolDiffs('bash', { command: 'ls' }, { exit: 0, output: 'a' }, ROOT)).toBeUndefined()
    expect(toolDiffs('edit', { filePath: 'a' }, undefined, ROOT)).toBeUndefined()
    expect(toolDiffs('apply_patch', {}, { files: [] }, ROOT)).toBeUndefined()
    expect(toolDiffs('write', { filePath: 'a' }, undefined, ROOT)).toBeUndefined()
  })
})
