import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { matchFiles } from '../shared/fileMatch.ts'
import { markText, QUICK_LIMIT } from './fileQuickOpen.ts'
import { useT } from './settingsStore.ts'

/** 파일 퀵오픈 (⌘P, 이슈 #624) — 인텔리제이 "Go to File" 스타일: 창 상단 중앙 팝업에 타이핑하면 전체 프로젝트
 *  파일이 거르고(이름 일치 우선, 짧은 경로 먼저 — shared/fileMatch.ts), ↑/↓ 로 이동, Enter·클릭으로 고른 파일을
 *  오른쪽 패널 파일 탭으로 열고, Esc·바깥 클릭으로 닫는다(닫으면 포커스는 입력창으로 — #382 패턴).
 *  목록은 메인이 준다(fileIndex.ts rg --files — .gitignore 준수, .git 제외, 5s 캐시). */
export function FileQuickOpen({
  directory,
  onPick,
  onClose,
}: {
  directory: string
  onPick(path: string): void
  /** focusComposer: 키보드(Esc·바깥 클릭)로 닫았으면 true — 포커스를 입력창으로 돌려준다 */
  onClose(focusComposer: boolean): void
}) {
  const t = useT()
  const [files, setFiles] = useState<string[]>()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    void window.litecode.listProjectFiles(directory).then((list) => live && setFiles(list), () => live && setFiles([]))
    return () => {
      live = false
    }
  }, [directory])

  const needle = query.trim().toLowerCase()
  const rows = useMemo(() => (files ? matchFiles(files, needle, QUICK_LIMIT) : []), [files, needle])

  // 목록이 줄어서 고른 행이 사라지면 마지막 행으로 붙인다
  useEffect(() => {
    if (active >= rows.length) setActive(Math.max(0, rows.length - 1))
  }, [rows.length, active])

  // 고른 행을 보이는 범위로
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active, rows])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.isComposing) return // 한글 조합 취소 Esc 에 닫지 않는다
      event.preventDefault() // 이 Esc 는 여기서 썼다 — 답변 중지 "Esc 두 번"(stopTurn) 에 세지 않게
      onClose(true)
    }
    function onMouseDown(event: MouseEvent): void {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return
      onClose(true)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onMouseDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onMouseDown)
    }
  }, [onClose])

  function openRow(index: number): void {
    const row = rows[index]
    if (row) onPick(row)
  }

  // 탐색칸과 행 버튼 어느 쪽에 포커스가 있어도 같은 키를 쓴다 (행 버튼 포커스 시 입력으로 돌아가 탐색 계속)
  function onKey(event: ReactKeyboardEvent): void {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return // 한글 조합 확정 Enter 를 못 뺏는다
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (rows.length === 0) return
      setActive((now) => (now + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      openRow(active)
    } else if ((event.key === 'Home' || event.key === 'End') && event.target instanceof HTMLInputElement) {
      event.preventDefault()
      setActive(event.key === 'Home' ? 0 : rows.length - 1)
    }
  }

  return (
    <div className="file-quick" ref={panelRef} role="dialog" aria-label={t('fileQuick.label')} onKeyDown={onKey}>
      <input
        className="file-quick__search"
        placeholder={t('fileQuick.search')}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setActive(0)
        }}
        autoFocus
      />
      <div className="file-quick__list" ref={listRef}>
        {files === undefined && <div className="file-quick__empty">{t('fileQuick.loading')}</div>}
        {files !== undefined && query.trim() !== '' && rows.length === 0 && <div className="file-quick__empty">{t('fileQuick.noMatch')}</div>}
        {rows.map((row, index) => (
          <button
            key={row}
            type="button"
            className={`file-quick__row${index === active ? ' file-quick__row--selected' : ''}`}
            onMouseEnter={() => setActive(index)}
            onClick={() => openRow(index)}
          >
            <span className="file-quick__path">
              {row.split('/').map((part, i, all) => (
                <span key={`${i}-${part}`} className={i < all.length - 1 ? 'file-quick__dir' : undefined}>
                  {markText(part, needle).map((m, j) => (m.hit ? <b key={j}>{m.text}</b> : <span key={j}>{m.text}</span>))}
                  {i < all.length - 1 && '/'}
                </span>
              ))}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
