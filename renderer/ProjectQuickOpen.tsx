import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import type { ConversationStatus, Project } from '../shared/ipc.ts'
import { useT } from './settingsStore.ts'
import { StatusDot } from './Notices.tsx'
import { RunningCount } from './Background.tsx'
import { Badge, CheckIcon } from './SidebarIcons.tsx'

interface ProjectQuickOpenProps {
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
  /** 전환 버튼 — 그 윗 mousedown 은 바깥 클릭으로 치지 않는다 (버튼의 click 이 스스로 토글하게) */
  switchButton?: RefObject<HTMLElement | null>
}

type Row = { kind: 'project'; project: Project } | { kind: 'folder' }

/** 빠른 열기 (이슈 #305) — VS Code 파일 열기 스타일. 상단 중앙 패널: 별도 검색칸 없이 타이핑한 즉시 목록이 거르고,
 *  ↑/↓ 로 이동(끝에서 처음으로), Enter 로 고르고, Esc 는 닫고 포커스를 전환 버튼으로 돌려준다.
 *  즐겨찾기/최근 그룹 라벨은 없애고 즐겨찾기가 ★ 표시와 함께 먼저 보인다. 행 hover 액션(✎·★·×)과
 *  맨 아래 "폴더 열기" 행은 이전 팝오버와 같다. 바깥 클릭은 그냥 닫는다.
 *  (이전 팝오버와 마찬가지로 "창 포커스를 잃으면 닫기" 는 없다 — 같은 머신의 다른 창이 포커스를
 *  가져가면 실물 테스트 도중 닫혀 실패했다, 2026-09-30.) */
