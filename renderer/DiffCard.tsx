import { useEffect, useState } from 'react'
import type { FileDiff } from '../shared/ipc.ts'
import { diffRows, foldRows, rowsText, type DiffRow } from './diffRows.ts'
import { CheckIcon, CopyIcon } from './Markdown.tsx'
import { useT } from './settingsStore.ts'
import './diff.css'

// 파일 변경 카드 — 도구 줄을 펼친 몸통과 추론 과정 탭에 같은 카드 (dsh ui-primitives DiffBlock·ui-tool 참조, 모양·치수만):
// 한 열 unified, 줄 번호 없음, 접두 `- `·`+ `·`  `(CSS), 경로 머리 줄, 떨어진 hunk 사이 ⋯, 9줄 넘으면 앞 5·뒤 4 + "N줄 더 보기".
// 문법 색 없음 (마크다운 코드 블록과 같은 판단, 사용자 결정 2026-10-02). 색은 styles.css 의 --diff-* 토큰만.

const MAX_ROWS = 9

interface Line {
  row: DiffRow
  diff?: FileDiff
}

/** 도구 줄 끝 `+A −D`. write 덮어쓰기처럼 옛 내용을 모르면 삭제 수는 `?` */
export function DiffStat({ diffs }: { diffs: readonly FileDiff[] }) {
  const added = diffs.reduce((sum, diff) => sum + diff.added, 0)
  const removed = diffs.some((diff) => diff.unknownBefore) ? '?' : String(diffs.reduce((sum, diff) => sum + diff.removed, 0))
  return <span className="diff-stat">{`+${added} −${removed}`}</span>
}

export function DiffCard({ diffs }: { diffs: readonly FileDiff[] }) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1_500)
    return () => clearTimeout(timer)
  }, [copied])

  const lines: Line[] = diffs.flatMap((diff) => [{ row: { kind: 'file', text: diff.path }, diff } as Line, ...diffRows(diff.patch).map((row) => ({ row }))])
  const { head, hidden, tail } = expanded ? { head: lines, hidden: 0, tail: [] } : foldRows(lines, MAX_ROWS)
  const copy = () => void navigator.clipboard.writeText(rowsText(lines.map((line) => line.row))).then(() => setCopied(true), () => {})

  return (
    <div className="diff-card">
      <div className="diff-card__bar">
        <button type="button" className="diff-card__copy" aria-label={copied ? t('diff.copied') : t('diff.copy')} title={copied ? t('diff.copied') : t('diff.copy')} onClick={copy}>
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>
      <div className="diff-card__body">
        <div className="diff-card__lines">
          {head.map((line, index) => (
            <LineView key={index} line={line} />
          ))}
          {hidden > 0 && (
            <button type="button" className="diff-card__more" onClick={() => setExpanded(true)}>
              {t('diff.more', { count: hidden })}
            </button>
          )}
          {tail.map((line, index) => (
            <LineView key={`tail-${index}`} line={line} />
          ))}
        </div>
      </div>
    </div>
  )
}

function LineView({ line: { row, diff } }: { line: Line }) {
  const t = useT()
  if (row.kind === 'file')
    return (
      <div className="diff-line" data-kind="file">
        <span className="diff-line__path">{row.text}</span>
        {diff?.status === 'added' && <span className="diff-line__note">{t('diff.added')}</span>}
        {diff?.status === 'deleted' && <span className="diff-line__note">{t('diff.deleted')}</span>}
        {diff?.unknownBefore && <span className="diff-line__note">{t('diff.unknownBefore')}</span>}
      </div>
    )
  return (
    <div className="diff-line" data-kind={row.kind}>
      {row.kind === 'gap' ? '⋯' : row.text}
    </div>
  )
}
