import { describe, expect, it } from 'vitest'
import { diffRows, foldRows, rowsText } from '../../renderer/diffRows.ts'

// unified patch → 화면 줄. @@ 머리가 줄 수의 유일한 근거다 — 본문 줄이 `--- `·`+++ ` 로 시작해도 머리로 읽지 않는다 (closed-code unifiedDiff.ts 의 교훈)

const EDIT_PATCH = 'Index: a.txt\n===================================================================\n--- a.txt\n+++ a.txt\n@@ -1,5 +1,5 @@\n line1\n line2\n-line3\n+LINE3\n line4\n line5\n'

describe('diffRows', () => {
  it('jsdiff 머리(Index·====·---·+++)를 건너뛰고 문맥·삭제·추가 줄을 낸다', () => {
    expect(diffRows(EDIT_PATCH)).toEqual([
      { kind: 'context', text: 'line1' },
      { kind: 'context', text: 'line2' },
      { kind: 'del', text: 'line3' },
      { kind: 'add', text: 'LINE3' },
      { kind: 'context', text: 'line4' },
      { kind: 'context', text: 'line5' },
    ])
  })

  it('떨어진 hunk 사이에 ⋯ 줄, `\\ No newline` 메타 줄은 버린다', () => {
    const patch = '--- a\n+++ a\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n@@ -10,1 +10,1 @@\n-z\n\\ No newline at end of file\n+Z\n\\ No newline at end of file\n'
    expect(diffRows(patch).map((row) => `${row.kind}:${row.text}`)).toEqual(['context:a', 'del:b', 'add:B', 'gap:', 'del:z', 'add:Z'])
  })

  it('본문 줄이 `--- `·`+++ ` 로 시작해도 hunk 수를 다 채우기 전에는 본문이다', () => {
    const patch = '--- a\n+++ a\n@@ -1,1 +1,1 @@\n--- old\n+++ new\n'
    expect(diffRows(patch)).toEqual([
      { kind: 'del', text: '-- old' },
      { kind: 'add', text: '++ new' },
    ])
  })

  it('수를 생략한 머리(@@ -1 +1 @@)는 한 줄이다. git 형식 머리도 건너뛴다', () => {
    const patch = 'diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-x\n+X\n'
    expect(diffRows(patch).map((row) => row.kind)).toEqual(['del', 'add'])
  })

  it('빈 patch 는 빈 목록', () => {
    expect(diffRows('')).toEqual([])
  })
})

describe('foldRows', () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({ kind: 'context' as const, text: String(index) }))

  it('9줄 이하는 그대로', () => {
    expect(foldRows(rows.slice(0, 9), 9)).toEqual({ head: rows.slice(0, 9), hidden: 0, tail: [] })
  })

  it('넘치면 앞 5줄·뒤 4줄만 남기고 사이 수를 센다', () => {
    expect(foldRows(rows, 9)).toEqual({ head: rows.slice(0, 5), hidden: 3, tail: rows.slice(8) })
  })
})

describe('rowsText', () => {
  it('복사본에도 접두(- · + · 공백)를 넣는다. 파일 머리는 경로, ⋯ 은 그대로', () => {
    expect(
      rowsText([
        { kind: 'file', text: 'a.txt' },
        { kind: 'context', text: 'a' },
        { kind: 'del', text: 'b' },
        { kind: 'add', text: 'B' },
        { kind: 'gap', text: '' },
      ]),
    ).toBe('a.txt\n  a\n- b\n+ B\n⋯')
  })
})
