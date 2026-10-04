import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { AttachmentKind, Project } from '../shared/ipc.ts'
import { FILE_ICON_PATHS } from './Attachments.tsx'
import { McpPopup } from './McpPopup.tsx'
import { mcpCounts } from './plusView.ts'
import { SKILL_ICON_PATH } from './SkillBadge.tsx'
import { SkillsPopup } from './SkillsPopup.tsx'
import { useT } from './settingsStore.ts'
import './plus.css'

// 입력 카드의 `+` 버튼과 메뉴 (이슈 #43, 시안 _workspace/mock-plus/Main.dc.html). 누르면 입력 카드 위에 메뉴가 뜬다: 머리 "<프로젝트> 에서 쓰는 것",
// 스킬(오른쪽에 개수) · MCP 서버(오른쪽에 "연결 N · 실패 M"). 고르면 각각 따로 된 팝업(SkillsPopup·McpPopup)이 그 프로젝트 기준으로 열린다.
// 맨 위는 "파일 추가"·"이미지 추가"(이슈 #44) — 누르면 메뉴를 닫고 onAttach 로 넘긴다(OS 파일 고르기는 메인이 띄운다). 그 아래 구분선.
// 지금 고른 모델이 이미지를 못 받으면(설정 > 모델의 "이미지 입력" — 01y: 그 표시 없이는 이미지가 ERROR 글로 바뀐다) "이미지 추가" 는 못 누르고
// 사유 한 줄을 보인다. disabled 가 아니라 aria-disabled 다 — 화살표로 닿아 사유가 읽힌다.
// 메뉴 동작은 모드 칩 메뉴(ModeChip — dsh ui-primitives Menu)와 같다: Esc·바깥 누르기로 닫힘, 화살표로 이동, 닫히면 버튼으로 포커스.
// 개수·요약은 메뉴를 열 때마다 묻는다(스킬 파일·서버 상태는 앱 밖에서 바뀐다). 프로젝트가 없으면 버튼을 못 누른다.

type Popup = 'skills' | 'mcp'

export function PlusMenu({ project, imageInput, onAttach }: { project?: Project; imageInput: boolean; onAttach(kind: AttachmentKind): void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [popup, setPopup] = useState<Popup>()
  const [skillCount, setSkillCount] = useState<number>()
  const [mcp, setMcp] = useState<{ connected: number; failed: number }>()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const directory = project?.path
  const rows = () => [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]

  useEffect(() => {
    if (!open) return
    rows()[0]?.focus()
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])

  useEffect(() => {
    if (!open || !directory) return
    let current = true
    setSkillCount(undefined)
    setMcp(undefined)
    // 못 읽으면(서비스가 못 떴다 등) 오른쪽 글자 없이 — 팝업을 열면 사유가 보인다
    window.litecode.listSkills(directory).then((list) => current && setSkillCount(list.length), () => {})
    // 내장 서버(앱 자신의 것, 이슈 #51)는 세지 않는다 — 사용자가 붙인 서버의 수다
    window.litecode.listMcp(directory).then((list) => current && setMcp(mcpCounts(list.filter((server) => server.source !== 'builtin'))), () => {})
    return () => {
      current = false
    }
  }, [open, directory])

  // 프로젝트가 바뀌면 열린 것을 닫는다 — 메뉴·팝업은 그 프로젝트의 것이다
  useEffect(() => {
    setOpen(false)
    setPopup(undefined)
  }, [directory])

  function close(): void {
    setOpen(false)
    triggerRef.current?.focus()
  }

  function onMenuKeyDown(event: ReactKeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault() // 입력창의 Esc 두 번(답변 중지)은 이미 쓰인 Esc 를 세지 않는다
      event.stopPropagation()
      close()
      return
    }
    if (event.key === 'Tab') {
      setOpen(false)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const list = rows()
    const at = list.indexOf(document.activeElement as HTMLElement)
    list[(at + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus()
  }

  function attach(kind: AttachmentKind): void {
    setOpen(false)
    onAttach(kind)
  }

  function show(next: Popup): void {
    setOpen(false)
    setPopup(next)
  }

  function closePopup(): void {
    setPopup(undefined)
    triggerRef.current?.focus()
  }

  return (
    <>
      {/* 막힌 버튼은 툴팁을 못 띄워 감싼 쪽에 둔다 */}
      <span className="composer__add-wrap" title={project ? undefined : t('plus.noProject')}>
        <button
          type="button"
          className="composer__add"
          ref={triggerRef}
          aria-label={t('plus.open')}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={!project}
          onClick={() => setOpen((now) => !now)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" strokeWidth="1.3" aria-hidden="true">
            <path d="M8 2V14M2 8H14" stroke="currentColor" />
          </svg>
        </button>
      </span>
      {open && project && (
        <div className="plus-menu" role="menu" aria-label={t('plus.open')} ref={menuRef} onKeyDown={onMenuKeyDown}>
          <button type="button" role="menuitem" className="plus-menu__item" data-plus="file" onClick={() => attach('file')}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {FILE_ICON_PATHS.map((d) => (
                <path key={d} d={d} />
              ))}
            </svg>
            <span className="plus-menu__name">{t('plus.menu.file')}</span>
          </button>
          <button type="button" role="menuitem" className="plus-menu__item" data-plus="image" aria-disabled={!imageInput} onClick={() => imageInput && attach('image')}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
              <circle cx="5.5" cy="6.25" r="1.25" />
              <path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3" />
            </svg>
            <span className="plus-menu__name">
              {t('plus.menu.image')}
              {!imageInput && <span className="plus-menu__note">{t('plus.menu.image.blocked')}</span>}
            </span>
          </button>
          <div className="plus-menu__divider" role="separator" />
          <div className="plus-menu__label">{t('plus.menu.title', { project: project.name })}</div>
          <button type="button" role="menuitem" className="plus-menu__item" data-plus="skills" onClick={() => show('skills')}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true">
              <path d={SKILL_ICON_PATH} />
            </svg>
            <span className="plus-menu__name">{t('plus.menu.skills')}</span>
            {skillCount !== undefined && <span className="plus-menu__meta">{t('plus.menu.skills.count', { count: skillCount })}</span>}
          </button>
          <button type="button" role="menuitem" className="plus-menu__item" data-plus="mcp" onClick={() => show('mcp')}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5.5 1.75V4.5M10.5 1.75V4.5M3.75 4.5H12.25V7.5A4.25 4.25 0 0 1 3.75 7.5ZM8 11.75V14.25" />
            </svg>
            <span className="plus-menu__name">{t('plus.menu.mcp')}</span>
            {mcp && <span className="plus-menu__meta">{t('plus.menu.mcp.summary', mcp)}</span>}
          </button>
        </div>
      )}
      {popup === 'skills' && project && <SkillsPopup project={project} onClose={closePopup} />}
      {popup === 'mcp' && project && <McpPopup project={project} onClose={closePopup} />}
    </>
  )
}
