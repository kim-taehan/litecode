import { useEffect, useRef } from 'react'
import type { QueuedSend } from '../shared/ipc.ts'

// 답변 중지 (이슈 #3) — 입력창 ■ · 사이드바 행 ■ · Esc 두 번. 모양·동작은 dsh ui-conversation 참조: 턴이 도는 동안 입력이 비면 보내기
// 자리가 ■(둥근 사각형)이 되고, 글을 쓰면 다시 보내기(=큐)다. Esc 두 번은 같은 대화에 STOP_SEQUENCE_MS 안의 독립된 두 번
// (dsh 기본 500ms). 메뉴·승인 카드처럼 Esc 를 먼저 쓴 곳(preventDefault)과 키 반복·입력기 조합은 세지 않는다

/** 두 Esc 사이 최대 간격 (dsh shortcuts stopSequenceMs 기본값) */
export const STOP_SEQUENCE_MS = 500

/** Esc 두 번 판정 — 같은 대화의 간격 안 두 번째 누름에만 true. 멈추면 새로 센다 */
export class EscapeTwice {
  private first: { id: string; at: number } | undefined

  press(id: string, now: number): boolean {
    const first = this.first
    this.first = undefined
    if (first && first.id === id && now - first.at <= STOP_SEQUENCE_MS) return true
    this.first = { id, at: now }
    return false
  }

  reset(): void {
    this.first = undefined
  }
}

/**
 * 멈추기 함수를 준다 — 메인(ctx.chat)에 멈춤을 보낸다. 메인이 그 대화의 대기열을 붙잡고(턴 끝에 보내지 않는다) 턴을 "중단됨" 으로 끝낸다.
 * 붙잡힌 대기열(held)은 그 대화가 화면에 있으면 곧장, 아니면 그 대화를 열 때 입력창으로 되돌린다 (입력창은 하나라 보이는 대화의 것만 넣는다).
 * restore 는 되돌릴 것(합친 글·첨부)을 그 대화의 초안에 넣는 함수 — 대기열의 "되돌리기" 와 같은 것을 쓴다
 */
export function useStopTurn(active: string | undefined, held: boolean, restore: (id: string, taken: QueuedSend) => void): (id: string) => void {
  useEffect(() => {
    // 두 번 불려도(StrictMode) 대기열은 한 번만 온다 — 메인이 주면서 비운다
    if (active && held) void window.litecode.takeQueue(active).then((taken) => taken && restore(active, taken))
  }, [active, held])
  return (id) => void window.litecode.stopTurn(id)
}

/** 채팅 칸·입력창(scope 셀렉터) 안에서 Esc 두 번이면 running 인 대화를 멈춘다. running 이 없으면(턴이 안 돎) 세지 않는다 */
export function useEscapeTwice(scope: string, running: string | undefined, onStop: (id: string) => void): void {
  const latest = useRef({ running, onStop })
  latest.current = { running, onStop }
  useEffect(() => {
    const escape = new EscapeTwice()
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return escape.reset() // 다른 키는 흐름을 끊는다
      const { running: id, onStop: stop } = latest.current
      if (!id || event.repeat || event.isComposing || event.defaultPrevented) return escape.reset()
      if (!(event.target instanceof Element) || !event.target.closest(scope)) return escape.reset()
      if (escape.press(id, performance.now())) stop(id)
    }
    window.addEventListener('keydown', onKeyDown) // 거품 단계 — 메뉴·카드가 먼저 쓴 Esc 는 defaultPrevented 로 보인다
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [scope])
}

/** ■ — dsh 중지 아이콘 치수 (16 격자의 10px 둥근 사각형) */
export function StopIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" />
    </svg>
  )
}
