import { memo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { extendTokens, highlight, highlighted, type Shown, type Token } from './highlight.ts'
import './highlight.css'

// 문법 색을 화면에 얹는 쪽 (이슈 #81) — 색칠 자체는 highlight.ts. 토큰을 React 요소(<span class>)로만 그린다.

/** 이보다 짧은 글은 그리는 자리에서 바로 색칠한다(1ms 미만) — 대화를 열 때 색 없는 글이 번쩍이지 않게 */
const SYNC_CHARS = 2_000
/** 글이 바뀌는 동안(답이 오는 중)엔 이 간격으로만 다시 색칠한다 — 조각마다 전체를 다시 색칠하지 않는다 */
const RECOLOR_MS = 200

/** 처음 칠할 때 — 짧은 글은 바로, 긴 글은 이미 칠해 둔 것(캐시)만 */
function firstColor(code: string, language: string | undefined): Shown | undefined {
  const tokens = code.length <= SYNC_CHARS ? highlight(code, language) : highlighted(code, language)
  return tokens && { code, language, tokens }
}

/** code 의 토큰. 아직 색칠 전이거나 색칠할 수 없으면 undefined(색 없는 글로 그린다).
 *  긴 글은 그린 뒤 다음 차례에 색칠하고, 글이 뒤로 자라는 동안엔 앞은 색을 지킨 채 붙은 글만 잠깐 색 없이 보인다.
 *  active 가 거짓인 동안은 칠하지 않는다(화면 밖 코드 블록 — useSeen) */
export function useHighlight(code: string, language: string | undefined, active = true): Token[] | undefined {
  const [shown, setShown] = useState<Shown | undefined>(() => (active ? firstColor(code, language) : undefined))
  const [activated, setActivated] = useState(active)
  if (active && !activated) {
    // 막 화면에 들어왔다 — 처음 그릴 때와 같이 짧은 글은 이번 그리기에서 바로 칠한다 (렌더 중 상태 맞추기, React 문서의 권장 형태)
    setActivated(true)
    setShown(firstColor(code, language))
  }
  const latest = useRef({ code, language })
  latest.current = { code, language }
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const current = shown?.code === code && shown.language === language

  useEffect(() => {
    if (!activated || current || !language || timer.current !== undefined) return
    timer.current = setTimeout(
      () => {
        timer.current = undefined
        const now = latest.current
        setShown({ ...now, tokens: highlight(now.code, now.language) })
      },
      shown ? RECOLOR_MS : 0,
    )
  }, [code, language, current, activated])

  useEffect(
    () => () => {
      clearTimeout(timer.current)
      timer.current = undefined
    },
    [],
  )

  return extendTokens(shown, code, language)
}

/** 화면에 들어오기 조금 전(위아래 이만큼)부터 칠한다 — 스크롤할 때 색 없는 글이 번쩍이지 않게 */
const SEEN_MARGIN = '200px 0px'

/** 요소들을 한 관찰자로 지켜보다가 화면에 처음 들어오면 한 번 알린다 (dsh ui-primitives markdown/useViewportHighlighting 참조) */
export const viewport = (() => {
  let observer: IntersectionObserver | undefined
  const waiting = new Map<Element, () => void>()
  const forget = (element: Element) => {
    waiting.delete(element)
    observer?.unobserve(element)
    if (waiting.size > 0) return
    observer?.disconnect()
    observer = undefined
  }
  return {
    once(element: Element, seen: () => void): () => void {
      observer ??= new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const notify = entry.isIntersecting ? waiting.get(entry.target) : undefined
            if (!notify) continue
            forget(entry.target)
            notify()
          }
        },
        { rootMargin: SEEN_MARGIN },
      )
      waiting.set(element, seen)
      observer.observe(element)
      return () => forget(element)
    },
  }
})()

/** target 이 화면에 한 번이라도 들어왔나 (그 뒤로는 계속 참). IntersectionObserver 가 없으면(서버 렌더·테스트) 처음부터 참 */
export function useSeen(target: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined')
  useLayoutEffect(() => {
    const element = target.current
    if (seen || !element) return
    // 그리기 전에 이미 화면 안이면 바로 — 대화를 열 때 보이는 블록이 한 장면 색 없이 번쩍이지 않게
    const box = element.getBoundingClientRect()
    if (box.bottom > 0 && box.top < window.innerHeight && box.width > 0) return setSeen(true)
    return viewport.once(element, () => setSeen(true))
  }, [seen])
  return seen
}

/** 토큰 → 요소. 종류 없는 조각은 글자 그대로 */
export const Tokens = memo(function Tokens({ tokens }: { tokens: readonly Token[] }) {
  return tokens.map((token, index) =>
    token.kind ? (
      <span key={index} className={token.kind}>
        {token.text}
      </span>
    ) : (
      token.text
    ),
  )
})
