import { useEffect, useRef, useState, type RefObject } from 'react'
import { useT } from './settingsStore.ts'

export type WsGroupBy = 'date' | 'status' | 'unread' | 'none'
export type WsSortBy = 'date' | 'name' | 'recent'
export type WsRecency = '7d' | '30d' | 'all'

export interface WsSettings {
  groupBy: WsGroupBy
  sortBy: WsSortBy
  recency: WsRecency
}

export const WS_SETTINGS_DEFAULT: WsSettings = { groupBy: 'date', sortBy: 'date', recency: 'all' }

const STORAGE_KEY = 'litecode.wsSettings'
const GROUP_BY_VALUES: WsGroupBy[] = ['date', 'status', 'unread', 'none']

export function loadWsSettings(): WsSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return WS_SETTINGS_DEFAULT
    const parsed = JSON.parse(raw) as Partial<WsSettings>
    return {
      groupBy: GROUP_BY_VALUES.includes(parsed.groupBy as WsGroupBy) ? (parsed.groupBy as WsGroupBy) : 'date',
       sortBy: parsed.sortBy === 'name' || parsed.sortBy === 'recent' ? parsed.sortBy : 'date',
      recency: parsed.recency === '7d' || parsed.recency === '30d' ? parsed.recency : 'all',
    }
  } catch {
    return WS_SETTINGS_DEFAULT
  }
}

export function saveWsSettings(s: WsSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
}

interface WsSettingsPopoverProps {
  open: boolean
  onClose(): void
  buttonRef: RefObject<HTMLButtonElement | null>
  width: number
  settings: WsSettings
  onChange(s: WsSettings): void
}

