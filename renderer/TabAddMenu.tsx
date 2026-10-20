import { useEffect, useRef, useState } from 'react'
import type { ExtensionSummary } from '../shared/extensions.ts'
import { PuzzleIcon } from './PuzzleIcon.tsx'
import { useT } from './settingsStore.ts'

// 탭 줄 끝의 `+` 하나 — 눌러서 "파일 목록 / 새 터미널" 을 고른다 (2026-10-12, 사용자 "버튼 > + 2개 하나로", dsh ui-dockkit 의 add 컨트롤 하나).
// 터미널 기능이 꺼져 있으면 고를 것이 없으니 바로 파일 목록. 메뉴는 탭 줄(스크롤 칸) 밖, 버튼 바로 아래에 absolute 로 붙인다 (#513 — fixed 좌표는 패널 안에서 화면 밖으로 밀렸다).
// 모양은 .open-in__menu / .open-in__item 을 그대로 쓴다.
// 패널 확장 (이슈 #511, 시안 _workspace/mock-extension-panel Panel) — 켜 둔 정상 확장이 있으면 구분선 + 소제목 "확장" 아래에 퍼즐 아이콘 + 이름.
// 누르면 그 확장 탭(이미 있으면 그 탭). 터미널이 꺼져 있어도 켜 둔 확장이 있으면 메뉴를 보인다.

/** `+` 메뉴에 나열할 확장 — 켜 둔 정상(on) 패널 확장만, id 순. 언어 팩(이슈 #525)은 열 것이 없어 빠진다 */
export function menuExtensions(extensions: readonly ExtensionSummary[]): ExtensionSummary[] {
  return extensions.filter((extension) => extension.state === 'on' && extension.type !== 'locale').sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function TabAddMenu({
  terminal,
  extensions,
  onFiles,
  onTerminal,
  onExtension,
  initialOpen = false,
}: {
  terminal: boolean
  /** menuExtensions 로 거른 것 */
  extensions: readonly ExtensionSummary[]
  onFiles(): void
  onTerminal(): void
  onExtension(id: string): void
  /** 테스트가 열린 메뉴를 그릴 때 */
  initialOpen?: boolean
}) {
  const t = useT()
  const [open, setOpen] = useState(initialOpen)
  const root = useRef<HTMLDivElement>(null)
  const menu = terminal || extensions.length > 0

  useEffect(() => {
    if (!open) return
    // 포커스가 가려진 조상(.app overflow:hidden)을 가로로 밀지 않게 (#513)
    root.current?.querySelector<HTMLButtonElement>('.open-in__item')?.focus({ preventScroll: true })
    const onMouseDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  function pick(action: () => void): void {
    setOpen(false)
    action()
  }

  return (
    <div ref={root} className="file-preview__add-wrap" onKeyDown={(event) => event.key === 'Escape' && setOpen(false)}>
      <button
        type="button"
        className="file-preview__add"
        aria-label={t(menu ? 'filePreview.newTab' : 'filePreview.addTab')}
        title={t(menu ? 'filePreview.newTab' : 'filePreview.addTab')}
        aria-haspopup={menu ? 'menu' : undefined}
        aria-expanded={menu ? open : undefined}
        onClick={() => {
          if (!menu) return onFiles()
          setOpen(!open)
        }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
          <path d="M8 3V13M3 8H13" />
        </svg>
      </button>
      {menu && open && (
        <div className="open-in__menu file-preview__add-menu" role="menu">
          <button type="button" role="menuitem" className="open-in__item" onClick={() => pick(onFiles)}>
            {t('filePreview.addTab')}
          </button>
          {terminal && (
            <button type="button" role="menuitem" className="open-in__item" onClick={() => pick(onTerminal)}>
              {t('terminal.newTerminal')}
            </button>
          )}
          {extensions.length > 0 && (
            <>
              <div role="separator" className="file-preview__add-divider" />
              <div role="presentation" className="file-preview__add-heading">{t('filePreview.extensions')}</div>
              {extensions.map((extension) => (
                <button
                  key={extension.id}
                  type="button"
                  role="menuitem"
                  className="open-in__item file-preview__add-extension"
                  data-extension={extension.id}
                  onClick={() => pick(() => onExtension(extension.id))}
                >
                  <PuzzleIcon size={14} />
                  <span className="open-in__name">{extension.name ?? extension.id}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
