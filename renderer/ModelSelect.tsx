import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ProviderSummary } from '../shared/ipc.ts'
import { findModel, type ModelRef } from './modelChoice.ts'
import { useT } from './settingsStore.ts'

interface ModelSelectProps {
  providers: ProviderSummary[]
  /** 그 대화의 모델 — 설정에서 지워졌으면 "모델 없음" 으로 보인다 */
  value?: ModelRef
  onChange(next: ModelRef): void
}

/** 입력창 아래 모델 드롭다운 (dsh ui-model-selection 참조). 설정의 모든 모델을 provider 묶음으로 보이고, 지금 모델 줄에 체크.
 *  열면 그 줄에 포커스, ↑/↓ 로 옮기고 Enter·클릭으로 고른다. Esc·바깥 클릭은 고르지 않고 닫는다. 닫히면 포커스는 버튼으로 */
export function ModelSelect({ providers, value, onChange }: ModelSelectProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  // 바꾼 뒤 버튼 위에 잠깐 띄우는 작은 알림 — 바뀐 것을 알아채게 (사용자 요청 2026-10-01)
  const [toast, setToast] = useState<string>()
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(toastTimer.current), [])
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const current = findModel(providers, value)
  const label = current?.model.displayName ?? (providers.length === 0 ? t('model.loading') : t('model.none'))
  // 지워진 모델은 dsh 처럼 저장된 provider/모델 id 를 보여 준다 (툴팁)
  const detail = current ? `${current.provider.displayName} · ${current.model.id}` : value && t('model.missing', { ref: `${value.providerId}/${value.modelId}` })

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
      event.stopPropagation() // 메뉴만 닫는다
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
    const step = event.key === 'ArrowDown' ? 1 : -1
    list[(at + step + list.length) % list.length]?.focus()
  }

  return (
    <div className="model-select" ref={rootRef}>
      {toast && (
        <div className="model-toast" role="status">
          {toast}
        </div>
      )}
      <button
        type="button"
        className="model-select__trigger"
        ref={triggerRef}
        aria-label={t('model.label', { name: label })}
        aria-haspopup="menu"
        aria-expanded={open}
        title={detail}
        disabled={providers.length === 0}
        onClick={() => setOpen((now) => !now)}
      >
        <span className="composer__model">{label}</span>
        {/* dsh IconChevronDownOutline (14px, 캡션색), 열리면 뒤집힌다 */}
        <svg className="model-select__caret" width="14" height="14" viewBox="0 0 16 16" fill="none" strokeWidth="1" aria-hidden="true">
          <path d="M4 6L7.3 9.3C7.7 9.7 8.3 9.7 8.7 9.3L12 6" stroke="currentColor" />
        </svg>
      </button>
      {open && (
        <div className="model-menu" role="menu" aria-label={t('model.menu')} ref={menuRef} onKeyDown={onMenuKeyDown}>
          {providers
            .filter((provider) => provider.models.length > 0)
            .map((provider) => (
              <div key={provider.id} role="group" aria-label={provider.displayName}>
                <div className="model-menu__label">{provider.displayName}</div>
                {provider.models.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    role="menuitemradio"
                    className="model-menu__item"
                    aria-checked={provider.id === value?.providerId && model.id === value.modelId}
                    title={model.id}
                    onClick={() => {
                      const changed = provider.id !== value?.providerId || model.id !== value.modelId
                      onChange({ providerId: provider.id, modelId: model.id })
                      close()
                      if (!changed) return
                      setToast(t('model.changed', { name: model.displayName }))
                      clearTimeout(toastTimer.current)
                      toastTimer.current = setTimeout(() => setToast(undefined), 2_000)
                    }}
                  >
                    {model.displayName}
                  </button>
                ))}
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
