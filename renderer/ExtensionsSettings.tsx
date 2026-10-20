import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import type { ExtensionPreview, ExtensionResult, ExtensionStoreFailure, ExtensionSummary } from '../shared/extensions.ts'
import { useFocusTrap } from './focusTrap.ts'
import { PermissionIcon } from './PermissionIcon.tsx'
import { PuzzleIcon } from './PuzzleIcon.tsx'
import { useT, type Translate } from './settingsStore.ts'
import { cardKind, failedReasonText, failureLines, formatBytes, installKind, lineSummary, problemLine, type ProblemLine } from './extensionsView.ts'

// 설정 > 기능의 확장 (이슈 #489, 시안 _workspace/mock-extension Main·Confirm·Reject). 기능 페이지(FeaturesSettings.tsx)에 끼우는 조각들:
// 검색창 옆 [확장 추가 (zip)] · 설치 직후 안내 · 기능 카드 아래 "설치한 확장" 구분선 + 카드 · 설치 확인/거절 대화상자.
// 카드는 기능 줄(.feature-row)의 모양을 그대로 쓰고 퍼즐 타일 · 보라 "확장" 뱃지 · 버전 · [열기] · ⋯ 메뉴를 더한다.
// 패널 확장 (이슈 #511, 시안 _workspace/mock-extension-panel Installed): 설치·삭제는 곧바로 적용된다(보류·재시작 안내가 없어졌다).
// 설치가 끝나면 대화상자를 닫고 초록 안내 한 줄 + 그 확장 탭을 오른쪽 패널에 연다(설치 직후 한 번). 정상(on) 카드에 [열기] — 탭을 열고 패널을 연다.
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

/** 설치 확인 (시안 Confirm) — 취소·Esc·바깥 누르기는 모두 cancelExtension(token). 설치가 실패하면 사유를 보이고 열어 둔다.
 *  성공하면 onInstalled(설치된 id) 뒤에 닫는다 */
