import type { Project } from '../shared/ipc.ts'
import { badgeColor, badgeLetters } from './badge.ts'

/** 16px 외곽선 톱니 — dsh 사이드바 설정 줄의 아이콘 자리 */
export function GearIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <path d="M15.64 8.26L17.35 8.51L17.35 11.49L15.64 11.74L15.22 12.75L16.25 14.14L14.14 16.25L12.75 15.22L11.74 15.64L11.49 17.35L8.51 17.35L8.26 15.64L7.25 15.22L5.86 16.25L3.75 14.14L4.78 12.75L4.36 11.74L2.65 11.49L2.65 8.51L4.36 8.26L4.78 7.25L3.75 5.86L5.86 3.75L7.25 4.78L8.26 4.36L8.51 2.65L11.49 2.65L11.74 4.36L12.75 4.78L14.14 3.75L16.25 5.86L15.22 7.25Z" />
      <circle cx="10" cy="10" r="2.5" />
    </svg>
  )
}

/** 팝오버의 지금 프로젝트 표시 — dsh Menu 선택 항목의 14px ✓ */
export function CheckIcon() {
  return (
    <svg className="project-item__check" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 7.5L5.5 10.5L11.5 3.5" />
    </svg>
  )
}

export function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <path d="M2.5 4.5H13.5M6.5 4.5V3H9.5V4.5M4 4.5L4.7 13.2C4.75 13.65 5.1 14 5.55 14H10.45C10.9 14 11.25 13.65 11.3 13.2L12 4.5M6.75 7V11.5M9.25 7V11.5" />
    </svg>
  )
}

export function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11.2 2.6L13.4 4.8L5.6 12.6L2.8 13.2L3.4 10.4Z" />
    </svg>
  )
}

export function Badge({ project }: { project: Project }) {
  return (
    <span className="project-switch__badge" style={{ background: badgeColor(project.path) }}>
      {badgeLetters(project.name)}
    </span>
  )
}

export function SidebarIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7.5 4V16" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

/** 로고 아이콘 — 간단한 기하 도형(둥근 사각형 안의 >_). 다른 회사 로고는 쓰지 않는다 */
export function LogoMark() {
  return (
    <svg className="sidebar__mark" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="7" fill="currentColor" />
      <path d="M7.5 8.5L11 12L7.5 15.5M12.5 16H16.5" stroke="var(--bg)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}
