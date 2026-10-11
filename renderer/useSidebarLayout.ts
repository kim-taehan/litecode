import { useEffect, useRef, useState } from 'react'

// 사이드바 폭·숨김 — dsh ui-layout 의 범위(264~420px)를 따른다. 기본값은 승인 시안의 272px.
// 창마다의 편의 설정이라 localStorage 에 둔다(못 읽으면 기본값 — 사생활 모드·접근 막힘에도 화면은 뜬다)
const SIDEBAR_MIN = 264
const SIDEBAR_MAX = 420
const SIDEBAR_DEFAULT = 272
const LAYOUT_KEY = 'litecode.sidebar'

export function clampSidebar(px: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px)))
}

function readLayout(): { width: number; hidden: boolean } {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}') as { width?: unknown; hidden?: unknown }
    return { width: typeof saved.width === 'number' ? clampSidebar(saved.width) : SIDEBAR_DEFAULT, hidden: saved.hidden === true }
  } catch {
    return { width: SIDEBAR_DEFAULT, hidden: false }
  }
}

/** 사이드바 폭·숨김과 폭을 끄는 중의 시작점 — 바뀌면 localStorage 에 적는다 */
export function useSidebarLayout() {
  const [layout, setLayout] = useState(readLayout)
  const drag = useRef<{ x: number; width: number }>(undefined)
  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
    } catch {
      // 못 쓰면 이번 실행 동안만 기억한다
    }
  }, [layout])
  return { layout, setLayout, drag }
}