export function ExtensionConfirmDialog({ preview, onClose, onInstalled }: { preview: ExtensionPreview; onClose(): void; onInstalled?(id: string): void }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<ProblemLine[]>()
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef)
  const manifest = preview.manifest
  const kind = installKind(preview)

  function cancel(): void {
    if (busy) return // 설치(압축 풀기) 중에는 닫지 않는다 — 큰 확장은 수십 초 걸린다 (이슈 #550)
    if (preview.token) void request(() => window.litecode.cancelExtension(preview.token!))
    onClose()
  }
  useEscape(cancel)

  async function install(): Promise<void> {
    if (!preview.token) return
    setBusy(true)
    const result = await request(() => window.litecode.installExtension(preview.token!))
    setBusy(false)
    if (result.ok) {
      // 목록은 extensions:changed 로 갱신된다
      onInstalled?.(result.id)
      onClose()
    } else setFailure(failureLines(result.failure))
  }

  const existing = preview.existing && manifest && {
    upgrade: t('extensions.confirm.upgrade', { from: preview.existing.version, to: manifest.version }),
    same: t('extensions.confirm.same', { version: manifest.version }),
    downgrade: t('extensions.confirm.downgrade', { from: preview.existing.version, to: manifest.version }),
    new: '',
  }[kind]
  const permissions = manifest?.permissions ?? []
  // 권한이 있으면 설치가 곧 권한 동의다 (이슈 #536, 시안 Confirm) — 업그레이드여도 같은 버튼 글(바뀐 것은 "이미 설치됨" 줄이 알린다)
  const installLabel =
    permissions.length > 0
      ? 'extensions.confirm.installWithPermissions'
      : kind === 'new'
        ? 'extensions.confirm.install'
        : kind === 'upgrade'
          ? 'extensions.confirm.installUpgrade'
          : 'extensions.confirm.reinstall'

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
        {permissions.length > 0 && (
          <section className="extension-permissions" aria-labelledby="extension-permissions-title">
            <b id="extension-permissions-title" className="extension-permissions__title">
              {t('extensions.confirm.permissionsTitle')}
            </b>
            <ul className="extension-permissions__list">
              {permissions.map((permission) => (
                <li key={permission} className="extension-permission" data-permission={permission}>
                  <PermissionIcon permission={permission} className="extension-permission__icon" />
                  <span className="extension-permission__text">
                    <span className="extension-permission__name">{t(`extensions.permission.${permission}`)}</span>
                    <span className="extension-permission__note">{t(`extensions.permission.${permission}.note`, { port: manifest?.server?.port ?? '' })}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
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
          {permissions.length === 0 && (
            <>
              <dt>{t('extensions.confirm.permissions')}</dt>
              <dd>{t('extensions.confirm.permissionsNone')}</dd>
            </>
          )}
          {existing && (
            <>
              <dt>{t('extensions.confirm.existing')}</dt>
              <dd>
                <b>{existing}</b>
              </dd>
            </>
          )}
        </dl>
        <p className="settings-notice extension-confirm__warning">{t(permissions.length > 0 ? 'extensions.confirm.warningPermissions' : 'extensions.confirm.warning')}</p>
        {failure && (
          <div className="feature-row__failure" role="alert">
            <b>{t('extensions.confirm.failed')}</b>
            <ProblemList lines={failure} />
          </div>
        )}
        <div className="confirm-dialog__actions">
          <button type="button" className="settings-button" disabled={busy} onClick={cancel}>
            {t('extensions.confirm.cancel')}
          </button>
          <button type="button" className="settings-button settings-button--primary" disabled={busy || !preview.token} aria-busy={busy || undefined} onClick={() => void install()}>
            {busy && <ButtonSpinner />}
            {t(busy ? 'extensions.installing' : installLabel)}
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

/** 설치가 끝났다 — 안내에 쓸 이름 */
export interface InstalledNote {
  name: string
}

/** [확장 추가 (zip)] — zip 고르기 → 통과면 설치 확인, 사유가 있으면 거절. 대화상자를 취소하면 아무것도 안 한다.
 *  설치가 끝나면 onInstalled 로 알린다(탭을 자동으로 열지 않는다 — 쓰는 법은 확장 상세의 details) — 안내 줄은 기능 페이지가 그린다 */
export function ExtensionAddButton({ onInstalled }: { onInstalled?(note: InstalledNote): void }) {
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
      <button type="button" className="settings-button settings-button--compact settings-button--primary extensions-add" disabled={busy} aria-busy={busy || undefined} onClick={() => void pick()}>
        {busy ? (
          <ButtonSpinner />
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <path d="M6 1.5v9M1.5 6h9" />
          </svg>
        )}
        {t(busy ? 'extensions.checking' : 'extensions.add')}
      </button>
      {dialog?.kind === 'confirm' && (
        <ExtensionConfirmDialog
          preview={dialog.preview}
          onClose={close}
          onInstalled={(id) => {
            const name = dialog.preview.manifest?.name ?? id
            onInstalled?.({ name })
          }}
        />
      )}
      {dialog?.kind === 'reject' && <ExtensionRejectDialog lines={dialog.lines} onClose={close} />}
    </>
  )
}

/** 설치 직후 초록 안내 한 줄 (시안 Installed) */
export function ExtensionInstalledNotice({ name }: InstalledNote) {
  const t = useT()
  return (
    <p className="extensions-installed" role="status">
      {t('extensions.installed', { name })}
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

/** 확장 카드 한 장 — 상태(cardKind)에 따라 설명 자리·스위치가 바뀐다. 본문(아이콘·이름·설명)을 누르면 상세가 펼쳐진다 — 기능 카드의
 *  feature-row__toggle 과 같은 모양 (이슈 #519). initialExpanded 는 테스트가 펼친 상세를 그릴 때 */
export function ExtensionCard({ extension, initialExpanded = false }: { extension: ExtensionSummary; initialExpanded?: boolean }) {
  const t = useT()
  const [expanded, setExpanded] = useState(initialExpanded)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [error, setError] = useState<string>()
  const kind = cardKind(extension)
  const name = extension.name ?? extension.id

  async function run(call: () => Promise<ExtensionResult>): Promise<void> {
    const result = await request(call)
    setError(result.ok ? undefined : failureLines(result.failure).map((line) => lineSummary(line, t)).join(' · '))
  }

  function summary(): ReactNode {
    if (kind === 'failed' && extension.reason) return <span className="feature-row__summary extension-row__reason">{failedReasonText(extension.reason, t)}</span>
    return <span className="feature-row__summary">{extension.description}</span>
  }

  const invalidProblems = extension.state === 'failed' && extension.reason?.code === 'invalid' ? extension.reason.params.problems : []
  const detailId = `extension-detail-${extension.id}`

  return (
    <li className="feature-row extension-row" data-extension={extension.id} data-kind={kind} data-expanded={expanded || undefined} data-on={extension.state === 'on' || undefined}>
      <div className="feature-row__head">
        <button type="button" className="feature-row__toggle extension-row__body" aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpanded((now) => !now)}>
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
        </button>
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
          <>
            <MoreMenu
              label={t('extensions.more', { name })}
              items={[
                { label: t('extensions.menu.remove'), danger: true, onSelect: () => setConfirmingRemove(true) },
              ]}
            />
          </>
        )}
        <button
          type="button"
          role="switch"
          className="settings-switch"
          aria-checked={extension.enabled}
          aria-label={name}
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
      {expanded && (
        <div className="feature-row__detail extension-row__info" id={detailId}>
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
          {/* details 는 글로만 — 줄바꿈은 CSS pre-line 으로 살린다 (이슈 #519) */}
          {extension.details && <p className="extension-row__details">{extension.details}</p>}
          {invalidProblems.length > 0 && (
            <>
              <b>{t('extensions.info.problems')}</b>
              <ProblemList lines={invalidProblems.map(problemLine)} />
            </>
          )}
          {/* 허용한 주소 (이슈 #536) — 확장 탭의 동의 띠에서 허용한 origin. 거두면 다음 요청 때 다시 묻는다 */}
          {extension.origins && extension.origins.length > 0 && (
            <>
              <b>{t('extensions.info.origins')}</b>
              <ul className="extension-origins">
                {extension.origins.map((origin) => (
                  <li key={origin} className="extension-origin">
                    <code>{origin}</code>
                    <button
                      type="button"
                      className="settings-button settings-button--compact"
                      aria-label={t('extensions.origins.revokeLabel', { origin })}
                      onClick={() => void run(() => window.litecode.revokeExtensionOrigin(extension.id, origin))}
                    >
                      {t('extensions.origins.revoke')}
                    </button>
                  </li>
                ))}
              </ul>
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

/** 버튼 안의 도는 고리 — 큰 zip 의 검사·설치가 수십 초 걸린다 (이슈 #550) */
function ButtonSpinner() {
  return (
    <svg className="button-spinner" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.5" />
      <path d="M6 1.5a4.5 4.5 0 0 1 4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
