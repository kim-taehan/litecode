import { useEffect, useRef } from 'react'

// 세션 이동 (2026-10-13 피드백 #3) — ⌘↑/⌘↓ (Windows·Linux 는 Ctrl) 로 바로 이전/다음 대화로.
// 터미널 탭(useTerminalKeys)·⌘F(ChatFind) 과 같은 전역 키 규칙: alt 는 무시, 판(aria-modal) 이 뜨면 물러남,
// 컴포저·파일 미리보기 외의 글 칸 포커스는 그 칸의 커서 이동. 캡처 단계 + preventDefault·stopPropagation.
export function useSessionNav({ onStep }: { onStep(dir: 1 | -1): void }): void {
  const stepRef = useRef(onStep)
  stepRef.current = onStep
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const command = navigator.platform.startsWith('Mac') ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      if (!command || event.altKey || event.shiftKey) return
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      // 판(aria-modal) 이나 프로젝트 전환(빠른 열기) 이 열려 있으면 물러난다 — 전환의 ↑/↓ 는 행 이동이다
      if (document.querySelector('[aria-modal="true"], .project-open__panel')) return
      const target = event.target instanceof HTMLElement ? event.target : undefined
      if (target?.matches('input, textarea, [contenteditable]') && !target.closest('.composer__input, .file-preview')) return
      stepRef.current(event.key === 'ArrowDown' ? 1 : -1)
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKeyDown, true) // 탭(xterm)·컴포저가 키를 먹기 전에
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])
}
