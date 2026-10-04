import { memo, useEffect, useRef, useState } from 'react'
import { extendTokens, highlight, highlighted, type Shown, type Token } from './highlight.ts'
import './highlight.css'

// 문법 색을 화면에 얹는 쪽 (이슈 #81) — 색칠 자체는 highlight.ts. 토큰을 React 요소(<span class>)로만 그린다.

/** 이보다 짧은 글은 그리는 자리에서 바로 색칠한다(1ms 미만) — 대화를 열 때 색 없는 글이 번쩍이지 않게 */
const SYNC_CHARS = 2_000
/** 글이 바뀌는 동안(답이 오는 중)엔 이 간격으로만 다시 색칠한다 — 조각마다 전체를 다시 색칠하지 않는다 */
const RECOLOR_MS = 200

/** code 의 토큰. 아직 색칠 전이거나 색칠할 수 없으면 undefined(색 없는 글로 그린다).
 *  긴 글은 그린 뒤 다음 차례에 색칠하고, 글이 뒤로 자라는 동안엔 앞은 색을 지킨 채 붙은 글만 잠깐 색 없이 보인다 */
export function useHighlight(code: string, language: string | undefined): Token[] | undefined {
  const [shown, setShown] = useState<Shown | undefined>(() => {
    const tokens = code.length <= SYNC_CHARS ? highlight(code, language) : highlighted(code, language)
    return tokens && { code, language, tokens }
  })
  const latest = useRef({ code, language })
  latest.current = { code, language }
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const current = shown?.code === code && shown.language === language

  useEffect(() => {
    if (current || !language || timer.current !== undefined) return
    timer.current = setTimeout(
      () => {
        timer.current = undefined
        const now = latest.current
        setShown({ ...now, tokens: highlight(now.code, now.language) })
      },
      shown ? RECOLOR_MS : 0,
    )
  }, [code, language, current])

  useEffect(
    () => () => {
      clearTimeout(timer.current)
      timer.current = undefined
    },
    [],
  )

  return extendTokens(shown, code, language)
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
