import { useEffect, useRef, useState } from 'react'
import { useT } from './settingsStore.ts'

// 탭 줄 끝의 `+` 하나 — 눌러서 "파일 목록 / 새 터미널" 을 고른다 (2026-10-12, 사용자 "버튼 > + 2개 하나로", dsh ui-dockkit 의 add 컨트롤 하나).
// 터미널 기능이 꺼져 있으면 고를 것이 없으니 바로 파일 목록. 메뉴는 탭 줄이 가로로 스크롤돼도 잘리지 않게 fixed 로 그린다.
// 모양은 .open-in__menu / .open-in__item 을 그대로 쓴다.

export function TabAddMenu({ terminal, onFiles, onTerminal }: { terminal: boolean; onFiles(): void; onTerminal(): void }) {
  const t = useT()
  const [at, setAt] = useState<{ left: number; top: number }>()
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!at) return
    root.current?.querySelector<HTMLButtonElement>('.open-in__item')?.focus()
    const onMouseDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setAt(undefined)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [at])

  function pick(action: () => void): void {
    setAt(undefined)
    action()
  }

  return (
    <div ref={root} onKeyDown={(event) => event.key === 'Escape' && setAt(undefined)}>
      <button
        type="button"
        className="file-preview__add"
        aria-label={t(terminal ? 'filePreview.newTab' : 'filePreview.addTab')}
        title={t(terminal ? 'filePreview.newTab' : 'filePreview.addTab')}
        aria-haspopup={terminal ? 'menu' : undefined}
        aria-expanded={terminal ? at !== undefined : undefined}
        onClick={(event) => {
          if (!terminal) return onFiles()
          const rect = event.currentTarget.getBoundingClientRect()
          setAt(at ? undefined : { left: rect.left, top: rect.bottom + 4 })
        }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
          <path d="M8 3V13M3 8H13" />
        </svg>
      </button>
      {at && (
        <div className="open-in__menu file-preview__add-menu" role="menu" style={{ left: at.left, top: at.top }}>
          <button type="button" role="menuitem" className="open-in__item" onClick={() => pick(onFiles)}>
            {t('filePreview.addTab')}
          </button>
          <button type="button" role="menuitem" className="open-in__item" onClick={() => pick(onTerminal)}>
            {t('terminal.newTerminal')}
          </button>
        </div>
      )}
    </div>
  )
}
