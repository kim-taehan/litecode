import { useEffect } from 'react'
import { cycleTerminalTab, openTerminalTab } from './filePreviewStore.ts'

// 터미널 탭 (이슈 #303) — ⌘T 로 새 터미널을 연다(열려 있는 것이 있어도), ⌘[·⌘] 로 이전·다음 터미널. Windows·Linux 는 Ctrl.
// (옛 셸 서랍의 ⌘↓/⌘↑ — ⌘↑ 접기 단축키는 2026-10-13 딴 데 쓰려고 풀었다)

export function useTerminalKeys({ project, terminalOn }: { project: string | undefined; terminalOn: boolean }): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const command = navigator.platform.startsWith('Mac') ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      if (!command || event.altKey || !project || !terminalOn) return
      // 판(aria-modal)이 떠 있으면 물러난다 (⌘F 와 같다 — ChatFind.tsx). 입력창·패널이 아닌 글 칸에서는 그 칸의 커서 이동·페이지 이동이다
      // 브랜치 팝업(#386)이 열려 있으면 ⌘T 는 그 팝업의 가져오기다
      if (document.querySelector('[aria-modal="true"], .branch-pop')) return
      const target = event.target instanceof HTMLElement ? event.target : undefined
      if (target?.matches('input, textarea, [contenteditable]') && !target.closest('.composer__input, .file-preview')) return
      if (event.key.toLowerCase() === 't' && !event.shiftKey) {
        void window.litecode.openTerminal(project).then(({ id }: { id: number }) => openTerminalTab(project, id)).catch(() => {})
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
