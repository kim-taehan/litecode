import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { OpenInApp } from '../shared/ipc.ts'
import { updateSettings, useSettings, useT } from './settingsStore.ts'
import './openIn.css'

// "다른 앱에서 열기" 분할 버튼 — 대화 머리 오른쪽 끝 (dsh ui-open-in-app 참조: 모양·치수·동작만, 코드는 새로 씀).
// 왼쪽 = 기본 앱으로 열기(아이콘만), 오른쪽 ⌄ = 메뉴. 메뉴에서 고른 앱이 다음부터 기본이 된다(settings.openInApp — dsh 방식, 설정 화면 없음).
// 여는 것은 그 대화의 프로젝트 폴더뿐이다. 앱 목록·허용 검사·실행은 메인(ctx.openIn) — 화면은 앱 id 와 폴더만 보낸다.
// 앱이 없으면(mac 이 아니면) 버튼을 그리지 않는다.
// file 을 주면(파일 미리보기 패널) 그 파일 하나를 편집기로 연다 — 메뉴는 파일을 받는 앱(files)만, 실행은 ctx.openIn.openFile.

/** ↗ — 아이콘을 못 구한 앱 */
function ArrowIcon() {
  return (
    <svg className="open-in__icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 10 10 4M5 4h5v5" />
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg className="open-in__chevron" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 4 5 6.5 7.5 4" />
    </svg>
  )
}

function AppIcon({ app }: { app: OpenInApp }) {
  return app.icon ? <img className="open-in__icon" src={app.icon} alt="" /> : <ArrowIcon />
}

export function OpenInButton({ directory, file }: { directory: string; file?: string }) {
  const t = useT()
  const { openInApp } = useSettings()
  const [apps, setApps] = useState<OpenInApp[]>()
  const [menu, setMenu] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const forFile = file !== undefined
    void window.litecode.openInApps().then(
      (found) => setApps(forFile ? found.filter((app) => app.files) : found),
      () => setApps([]),
    )
  }, [file !== undefined])

  // 메뉴 밖을 누르면 닫는다. 열리면 첫 항목에 포커스 (키보드로 바로 고르게)
  useEffect(() => {
    if (!menu) return
    root.current?.querySelector<HTMLButtonElement>('.open-in__item')?.focus()
    const onMouseDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setMenu(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [menu])

  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => setError(undefined), 4000)
    return () => clearTimeout(timer)
  }, [error])

  if (!apps?.length) return null
  const primary = apps.find((app) => app.id === openInApp) ?? apps[0]

  async function open(app: OpenInApp): Promise<void> {
    setBusy(true)
    setError(undefined)
    try {
      await (file === undefined ? window.litecode.openIn(app.id, directory) : window.litecode.openFileIn(app.id, directory, file))
    } catch (failure) {
      // IPC 를 지난 오류는 "Error invoking remote method …: Error: <사유>" — 사유만
      setError(String(failure instanceof Error ? failure.message : failure).replace(/^.*?Error: /, ''))
    } finally {
      setBusy(false)
    }
  }

  function pick(app: OpenInApp): void {
    setMenu(false)
    if (app.id !== primary.id) void updateSettings({ openInApp: app.id })
    void open(app)
  }

  function onMenuKey(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault() // 메뉴만 닫는다 — 파일 미리보기 패널이 이 Esc 로 같이 닫히지 않게
      setMenu(false)
      root.current?.querySelector<HTMLButtonElement>('.open-in__more')?.focus()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('.open-in__item') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
  }

  return (
    <div className="open-in" ref={root}>
      <div className="open-in__split">
        <button
          type="button"
          className="open-in__primary"
          disabled={busy}
          aria-label={t('openIn.openWith', { app: primary.name })}
          title={t('openIn.openWith', { app: primary.name })}
          onClick={() => void open(primary)}
        >
          <AppIcon app={primary} />
        </button>
        {apps.length > 1 && (
          <button
            type="button"
            className="open-in__more"
            aria-label={t('openIn.more')}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((now) => !now)}
          >
            <ChevronIcon />
          </button>
        )}
      </div>
      {menu && (
        <div className="open-in__menu" role="menu" aria-label={t('openIn.more')} onKeyDown={onMenuKey}>
          {apps.map((app) => (
            <button key={app.id} type="button" role="menuitem" className="open-in__item" onClick={() => pick(app)}>
              <AppIcon app={app} />
              <span className="open-in__name">{app.id === primary.id ? t('openIn.default', { app: app.name }) : app.name}</span>
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="open-in__error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
