import { describe, expect, it } from 'vitest'
import { toolDiffs } from '../../src/services/toolDiffs.ts'

// 도구 결과(structured) → 파일별 변경. 모양은 01p 실측 그대로 (opencode 1.18.18, edit·apply_patch·write)

const EDIT_PATCH = 'Index: a.txt\n===================================================================\n--- a.txt\n+++ a.txt\n@@ -1,5 +1,5 @@\n line1\n line2\n-line3\n+LINE3\n line4\n line5\n'

describe('toolDiffs', () => {
  it('edit: structured.files 의 patch·추가·삭제 수·상태를 그대로', () => {
    const structured = { files: [{ file: 'a.txt', patch: EDIT_PATCH, additions: 1, deletions: 1, status: 'modified' }], replacements: 1 }
    expect(toolDiffs('edit', { path: '/p/a.txt', oldString: 'line3', newString: 'LINE3' }, structured)).toEqual([
      { path: 'a.txt', status: 'modified', added: 1, removed: 1, patch: EDIT_PATCH },
    ])
  })

  it('apply_patch: 파일 여러 개 — added·deleted 상태도 그대로', () => {
    const structured = {
      applied: [],
      files: [
        { file: 'a.txt', patch: '@@ -1 +1 @@\n-a\n+A\n', additions: 1, deletions: 1, status: 'modified' },
        { file: 'n.txt', patch: '@@ -0,0 +1 @@\n+n\n', additions: 1, deletions: 0, status: 'added' },
        { file: 'd.txt', patch: '@@ -1 +0,0 @@\n-d\n', additions: 0, deletions: 1, status: 'deleted' },
      ],
    }
    expect(toolDiffs('apply_patch', { patchText: '…' }, structured)?.map((diff) => [diff.path, diff.status, diff.added, diff.removed])).toEqual([
      ['a.txt', 'modified', 1, 1],
      ['n.txt', 'added', 1, 0],
      ['d.txt', 'deleted', 0, 1],
    ])
  })

  it('write 새 파일(existed:false): patch 가 없어 input.content 전부를 추가로 만든다', () => {
    const diffs = toolDiffs('write', { path: '/p/new.txt', content: 'x\ny\n' }, { operation: 'write', target: '/p/new.txt', resource: 'new.txt', existed: false })
    expect(diffs).toEqual([{ path: 'new.txt', status: 'added', added: 2, removed: 0, patch: '@@ -0,0 +1,2 @@\n+x\n+y\n' }])
  })

  it('write 덮어쓰기(existed:true): 이전 내용을 모른다 — 새 내용 전부를 추가로, unknownBefore', () => {
    const diffs = toolDiffs('write', { path: '/p/a.txt', content: 'only' }, { operation: 'write', target: '/p/a.txt', resource: 'a.txt', existed: true })
    expect(diffs).toEqual([{ path: 'a.txt', status: 'modified', added: 1, removed: 0, patch: '@@ -0,0 +1,1 @@\n+only\n', unknownBefore: true }])
  })

  it('파일 변경이 없는 도구·결과가 없는 도구는 undefined', () => {
    expect(toolDiffs('bash', { command: 'ls' }, { exit: 0, truncated: false })).toBeUndefined()
    expect(toolDiffs('edit', { path: 'a' }, undefined)).toBeUndefined()
    expect(toolDiffs('edit', { path: 'a' }, { files: [] })).toBeUndefined()
    expect(toolDiffs('write', { path: 'a' }, undefined)).toBeUndefined()
  })
})
