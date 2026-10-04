import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Mode } from '../shared/ipc.ts'
import { CYCLE_MODES, MODES } from '../shared/modes.ts'
import { useT } from './settingsStore.ts'
import { useFocusTrap } from './focusTrap.ts'

// 입력창 왼쪽 모드 칩 (사용자 결정 2026-10-02, 01k §5). 칩 하나·항상 보임, 기본이 아니면 모드 색(계획 파랑·매번 묻기 회색 테두리·전체 권한 주황).
// 색만으로 가르지 않는다 — 이름이 늘 보인다(closed-code PermissionModeSwitch 와 같은 이유). 메뉴 모양은 모델 드롭다운(dsh ui-model-selection)과
// 같은 틀에 머리 "모드 ⇧Tab"·줄마다 설명(closed-code 방식). 답을 기다리는 동안은 잠근다(01k §6 권고 — 진행 중 턴이 반은 다른 모드가 된다).
// 전체 권한은 고를 때 확인 대화상자(dsh ui-permission-presets — 체크해야 켜진다). Shift+Tab 순환은 입력창이 한다(nextMode) — 전체 권한은 돌지 않는다

/** Shift+Tab 의 다음 모드 — 전체 권한(순환 밖)에서는 처음으로 */
export function nextMode(mode: Mode): Mode {
  return CYCLE_MODES[(CYCLE_MODES.indexOf(mode) + 1) % CYCLE_MODES.length]!
}

function ModeIcon({ mode }: { mode: Mode }) {
  const paths: Record<Mode, string> = {
    plan: 'M3 4H13M3 8H10M3 12H8', // 목록
    build: 'M5.5 5L2.5 8L5.5 11M10.5 5L13.5 8L10.5 11', // </>
    ask: 'M6 6.2C6 5 6.9 4.2 8 4.2S10 5 10 6C10 7.4 8 7.5 8 9M8 11.6V11.8', // ?
    full: 'M8 2L13 4V8C13 11 10.8 13.2 8 14C5.2 13.2 3 11 3 8V4Z', // 방패
  }
  return (
    <svg className="mode-chip__icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[mode]} />
    </svg>
  )
}

interface ModeChipProps {
  value: Mode
  /** 답을 기다리는 중 — 바꿀 수 없다 */
  locked: boolean
  onChange(mode: Mode): void
}

export function ModeChip({ value, locked, onChange }: ModeChipProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
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

  useEffect(() => {
    if (locked) setOpen(false)
  }, [locked])

  function close(): void {
    setOpen(false)
    triggerRef.current?.focus()
  }

  function choose(mode: Mode): void {
    close()
    if (mode === value) return
    if (mode === 'full') setConfirming(true)
    else onChange(mode)
  }

  function onMenuKeyDown(event: ReactKeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation()
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
    <div className="mode-select" ref={rootRef}>
      {/* 막힌 버튼은 툴팁을 못 띄워 감싼 쪽에 둔다 */}
      <span className="mode-select__wrap" title={locked ? t('mode.locked') : t(`mode.${value}.description`)}>
        <button
          type="button"
          className="mode-chip"
          data-mode={value}
          ref={triggerRef}
          aria-label={t('mode.label', { name: t(`mode.${value}`) })}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={locked}
          onClick={() => setOpen((now) => !now)}
        >
          <ModeIcon mode={value} />
          <span className="mode-chip__name">{t(`mode.${value}`)}</span>
        </button>
      </span>
      {open && (
        <div className="model-menu mode-menu" role="menu" aria-label={t('mode.menu')} ref={menuRef} onKeyDown={onMenuKeyDown}>
          <div className="model-menu__label mode-menu__label">
            <span>{t('mode.menu')}</span>
            <kbd>{t('mode.cycleHint')}</kbd>
          </div>
          {MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              role="menuitemradio"
              className="model-menu__item mode-menu__item"
              data-mode={mode}
              aria-checked={mode === value}
              onClick={() => choose(mode)}
            >
              <ModeIcon mode={mode} />
              <span className="mode-menu__text">
                <span className="mode-menu__name">{t(`mode.${mode}`)}</span>
                <span className="mode-menu__description">{t(`mode.${mode}.description`)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {confirming && (
        <ConfirmFullAccess
          onCancel={() => {
            setConfirming(false)
            triggerRef.current?.focus()
          }}
          onConfirm={() => {
            setConfirming(false)
            onChange('full')
            triggerRef.current?.focus()
          }}
        />
      )}
    </div>
  )
}

/** 전체 권한 확인 (dsh ui-permission-presets: 위험 설명 + "위험을 이해했습니다" 체크 뒤에 켜기). Esc·바깥·취소는 그대로 둔다 */
export function ConfirmFullAccess({ onCancel, onConfirm }: { onCancel(): void; onConfirm(): void }) {
  const t = useT()
  const [acknowledged, setAcknowledged] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation() // 설정 모달까지 닫지 않는다
      onCancel()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onCancel])
  return (
    <div className="confirm-mask" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <div className="confirm-dialog" ref={dialogRef} role="alertdialog" aria-modal="true" aria-labelledby="confirm-full-title" aria-describedby="confirm-full-description">
        <h2 id="confirm-full-title" className="confirm-dialog__title">
          {t('mode.confirm.title')}
        </h2>
        <p id="confirm-full-description" className="confirm-dialog__description">
          {t('mode.confirm.description')}
        </p>
        <label className="confirm-dialog__acknowledge">
          <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} autoFocus />
          {t('mode.confirm.acknowledge')}
        </label>
        <div className="confirm-dialog__actions">
          <button type="button" className="attention-card__button attention-card__button--reject" onClick={onCancel}>
            {t('mode.confirm.cancel')}
          </button>
          <button type="button" className="attention-card__button attention-card__button--danger" disabled={!acknowledged} onClick={onConfirm}>
            {t('mode.confirm.enable')}
          </button>
        </div>
      </div>
    </div>
  )
}