export function WsSettingsPopover({ open, onClose, buttonRef, width, settings, onChange }: WsSettingsPopoverProps) {
  const t = useT()
  const [anchor, setAnchor] = useState<{ top: number; left: number }>()
  const [expanded, setExpanded] = useState<'none' | 'groupBy' | 'sortBy' | 'recency'>('none')
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setExpanded('none')
    const btn = buttonRef.current
    if (btn) {
      const rect = btn.getBoundingClientRect()
      setAnchor({ top: rect.bottom + 6, left: rect.left - (rect.width / 2 - 12) })
    }
  }, [open, buttonRef, width])

  useEffect(() => {
    if (open) return
    setAnchor(undefined)
  }, [open])

  useEffect(() => {
    if (!open) return
    function onMouseDown(event: MouseEvent): void {
      const target = event.target
      if (target instanceof Node && (panelRef.current?.contains(target) || buttonRef.current?.contains(target))) return
      onClose()
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose, buttonRef])

  if (!open || !anchor) return null

  function row(label: string, value: string, key: 'groupBy' | 'sortBy' | 'recency') {
    const isExpanded = expanded === key
    return (
      <button
        type="button"
        className={`ws-pop__row${isExpanded ? ' ws-pop__row--expanded' : ''}`}
        onClick={() => setExpanded(isExpanded ? 'none' : key)}
      >
        <span className="ws-pop__label">{label}</span>
        <span className="ws-pop__value">{value}</span>
        <span className="ws-pop__caret" aria-hidden="true">›</span>
      </button>
    )
  }

  function optionRow(label: string, selected: boolean, onSelect: () => void) {
    return (
      <button type="button" className={`ws-pop__option${selected ? ' ws-pop__option--on' : ''}`} onClick={onSelect}>
        {label}
        {selected && <span className="ws-pop__check" aria-hidden="true">✓</span>}
      </button>
    )
  }

  return (
    <div className="ws-pop" ref={panelRef} role="dialog" aria-label={t('sidebar.workspaceSettings')} style={{ top: anchor.top, left: anchor.left, width }}>
      <div className="ws-pop__header">{t('sidebar.workspaceSettings')}</div>

      <div className="ws-pop__menupair">
        {row(t('sidebar.ws.lastActive'), settings.recency === '7d' ? t('sidebar.ws.lastActive7') : settings.recency === '30d' ? t('sidebar.ws.lastActive30') : t('sidebar.ws.lastActiveAll'), 'recency')}
        {expanded === 'recency' && (
          <div className="ws-pop__menu ws-pop__menu--open">
            {optionRow(t('sidebar.ws.lastActive7'), settings.recency === '7d', () => { onChange({ ...settings, recency: '7d' }); saveWsSettings({ ...settings, recency: '7d' }); setExpanded('none') })}
            {optionRow(t('sidebar.ws.lastActive30'), settings.recency === '30d', () => { onChange({ ...settings, recency: '30d' }); saveWsSettings({ ...settings, recency: '30d' }); setExpanded('none') })}
            {optionRow(t('sidebar.ws.lastActiveAll'), settings.recency === 'all', () => { onChange({ ...settings, recency: 'all' }); saveWsSettings({ ...settings, recency: 'all' }); setExpanded('none') })}
          </div>
        )}
      </div>

      <div className="ws-pop__menupair">
        {row(
          t('sidebar.ws.groupBy'),
          settings.groupBy === 'date' ? t('sidebar.ws.groupByDate')
          : settings.groupBy === 'status' ? t('sidebar.ws.groupByStatus')
          : settings.groupBy === 'unread' ? t('sidebar.ws.groupByUnread')
          : t('sidebar.ws.groupByNone'),
          'groupBy',
        )}
        {expanded === 'groupBy' && (
          <div className="ws-pop__menu ws-pop__menu--open">
            {optionRow(t('sidebar.ws.groupByDate'), settings.groupBy === 'date', () => { onChange({ ...settings, groupBy: 'date' }); saveWsSettings({ ...settings, groupBy: 'date' }); setExpanded('none') })}
            {optionRow(t('sidebar.ws.groupByStatus'), settings.groupBy === 'status', () => { onChange({ ...settings, groupBy: 'status' }); saveWsSettings({ ...settings, groupBy: 'status' }); setExpanded('none') })}
            {optionRow(t('sidebar.ws.groupByUnread'), settings.groupBy === 'unread', () => { onChange({ ...settings, groupBy: 'unread' }); saveWsSettings({ ...settings, groupBy: 'unread' }); setExpanded('none') })}
            <div className="ws-pop__divider" />
            {optionRow(t('sidebar.ws.groupByNone'), settings.groupBy === 'none', () => { onChange({ ...settings, groupBy: 'none' }); saveWsSettings({ ...settings, groupBy: 'none' }); setExpanded('none') })}
          </div>
        )}
      </div>

      <div className="ws-pop__menupair">
        {row(t('sidebar.ws.sortBy'), settings.sortBy === 'date' ? t('sidebar.ws.sortByDate') : settings.sortBy === 'name' ? t('sidebar.ws.sortByName') : t('sidebar.ws.sortByRecent'), 'sortBy')}
        {expanded === 'sortBy' && (
          <div className="ws-pop__menu ws-pop__menu--open">
            {optionRow(t('sidebar.ws.sortByName'), settings.sortBy === 'name', () => { onChange({ ...settings, sortBy: 'name' }); saveWsSettings({ ...settings, sortBy: 'name' }); setExpanded('none') })}
            {optionRow(t('sidebar.ws.sortByDate'), settings.sortBy === 'date', () => { onChange({ ...settings, sortBy: 'date' }); saveWsSettings({ ...settings, sortBy: 'date' }); setExpanded('none') })}
            {optionRow(t('sidebar.ws.sortByRecent'), settings.sortBy === 'recent', () => { onChange({ ...settings, sortBy: 'recent' }); saveWsSettings({ ...settings, sortBy: 'recent' }); setExpanded('none') })}
          </div>
        )}
      </div>

      <button
        type="button"
        className="ws-pop__reset"
        onClick={() => { onChange(WS_SETTINGS_DEFAULT); saveWsSettings(WS_SETTINGS_DEFAULT); setExpanded('none'); onClose() }}
      >
        {t('sidebar.ws.reset')}
      </button>
    </div>
  )
}
