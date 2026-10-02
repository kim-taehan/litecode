import { useEffect, useRef, useState, type RefObject } from 'react'
import { useT } from './settingsStore.ts'

// 대화 오른쪽 가장자리 미니맵 (dsh ui-chat TurnNavigator 참조) — 내 말(턴)마다 가로줄 하나. 대화 칸 위 1/3 선을 지난 마지막 턴이
// "지금" 이라 진하게. 누르면 그 턴의 내 말이 위에 오게 옮긴다. 턴의 자리는 대화 칸 안의 `.user-turn` 이다

/** 미니맵을 그린다. turns 는 턴마다 내 말 글 (줄의 이름표·툴팁) */
export function Minimap({ scroller, turns }: { scroller: RefObject<HTMLElement | null>; turns: readonly string[] }) {
  const t = useT()
  const [active, setActive] = useState(0)
  const frame = useRef(0)

  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const update = () => {
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(() => {
        const top = element.getBoundingClientRect().top
        const line = top + element.clientHeight / 3
        let index = 0
        anchors(element).forEach((anchor, at) => {
          if (anchor.getBoundingClientRect().top <= line) index = at
        })
        setActive(index)
      })
    }
    update()
    element.addEventListener('scroll', update, { passive: true })
    return () => {
      element.removeEventListener('scroll', update)
      cancelAnimationFrame(frame.current)
    }
  }, [scroller, turns.length])

  if (turns.length === 0) return null
  return (
    <nav className="minimap" aria-label={t('chat.minimap')}>
      {turns.map((text, index) => (
        <button
          key={index}
          type="button"
          className="minimap__mark"
          aria-current={index === active ? 'true' : undefined}
          aria-label={t('chat.minimapTurn', { index: index + 1, text })}
          title={text}
          onClick={() => {
            const element = scroller.current
            const anchor = element && anchors(element)[index]
            if (!element || !anchor) return
            element.scrollTo({ top: element.scrollTop + anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - 12 })
          }}
        />
      ))}
    </nav>
  )
}

function anchors(element: HTMLElement): HTMLElement[] {
  return [...element.querySelectorAll<HTMLElement>('.user-turn')]
}

/** 대화 칸이 맨 아래에 붙어 있으면 내용이 늘 때 따라 내려간다. 사용자가 위로 올리면(미니맵 이동 포함) 따라가지 않는다.
 *  key 가 바뀌면(다른 대화·탭) 다시 따라간다. 돌려주는 ref 를 true 로 두면 다음 그리기에서 맨 아래로 (보낼 때) */
export function useFollowBottom(scroller: RefObject<HTMLElement | null>, key: unknown): RefObject<boolean> {
  const following = useRef(true)
  useEffect(() => {
    following.current = true
  }, [key])
  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const onScroll = () => {
      following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => element.removeEventListener('scroll', onScroll)
  })
  useEffect(() => {
    const element = scroller.current
    if (element && following.current) element.scrollTo({ top: element.scrollHeight })
  })
  return following
}
