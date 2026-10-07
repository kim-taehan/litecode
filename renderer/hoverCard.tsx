import { useEffect, useRef, useState } from 'react'

// 잘린 경로를 보여주는 방식은 dsh ui-workspace 의 세션 행을 따른다: 마우스를 올리면 잘린 글자가 일정한 속도로 흘러가
// 끝부분을 보이고(양 끝은 페이드), 떼면 한 번에 제자리로. 거의 안 잘린 것(8px 이하)은 흔들림으로 보여 움직이지 않는다.
const MARQUEE_MIN_PX = 8
const MARQUEE_PX_PER_MS = 0.03
const marqueeFrames = new WeakMap<HTMLElement, number>()

/** 행 안에서 흘러갈 글자 — `.marquee` 를 붙인 한 줄짜리 요소 */
function pathOf(row: HTMLElement): HTMLElement | null {
  return row.querySelector<HTMLElement>('.marquee')
}

function isClipped(row: HTMLElement): boolean {
  const path = pathOf(row)
  return !!path && path.scrollWidth - path.clientWidth > MARQUEE_MIN_PX
}

function placePath(path: HTMLElement, left: number, range: number): void {
  path.scrollLeft = left
  path.toggleAttribute('data-scrolled', left > 0)
  path.toggleAttribute('data-clipped', left < range)
}

export function startMarquee(row: HTMLElement): void {
  const path = pathOf(row)
  if (!path || !isClipped(row)) return
  const range = path.scrollWidth - path.clientWidth
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return placePath(path, range, range)
  cancelAnimationFrame(marqueeFrames.get(path) ?? 0)
  let previous: number | undefined
  let position = 0
  const step = (now: number): void => {
    position += previous === undefined ? 0 : (now - previous) * MARQUEE_PX_PER_MS
    previous = now
    placePath(path, Math.min(position, range), range)
    if (position < range) marqueeFrames.set(path, requestAnimationFrame(step))
  }
  marqueeFrames.set(path, requestAnimationFrame(step))
}

export function stopMarquee(row: HTMLElement): void {
  const path = pathOf(row)
  if (!path) return
  cancelAnimationFrame(marqueeFrames.get(path) ?? 0)
  path.scrollLeft = 0
  path.removeAttribute('data-scrolled')
  path.removeAttribute('data-clipped')
}

type HoverCardContent = { title: string; detail?: string }

/** 잘린 행에 800ms 머물면 행 오른쪽 8px 에 전체 내용 카드 (dsh ui-primitives HoverCard). 흘러가는 글자도 함께 켜고 끈다 */
export function useHoverCard() {
  const [card, setCard] = useState<HoverCardContent & { top: number; left: number }>()
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return {
    card,
    /** always: 잘리지 않아도 카드를 띄운다 — 카드에 제목 말고 다른 정보(메시지 수 등)가 있을 때 */
    enter(row: HTMLElement, content: HoverCardContent, always = false): void {
      startMarquee(row)
      clearTimeout(timer.current)
      if (!always && !isClipped(row)) return
      timer.current = setTimeout(() => {
        // 행에 딸린 버튼(☆·✎·× 등)까지 포함한 줄 전체의 오른쪽 바깥에 붙인다 — 버튼을 덮지 않게
        const rect = (row.closest<HTMLElement>('[data-hover-row]') ?? row).getBoundingClientRect()
        setCard({ ...content, top: rect.top, left: rect.right + 8 })
      }, 800) // dsh HoverCard 열림 지연
    },
    leave(row: HTMLElement): void {
      stopMarquee(row)
      clearTimeout(timer.current)
      setCard(undefined)
    },
  }
}

export function HoverCard({ card }: { card?: HoverCardContent & { top: number; left: number } }) {
  if (!card) return null
  return (
    <div className="hover-card" role="tooltip" style={{ top: card.top, left: card.left }}>
      <div className="hover-card__name">{card.title}</div>
      {card.detail && <div className="hover-card__path">{card.detail}</div>}
    </div>
  )
}
