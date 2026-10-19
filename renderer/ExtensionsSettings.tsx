import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import type { ExtensionPreview, ExtensionResult, ExtensionStoreFailure, ExtensionSummary } from '../shared/extensions.ts'
import { useFocusTrap } from './focusTrap.ts'
import { useT, type Translate } from './settingsStore.ts'
import { cardKind, failedReasonText, failureLines, formatBytes, installKind, lineSummary, problemLine, type ProblemLine } from './extensionsView.ts'

// 설정 > 기능의 확장 (이슈 #489, 시안 _workspace/mock-extension Main·Confirm·Reject). 기능 페이지(FeaturesSettings.tsx)에 끼우는 조각들:
// 검색창 옆 [확장 추가 (zip)] · 보류 안내 배너 · 기능 카드 아래 "설치한 확장" 구분선 + 카드 · 설치 확인/거절 대화상자.
// 카드는 기능 줄(.feature-row)의 모양을 그대로 쓰고 퍼즐 타일 · 보라 "확장" 뱃지 · 버전 · ⋯ 메뉴를 더한다.
// 시안과 다른 점: 배너의 [지금 다시 시작] 은 없다 — 앱 재시작 기능이 없다(종료 확인·자식 프로세스 정리까지 번진다). 배너는 문구만.
// 삭제 확인은 모델 카드(Settings.tsx ModelsPage)처럼 카드 안 [삭제 확인][취소] 두 버튼. 대화상자 틀은 전체 권한 확인(ModeChip ConfirmFullAccess)과 같다.
// 요청 결과는 던지지 않고 { ok, failure } 로 온다 — 그래도 IPC 자체가 실패할 수 있어 거부도 받는다.

const UNKNOWN_FAILURE = { code: 'unknown', params: {} } as unknown as ExtensionStoreFailure

/** 메인 요청 — IPC 가 던져도 실패 결과로 */
async function request<T extends object>(call: () => Promise<ExtensionResult<T>>): Promise<ExtensionResult<T>> {
  try {
    return await call()
  } catch {
    return { ok: false, failure: UNKNOWN_FAILURE }
  }
}

function PuzzleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 4h4v3a2 2 0 1 0 4 0v3h-3a2 2 0 1 0 0 4h3v4h-4v-3a2 2 0 1 0-4 0v3H6v-4h3a2 2 0 1 0 0-4H6V7h4z" />
    </svg>
  )
}

/** 사유 한 줄의 보조 글 — 고정폭 값 · 번역한 보조 글 · 원문을 " — " 로 잇는다 */
function lineNote(line: ProblemLine, t: Translate): ReactNode[] {
  const parts: ReactNode[] = []
  if (line.mono) parts.push(<code key="mono">{line.mono}</code>)
  if (line.detail) parts.push(t(line.detail.key, line.detail.vars))
  if (line.plain) parts.push(line.plain)
  return parts.flatMap((part, index) => (index === 0 ? [part] : [' — ', part]))
}

/** 거절·실패 사유 목록 — 사유마다 굵은 제목 + 보조 글 */
function ProblemList({ lines }: { lines: readonly ProblemLine[] }) {
  const t = useT()
  return (
    <ul className="extension-reject__lines">
      {lines.map((line, index) => {
        const note = lineNote(line, t)
        return (
          <li key={index} className="extension-reject__line">
            <b>{t(line.title.key, line.title.vars)}</b>
            {note.length > 0 && <span className="extension-reject__note">{note}</span>}
          </li>
        )
      })}
    </ul>
  )
}

/** 대화상자 Esc — 설정 모달까지 닫지 않게 먼저 받아 멈춘다 (ConfirmFullAccess 와 같다) */
function useEscape(onEscape: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.stopPropagation()
      onEscape()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onEscape])
}

