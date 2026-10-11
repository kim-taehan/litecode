import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react'

interface ShellDrawerKeysOptions {
  /** 지금 대화의 프로젝트 — 칸은 프로젝트마다 따로 */
  drawerProject: string | undefined
  drawerOpen: boolean
  terminalOn: boolean
  setShellOpen: Dispatch<SetStateAction<Record<string, boolean>>>
  setShellFocus: Dispatch<SetStateAction<number>>
  inputRef: RefObject<HTMLTextAreaElement | null>
}

// 터미널 칸 — ⌘↓ 로 펴고 키를 칸으로 내리고, ⌘↑ 로 접고 입력창으로 올라온다 (closed-code useShellDrawer. Windows·Linux 는 Ctrl).
// `!` 로는 안 열린다(`!명령` 은 대화 카드). ⌘⇧↑ 은 글 선택 확장이라 건드리지 않는다. 칸이 접혀 있으면 ⌘↑ 은 입력창의 것이다
export function useShellDrawerKeys({ drawerProject, drawerOpen, terminalOn, setShellOpen, setShellFocus, inputRef }: ShellDrawerKeysOptions): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const command = navigator.platform.startsWith('Mac') ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      if (!command || event.shiftKey || event.altKey || !drawerProject || !terminalOn) return
      // 판(aria-modal)이 떠 있으면 물러난다 (⌘F 와 같다 — ChatFind.tsx). 입력창·터미널 칸이 아닌 글 칸에서는 ⌘↓/⌘↑ 이 그 칸의 커서 이동이다
      if (document.querySelector('[aria-modal="true"]')) return
      const target = event.target instanceof HTMLElement ? event.target : undefined
      if (target?.matches('input, textarea, [contenteditable]') && !target.closest('.composer__input, .shell-drawer')) return
      if (event.key === 'ArrowDown') {
        setShellOpen((open) => ({ ...open, [drawerProject]: true }))
        setShellFocus((count) => count + 1)
      } else if (event.key === 'ArrowUp' && drawerOpen) {
        setShellOpen((open) => ({ ...open, [drawerProject]: false }))
        inputRef.current?.focus()
      } else return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKeyDown, true) // 칸(xterm)이 키를 먹기 전에
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [drawerProject, drawerOpen, terminalOn])
}
