import { Fragment, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { Project } from '../shared/ipc.ts'
import { TITLE_MAX } from '../shared/chat.ts'
import { ago } from './ago.ts'
import type { Translate } from './settingsStore.ts'
import { StatusDot, type useNotices } from './Notices.tsx'
import { otherProjectsStatus } from './noticeView.ts'
import { FromIcon } from './Delegation.tsx'
import { sidebarMark } from './delegationView.ts'
import { RunningCount, RunningFilter } from './Background.tsx'
import { runningOutside } from './backgroundView.ts'
import { StopIcon } from './stopTurn.tsx'
import { PinButton, PinnedMark, SessionSearch } from './SessionListTools.tsx'
import { GearIcon, LogoMark, PencilIcon, SidebarIcon, TrashIcon, Badge } from './SidebarIcons.tsx'
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
  runningOnly: boolean
  setRunningOnly: Dispatch<SetStateAction<boolean>>
  titleQuery: string
  setTitleQuery: Dispatch<SetStateAction<string>>
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
}

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
  runningOnly,
  setRunningOnly,
  titleQuery,
  setTitleQuery,
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
}: SidebarProps) {
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

      <div className="sidebar__label">
        {t('sidebar.conversations')}
        <RunningFilter count={running.length} on={runningOnly} onToggle={() => setRunningOnly((on) => !on)} />
      </div>
      <SessionSearch value={titleQuery} onChange={setTitleQuery} />

      <div className="sidebar__sessions">
        {/* 행의 휴지통은 dsh ui-workspace 세션 행의 hover 버튼처럼 hover·포커스 때만 시각 자리에 보인다. 누르면 "삭제 확인" 으로
            바뀌고 한 번 더 눌러야 지운다(설정 화면 provider 삭제와 같은 방식). 포커스를 잃거나 Esc 면 되돌린다 */}
        {listed.length === 0 && titleQuery.trim() && <div className="session-list__empty">{t('sidebar.noMatch')}</div>}
        {listed.map((session, at) => (
          <Fragment key={session.id}>
          {/* 고정 묶음과 나머지 사이의 선 */}
          {at > 0 && !session.pinned && listed[at - 1]!.pinned && <div className="session-list__divider" role="separator" />}
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
        ))}
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
