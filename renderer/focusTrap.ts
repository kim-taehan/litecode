import { useEffect, type RefObject } from 'react'

// 모달 포커스 가두기 (dsh 공용 Modal 의 동작) — `aria-modal` 인 판이 떠 있는 동안 Tab 이 뒤 화면으로 나가지 않고 판 안에서 돈다.
// 열릴 때 포커스를 판으로 옮기고(안에 autoFocus 가 있으면 그대로), 닫히면 열기 전 자리로 돌려준다.
// 판이 겹치면(설정 위의 확인 창) 맨 나중에 뜬 판만 가둔다

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Tab 한 번에 포커스를 어디로 옮길지 — 판 안의 포커스 받을 것 count 개 중 지금 자리 active(-1 = 판 밖이거나 판 자신).
 * 돌려주는 값: 옮길 자리, -1 은 판 자신(받을 것이 없다), undefined 는 브라우저에 맡긴다(가운데)
 */
export function trapTarget(count: number, active: number, shift: boolean): number | undefined {
  if (count === 0) return -1
  if (active === -1) return shift ? count - 1 : 0
  if (shift && active === 0) return count - 1
  if (!shift && active === count - 1) return 0
  return undefined
}

const stack: HTMLElement[] = []

/** 보이는 것만 — display:none 인 것은 Tab 순서에 없다 */
function focusables(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.getClientRects().length > 0)
}

/** on: 판이 떠 있다 (늘 떠 있는 컴포넌트는 안 준다).
 *  steal: 열릴 때 포커스를 판으로 옮긴다. 사용자가 부르지 않았는데 뜨는 판(폰 짝짓기 요청)은 false — 치던 글을 끊지 않는다 */
export function useFocusTrap(panel: RefObject<HTMLElement | null>, { on = true, steal = true }: { on?: boolean; steal?: boolean } = {}): void {
  useEffect(() => {
    const element = panel.current
    if (!on || !element) return
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    stack.push(element)
    if (steal && !element.contains(document.activeElement)) {
      // 판 자신에 둔다 — 첫 버튼(닫기·거절)에 두면 Enter 한 번에 눌린다. 자동으로 준 포커스라 링은 그리지 않는다 (dsh ui-theme focus)
      if (!element.hasAttribute('tabindex')) element.tabIndex = -1
      element.style.outline = 'none'
      element.focus()
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Tab' || stack.at(-1) !== element) return
      const items = focusables(element!)
      const target = trapTarget(items.length, items.indexOf(document.activeElement as HTMLElement), event.shiftKey)
      if (target === undefined) return
      event.preventDefault()
      ;(items[target] ?? element!).focus()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      stack.splice(stack.indexOf(element), 1)
      // 닫는 쪽이 이미 다른 곳에 포커스를 줬으면 그대로 둔다
      if (before?.isConnected && (element.contains(document.activeElement) || document.activeElement === document.body)) before.focus()
    }
  }, [panel, on, steal])
}
