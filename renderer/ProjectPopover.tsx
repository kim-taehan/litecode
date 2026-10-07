import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ConversationStatus, Project } from '../shared/ipc.ts'
import { useT } from './settingsStore.ts'
import { StatusDot } from './Notices.tsx'
import { RunningCount } from './Background.tsx'
import { HoverCard, useHoverCard } from './hoverCard.tsx'
import { Badge, CheckIcon } from './SidebarIcons.tsx'

interface ProjectPopoverProps {
  projects: Project[]
  current?: string
  /** 그 프로젝트 대화의 알림 점 (없으면 점 없음) */
  statusOf(project: string): ConversationStatus | undefined
  /** 그 프로젝트에서 도는 대화 수 — 실행 중 점 대신 점 + 숫자 */
  runningOf(project: string): number
  /** 여는 중 — 행을 막는다 */
  busy: boolean
  error?: string
  onPick(project: Project): void
  onOpenFolder(): void
  onToggleFavorite(project: Project): void
  onRemove(project: Project): Promise<void>
  /** 보이는 이름만 바꾼다 (폴더는 그대로). 빈 이름이면 폴더 이름으로 */
  onRename(project: Project, name: string): Promise<void>
  /** returnFocus: 키보드(Esc)로 닫았으면 true — 포커스를 전환 버튼으로 돌려준다 */
  onClose(returnFocus: boolean): void
}

/** 전환 버튼 아래 팝오버 — 검색·즐겨찾기·최근 목록·폴더 열기 (시안 + 00_request B).
 *  시안이 안 정한 상호작용은 dsh ui-primitives Menu 를 따른다: ↑/↓ 로 행을 돌고(끝에서 처음으로) Home/End 로 끝으로,
 *  Esc 는 닫고 포커스를 전환 버튼으로, 바깥 클릭은 그냥 닫는다. (dsh 의 "창 포커스를 잃으면 닫기" 는 뺐다 — 같은 머신의
 *  다른 창이 포커스를 가져가면 실물 테스트 도중 팝오버가 닫혀 실패했다, 2026-09-30.) 목록이 길면 목록만 스크롤하고
 *  "폴더 열기" 는 아래에 고정한다. 행의 ☆·× 는 dsh ui-workspace 의 행 hover 버튼처럼 hover·포커스 때만 보인다
 *  (화살표는 행끼리만 걷고, 행 안의 버튼은 Tab 으로 닿는다). */