/** 설치 확인 (시안 Confirm) — 취소·Esc·바깥 누르기는 모두 cancelExtension(token). 설치가 실패하면 사유를 보이고 열어 둔다 */
export function ExtensionConfirmDialog({ preview, onClose }: { preview: ExtensionPreview; onClose(): void }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<ProblemLine[]>()
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef)
  const manifest = preview.manifest
  const kind = installKind(preview)

  function cancel(): void {
    if (preview.token) void request(() => window.litecode.cancelExtension(preview.token!))
    onClose()
  }
  useEscape(cancel)

  async function install(): Promise<void> {
    if (!preview.token) return
    setBusy(true)
    const result = await request(() => window.litecode.installExtension(preview.token!))
    setBusy(false)
    if (result.ok) onClose() // 목록은 extensions:changed 로 갱신된다
    else setFailure(failureLines(result.failure))
  }

  const existing = preview.existing && manifest && {
    upgrade: t('extensions.confirm.upgrade', { from: preview.existing.version, to: manifest.version }),
    same: t('extensions.confirm.same', { version: manifest.version }),
    downgrade: t('extensions.confirm.downgrade', { from: preview.existing.version, to: manifest.version }),
    new: '',
  }[kind]
  const installLabel = kind === 'new' ? 'extensions.confirm.install' : kind === 'upgrade' ? 'extensions.confirm.installUpgrade' : 'extensions.confirm.reinstall'
  const permissions = manifest?.permissions ?? []

  return (
    <div className="confirm-mask" onMouseDown={(event) => event.target === event.currentTarget && cancel()}>
      <div className="confirm-dialog extension-confirm" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="extension-confirm-title">
        <h2 id="extension-confirm-title" className="confirm-dialog__title">
          {t('extensions.confirm.title')}
        </h2>
        <div className="extension-confirm__card">
          <span className="feature-row__tile extension-row__tile">
            <PuzzleIcon />
          </span>
          <span className="feature-row__text">
            <span className="feature-row__line">
              <span className="feature-row__title">{manifest?.name}</span>
              {manifest && <span className="extension-row__version">v{manifest.version}</span>}
            </span>
            <span className="feature-row__summary">{manifest?.description}</span>
          </span>
        </div>
        <dl className="extension-confirm__rows">
          <dt>{t('extensions.confirm.id')}</dt>
          <dd>
            <code>{manifest?.id}</code>
          </dd>
          <dt>{t('extensions.confirm.files')}</dt>
          <dd>{t('extensions.confirm.filesValue', { count: preview.files.count, size: formatBytes(preview.files.totalBytes) })}</dd>
          <dt>{t('extensions.confirm.app')}</dt>
          <dd>
            {manifest?.litecode ? (
              <>
                {t('extensions.confirm.appAtLeast', { version: manifest.litecode })}
                <span className="extension-confirm__met"> · {t('extensions.confirm.appMet')}</span>
              </>
            ) : (
              t('extensions.confirm.appAny')
            )}
          </dd>
          <dt>{t('extensions.confirm.permissions')}</dt>
          <dd>
            {permissions.length === 0
              ? t('extensions.confirm.permissionsNone')
              : permissions.flatMap((permission, index) => [index > 0 ? ', ' : '', <code key={permission}>{permission}</code>])}
          </dd>
          {existing && (
            <>
              <dt>{t('extensions.confirm.existing')}</dt>
              <dd>
                <b>{existing}</b>
              </dd>
            </>
          )}
        </dl>
        <p className="settings-notice extension-confirm__warning">{t('extensions.confirm.warning')}</p>
        {failure && (
          <div className="feature-row__failure" role="alert">
            <b>{t('extensions.confirm.failed')}</b>
            <ProblemList lines={failure} />
          </div>
        )}
        <div className="confirm-dialog__actions">
          <button type="button" className="settings-button" onClick={cancel}>
            {t('extensions.confirm.cancel')}
          </button>
          <button type="button" className="settings-button settings-button--primary" disabled={busy || !preview.token} onClick={() => void install()}>
            {t(installLabel)}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 설치 거절 (시안 Reject) — 아무것도 설치하지 않았다. 닫기·Esc·바깥 누르기로 닫는다 */
export function ExtensionRejectDialog({ lines, onClose }: { lines: readonly ProblemLine[]; onClose(): void }) {
  const t = useT()
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef)
  useEscape(onClose)
  return (
    <div className="confirm-mask" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="confirm-dialog extension-confirm" ref={dialogRef} role="alertdialog" aria-modal="true" aria-labelledby="extension-reject-title" aria-describedby="extension-reject-description">
        <div className="extension-reject__head">
          <span className="extension-reject__icon" aria-hidden="true">
            !
          </span>
          <h2 id="extension-reject-title" className="confirm-dialog__title">
            {t('extensions.reject.title')}
          </h2>
        </div>
        <p id="extension-reject-description" className="confirm-dialog__description">
          {t('extensions.reject.nothing')}
        </p>
        <ProblemList lines={lines} />
        <div className="confirm-dialog__actions">
          <button type="button" className="settings-button settings-button--primary" onClick={onClose}>
            {t('extensions.reject.close')}
          </button>
        </div>
      </div>
    </div>
  )
}