export function ProjectQuickOpen({ projects, current, statusOf, runningOf, busy, error, onPick, onOpenFolder, onToggleFavorite, onRemove, onRename, onClose, switchButton }: ProjectQuickOpenProps) {
  const t = useT()
  const [query, setQuery] = useState('')
  /** ↑/↓·마우스 hover 가 고른 행 — Enter 로 고른다 */
  const [active, setActive] = useState(0)
  const [editing, setEditing] = useState<string>()
  const searchRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onMouseDown(event: MouseEvent): void {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return
      if (switchButton && event.target instanceof Node && switchButton.current?.contains(event.target)) return
      onClose(false)
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

  // 즐겨찾기가 항상 먼저 — 그룹 라벨 없이 (이슈 #305). 맨 아래 "폴더 열기" 행
  const needle = query.trim().toLowerCase()
  const rows = useMemo<Row[]>(() => {
    const filtered = projects.filter((project) => project.name.toLowerCase().includes(needle))
    return [
      ...filtered.filter((project) => project.favorite).map((project): Row => ({ kind: 'project', project })),
      ...filtered.filter((project) => !project.favorite).map((project): Row => ({ kind: 'project', project })),
      { kind: 'folder' },
    ]
  }, [projects, needle])

  function select(index: number): void {
    setActive(((index % rows.length) + rows.length) % rows.length)
  }

  function act(index: number): void {
    const row = rows[index]
    if (!row) return
    if (row.kind === 'folder') onOpenFolder()
    else onPick(row.project)
  }

  /** 탐색칸과 행 버튼 어느 쪽에 포커스가 있어도 같은 키를 쓴다 (행 버튼 포커스 시 포커스를 다시 탐색칸으로).
   *  리네임 입력칸은 제외 — 여기선 화살표가 문장 내 커서 이동이지 행 탐색이 아니다 */
  function onKey(event: ReactKeyboardEvent): void {
    if (event.target instanceof HTMLInputElement && event.target !== searchRef.current) return
    if (event.nativeEvent.isComposing || event.keyCode === 229) return // 한글 조합 확정 Enter
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      searchRef.current?.focus()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((now) => ((now + step + rows.length) % rows.length))
    } else if ((event.key === 'Home' || event.key === 'End') && event.target === searchRef.current) {
      event.preventDefault()
      select(event.key === 'Home' ? 0 : rows.length - 1)
    } else if (event.key === 'Enter' && event.target === searchRef.current) {
      event.preventDefault()
      act(active)
    }
  }

  return (
    <div className="project-open__panel" ref={panelRef} role="dialog" aria-label={t('project.search')} onKeyDown={onKey}>
      <input
        ref={searchRef}
        className="project-open__search"
        placeholder={t('project.search')}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          select(0)
        }}
        autoFocus
      />
      <div className="project-open__list">
        {needle && rows.length === 1 && <div className="project-open__empty">{t('project.noMatch')}</div>}
        {rows.map((row, index) =>
          row.kind === 'folder' ? (
            <button
              type="button"
              key="folder"
              className={`project-open__open${index === active ? ' project-open__open--selected' : ''}`}
              disabled={busy}
              onMouseEnter={() => select(index)}
              onClick={() => onOpenFolder()}
            >
              {t('project.openFolder')}
            </button>
          ) : (
            <div
              key={row.project.path}
              data-hover-row
              className={`project-item${index === active ? ' project-item--selected' : ''}${row.project.path === current ? ' project-item--active' : ''}`}
            >
              {editing === row.project.path ? (
                <input
                  className="project-item__rename"
                  aria-label={t('project.nameLabel')}
                  defaultValue={row.project.name}
                  autoFocus
                  onFocus={(event) => event.currentTarget.select()}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing || event.keyCode === 229) return
                    if (event.key === 'Enter') event.currentTarget.blur()
                    if (event.key === 'Escape') {
                      event.stopPropagation() // 패널까지 닫지 않는다
                      setEditing(undefined)
                    }
                  }}
                  onBlur={(event) => {
                    if (editing !== row.project.path) return
                    setEditing(undefined)
                    void onRename(row.project, event.currentTarget.value).then(() => searchRef.current?.focus())
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="project-item__main"
                  disabled={busy}
                  onMouseEnter={() => select(index)}
                  onClick={() => onPick(row.project)}
                >
                  <Badge project={row.project} />
                  <span className="project-switch__text">
                    <span className="project-item__name">{row.project.name}</span>
                    <span className="project-switch__path marquee">{row.project.displayPath}</span>
                  </span>
                  {/* 실행 중은 점 대신 점 + 숫자, 그 밖의 상태(답 필요·안 본 끝남)는 점 그대로 */}
                  {statusOf(row.project.path) && statusOf(row.project.path) !== 'running' && <StatusDot status={statusOf(row.project.path)!} />}
                  <RunningCount count={runningOf(row.project.path)} label={t('sidebar.running', { count: runningOf(row.project.path) })} />
                  {row.project.path === current && <CheckIcon />}
                </button>
              )}
              {row.project.favorite && (
                <span className="project-item__marker" aria-hidden="true">
                  ★
                </span>
              )}
              <span className="project-item__actions">
                <button type="button" className="project-item__action" aria-label={t('project.rename')} title={t('project.renameTitle')} disabled={busy} onClick={() => setEditing(row.project.path)}>
                  ✎
                </button>
                <button
                  type="button"
                  className="project-item__action"
                  aria-label={row.project.favorite ? t('project.unfavorite') : t('project.favorite')}
                  title={row.project.favorite ? t('project.unfavorite') : t('project.favorite')}
                  disabled={busy}
                  onClick={() => onToggleFavorite(row.project)}
                >
                  {row.project.favorite ? '★' : '☆'}
                </button>
                <button
                  type="button"
                  className="project-item__action"
                  aria-label={t('project.remove')}
                  title={t('project.removeTitle')}
                  disabled={busy}
                  // 뺀 행의 포커스가 사라지므로 탐색칸으로 돌려 키보드를 이어 쓰게 한다
                  onClick={() => void onRemove(row.project).then(() => searchRef.current?.focus())}
                >
                  ×
                </button>
              </span>
            </div>
          ),
        )}
        {error && (
          <div className="project-open__error" role="alert">
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
