import type { Thinking } from '../shared/engineModelId.ts'
import type { Translate } from './settingsStore.ts'

// 모델 메뉴 안의 Thinking (이슈 #500 시안, dsh ui-model-selection 참조) — Thinking 모델을 고른 동안 메뉴는 루트 패널(Model / Thinking 두 줄)로 열리고,
// Thinking 줄은 디폴트·켬·끔 세 줄 패널로 들어간다. 상태·키보드는 ModelSelect 가 쥔다. 여기는 그리기만

const THINKING: readonly Thinking[] = ['default', 'on', 'off']

/** 루트 줄·Thinking 패널에 보이는 값 이름 (디폴트·켬·끔). 닫힌 칩에서는 접근성 이름·툴팁에 */
export function thinkingLabel(t: Translate, value: Thinking): string {
  return t(`model.thinking.${value}` as const)
}

/** 닫힌 칩의 Thinking 켬 표시 — 채운 전구 하나(13px, aria-hidden — 값은 트리거의 aria-label·title 이 읽힌다). 디폴트·끔일 때는 그리지 않는다 (이슈 #505) */
export function ThinkingBulb() {
  return (
    <svg
      className="model-select__bulb"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z" />
    </svg>
  )
}

/** 루트 패널 — 왼쪽 작은 라벨, 가운데 지금 값, 오른쪽 ›. 누르면 그 패널로 들어간다 */
export function ModelRootPane({ t, modelName, thinking, onOpen }: { t: Translate; modelName: string; thinking: Thinking; onOpen(pane: 'model' | 'thinking'): void }) {
  const rows = [
    { pane: 'model' as const, label: t('model.rowModel'), value: modelName },
    { pane: 'thinking' as const, label: t('model.rowThinking'), value: thinkingLabel(t, thinking) },
  ]
  return (
    <>
      {rows.map((row) => (
        <button key={row.pane} type="button" role="menuitem" className="model-menu__cell" onClick={() => onOpen(row.pane)}>
          <span className="model-menu__cell-label">{row.label}</span>
          <span className="model-menu__cell-value">{row.value}</span>
          <span className="model-menu__cell-chevron" aria-hidden="true">
            ›
          </span>
        </button>
      ))}
    </>
  )
}

/** Thinking 패널 — 머리줄(‹ Thinking, 누르면 루트로)과 세 줄(제목 + 한 줄 설명), 지금 값에 체크 */
export function ThinkingPane({ t, value, onBack, onPick }: { t: Translate; value: Thinking; onBack(): void; onPick(next: Thinking): void }) {
  return (
    <>
      <button type="button" className="model-menu__back" title={t('model.back')} onClick={onBack}>
        <span aria-hidden="true">‹</span>
        {t('model.rowThinking')}
      </button>
      {THINKING.map((option) => (
        <button key={option} type="button" role="menuitemradio" className="model-menu__item" aria-checked={option === value} onClick={() => onPick(option)}>
          <span className="model-menu__option">
            <span className="model-menu__option-title">{thinkingLabel(t, option)}</span>
            <span className="model-menu__option-hint">{t(`model.thinking.${option}Hint` as const)}</span>
          </span>
        </button>
      ))}
    </>
  )
}
