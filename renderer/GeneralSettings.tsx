import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import type { Appearance, Mode, Settings } from '../shared/ipc.ts'
import { LANGUAGES } from '../shared/i18n/index.ts'
import { MODES } from '../shared/modes.ts'
import { speechLanguage, type SpeechLanguage } from '../shared/speech.ts'
import { ConfirmFullAccess } from './ModeChip.tsx'
import { FONT_SIZE_MAX, FONT_SIZE_MIN } from '../shared/fontSize.ts'
import { useFeatures } from './featuresStore.ts'
import { updateSettings, useSettings, useT } from './settingsStore.ts'
import { DEFAULT_UPDATE_URL } from '../shared/updates.ts'
import { updateResult, useUpdateStatus } from './updates.ts'

// 설정 > 일반 — dsh ui-settings-general GeneralSection 의 행 모양(이름 + 회색 설명, 오른쪽 컨트롤, 행 사이 0.5px 선)과
// 행들(locale LanguageRow · ui-theme AppearanceRow·FontSizeRow · DeveloperToolsRow)을 따른다. 바꾸면 곧바로 메인(ctx.settings)에
// 저장하고, 보이는 값은 저장된 값을 따른다(클릭을 미리 반영하지 않는다 — dsh). 저장에 실패하면 페이지 위에 한 줄.

function ChevronDown() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 6L7.3 9.3C7.7 9.7 8.3 9.7 8.7 9.3L12 6" />
    </svg>
  )
}

function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.8 7.3L5.6 10.1L11.2 3.9" />
    </svg>
  )
}

const ARROW = { up: 'M2 6.5L4.5 4L7 6.5', down: 'M2 2.5L4.5 5L7 2.5' }
function Arrow({ direction }: { direction: keyof typeof ARROW }) {
  return (
    <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ARROW[direction]} />
    </svg>
  )
}

/** 테마 카드 아이콘 16px — 해(라이트)·달(다크)·반쪽 원(시스템) */
const THEME_ICON: Record<Appearance, ReactNode> = {
  light: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5V2.8M8 13.2V14.5M1.5 8H2.8M13.2 8H14.5M3.4 3.4L4.3 4.3M11.7 11.7L12.6 12.6M3.4 12.6L4.3 11.7M11.7 4.3L12.6 3.4" />
    </svg>
  ),
  dark: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true">
      <path d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5A5.8 5.8 0 1 0 13.5 9.6Z" />
    </svg>
  ),
  system: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 2.2A5.8 5.8 0 0 1 8 13.8Z" fill="currentColor" />
    </svg>
  ),
}