type Dialog = { kind: 'confirm'; preview: ExtensionPreview } | { kind: 'reject'; lines: ProblemLine[] }

/** [확장 추가 (zip)] — zip 고르기 → 통과면 설치 확인, 사유가 있으면 거절. 대화상자를 취소하면 아무것도 안 한다 */
export function ExtensionAddButton() {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<Dialog>()

  async function pick(): Promise<void> {
    setBusy(true)
    const result = await request(() => window.litecode.pickExtension())
    setBusy(false)
    if (!result.ok) return setDialog({ kind: 'reject', lines: failureLines(result.failure) })
    const preview = result.preview
    if (!preview) return // 고르기 취소
    if (preview.token) return setDialog({ kind: 'confirm', preview })
    setDialog({ kind: 'reject', lines: preview.problems.length > 0 ? preview.problems.map(problemLine) : failureLines(UNKNOWN_FAILURE) })
  }

  const close = () => setDialog(undefined)
  return (
    <>
      <button type="button" className="settings-button settings-button--compact settings-button--primary extensions-add" disabled={busy} onClick={() => void pick()}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
          <path d="M6 1.5v9M1.5 6h9" />
        </svg>
        {t('extensions.add')}
      </button>
      {dialog?.kind === 'confirm' && <ExtensionConfirmDialog preview={dialog.preview} onClose={close} />}
      {dialog?.kind === 'reject' && <ExtensionRejectDialog lines={dialog.lines} onClose={close} />}
    </>
  )
}

/** 보류가 하나라도 있으면 노란 안내 (버튼 없음 — 앱 재시작 기능이 없다) */
export function ExtensionsNotice({ extensions }: { extensions: readonly ExtensionSummary[] }) {
  const t = useT()
  if (!extensions.some((extension) => extension.pending)) return null
  return (
    <p className="settings-notice extensions-notice" role="status">
      {t('extensions.notice')}
    </p>
  )
}

