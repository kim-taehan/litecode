import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ProviderSummary } from '../shared/ipc.ts'
import { focusComposerInput } from './composerFocus.ts'
import { findModel, withThinking, type ModelRef } from './modelChoice.ts'
import { engineModelId, resolveModelKey, type Thinking } from '../shared/engineModelId.ts'
import { useT } from './settingsStore.ts'
import { ModelRootPane, ThinkingBulb, ThinkingPane, thinkingLabel } from './ThinkingPane.tsx'

interface ModelSelectProps {
  providers: ProviderSummary[]
  /** 그 대화의 모델 — 설정에서 지워졌으면 "모델 없음" 으로 보인다 */
  value?: ModelRef
  onChange(next: ModelRef): void
}

/** 메뉴가 보이는 패널 — 루트(Model / Thinking 두 줄)는 Thinking 모델을 고른 동안만 (이슈 #500) */
export type ModelMenuPane = 'root' | 'model' | 'thinking'

/** 그 선택의 Thinking 값 — Thinking 모델이고, 켬·끔 키가 그 항목으로 되돌아올 때만. 파생 키가 같은 provider 의 다른 항목 id 와 겹치는
 *  읽기 상태(저장은 거절)면 없음 — "켬"이 다른 진짜 모델로 가지 않게 Thinking 을 고르지 못한다 (이슈 #503) */
export function thinkingOf(current: ReturnType<typeof findModel>): Thinking | undefined {
  if (current?.model.thinking !== true) return undefined
  const intact = (['on', 'off'] as const).every((value) => resolveModelKey(current.provider.models, engineModelId(current.model, value))?.model === current.model)
  return intact ? current.thinking : undefined
}

/** 메뉴를 열 때의 패널 — Thinking 을 고를 수 있으면 루트, 아니면 곧바로 모델 목록 (지금까지와 같다) */
export function openingPane(current: ReturnType<typeof findModel>): ModelMenuPane {
  return thinkingOf(current) ? 'root' : 'model'
}

/** 입력창 아래 모델 드롭다운 (dsh ui-model-selection 참조). 설정의 모든 모델을 provider 묶음으로 보이고, 지금 모델 줄에 체크.
 *  Thinking 모델(이슈 #500)을 고른 동안은 칩에 Thinking 값이 전구 아이콘으로 붙고(#503), 메뉴는 루트 패널(Model / Thinking)로 열린다.
 *  열면 첫 줄(모델 목록이면 지금 모델 줄)에 포커스, ↑/↓ 로 옮기고 Enter·클릭으로 들어가거나 고른다. Esc·Shift+Tab 은 들어간 패널에서 루트로,
 *  루트(또는 루트가 없는 모델 목록)에서는 고르지 않고 닫는다. 바깥 클릭도 닫는다. 닫히면 포커스는 입력창으로 (#374) */
