import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { translate } from '../../shared/i18n/index.ts'
import type { Project } from '../../shared/ipc.ts'
import { Badge, CheckIcon, GearIcon, LogoMark, PencilIcon, SidebarIcon, TrashIcon } from '../../renderer/SidebarIcons.tsx'
import { HoverCard } from '../../renderer/hoverCard.tsx'
import { Rail } from '../../renderer/Rail.tsx'
import { MissingConversations } from '../../renderer/MissingConversations.tsx'
import { ProjectPopover } from '../../renderer/ProjectPopover.tsx'

// App.tsx 에서 닫힌 조각을 파일로 옮길 때(이슈 #198, 동작 변화 0) 첫 모양이 그대로인지 지킨다.
// 스냅숏은 옮기기 **전** 코드로 만들었다 — 이 파일은 import 경로만 바뀐다
vi.mock('../../renderer/settingsStore.ts', () => ({ useT: () => (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('ko', key, vars) }))

const noop = () => {}
const later = () => Promise.resolve()
const projects: Project[] = [
  { path: '/work/alpha', name: 'alpha', displayPath: '~/work/alpha', favorite: true },
  { path: '/work/beta', name: 'beta', displayPath: '~/work/beta', favorite: false },
  { path: '/work/gamma', name: 'gamma', displayPath: '~/work/gamma', favorite: false },
]

describe('사이드바 아이콘·배지', () => {
  it('아이콘과 배지의 마크업', () => {
    expect(renderToStaticMarkup(createElement(GearIcon))).toMatchSnapshot('GearIcon')
    expect(renderToStaticMarkup(createElement(GearIcon, { size: 18 }))).toMatchSnapshot('GearIcon 18')
    expect(renderToStaticMarkup(createElement(CheckIcon))).toMatchSnapshot('CheckIcon')
    expect(renderToStaticMarkup(createElement(TrashIcon))).toMatchSnapshot('TrashIcon')
    expect(renderToStaticMarkup(createElement(PencilIcon))).toMatchSnapshot('PencilIcon')
    expect(renderToStaticMarkup(createElement(SidebarIcon))).toMatchSnapshot('SidebarIcon')
    expect(renderToStaticMarkup(createElement(SidebarIcon, { size: 18 }))).toMatchSnapshot('SidebarIcon 18')
    expect(renderToStaticMarkup(createElement(LogoMark))).toMatchSnapshot('LogoMark')
    expect(renderToStaticMarkup(createElement(Badge, { project: projects[0]! }))).toMatchSnapshot('Badge')
  })
})

describe('HoverCard', () => {
  it('카드가 없으면 아무것도 안 그린다', () => {
    expect(renderToStaticMarkup(createElement(HoverCard, {}))).toBe('')
  })
  it('제목만 / 제목 + 자세히', () => {
    expect(renderToStaticMarkup(createElement(HoverCard, { card: { title: 'alpha', top: 10, left: 20 } }))).toMatchSnapshot('title')
    expect(renderToStaticMarkup(createElement(HoverCard, { card: { title: 'alpha', detail: '/work/alpha', top: 10, left: 20 } }))).toMatchSnapshot('detail')
  })
})

describe('Rail — 접힌 사이드바', () => {
  const base = { switchRef: createRef<HTMLButtonElement>(), settingsRef: createRef<HTMLButtonElement>(), onExpand: noop, onNewChat: noop, onSwitch: noop, onRunning: noop, onSettings: noop }
  it('프로젝트·알림 점·진행 중 수·팝오버 자리', () => {
    const html = renderToStaticMarkup(createElement(Rail, { ...base, project: projects[0], picking: false, notice: 'attention', running: 2 }, createElement('div', { className: 'slot' })))
    expect(html).toMatchSnapshot()
  })
  it('프로젝트 없음·고르는 중·도는 대화 없음', () => {
    const html = renderToStaticMarkup(createElement(Rail, { ...base, picking: true, running: 0 }))
    expect(html).toMatchSnapshot()
  })
})

describe('MissingConversations — 못 연 프로젝트의 대화', () => {
  it('없으면 아무것도 안 그린다', () => {
    expect(renderToStaticMarkup(createElement(MissingConversations, { sessions: [], onRemove: later }))).toBe('')
  })
  it('대화마다 제목·안내·휴지통', () => {
    const sessions = [
      { id: 's1', project: '/gone', title: '첫 대화', messages: [], updatedAt: 1 },
      { id: 's2', project: '/gone', title: '둘째 대화', messages: [], updatedAt: 2 },
    ] as unknown as Parameters<typeof MissingConversations>[0]['sessions']
    expect(renderToStaticMarkup(createElement(MissingConversations, { sessions, onRemove: later }))).toMatchSnapshot()
  })
})

describe('ProjectPopover — 프로젝트 전환 팝오버', () => {
  const base = { projects, onPick: noop, onOpenFolder: noop, onToggleFavorite: noop, onRemove: later, onRename: later, onClose: noop }
  it('즐겨찾기·최근 묶음, 지금 프로젝트 ✓, 상태 점·도는 수, 오류', () => {
    const html = renderToStaticMarkup(
      createElement(ProjectPopover, {
        ...base,
        current: '/work/beta',
        statusOf: (path: string) => (path === '/work/alpha' ? 'attention' : path === '/work/beta' ? 'running' : undefined),
        runningOf: (path: string) => (path === '/work/beta' ? 3 : 0),
        busy: false,
        error: '폴더를 열 수 없습니다',
      }),
    )
    expect(html).toMatchSnapshot()
  })
  it('여는 중 — 행과 폴더 열기가 막힌다', () => {
    const html = renderToStaticMarkup(createElement(ProjectPopover, { ...base, statusOf: () => undefined, runningOf: () => 0, busy: true }))
    expect(html).toMatchSnapshot()
  })
})