export function ProjectPopover({ projects, current, statusOf, runningOf, busy, error, onPick, onOpenFolder, onToggleFavorite, onRemove, onRename, onClose }: ProjectPopoverProps) {
  const t = useT()
  const [query, setQuery] = useState('')
  // 이름 바꾸는 중인 행 — dsh ui-workspace 처럼 그 자리에서 입력칸으로 바뀐다. Enter·바깥으로 나가면 저장, Esc 는 취소
  const [editing, setEditing] = useState<string>()
  const ref = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const hover = useHoverCard()

  useEffect(() => {
    function onMouseDown(event: MouseEvent): void {
      // 전환 버튼(같은 .sidebar__project 안)은 스스로 토글하므로 바깥으로 치지 않는다
      if (!ref.current?.parentElement?.contains(event.target as Node)) onClose(false)
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.isComposing) return // 한글 조합 취소 Esc 에 닫지 않는다
      event.preventDefault() // 이 Esc 는 여기서 썼다 — 녹음(VoiceInput)까지 취소하지 않게
      onClose(true)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  function walk(event: ReactKeyboardEvent): void {
    const inSearch = event.target instanceof HTMLInputElement
    if (!['ArrowDown', 'ArrowUp'].includes(event.key) && !(!inSearch && ['Home', 'End'].includes(event.key))) return
    const rows = [...(ref.current?.querySelectorAll<HTMLButtonElement>('.project-item__main:not(:disabled), .project-popover__open:not(:disabled)') ?? [])]
    if (rows.length === 0) return
    event.preventDefault()
    const from = rows.indexOf(document.activeElement as HTMLButtonElement)
    const step = event.key === 'ArrowDown' ? 1 : -1
    const next =
      event.key === 'Home' ? 0
      : event.key === 'End' ? rows.length - 1
      : from === -1 ? (step === 1 ? 0 : rows.length - 1)
      : (from + step + rows.length) % rows.length
    rows[next]?.focus()
  }

  const needle = query.trim().toLowerCase()
  const filtered = projects.filter((project) => project.name.toLowerCase().includes(needle))
  // 즐겨찾기한 것은 즐겨찾기 묶음에만 — 최근에 중복으로 안 나온다 (00_request B)
  const groups = [
    { name: t('project.favorites'), items: filtered.filter((project) => project.favorite) },
    { name: t('project.recent'), items: filtered.filter((project) => !project.favorite) },
  ]

  return (
    <div className="project-popover" ref={ref} onKeyDown={walk}>
      <input
        ref={searchRef}
        className="project-popover__search"
        placeholder={t('project.search')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        autoFocus
      />
      <div className="project-popover__list">
        {groups.map(
          (group) =>
            group.items.length > 0 && (
              <div key={group.name} role="group" aria-label={group.name}>
                <div className="project-popover__label">{group.name}</div>
                {group.items.map((project) => (
                  <div key={project.path} data-hover-row className={`project-item${project.path === current ? ' project-item--active' : ''}`}>
                    {editing === project.path ? (
                      <input
                        className="project-item__rename"
                        aria-label={t('project.nameLabel')}
                        defaultValue={project.name}
                        autoFocus
                        onFocus={(event) => event.currentTarget.select()}
                        onKeyDown={(event) => {
                          if (event.nativeEvent.isComposing || event.keyCode === 229) return // 한글 조합 확정 Enter
                          if (event.key === 'Enter') event.currentTarget.blur()
                          if (event.key === 'Escape') {
                            event.stopPropagation() // 팝오버까지 닫지 않는다
                            setEditing(undefined)
                          }
                        }}
                        onBlur={(event) => {
                          if (editing !== project.path) return
                          setEditing(undefined)
                          void onRename(project, event.currentTarget.value).then(() => searchRef.current?.focus())
                        }}
                      />
                    ) : (
                    <button
                      type="button"
                      className="project-item__main"
                      disabled={busy}
                      onMouseEnter={(event) => hover.enter(event.currentTarget, { title: project.name, detail: project.path }, true)}
                      onMouseLeave={(event) => hover.leave(event.currentTarget)}
                      onClick={() => onPick(project)}
                    >
                      <Badge project={project} />
                      <span className="project-switch__text">
                        <span className="project-item__name">{project.name}</span>
                        <span className="project-switch__path marquee">{project.displayPath}</span>
                      </span>
                      {/* 실행 중은 점 대신 점 + 숫자, 그 밖의 상태(답 필요·안 본 끝남)는 점 그대로 */}
                      {statusOf(project.path) && statusOf(project.path) !== 'running' && <StatusDot status={statusOf(project.path)!} />}
                      <RunningCount count={runningOf(project.path)} label={t('sidebar.running', { count: runningOf(project.path) })} />
                      {project.path === current && <CheckIcon />}
                    </button>
                    )}
                    {project.favorite && (
                      <span className="project-item__marker" aria-hidden="true">
                        ★
                      </span>
                    )}
                    <span className="project-item__actions">
                      <button
                        type="button"
                        className="project-item__action"
                        aria-label={t('project.rename')}
                        title={t('project.renameTitle')}
                        disabled={busy}
                        onClick={() => setEditing(project.path)}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className="project-item__action"
                        aria-label={project.favorite ? t('project.unfavorite') : t('project.favorite')}
                        title={project.favorite ? t('project.unfavorite') : t('project.favorite')}
                        disabled={busy}
                        onClick={() => onToggleFavorite(project)}
                      >
                        {project.favorite ? '★' : '☆'}
                      </button>
                      <button
                        type="button"
                        className="project-item__action"
                        aria-label={t('project.remove')}
                        title={t('project.removeTitle')}
                        disabled={busy}
                        // 뺀 행의 포커스가 사라지므로 검색 입력으로 돌려 키보드를 이어 쓰게 한다
                        onClick={() => void onRemove(project).then(() => searchRef.current?.focus())}
                      >
                        ×
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            ),
        )}
        {needle && filtered.length === 0 && <div className="project-popover__empty">{t('project.noMatch')}</div>}
      </div>
      {error && (
        <div className="project-popover__error" role="alert">
          {error}
        </div>
      )}
      <div className="project-popover__divider" />
      <button type="button" className="project-popover__open" disabled={busy} onClick={onOpenFolder}>
        {t('project.openFolder')}
      </button>
      <HoverCard card={hover.card} />
    </div>
  )
}