export function GeneralPage() {
  const t = useT()
  const settings = useSettings()
  const [error, setError] = useState<string>()
  /** 새 대화 기본 모드로 전체 권한을 고르는 중 — 확인 대화상자 (dsh PermissionRow) */
  const [confirmingFull, setConfirmingFull] = useState(false)
  const [version, setVersion] = useState<string>()
  const features = useFeatures()
  const voiceOn = features.has('voice')
  const updatesOn = features.has('updates')
  useEffect(() => void window.litecode.getAppVersion().then(setVersion, () => {}), [])
  const save = (patch: Partial<Settings>): void =>
    void updateSettings(patch).then(
      () => setError(undefined),
      () => setError(t('settings.saveError')),
    )

  return (
    <div className="general-page">
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {/* 새 대화의 입력창 칩 처음 값 (01k §6 — dsh "새 세션의 기본 권한 모드" 행 — dsh 처럼 맨 위). 전체 권한은 확인 뒤에 */}
      <div className="settings-row">
        <div className="settings-row__text">
          <div className="settings-row__title">{t('settings.defaultMode')}</div>
          <div className="settings-row__description">{t('settings.defaultMode.description')}</div>
        </div>
        <OptionSelect<Mode>
          value={settings.defaultMode}
          options={MODES.map((mode) => ({ id: mode, label: t(`mode.${mode}`) }))}
          onChange={(defaultMode) => (defaultMode === 'full' ? setConfirmingFull(true) : save({ defaultMode }))}
        />
      </div>
      {confirmingFull && (
        <ConfirmFullAccess
          onCancel={() => setConfirmingFull(false)}
          onConfirm={() => {
            setConfirmingFull(false)
            save({ defaultMode: 'full' })
          }}
        />
      )}

      <div className="settings-row">
        <div className="settings-row__text">
          <div className="settings-row__title">{t('settings.language')}</div>
        </div>
        <OptionSelect value={settings.language} options={LANGUAGES} onChange={(language) => save({ language })} />
      </div>

      {/* 받아쓰기 언어 (음성 입력, 이슈 #109) — 기능이 켜져 있을 때만. 고른 적이 없으면 화면 언어를 따른다 (shared/speech.ts) */}
      {voiceOn && (
        <div className="settings-row" data-setting="speechLanguage">
          <div className="settings-row__text">
            <div className="settings-row__title">{t('settings.speechLanguage')}</div>
            <div className="settings-row__description">{t('settings.speechLanguage.description')}</div>
          </div>
          <OptionSelect<SpeechLanguage>
            value={speechLanguage(settings)}
            options={[
              { id: 'auto', label: t('settings.speechLanguage.auto') },
              ...LANGUAGES,
            ]}
            onChange={(next) => save({ speechLanguage: next })}
          />
        </div>
      )}

      <div className="settings-row settings-row--stacked">
        <div className="settings-row__title">{t('settings.appearance')}</div>
        <div className="theme-cards">
          {(['light', 'dark', 'system'] as const).map((appearance) => (
            <button
              key={appearance}
              type="button"
              className="theme-card"
              aria-pressed={settings.appearance === appearance}
              onClick={() => save({ appearance })}
            >
              {THEME_ICON[appearance]}
              {t(`settings.appearance.${appearance}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-row__text">
          <div className="settings-row__title">{t('settings.fontSize')}</div>
          <div className="settings-row__description">{t('settings.fontSize.description')}</div>
        </div>
        <div className="font-size">
          <div className="font-size__stepper">
            <span className="font-size__value">{settings.fontSize}</span>
            <span className="font-size__arrows">
              <button
                type="button"
                className="font-size__arrow"
                aria-label={t('settings.fontSize.increase')}
                disabled={settings.fontSize >= FONT_SIZE_MAX}
                onClick={() => save({ fontSize: settings.fontSize + 1 })}
              >
                <Arrow direction="up" />
              </button>
              <button
                type="button"
                className="font-size__arrow"
                aria-label={t('settings.fontSize.decrease')}
                disabled={settings.fontSize <= FONT_SIZE_MIN}
                onClick={() => save({ fontSize: settings.fontSize - 1 })}
              >
                <Arrow direction="down" />
              </button>
            </span>
          </div>
          <span className="font-size__unit">{t('settings.fontSize.unit')}</span>
        </div>
      </div>

      {/* 자동 대화 제목 (이슈 #215, 기본 꺼짐) — 첫 답이 끝나면 메인(autoTitle.ts)이 모델에 한 번 더 물어 제목을 바꾼다 */}
      <div className="settings-row">
        <div className="settings-row__text">
          <div className="settings-row__title">{t('settings.autoTitle')}</div>
          <div className="settings-row__description">{t('settings.autoTitle.description')}</div>
        </div>
        <button
          type="button"
          role="switch"
          className="settings-switch"
          aria-checked={settings.autoTitle === true}
          aria-label={t('settings.autoTitle')}
          onClick={() => save({ autoTitle: settings.autoTitle !== true })}
        >
          <span className="settings-switch__thumb" />
        </button>
      </div>

      {/* 창 닫기 = 숨기기 (ctx.quit, 이슈 #92) — Windows·Linux 만. macOS 는 창을 닫아도 원래 앱이 남는다 (플랫폼 표시는 preload 가 html 에 적는다) */}
      {document.documentElement.dataset.platform !== 'darwin' && (
        <div className="settings-row">
          <div className="settings-row__text">
            <div className="settings-row__title">{t('settings.keepRunning')}</div>
            <div className="settings-row__description">{t('settings.keepRunning.description')}</div>
          </div>
          <button
            type="button"
            role="switch"
            className="settings-switch"
            aria-checked={settings.keepRunning !== false}
            aria-label={t('settings.keepRunning')}
            onClick={() => save({ keepRunning: settings.keepRunning === false })}
          >
            <span className="settings-switch__thumb" />
          </button>
        </div>
      )}

      {/* 새 버전 알림 (이슈 #273) — 기능이 켜져 있을 때만: 확인 주소(비우면 기본) + [지금 확인] 과 결과 한 줄 */}
      {updatesOn && <UpdateRows updateUrl={settings.updateUrl ?? ''} onSave={(updateUrl) => save({ updateUrl })} />}

      {/* 맨 아래 한 줄 — dsh CurrentVersionRow. 못 받으면 줄째 없다 */}
      {version && <div className="settings-version">{t('settings.currentVersion', { version })}</div>}
    </div>
  )
}

/** 확인 주소(칸을 떠나거나 Enter 면 저장 — 잘못된 주소는 메인이 거절해 위에 한 줄) + [지금 확인] 과 결과 한 줄 */
function UpdateRows({ updateUrl, onSave }: { updateUrl: string; onSave(next: string): void }) {
  const t = useT()
  const status = useUpdateStatus(true)
  const [draft, setDraft] = useState(updateUrl)
  useEffect(() => setDraft(updateUrl), [updateUrl])
  const commit = (): void => {
    if (draft.trim() !== updateUrl) onSave(draft.trim())
  }
  const result = updateResult(status)
  return (
    <>
      <div className="settings-row settings-row--stacked" data-setting="updateUrl">
        <div className="settings-row__text">
          <div className="settings-row__title">{t('settings.updateUrl')}</div>
          <div className="settings-row__description">{t('settings.updateUrl.description')}</div>
        </div>
        <input
          className="settings-input"
          type="url"
          spellCheck={false}
          aria-label={t('settings.updateUrl')}
          placeholder={DEFAULT_UPDATE_URL}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => event.key === 'Enter' && commit()}
        />
      </div>
      <div className="settings-row" data-setting="updateCheck">
        <div className="settings-row__text">
          <div className="settings-row__title">{t('settings.updateCheck')}</div>
          {result && (
            <div className="settings-row__description" role="status">
              {t(result.key, result.vars)}
            </div>
          )}
        </div>
        <button
          type="button"
          className="settings-button"
          disabled={status.state === 'checking'}
          onClick={() => void window.litecode.checkForUpdate().catch(() => {})}
        >
          {t('settings.updateCheck.now')}
        </button>
      </div>
    </>
  )
}

/** 설정 드롭다운 — 언어·새 대화 기본 모드 (dsh LanguageRow + ui-primitives Menu): 버튼 오른쪽 끝에 맞춘 메뉴, 고른 줄은 바탕 없이 오른쪽 ✓.
 *  열면 고른 줄에 포커스, ↑/↓ 로 옮기고 Enter·클릭으로 고른다. Esc 는 메뉴만 닫는다(모달은 그대로), 바깥 클릭은 닫는다 */
function OptionSelect<T extends string>({ value, options, onChange }: { value: T; options: readonly { id: T; label: string }[]; onChange(next: T): void }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const rows = () => [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])]

  useEffect(() => {
    if (!open) return
    const list = rows()
    ;(list.find((row) => row.getAttribute('aria-checked') === 'true') ?? list[0])?.focus()
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
    if (event.key === 'Tab') {
      setOpen(false)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const list = rows()
    const at = list.indexOf(document.activeElement as HTMLElement)
    list[(at + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus()
  }

  return (
    <div className="settings-select" ref={rootRef}>
      <button
        type="button"
        className="settings-select__trigger"
        ref={triggerRef}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((now) => !now)}
      >
        {options.find((option) => option.id === value)?.label}
        <ChevronDown />
      </button>
      {open && (
        <div className="settings-menu" role="menu" ref={menuRef} onKeyDown={onMenuKeyDown}>
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              role="menuitemradio"
              className="settings-menu__item"
              aria-checked={option.id === value}
              onClick={() => {
                close()
                if (option.id !== value) onChange(option.id)
              }}
            >
              <span>{option.label}</span>
              {option.id === value && <Check />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
