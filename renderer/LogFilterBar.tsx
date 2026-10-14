// 기록 탭 필터 바 (#400 #409, 시안 ⑤) — 검색(텍스트 또는 해시, `.*`·`Cc`) + 브랜치·사용자·날짜·경로 알약.
// 검색은 250ms 디바운스, 알약은 작은 fixed 메뉴(.git-menu 틀)에서 고른다. 상태는 gitStore 의 logFilter.

import { useEffect, useRef, useState, type MouseEvent } from 'react'
import type { GitBranch } from '../shared/git.ts'
import type { GitLogFilter } from './logFilter.ts'
import { useT } from './settingsStore.ts'

const DEBOUNCE = 250
type MenuKey = 'branch' | 'author' | 'date' | 'path'

export function LogFilterBar({
  filter,
  currentBranch,
  branches,
  remotes,
  authors,
  onChange,
}: {
  filter: GitLogFilter
  currentBranch: string
  branches: GitBranch[] | undefined
  remotes: string[]
  authors: string[] | undefined
  onChange(patch: Partial<GitLogFilter>): void
}) {
  const t = useT()
  const [text, setText] = useState(filter.text)
  const [path, setPath] = useState(filter.paths.join(' '))
  const [menu, setMenu] = useState<{ key: MenuKey; left: number; top: number }>()
  const barRef = useRef<HTMLDivElement>(null)

  // 바깥에서(예: ×) 필터가 바뀌면 칸에 반영
  useEffect(() => setText(filter.text), [filter.text])
  useEffect(() => setPath(filter.paths.join(' ')), [filter.paths])

  // 디바운스 — 멈춘 지 250ms 후, 값이 달라졌다면만
  const latest = useRef({ filterText: filter.text, onChange })
  latest.current = { filterText: filter.text, onChange }
  useEffect(() => {
    if (text === latest.current.filterText) return
    const id = setTimeout(() => latest.current.onChange({ text }), DEBOUNCE)
    return () => clearTimeout(id)
  }, [text])

  // 메뉴 닫기 — 바깥 클릭·Esc
  useEffect(() => {
    if (!menu) return
    const off = (event: globalThis.MouseEvent) => {
      if (barRef.current && !barRef.current.contains(event.target as Node)) setMenu(undefined)
    }
    document.addEventListener('mousedown', off)
    return () => document.removeEventListener('mousedown', off)
  }, [menu])

  const open = (key: MenuKey) => (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({ key, left: rect.left, top: rect.bottom + 4 })
  }
  const close = () => setMenu(undefined)

  const applyPath = () => {
    onChange({ paths: path.split(/\s+/).filter(Boolean) })
    close()
  }

  return (
    <div className="git-log2__bar" ref={barRef}>
      <div className="git-log2__search">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" />
          <path d="m10.5 10.5 3 3" />
        </svg>
        <input value={text} placeholder={t('git.logSearch')} aria-label={t('git.logSearch')} onChange={(event) => setText(event.target.value)} />
        <button type="button" className="git-log2__toggle" aria-pressed={filter.regex} title="정규식" onClick={() => onChange({ regex: !filter.regex })}>
          .*
        </button>
        <button type="button" className="git-log2__toggle" aria-pressed={filter.caseSensitive} title="대소문자 구분" onClick={() => onChange({ caseSensitive: !filter.caseSensitive })}>
          Cc
        </button>
      </div>
      <div className="git-log2__pills">
        <Pill
          label={t('git.logBranch')}
          value={filter.branch === '' ? currentBranch : filter.branch === 'all' ? t('git.logAll') : filter.branch}
          active={filter.branch !== ''}
          onPick={open('branch')}
          onClear={() => onChange({ branch: '' })}
        />
        <Pill label={t('git.logUser')} value={filter.author} active={filter.author !== ''} onPick={open('author')} onClear={() => onChange({ author: '' })} />
        <Pill
          label={t('git.logDate')}
          value={filter.date === 'today' ? t('git.logToday') : filter.date === 'week' ? t('git.logWeek') : filter.date === 'month' ? t('git.logMonth') : t('git.logAll')}
          active={filter.date !== 'all'}
          onPick={open('date')}
          onClear={() => onChange({ date: 'all' })}
        />
        <Pill label={t('git.logPath')} value={filter.paths.join(' ')} active={filter.paths.length > 0} onPick={open('path')} onClear={() => onChange({ paths: [] })} />
      </div>
      {menu && (
        <div
          className="git-menu git-log2__menu"
          role="menu"
          style={{ left: menu.left, top: menu.top }}
          onKeyDown={(event) => event.key === 'Escape' && close()}
        >
          {menu.key === 'branch' && (
            <>
              <MenuItem on={filter.branch === 'all'} onClick={() => { onChange({ branch: 'all' }); close() }} onLabel={t('git.logAll')} />
              {(branches ?? []).map((branch) => (
                <MenuItem key={branch.name} on={branch.name === (filter.branch === '' ? currentBranch : filter.branch)} onClick={() => { onChange({ branch: branch.name === currentBranch ? '' : branch.name }); close() }} onLabel={branch.name} />
              ))}
              {remotes.map((name) => (
                <MenuItem key={name} on={filter.branch === name} onClick={() => { onChange({ branch: name }); close() }} onLabel={name} />
              ))}
            </>
          )}
          {menu.key === 'author' && (
            <>
              {(authors ?? []).map((author) => (
                <MenuItem key={author} on={filter.author === author} onClick={() => { onChange({ author }); close() }} onLabel={author} />
              ))}
            </>
          )}
          {menu.key === 'date' && (
            <>
              {(
                [
                  ['all', t('git.logAll')],
                  ['today', t('git.logToday')],
                  ['week', t('git.logWeek')],
                  ['month', t('git.logMonth')],
                ] as const
              ).map(([value, label]) => (
                <MenuItem key={value} on={filter.date === value} onClick={() => { onChange({ date: value }); close() }} onLabel={label} />
              ))}
            </>
          )}
          {menu.key === 'path' && (
            <>
              <div className="git-log2__menu-hint">{t('git.logPathHint')}</div>
              <input
                autoFocus
                className="git-log2__path-input"
                value={path}
                onChange={(event) => setPath(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && applyPath()}
              />
              <button type="button" role="menuitem" className="git-menu__item" onClick={applyPath}>
                {t('git.logApply')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Pill({ label, value, active, onPick, onClear }: { label: string; value: string; active: boolean; onPick(event: MouseEvent<HTMLButtonElement>): void; onClear(): void }) {
  const t = useT()
  return (
    <span className="git-log2__pill">
      <button type="button" className="git-log2__pill-button" onClick={onPick} aria-expanded={active}>
        {label}
        {value && <span className="git-log2__pill-value">{value}</span>}
        <span className="git-log2__pill-caret" aria-hidden="true">
          ⌄
        </span>
      </button>
      {active && (
        <button type="button" className="git-log2__pill-x" aria-label={t('git.logFilterClear')} onClick={onClear}>
          ×
        </button>
      )}
    </span>
  )
}

function MenuItem({ on, onLabel, onClick }: { on: boolean; onLabel: string; onClick(): void }) {
  return (
    <button type="button" role="menuitem" className="git-menu__item" data-on={on || undefined} onClick={onClick}>
      {onLabel}
    </button>
  )
}
