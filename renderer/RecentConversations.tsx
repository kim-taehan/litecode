import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { Project } from '../shared/ipc.ts'
import type { Session } from './session.ts'
import { ago } from './ago.ts'
import { useT } from './settingsStore.ts'
// 전 프로젝트 최근 대화 팝오버 (진입: 사이드바 제목찾기 옆 버튼).
// 시안 A 행: 프로젝트명(작은 라벨) + 대화 제목 + 시간. 빠른 열기(#305)의 키보드 UX를
// 재사용(↑↓·Enter·Esc·바깥 클릭). 좌표는 버튼 rect 로 (인라인 top/left).

interface RecentConversationsProps {
  open: boolean
  onClose(): void
  sessions: Session[]
  projects: readonly Pick<Project, 'path' | 'name'>[]
  onOpen(id: string): void
  /** 진입 버튼 — rect 로 좌표, 그 위의 mousedown 은 바깥 클릭으로 치지 않는다 */
  buttonRef: RefObject<HTMLButtonElement | null>
  /** 패널 폭 — 사이드바 폭에서 여백(12*2)을 뺀 값 */
  width: number
  /** 지금 열려 있는 프로젝트 — 그 대화는 라벨을 진하게 보여 구분한다 */
  currentProject?: string
}

const RECENT_LIMIT = 5

interface RecentRow {
  id: string
  project: string
  projectName: string
  title: string
  updatedAt: number
  pinned: boolean
}

/** 행 — 현재 프로젝트 최근 5개 먼저, 그 뒤 다른 프로젝트 최근 5개 (각 updatedAt 내림차순).
 *  글이 있으면 제목·프로젝트명 부분일치로 거르고 (구분 없이) 최대 10개 */
export function recentRows(
  sessions: Session[],
  projects: readonly Pick<Project, 'path' | 'name'>[],
  query = '',
  currentProject?: string,
): RecentRow[] {
  const names = new Map(projects.map((p) => [p.path, p.name]))
  const q = query.trim().toLowerCase()
  const match = q ? (s: Session) => s.title.toLowerCase().includes(q) || (names.get(s.project) ?? '').toLowerCase().includes(q) : () => true
  const toRow = (s: Session): RecentRow => ({
    id: s.id,
    project: s.project,
    projectName: names.get(s.project) ?? s.project.split('/').pop() ?? s.project,
    title: s.title,
    updatedAt: s.updatedAt,
    pinned: Boolean(s.pinned),
  })
  // 새 대화(제목 없음)는 제외한다
  const nonEmpty = sessions.filter((s) => s.title.trim() !== '')
  if (q || currentProject === undefined) {
    return nonEmpty
      .filter((s) => match(s))
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt)
      .slice(0, RECENT_LIMIT * 2)
      .map(toRow)
  }
  const byDate = (a: Session, b: Session) => b.updatedAt - a.updatedAt
  const current = nonEmpty.filter((s) => s.project === currentProject).sort(byDate).slice(0, RECENT_LIMIT)
  const other = nonEmpty.filter((s) => s.project !== currentProject).sort(byDate).slice(0, RECENT_LIMIT)
  return [...current, ...other].map(toRow)
}

/** 최근 대화를 한 번에 — 제목찾기 옆 버튼(open=true)으로 연다.
 *  행 클릭 = 그 프로젝트로 전환 + 그 대화 보기 (App 의 알림 열기 경로와 같은 길).
 *  키: ↑↓·Enter·Esc(같은 규칙). 시간이 열려 있는 동안 30초마다 갱신 */
