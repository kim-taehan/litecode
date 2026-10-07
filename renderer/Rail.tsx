import type { MouseEvent as ReactMouseEvent, ReactNode, RefObject } from 'react'
import type { ConversationStatus, Project } from '../shared/ipc.ts'
import { useT } from './settingsStore.ts'
import { StatusDot } from './Notices.tsx'
import { HoverCard, useHoverCard } from './hoverCard.tsx'
import { Badge, GearIcon, SidebarIcon } from './SidebarIcons.tsx'

interface RailProps {
  project?: Project
  /** 폴더를 고르거나 여는 중 — 배지를 막는다 */
  picking: boolean
  /** 다른 프로젝트에 확인할 대화가 있다 — 배지 모서리의 점 (펼친 사이드바 전환 카드의 점과 같은 값) */
  notice?: ConversationStatus
  /** 지금 프로젝트에서 도는 대화 수 — 0 이면 그 아이콘은 없다 */
  running: number
  switchRef: RefObject<HTMLButtonElement | null>
  settingsRef: RefObject<HTMLButtonElement | null>
  onExpand(): void
  onNewChat(): void
  onSwitch(): void
  /** 사이드바를 펼치고 "진행 중" 만 보이게 */
  onRunning(): void
  onSettings(): void
  /** 프로젝트 전환 팝오버 — 배지 옆에 뜬다 */
  children?: ReactNode
}

/** 접힌 사이드바 — 56px 아이콘 줄 (이슈 #60 시안, dsh ui-sidebar 의 collapsed rail). 위에서부터 펼치기 · 새 대화 · 프로젝트 배지 ·
 *  진행 중인 대화 수, 맨 아래 설정. 글자가 없으므로 아이콘마다 aria-label 과 옆 카드(HoverCard)로 이름을 보인다.
 *  macOS 는 맨 위 52px 가 창 버튼 자리다 — 빈 끌기 줄(.rail__top)이 차지하고 아이콘은 그 아래부터 */
export function Rail({ project, picking, notice, running, switchRef, settingsRef, onExpand, onNewChat, onSwitch, onRunning, onSettings, children }: RailProps) {
  const t = useT()
  const hover = useHoverCard()
  /** 이름 카드 — 누르면 바로 거둔다 (열린 팝오버·모달 위에 뜨지 않게) */
  const tip = (title: string) => ({
    'aria-label': title,
    onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => hover.enter(event.currentTarget, { title }, true),
    onMouseLeave: (event: ReactMouseEvent<HTMLElement>) => hover.leave(event.currentTarget),
    onMouseDown: (event: ReactMouseEvent<HTMLElement>) => hover.leave(event.currentTarget),
  })
  return (
    <aside className="rail" aria-label={t('rail.label')}>
      <div className="rail__top" />
      <button type="button" className="rail__button" {...tip(t('sidebar.show'))} onClick={onExpand}>
        <SidebarIcon size={18} />
      </button>
      <button type="button" className="rail__button rail__button--raised" {...tip(t('rail.newChat'))} disabled={!project} onClick={onNewChat}>
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M8 2.5H4A1.5 1.5 0 0 0 2.5 4v8A1.5 1.5 0 0 0 4 13.5h8a1.5 1.5 0 0 0 1.5-1.5V8" />
          <path d="M12 2.2l1.8 1.8-5 5H7V7.2z" />
        </svg>
      </button>
      <div className="rail__project">
        <button
          type="button"
          className="rail__button"
          ref={switchRef}
          disabled={picking}
          {...tip(project ? t('rail.project', { name: project.name }) : t('rail.openProject'))}
          onClick={onSwitch}
        >
          {project ? <Badge project={project} /> : <span className="project-switch__badge" />}
          {notice && <StatusDot status={notice} className="rail__notice" />}
        </button>
        {children}
      </div>
      {running > 0 && (
        <button type="button" className="rail__button" {...tip(t('rail.running', { count: running }))} onClick={onRunning}>
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2.5 3.5h11v7.5h-6l-3 2.5v-2.5h-2z" />
          </svg>
          <span className="rail__count" aria-hidden="true">
            {running}
          </span>
        </button>
      )}
      <span className="rail__spacer" />
      <button type="button" className="rail__button" ref={settingsRef} {...tip(t('sidebar.settings'))} onClick={onSettings}>
        <GearIcon size={18} />
      </button>
      <HoverCard card={hover.card} />
    </aside>
  )
}