/** ⋯ 메뉴 — 설정 드롭다운(OptionSelect)과 같은 동작: 열면 첫 줄에 포커스, ↑/↓, Esc 는 메뉴만 닫고, 바깥 누르면 닫는다 */
function MoreMenu({ label, items }: { label: string; items: readonly { label: string; danger?: boolean; onSelect(): void }[] }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const rows = () => [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]

  useEffect(() => {
    if (!open) return
    rows()[0]?.focus()
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])

  function close(): void {
    setOpen(false)
    triggerRef.current?.focus()
  }

  function onMenuKeyDown(event: ReactKeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation() // 메뉴만 닫는다 — 설정 모달은 그대로
      close()
      return
    }
    if (event.key === 'Tab') return setOpen(false)
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const list = rows()
    const at = list.indexOf(document.activeElement as HTMLElement)
    list[(at + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus()
  }

  return (
    <div className="settings-select" ref={rootRef}>
      <button type="button" className="extension-row__more" ref={triggerRef} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((now) => !now)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
      {open && (
        <div className="settings-menu" role="menu" aria-label={label} ref={menuRef} onKeyDown={onMenuKeyDown}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={item.danger ? 'settings-menu__item extension-row__danger' : 'settings-menu__item'}
              onClick={() => {
                close()
                item.onSelect()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 확장 카드 한 장 — 상태(cardKind)에 따라 설명 자리·스위치가 바뀐다. initialInfo 는 테스트가 정보 패널을 열어 그릴 때 */
export function ExtensionCard({ extension, initialInfo = false }: { extension: ExtensionSummary; initialInfo?: boolean }) {
  const t = useT()
  const [info, setInfo] = useState(initialInfo)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [error, setError] = useState<string>()
  const kind = cardKind(extension)
  const name = extension.name ?? extension.id
  const locked = kind === 'pending-install' || kind === 'pending-remove'

  async function run(call: () => Promise<ExtensionResult>): Promise<void> {
    const result = await request(call)
    setError(result.ok ? undefined : failureLines(result.failure).map((line) => lineSummary(line, t)).join(' · '))
  }

  function summary(): ReactNode {
    if (kind === 'pending-install') return <span className="feature-row__summary">{t('extensions.pending.install')}</span>
    if (kind === 'pending-remove') return <span className="feature-row__summary">{t('extensions.pending.remove')}</span>
    if (kind === 'failed' && extension.reason) return <span className="feature-row__summary extension-row__reason">{failedReasonText(extension.reason, t)}</span>
    return <span className="feature-row__summary">{extension.description}</span>
  }

  const invalidProblems = extension.state === 'failed' && extension.reason?.code === 'invalid' ? extension.reason.params.problems : []

  return (
    <li className="feature-row extension-row" data-extension={extension.id} data-kind={kind} data-on={extension.state === 'on' || undefined}>
      <div className="feature-row__head">
        <div className="feature-row__toggle extension-row__body">
          <span className="feature-row__tile extension-row__tile">
            <PuzzleIcon />
          </span>
          <span className="feature-row__text">
            <span className="feature-row__line">
              <span className="feature-row__title">{name}</span>
              <span className="feature-row__badge extension-row__badge">{t('extensions.badge')}</span>
              {extension.version && <span className="extension-row__version">v{extension.version}</span>}
              {kind === 'mounting' && <span className="extension-row__mounting">{t('extensions.mounting')}</span>}
            </span>
            {summary()}
          </span>
        </div>
        {confirmingRemove ? (
          <span className="provider-card__actions">
            <button
              type="button"
              className="settings-button settings-button--compact settings-button--danger"
              onClick={() => {
                setConfirmingRemove(false)
                void run(() => window.litecode.removeExtension(extension.id))
              }}
            >
              {t('extensions.confirmRemove')}
            </button>
            <button type="button" className="settings-button settings-button--compact" onClick={() => setConfirmingRemove(false)}>
              {t('extensions.cancelRemove')}
            </button>
          </span>
        ) : (
          <MoreMenu
            label={t('extensions.more', { name })}
            items={[
              { label: t('extensions.menu.info'), onSelect: () => setInfo((now) => !now) },
              ...(kind === 'pending-remove' ? [] : [{ label: t('extensions.menu.remove'), danger: true, onSelect: () => setConfirmingRemove(true) }]),
            ]}
          />
        )}
        <button
          type="button"
          role="switch"
          className="settings-switch"
          aria-checked={extension.enabled}
          aria-label={name}
          disabled={locked}
          title={locked ? t('extensions.locked') : undefined}
          onClick={() => void run(() => window.litecode.setExtensionEnabled(extension.id, !extension.enabled))}
        >
          <span className="settings-switch__thumb" />
        </button>
      </div>
      {error && (
        <p className="settings-error extension-row__error" role="alert">
          {error}
        </p>
      )}
      {info && (
        <div className="feature-row__detail extension-row__info">
          <dl className="extension-confirm__rows">
            <dt>{t('extensions.info.id')}</dt>
            <dd>
              <code>{extension.id}</code>
            </dd>
            {extension.version && (
              <>
                <dt>{t('extensions.info.version')}</dt>
                <dd>{extension.version}</dd>
              </>
            )}
            {extension.description && (
              <>
                <dt>{t('extensions.info.description')}</dt>
                <dd>{extension.description}</dd>
              </>
            )}
          </dl>
          {invalidProblems.length > 0 && (
            <>
              <b>{t('extensions.info.problems')}</b>
              <ProblemList lines={invalidProblems.map(problemLine)} />
            </>
          )}
        </div>
      )}
    </li>
  )
}

/** 기능 카드 아래 — "설치한 확장" 구분선 + 카드들(받은 순서 그대로, 정렬·거르기는 extensionsView.filterExtensions). 없으면 아무것도 */
export function ExtensionsSection({ extensions }: { extensions: readonly ExtensionSummary[] }) {
  const t = useT()
  if (extensions.length === 0) return null
  return (
    <section className="extensions-section" aria-label={t('extensions.section')}>
      <div className="extensions-section__divider">
        <span>{t('extensions.section')}</span>
      </div>
      <ul className="feature-rows">
        {extensions.map((extension) => (
          <ExtensionCard key={extension.id} extension={extension} />
        ))}
      </ul>
    </section>
  )
}