export function RecentConversations({ open, onClose, sessions, projects, onOpen, buttonRef, width, currentProject }: RecentConversationsProps) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [anchor, setAnchor] = useState<{ top: number; left: number }>()
  const searchRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const rows = useMemo(() => recentRows(sessions, projects, query, currentProject), [sessions, projects, query, currentProject])
  const rowsWithPrev = useMemo(
    () =>
      rows.map((row, i) => ({
        row,
        i,
        previousIsNow: i > 0 && currentProject !== undefined ? rows[i - 1].project === currentProject : undefined,
      })),
    [rows, currentProject],
  )

  // 열면 갱신 + 좌표(버튼 rect) — 찾기관(12px 인셋) 좌측 정렬·버튼 아래 6px
  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    setNow(Date.now())
    const button = buttonRef.current
    if (button) {
      const rect = button.getBoundingClientRect()
      setAnchor({ top: rect.bottom + 6, left: rect.left - (rect.width / 2 - 12) })
    }
  }, [open, buttonRef])

  // 닫으면 좌표 지운다 — 다시 열 때 이전 자리가 먼저 보이지 않게 (측정 전까지 패널을 안 그려)
  useEffect(() => {
    if (open) return
    setAnchor(undefined)
  }, [open])

  // 탐색칸은 그려졌을 때 포커스 (빠른 열기와 같은 지연 포커스)
  useEffect(() => {
    if (!open || !anchor) return
    const timer = setTimeout(() => searchRef.current?.focus(), 0)
    return () => clearTimeout(timer)
  }, [open, anchor])

  // 열려 있는 동안 시간 갱신 (App 의 now 30초 틱과 같은 주기)
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [open])

  // 검색으로 줄이 줄면 선택이 범위를 넘는 일이 없게
  useEffect(() => {
    if (!open) return
    setActive((a) => Math.min(a, Math.max(0, rows.length - 1)))
  }, [open, rows.length])

  // 바깥 클릭·Esc 로 닫는다 — 진입 버튼 위의 mousedown 은 스스로 토글하게 (빠른 열기 같은 예외)
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

  // 선택 행을 보이는 자리에
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('[data-recent-active]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  // 좌표를 재측정할 때까지는 그리지 않는다 (첫 열림·다시 열림 모두 깜빡임 없이)
  if (!open || !anchor) return null

  function act(index: number): void {
    const row = rows[index]
    if (!row) return
    onClose()
    onOpen(row.id)
  }

  function onKey(event: React.KeyboardEvent): void {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((a) => (rows.length === 0 ? a : (a + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length))
    } else if (event.key === 'Enter' && event.target === searchRef.current) {
      event.preventDefault()
      act(active)
    }
  }

  return (
    <div
      className="recent-pop"
      ref={panelRef}
      role="dialog"
      aria-label={t('sidebar.recent')}
      style={{ top: anchor?.top, left: anchor?.left, width }}
      onKeyDown={onKey}
    >
      <input
        ref={searchRef}
        className="recent-pop__search"
        placeholder={t('sidebar.recentPlaceholder')}
        aria-label={t('sidebar.recentPlaceholder')}
        value={query}
        spellCheck={false}
        onChange={(event) => {
          setQuery(event.target.value)
          setActive(0)
        }}
      />
      <div className="recent-pop__list">
        {query.trim() && rows.length === 0 && <div className="recent-pop__empty">{t('sidebar.recentEmpty')}</div>}
        {rowsWithPrev.map(({ row, i, previousIsNow }) => {
          const isNow = currentProject !== undefined && row.project === currentProject
          const showGroupHeader = !query.trim() && (i === 0 || (previousIsNow !== undefined && isNow !== previousIsNow))
          return (
            <div key={row.id}>
              {showGroupHeader && <div className="recent-pop__group">{isNow ? t('sidebar.recentCurrent') : t('sidebar.recentOther')}</div>}
              <button
                type="button"
                data-recent-active={i === active || undefined}
                className={`recent-pop__row${showGroupHeader && i !== 0 ? ' recent-pop__row--spaced' : ''}${i === active ? ' recent-pop__row--on' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => act(i)}
              >
                <span className="recent-pop__main">
                  <span className="recent-pop__title">{row.title || t('sidebar.untitled')}</span>
                  <span className="recent-pop__time">{ago(row.updatedAt, now)}</span>
                </span>
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