export function ModelSelect({ providers, value, onChange }: ModelSelectProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<ModelMenuPane>('model')
  // 바꾼 뒤 버튼 위에 잠깐 띄우는 작은 알림 — 바뀐 것을 알아채게 (사용자 요청 2026-10-01)
  const [toast, setToast] = useState<string>()
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(toastTimer.current), [])
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  /** 루트로 돌아올 때 포커스를 돌려줄 줄 — 그 패널을 연 줄 (dsh) */
  const cameFrom = useRef<'model' | 'thinking'>(undefined)
  const current = findModel(providers, value)
  const thinking = thinkingOf(current)
  const label = current?.model.displayName ?? (providers.length === 0 ? t('model.loading') : t('model.none'))
  // 지워진 모델은 dsh 처럼 저장된 provider/모델 id 를 보여 준다 (툴팁). Thinking 값은 아이콘이라 툴팁 첫 줄에 글자로 (#503)
  const detail = current ? `${current.provider.displayName} · ${current.model.id}` : value && t('model.missing', { ref: `${value.providerId}/${value.modelId}` })
  const title = thinking ? `${t('model.thinkingTitle', { value: thinkingLabel(t, thinking) })}\n${detail}` : detail

  const rows = () => [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]') ?? [])]

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close()
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])

  // 패널이 바뀌면 보던 줄이 사라진다 — 들어간 패널은 지금 값 줄(없으면 첫 줄), 루트로 돌아오면 그 패널을 연 줄에 포커스
  useEffect(() => {
    if (!open) return
    const list = rows()
    const back = pane === 'root' && cameFrom.current ? list[cameFrom.current === 'thinking' ? 1 : 0] : undefined
    cameFrom.current = undefined
    ;(back ?? list.find((row) => row.getAttribute('aria-checked') === 'true') ?? list[0])?.focus()
  }, [open, pane])

  function show(): void {
    setPane(openingPane(current))
    setOpen(true)
  }

  function close(): void {
    setOpen(false)
    if (!focusComposerInput()) triggerRef.current?.focus() // 닫히면 입력창으로 — 없으면(컴포저 안 보이는 화면) 버튼으로
  }

  /** 들어간 패널에서 한 단계 — 루트가 있으면 루트로, 없으면 닫기 */
  function leave(): void {
    if (pane !== 'root' && openingPane(current) === 'root') {
      cameFrom.current = pane
      setPane('root')
    } else close()
  }

  function onMenuKeyDown(event: ReactKeyboardEvent): void {
    if (event.key === 'Escape' || (event.key === 'Tab' && event.shiftKey)) {
      event.preventDefault()
      event.stopPropagation() // 메뉴만 닫는다
      leave()
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
        aria-label={thinking ? t('model.labelThinking', { name: label, value: thinkingLabel(t, thinking) }) : t('model.label', { name: label })}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        disabled={providers.length === 0}
        onClick={() => (open ? close() : show())}
      >
        <span className="composer__model">{label}</span>
        {/* Thinking 모델이면 값이 전구 아이콘으로 (#503 시안 — 디폴트 윤곽선·켬 채움·끔 사선) */}
        {thinking && <ThinkingBulb value={thinking} />}
        {/* dsh IconChevronDownOutline (14px, 캡션색), 열리면 뒤집힌다 */}
        <svg className="model-select__caret" width="14" height="14" viewBox="0 0 16 16" fill="none" strokeWidth="1" aria-hidden="true">
          <path d="M4 6L7.3 9.3C7.7 9.7 8.3 9.7 8.7 9.3L12 6" stroke="currentColor" />
        </svg>
      </button>
      {open && (
        <div className="model-menu" role="menu" aria-label={t('model.menu')} ref={menuRef} onKeyDown={onMenuKeyDown}>
          {pane === 'root' && current && thinking && (
            <ModelRootPane t={t} modelName={current.model.displayName} thinking={thinking} onOpen={setPane} />
          )}
          {pane === 'thinking' && thinking && (
            <ThinkingPane
              t={t}
              value={thinking}
              onBack={leave}
              onPick={(next) => {
                const ref = withThinking(providers, value, next)
                if (ref && ref.modelId !== value?.modelId) onChange(ref)
                close()
              }}
            />
          )}
          {pane === 'model' &&
            providers
              .filter((provider) => provider.models.length > 0)
              .map((provider) => (
                <div key={provider.id} role="group" aria-label={provider.displayName}>
                  <div className="model-menu__label">{provider.displayName}</div>
                  {provider.models.map((model) => {
                    // 체크는 항목 단위 — 같은 항목의 Thinking 켬·끔 키도 이 줄 (이슈 #500)
                    const selected = current?.provider.id === provider.id && current?.model === model
                    return (
                      <button
                        key={model.id}
                        type="button"
                        role="menuitemradio"
                        className="model-menu__item"
                        aria-checked={selected}
                        title={model.id}
                        onClick={() => {
                          close()
                          if (selected) return // 같은 모델 — Thinking 값도 그대로
                          // 새 모델은 디폴트로 시작한다 — 그 모델의 이전 Thinking 값을 기억하지 않는다 (#500 시안)
                          onChange({ providerId: provider.id, modelId: engineModelId(model) })
                          setToast(t('model.changed', { name: model.displayName }))
                          clearTimeout(toastTimer.current)
                          toastTimer.current = setTimeout(() => setToast(undefined), 2_000)
                        }}
                      >
                        {model.displayName}
                      </button>
                    )
                  })}
                </div>
              ))}
        </div>
      )}
    </div>
  )
}
