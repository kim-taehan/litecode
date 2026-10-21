import { Fragment, useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { Project } from '../shared/ipc.ts'
import { TITLE_MAX } from '../shared/chat.ts'
import { ago } from './ago.ts'
import type { Translate } from './settingsStore.ts'
import { StatusDot, type useNotices } from './Notices.tsx'
import { otherProjectsStatus } from './noticeView.ts'
import { FromIcon } from './Delegation.tsx'
import { sidebarMark } from './delegationView.ts'
import { RunningCount } from './Background.tsx'
import { runningOutside } from './backgroundView.ts'
import { StopIcon } from './stopTurn.tsx'
import { PinButton, PinnedMark } from './SessionListTools.tsx'
import { RecentConversations } from './RecentConversations.tsx'
import { WsSettingsPopover, loadWsSettings, type WsSettings } from './WsSettings.tsx'
import { GearIcon, LogoMark, PencilIcon, SearchIcon, SidebarIcon, SlidersIcon, TrashIcon, Badge } from './SidebarIcons.tsx'
import { HoverCard, startMarquee, stopMarquee, type useHoverCard } from './hoverCard.tsx'
import { UpdateNotice } from './UpdateNotice.tsx'
import { clampSidebar, type useSidebarLayout } from './useSidebarLayout.ts'
import { isBlank, type Session } from './session.ts'

type SidebarLayout = ReturnType<typeof useSidebarLayout>

interface SidebarProps {
  t: Translate
  layout: SidebarLayout['layout']
  setLayout: SidebarLayout['setLayout']
  drag: SidebarLayout['drag']
  project: Project | undefined
  picking: boolean
  switchRef: RefObject<HTMLButtonElement | null>
  settingsRef: RefObject<HTMLButtonElement | null>
  notices: ReturnType<typeof useNotices>
  sessions: Session[]
  /** 지금 프로젝트에서 도는 대화 id */
  running: string[]
  /** 목록에 보이는 대화 (거른 뒤, 고정한 대화가 위) */
  listed: Session[]
  active: Session | undefined
  setActiveIds: Dispatch<SetStateAction<Record<string, string>>>
  confirming: string | undefined
  setConfirming: Dispatch<SetStateAction<string | undefined>>
  renaming: string | undefined
  setRenaming: Dispatch<SetStateAction<string | undefined>>
  renameCancelled: RefObject<boolean>
  fresh: ReadonlySet<string>
  now: number
  sessionHover: ReturnType<typeof useHoverCard>
  titleOf(session: Session): string
  toggleSwitcher(): void
  startNewChat(): void
  stopTurn(id: string): void
  removeConversation(target: Session): Promise<void>
  renameConversation(target: Session, name: string): Promise<void>
  pinConversation(target: Session): Promise<void>
  setSettingsOpen: Dispatch<SetStateAction<boolean>>
  /** 최근 대화 팝오버 (제목찾기 옆 버튼) — 열림 상태 */
  recentOpen: boolean
  /** 전 프로젝트 목록 — 최근 대화 행의 이름 라벨 */
  allProjects: readonly Pick<Project, 'path' | 'name'>[]
  toggleRecent(): void
  closeRecent(): void
  openRecentConversation(id: string): void
}

/** 대화 목록 한 묶음에 보이는 개수 — 넘어가면 [더보기] 로 10개씩 (이슈 #568) */


/** 펼친 사이드바 — 로고 줄·프로젝트 전환 카드·새 대화·대화 목록·설정 (승인 시안). 상태는 모두 App 이 쥐고 여기는 그리기만 한다 */
export function Sidebar({
  t,
  layout,
  setLayout,
  drag,
  project,
  picking,
  switchRef,
  settingsRef,
  notices,
  sessions,
  running,
  listed,
  active,
  setActiveIds,
  confirming,
  setConfirming,
  renaming,
  setRenaming,
  renameCancelled,
  fresh,
  now,
  sessionHover,
  titleOf,
  toggleSwitcher,
  startNewChat,
  stopTurn,
  removeConversation,
  renameConversation,
  pinConversation,
    setSettingsOpen,
  recentOpen,
  allProjects,
  toggleRecent,
  closeRecent,
  openRecentConversation,
}: SidebarProps) {
    const startOfToday = new Date(now).setHours(0, 0, 0, 0)
    const recentRef = useRef<HTMLButtonElement>(null)
    const wsSettingsRef = useRef<HTMLButtonElement>(null)
    const [wsSettingsOpen, setWsSettingsOpen] = useState(false)
    const [wsSettings, setWsSettings] = useState<WsSettings>(() => loadWsSettings())
    const [expanded, setExpanded] = useState(false)
    const projectKey = project?.path ?? ''
    const lastProjectKey = useRef(projectKey)
    if (lastProjectKey.current !== projectKey) {
      lastProjectKey.current = projectKey
      setExpanded(false)
    }

    function updateWsSettings(next: WsSettings): void {
      setWsSettings(next)
    }

    const visible = useMemo(() => {
      let items = [...listed]
      if (wsSettings.recency !== 'all') {
        const days = wsSettings.recency === '7d' ? 7 : 30
        const cutoffStart = new Date(now - days * 86_400_000).setHours(0, 0, 0, 0)
        items = items.filter((s) => s.updatedAt >= cutoffStart || s.pinned)
      }
      if (wsSettings.sortBy === 'name') {
        items.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || titleOf(a).localeCompare(titleOf(b), 'ko'))
      } else if (wsSettings.sortBy === 'recent') {
        items.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt)
      }
      if (wsSettings.groupBy === 'status' || wsSettings.groupBy === 'unread') {
        const inProgressIds = new Set(items.filter((s) => {
          const st = notices.state[s.id]?.status
          return st === 'running' || st === 'failed' || st === 'interrupted' || s.pending
        }).map((s) => s.id))
        items.sort((a, b) => {
          const ap = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
          if (ap !== 0) return ap
          const ai = inProgressIds.has(a.id) ? 0 : 1
          const bi = inProgressIds.has(b.id) ? 0 : 1
          if (ai !== bi) return ai - bi
          return 0
        })
      }
      return items
    }, [listed, wsSettings.recency, wsSettings.sortBy, wsSettings.groupBy, notices.state, now, titleOf])

    const groupLabel = useMemo((): Map<string, string | null> => {
      const labels = new Map<string, string | null>()
      if (visible.length === 0) return labels
      const firstPinned = visible.find((s) => s.pinned)
      if (firstPinned) labels.set(firstPinned.id, 'pinned')
      if (wsSettings.groupBy === 'none') {
        // 고정/비고정 구분선만 — 헤더는 "고정됨" 뿐
        const firstUnpinned = visible.find((s) => !s.pinned)
        if (firstUnpinned) labels.set(firstUnpinned.id, 'unpinned')
        return labels
      }
      const firstUnpinned = visible.find((s) => !s.pinned)
      if (firstUnpinned) {
        if (wsSettings.groupBy === 'date') {
          labels.set(firstUnpinned.id, firstUnpinned.updatedAt >= startOfToday ? 'today' : 'earlier')
        } else if (wsSettings.groupBy === 'status' || wsSettings.groupBy === 'unread') {
          const isProgress = (s: (typeof visible)[number]) => {
            const st = notices.state[s.id]?.status
            return st === 'running' || st === 'failed' || st === 'interrupted' || !!s.pending
          }
          const firstProgress = visible.find((s) => !s.pinned && isProgress(s))
          const firstAwaiting = visible.find((s) => !s.pinned && !isProgress(s))
          if (firstProgress) labels.set(firstProgress.id, wsSettings.groupBy === 'unread' ? 'unreadOnly' : 'inProgress')
          if (firstAwaiting) labels.set(firstAwaiting.id, wsSettings.groupBy === 'unread' ? 'readOnly' : 'awaiting')
        }
      }
      return labels
    }, [visible, wsSettings.groupBy, notices.state, startOfToday])

    // 특별한 묶음(고정·오늘·진행·읽지않음)은 전부, 나머지는 10개만 [더보기] (사용자 2026-10-22)
    // groupBy 'none'이면 고정/일반만 구분 — 그 외 날짜·상태 그룹은 "특별"
    const CAP = 10
    const isProgressSession = (s: (typeof visible)[number]): boolean => {
      const st = notices.state[s.id]?.status
      return st === 'running' || st === 'failed' || st === 'interrupted' || !!s.pending
    }
    const isSpecialSession = (s: (typeof visible)[number]): boolean => {
      if (s.pinned) return true
      const groupBy = wsSettings.groupBy
      if (groupBy === 'none') return false
      if (groupBy === 'date') return s.updatedAt >= startOfToday
      return isProgressSession(s)
    }
    let tailStart = visible.findIndex((s) => !isSpecialSession(s))
    if (tailStart === -1) tailStart = visible.length
    const tailCount = Math.max(0, visible.length - tailStart)
    const tailShown = expanded ? tailCount : Math.min(CAP, tailCount)
    const hasMore = tailCount > tailShown
    const shownCount = tailStart + tailShown
    const shown = visible.slice(0, shownCount)
    return (
    <aside className="sidebar" style={{ width: layout.width, display: layout.hidden ? 'none' : undefined }}>
      <div
        className="sidebar__resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('sidebar.resize')}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { x: event.clientX, width: layout.width }
        }}
        onPointerMove={(event) => {
          const start = drag.current
          if (start) setLayout((now) => ({ ...now, width: clampSidebar(start.width + event.clientX - start.x) }))
        }}
        onPointerUp={() => (drag.current = undefined)}
        onPointerCancel={() => (drag.current = undefined)}
      />
      {/* dsh ui-sidebar 로고 줄: 왼쪽 아이콘·이름, 오른쪽 끝 접기 */}
      <div className="sidebar__logo">
        <span className="sidebar__identity">
          <LogoMark />
          <span className="sidebar__brand">LiteCode</span>
        </span>
        <button
          type="button"
          className="sidebar-toggle"
          aria-label={t('sidebar.hide')}
          title={t('sidebar.hide')}
          onClick={() => setLayout((now) => ({ ...now, hidden: true }))}
        >
          <SidebarIcon />
        </button>
      </div>
      <div className="sidebar__project">
        <button
          type="button"
          className="project-switch"
          ref={layout.hidden ? undefined : switchRef}
          disabled={picking}
          onClick={toggleSwitcher}
        >
          {project && <Badge project={project} />}
          <span className="project-switch__text" onMouseEnter={(event) => startMarquee(event.currentTarget)} onMouseLeave={(event) => stopMarquee(event.currentTarget)}>
            <span className="project-switch__name">{project?.name ?? t('sidebar.noProject')}</span>
            {project && <span className="project-switch__path marquee">{project.displayPath}</span>}
          </span>
          {otherProjectsStatus(notices.state, project?.path) && (
            <StatusDot status={otherProjectsStatus(notices.state, project?.path)!} className="project-switch__notice" />
          )}
          <RunningCount
            count={runningOutside(sessions, project?.path)}
            label={t('sidebar.runningElsewhere', { count: runningOutside(sessions, project?.path) })}
            className="project-switch__running"
          />
          <span className="project-switch__caret">▾</span>
        </button>
      </div>

      <div className="sidebar__new">
        <button
          type="button"
          className="new-chat"
          disabled={!project}
          onClick={startNewChat}
        >
          {t('sidebar.newChat')}
        </button>
      </div>

      <div className="sidebar__workspaces">
        <span className="sidebar__workspaces-label">{t('sidebar.workspaces')}</span>
        <span className="sidebar__workspaces-actions">
          <button
            ref={recentRef}
            type="button"
            className="sidebar__workspaces-action"
            aria-pressed={recentOpen}
            aria-label={t('sidebar.recent')}
            title={t('sidebar.recent')}
            onClick={toggleRecent}
          >
            <SearchIcon />
          </button>
          <button
            ref={wsSettingsRef}
            type="button"
            className="sidebar__workspaces-action"
            aria-label={t('sidebar.workspaceSettings')}
            title={t('sidebar.workspaceSettings')}
            onClick={() => setWsSettingsOpen((v) => !v)}
          >
            <SlidersIcon />
          </button>
        </span>
      </div>
      <RecentConversations
        open={recentOpen}
        onClose={closeRecent}
        sessions={sessions}
        projects={allProjects}
        onOpen={openRecentConversation}
        buttonRef={recentRef}
         width={layout.width - 4}
        currentProject={project?.path}
      />
      <WsSettingsPopover
        open={wsSettingsOpen}
        onClose={() => setWsSettingsOpen(false)}
        buttonRef={wsSettingsRef}
        width={Math.max(layout.width - 4, 240)}
        settings={wsSettings}
        onChange={updateWsSettings}
      />

      <div className="sidebar__sessions">
        {/* 행의 휴지통은 dsh ui-workspace 세션 행의 hover 버튼처럼 hover·포커스 때만 시각 자리에 보인다. 누르면 "삭제 확인" 으로
            바뀌고 한 번 더 눌러야 지운다(설정 화면 provider 삭제와 같은 방식). 포커스를 잃거나 Esc 면 되돌린다 */}
        {shown.length === 0 && <div className="session-list__empty">{t('sidebar.noMatch')}</div>}
        {shown.map((session, at) => {
          const gl = groupLabel.get(session.id) ?? null
          return (
          <Fragment key={session.id}>
          {gl === 'pinned' && <div className="session-group__label">{t('sidebar.pinned')}</div>}
          {gl === 'unpinned' && <div className="session-group__sep" />}
          {gl === 'today' && <div className="session-group__label">{t('sidebar.today')}</div>}
          {gl === 'earlier' && <div className="session-group__label">{t('sidebar.earlier')}</div>}
          {gl === 'inProgress' && <div className="session-group__label">{t('sidebar.ws.groupStatusInProgress')}</div>}
          {gl === 'awaiting' && <div className="session-group__label">{t('sidebar.ws.groupStatusAwaiting')}</div>}
          {gl === 'unreadOnly' && <div className="session-group__label">{t('sidebar.ws.groupUnread')}</div>}
          {gl === 'readOnly' && <div className="session-group__label">{t('sidebar.ws.groupRead')}</div>}
          <div
            data-hover-row
            className={`session-item${session.id === active?.id ? ' session-item--active' : ''}${confirming === session.id ? ' session-item--confirming' : ''}`}
          >
            {renaming === session.id ? (
              <input
                className="session-item__rename"
                aria-label={t('sidebar.chatNameLabel')}
                defaultValue={session.title}
                maxLength={TITLE_MAX}
                autoFocus
                onFocus={(event) => event.currentTarget.select()}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return // 한글 조합 확정 Enter
                  if (event.key === 'Enter') event.currentTarget.blur()
                  if (event.key === 'Escape') {
                    event.preventDefault() // 이 Esc 는 여기서 썼다 — 녹음(VoiceInput)까지 취소하지 않게
                    renameCancelled.current = true
                    setRenaming(undefined)
                  }
                }}
                onBlur={(event) => {
                  setRenaming(undefined)
                  if (!renameCancelled.current) void renameConversation(session, event.currentTarget.value)
                }}
              />
            ) : (
            <button
              type="button"
              className="session-item__main"
              onClick={() => setActiveIds((current) => ({ ...current, [session.project]: session.id }))}
              onMouseEnter={(event) =>
                sessionHover.enter(event.currentTarget, {
                  title: titleOf(session),
                  detail: session.pending
                    ? t('sidebar.waiting')
                    : session.history === 'unloaded' || session.history === 'loading'
                      ? undefined
                      : t('sidebar.messageCount', { count: session.messages.length }),
                }, true)
              }
              onMouseLeave={(event) => sessionHover.leave(event.currentTarget)}
            >
              {/* 상태 점 자리는 늘 있다 — 점이 생기고 사라져도 제목이 안 움직인다 (dsh 세션 행) */}
              <span className="session-item__slot">
                {notices.state[session.id] && <StatusDot status={notices.state[session.id]!.status} className="session-item__notice" />}
              </span>
              <span className="session-item__title marquee">{titleOf(session)}</span>
              {session.pinned && <PinnedMark />}
              {/* 시각 자리 — 지금 보는 대화는 "현재" 뱃지(2026-10-13 피드백 #3), 지시로 새로 생긴 대화는 "새로 생김",
                  다른 대화가 시킨 일을 하는 중이면 그 아이콘 (이슈 #55 시안) */}
              {session.id === active?.id ? (
                <span className="session-item__current">{t('sidebar.current')}</span>
              ) : sidebarMark(session, fresh) === 'fresh' ? (
                <span className="session-item__fresh">{t('delegate.sidebar.fresh')}</span>
              ) : sidebarMark(session, fresh) === 'delegated' ? (
                <span className="session-item__mark">
                  <FromIcon size={14} label={t('delegate.sidebar.running')} />
                </span>
              ) : (
                !isBlank(session) && <span className="session-item__time">{ago(session.updatedAt, now)}</span>
              )}
            </button>
            )}
            {/* 연필 — 이름 바꾸기 (저장된 대화만, 도는 중에도). 도는 대화는 휴지통 자리에 ■ — 답변 중지 (01l A4) */}
            {renaming !== session.id && (session.pending || !isBlank(session)) && (
              <span className="session-item__actions">
                {!isBlank(session) && confirming !== session.id && (
                  <button
                    type="button"
                    className="session-item__action"
                    aria-label={t('sidebar.renameChat')}
                    title={t('sidebar.renameChat')}
                    onClick={() => {
                      renameCancelled.current = false
                      setRenaming(session.id)
                    }}
                  >
                    <PencilIcon />
                  </button>
                )}
                {!isBlank(session) && confirming !== session.id && <PinButton pinned={!!session.pinned} onToggle={() => void pinConversation(session)} />}
                {session.pending ? (
                  <button
                    type="button"
                    className="session-item__action session-item__stop"
                    aria-label={t('sidebar.stopChat')}
                    title={t('sidebar.stopChat')}
                    onClick={() => stopTurn(session.id)}
                  >
                    <StopIcon size={14} />
                  </button>
                ) : confirming === session.id ? (
                  <button
                    type="button"
                    className="session-item__confirm"
                    autoFocus
                    onClick={() => void removeConversation(session)}
                    onBlur={() => setConfirming(undefined)}
                    onKeyDown={(event) => event.key === 'Escape' && setConfirming(undefined)}
                  >
                    {t('sidebar.confirmDelete')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="session-item__action"
                    aria-label={t('sidebar.deleteChat')}
                    title={t('sidebar.deleteChat')}
                    onClick={() => setConfirming(session.id)}
                  >
                    <TrashIcon />
                  </button>
                )}
              </span>
            )}
          </div>
          </Fragment>
        )
        })}
        {hasMore && !expanded && (
          <button
            type="button"
            className="conversation-list__more-bar"
            onClick={() => setExpanded(true)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
            <span>{t('sidebar.showMore')}</span>
            <span className="conversation-list__more-count">{t('sidebar.remaining', { count: tailCount - tailShown })}</span>
          </button>
        )}
        {expanded && tailCount > CAP && (
          <button type="button" className="conversation-list__more-bar conversation-list__collapse-bar" onClick={() => setExpanded(false)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15" /></svg>
            <span>{t('sidebar.collapse')}</span>
          </button>
        )}
      </div>
      <div className="sidebar__fade" aria-hidden="true" />
      <HoverCard card={sessionHover.card} />

      <div className="sidebar__foot">
        <UpdateNotice />
        <button
          type="button"
          className="settings-trigger"
          ref={layout.hidden ? undefined : settingsRef}
          onClick={() => setSettingsOpen(true)}
        >
          <GearIcon />
          {t('sidebar.settings')}
        </button>
      </div>
    </aside>
  )
}
