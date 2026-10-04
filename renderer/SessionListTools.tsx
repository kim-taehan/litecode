import { useT } from './settingsStore.ts'
import './find.css'

// 사이드바 대화 목록의 찾기 칸과 고정 (이슈 #79, dsh ui-workspace 참조 — 제목 부분 일치는 치는 즉시, 고정한 대화가 위).
// 거르기·순서의 규칙은 sessionListView.ts

/** 대화 목록 위 제목 찾기 칸 — 치는 즉시 거른다. Esc 는 글을 지운다 */
export function SessionSearch({ value, onChange }: { value: string; onChange(value: string): void }) {
  const t = useT()
  return (
    <div className="session-search">
      <input
        className="session-search__input"
        type="text"
        aria-label={t('sidebar.searchChats')}
        placeholder={t('sidebar.searchPlaceholder')}
        value={value}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || event.nativeEvent.isComposing || !value) return
          event.preventDefault()
          onChange('')
        }}
      />
      {value && (
        <button type="button" className="session-search__clear" aria-label={t('sidebar.searchClear')} title={t('sidebar.searchClear')} onClick={() => onChange('')}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <path d="M4 4L12 12M12 4L4 12" />
          </svg>
        </button>
      )}
    </div>
  )
}

/** 핀 — 행 버튼(14)과 시각 앞 표식(12)이 같이 쓴다. filled: 고정된 상태 */
export function PinIcon({ size = 14, filled = false }: { size?: number; filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.6 2.2L13.8 6.4L11.6 7L9.4 9.2L9.2 11.8L4.2 6.8L6.8 6.6L9 4.4Z" />
      <path d="M6.6 9.4L2.6 13.4" fill="none" />
    </svg>
  )
}

/** 행의 고정 버튼 — 연필·휴지통과 같은 행 버튼(.session-item__action). 눌린 상태가 고정 */
export function PinButton({ pinned, onToggle }: { pinned: boolean; onToggle(): void }) {
  const t = useT()
  const label = pinned ? t('sidebar.unpinChat') : t('sidebar.pinChat')
  return (
    <button type="button" className="session-item__action" aria-pressed={pinned} aria-label={label} title={label} onClick={onToggle}>
      <PinIcon filled={pinned} />
    </button>
  )
}

/** 고정한 대화의 시각 앞 작은 핀 */
export function PinnedMark() {
  const t = useT()
  return (
    <span className="session-item__pinned" role="img" aria-label={t('sidebar.pinned')} title={t('sidebar.pinned')}>
      <PinIcon size={12} filled />
    </span>
  )
}
