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

/** 맨 아래에 붙어 있다 — 남은 거리 40px 미만. 따라 내려가기와 맨 아래로 버튼(ScrollToBottom.tsx)이 같은 판정을 쓴다 */
export function nearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 40
}

/** 대화 칸이 맨 아래에 붙어 있으면 내용이 늘 때 따라 내려간다. 사용자가 위로 올리면(미니맵 이동 포함) 따라가지 않는다.
 *  key 가 바뀌면(다른 대화·탭) 다시 따라간다. 돌려주는 ref 를 true 로 두면 다음 그리기에서 맨 아래로 (보낼 때) */
export function useFollowBottom(scroller: RefObject<HTMLElement | null>, key: unknown): RefObject<boolean> {
  const following = useRef(true)
  /** 마지막으로 따라 내려가며 둔 scrollTop — scroll 이벤트가 사용자 움직임인지 가린다 */
  const landed = useRef(-1)
  useEffect(() => {
    following.current = true
  }, [key])
  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const toBottom = () => {
      element.scrollTo({ top: element.scrollHeight })
      landed.current = element.scrollTop
    }
    const onScroll = () => {
      // 우리가 둔 자리 그대로인데 맨 아래가 아니면 그 사이 글이 더 늘어난 것이다 — 사용자가 올린 게 아니니 계속 따라간다
      // (dsh movedByReader). 거리만 보면 답이 길게 붙는 순간 "위로 올렸다" 로 읽혀 답 끝을 못 따라갔다 (실측 2026-10-02, 남은 거리 436px)
      if (following.current && Math.abs(element.scrollTop - landed.current) <= 1) {
        if (!nearBottom(element)) toBottom()
        return
      }
      following.current = nearBottom(element)
      element.toggleAttribute('data-following', following.current)
    }
    // App 이 다시 그리지 않는 크기 변화(자식 컴포넌트 안의 변화·창 크기)에도 따라 내려간다 (dsh ChatViewport 의 ResizeObserver)
    const observer = new ResizeObserver(() => {
      if (following.current) toBottom()
    })
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    // 따라가는 동안은 브라우저 스크롤 고정(overflow-anchor)을 끈다 (chat.css, dsh 와 같다)
    element.toggleAttribute('data-following', following.current)
    if (following.current) toBottom()
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      element.removeEventListener('scroll', onScroll)
      observer.disconnect()
    }
  })
  return following
}
