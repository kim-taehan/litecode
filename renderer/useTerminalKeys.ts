import { useEffect, type RefObject } from 'react'
import { closeFilePreview, cycleTerminalTab, focusLastTerminalTab, getPanelState, openTerminalTab } from './filePreviewStore.ts'

// 터미널 탭 (이슈 #303) — ⌘↓ 로 열고 키를 탭으로 내린다(터미널 탭이 없으면 새 터미널을 엽니다), ⌘↑ 로 패널을 접고 키를 입력창으로
// 올려온다, ⌘⇧↓ 로 새 터미널, ⌘[·⌘] 로 이전·다음 터미널. Windows·Linux 는 Ctrl. ⌘⇧↑ 는 글 선택 확장이라 건드리지 않는다. (옛
// 셸 서랍의 ⌘↓/⌘↑ — 지금은 오른쪽 패널의 터미널 탭으로)

export function useTerminalKeys({ project, terminalOn, inputRef }: { project: string | undefined; terminalOn: boolean; inputRef: RefObject<HTMLTextAreaElement | null> }): void {
  useEffect(() => {
    function openNew(): void {
      if (!project) return
      void window.litecode.openTerminal(project).then(({ id }: { id: number }) => openTerminalTab(project, id)).catch(() => {})
    }
    function onKeyDown(event: KeyboardEvent): void {
      const command = navigator.platform.startsWith('Mac') ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      if (!command || event.altKey || !project || !terminalOn) return
      // 판(aria-modal)이 떠 있으면 물러난다 (⌘F 와 같다 — ChatFind.tsx). 입력창·패널이 아닌 글 칸에서는 그 칸의 커서 이동·페이지 이동이다
      if (document.querySelector('[aria-modal="true"]')) return
      const target = event.target instanceof HTMLElement ? event.target : undefined
      if (target?.matches('input, textarea, [contenteditable]') && !target.closest('.composer__input, .file-preview')) return
      if (event.key === 'ArrowDown' && !event.shiftKey) {
        if (!focusLastTerminalTab(project)) openNew()
        event.preventDefault()
        event.stopPropagation()
      } else if (event.key === 'ArrowDown' && event.shiftKey) {
        openNew() // 새 터미널
        event.preventDefault()
        event.stopPropagation()
      } else if (event.key === 'ArrowUp' && !event.shiftKey) {
        const panel = getPanelState()
        // 이 프로젝트의 열린 패널만 접고, 안 열려 있으면 입력창의 것
        if (!(panel?.open && panel.directory === project)) return
        closeFilePreview()
        inputRef.current?.focus()
        event.preventDefault()
        event.stopPropagation()
      } else if (!event.shiftKey && event.key === '[') {
        if (cycleTerminalTab(project, -1)) {
          event.preventDefault()
          event.stopPropagation()
        }
      } else if (!event.shiftKey && event.key === ']') {
        if (cycleTerminalTab(project, 1)) {
          event.preventDefault()
          event.stopPropagation()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown, true) // 탭(xterm)이 키를 먹기 전에
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [project, terminalOn])
}
