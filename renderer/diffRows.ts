// unified patch → diff 카드의 줄 (dsh ui-primitives DiffBlock 의 한 열 모양 참조 — 모양만, 코드는 새로 썼다).
// 그리는 쪽(DiffCard)은 DiffRow[] 만 받는다. @@ 머리의 줄 수가 hunk 끝의 유일한 근거다 — 본문 줄이 `--- `·`+++ ` 로 시작해도
// 머리로 읽지 않고, `\ No newline at end of file` 같은 메타 줄은 수에 안 넣는다 (closed-code unifiedDiff.ts 의 교훈).

export interface DiffRow {
  /** file: 경로 머리 줄 · gap: 떨어진 hunk 사이 ⋯ */
  kind: 'file' | 'context' | 'add' | 'del' | 'gap'
  text: string
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/

export function diffRows(patch: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLeft = 0
  let newLeft = 0
  let hunks = 0
  for (const line of patch.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('\\')) continue
      const body = line.slice(1)
      if (line.startsWith('+')) {
        rows.push({ kind: 'add', text: body })
        newLeft--
      } else if (line.startsWith('-')) {
        rows.push({ kind: 'del', text: body })
        oldLeft--
      } else {
        rows.push({ kind: 'context', text: body })
        oldLeft--
        newLeft--
      }
      continue
    }
    const hunk = HUNK.exec(line)
    if (!hunk) continue // 파일 머리(Index·====·---·+++·diff --git·index)와 hunk 뒤 메타 줄
    if (hunks++ > 0) rows.push({ kind: 'gap', text: '' })
    oldLeft = Number(hunk[1] ?? 1)
    newLeft = Number(hunk[2] ?? 1)
  }
  return rows
}

/** max 줄을 넘으면 앞 ceil(max/2)·뒤 나머지만 남기고 사이를 접는다 (dsh 채팅 카드 9줄) */
export function foldRows<T>(rows: readonly T[], max: number): { head: T[]; hidden: number; tail: T[] } {
  if (rows.length <= max) return { head: [...rows], hidden: 0, tail: [] }
  const head = Math.ceil(max / 2)
  const tail = max - head
  return { head: rows.slice(0, head), hidden: rows.length - max, tail: rows.slice(rows.length - tail) }
}

const PREFIX: Record<DiffRow['kind'], string> = { file: '', context: '  ', add: '+ ', del: '- ', gap: '' }

/** 복사본 — 화면과 같은 접두를 넣는다 */
export function rowsText(rows: readonly DiffRow[]): string {
  return rows.map((row) => (row.kind === 'gap' ? '⋯' : PREFIX[row.kind] + row.text)).join('\n')
}
