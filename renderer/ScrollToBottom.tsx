import { useEffect, useRef, useState, type RefObject } from 'react'
import { nearBottom } from './Minimap.tsx'
import { useT } from './settingsStore.ts'

// "맨 아래로" 버튼 (dsh ui-chat ChatView 의 toBottom 참조) — 대화 칸이 맨 아래가 아닐 때만 입력 카드 오른쪽 위에 뜬다.
// 맨 아래 판정은 따라 내려가기(useFollowBottom)와 같다. 누르면 부드럽게 맨 아래로 가고 다시 따라 내려간다

/** scroller: 대화 스크롤 칸. following: useFollowBottom 이 돌려준 "따라 내려가기" 표시 */
export function ScrollToBottom({ scroller, following }: { scroller: RefObject<HTMLElement | null>; following: RefObject<boolean> }) {
  const t = useT()
  const [away, setAway] = useState(false)
  /** 누른 뒤 부드러운 이동이 끝나기 전 — 그동안은 감춘 채로 둔다 */
  const returning = useRef(false)

  useEffect(() => {
    const element = scroller.current
    const content = element?.firstElementChild
    if (!element) return
    const update = () => setAway(!returning.current && !nearBottom(element))
    // 이동이 끝났을 때 그 사이 글이 늘었으면 마저 내려간다
    const settle = () => {
      if (!returning.current) return
      returning.current = false
      following.current = true
      element.scrollTo({ top: element.scrollHeight })
      update()
    }
    // 이동 중에 사용자가 직접 스크롤하면 그쪽을 따른다
    const interrupt = () => {
      returning.current = false
    }
    update()
    element.addEventListener('scroll', update, { passive: true })
    element.addEventListener('scrollend', settle)
    element.addEventListener('wheel', interrupt, { passive: true })
    element.addEventListener('pointerdown', interrupt)
    const observer = new ResizeObserver(update)
    observer.observe(element)
    if (content) observer.observe(content)
    return () => {
      element.removeEventListener('scroll', update)
      element.removeEventListener('scrollend', settle)
      element.removeEventListener('wheel', interrupt)
      element.removeEventListener('pointerdown', interrupt)
      observer.disconnect()
    }
  }, [scroller, following])

  if (!away) return null
  return (
    <div className="scroll-bottom">
      <button
        type="button"
        className="scroll-bottom__button"
        aria-label={t('chat.toBottom')}
        onClick={() => {
          const element = scroller.current
          if (!element) return
          following.current = true
          setAway(false)
          if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
            element.scrollTo({ top: element.scrollHeight })
            return
          }
          returning.current = true
          element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
        }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" strokeWidth="1" aria-hidden="true">
          <path d="M4 6L8 10L12 6" stroke="currentColor" />
        </svg>
      </button>
    </div>
  )
}
