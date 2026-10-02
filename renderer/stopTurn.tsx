import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { QueuedSend } from './useSendQueue.ts'

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
 * 멈추기 함수를 준다 — 그 대화의 큐를 붙잡고(턴 끝에 보내지 않는다) 메인에 멈춤을 보낸다. 턴 끝은 그 턴의 sendMessage 결과("중단됨")가 정한다.
 * 붙잡힌 큐는 그 대화가 화면에 있으면 곧장, 아니면 그 대화를 열 때 입력창으로 되돌린다 (입력창은 하나라 보이는 대화의 것만 넣는다)
 */
export function useStopTurn(
  queue: { hold(id: string): void; held(id: string): boolean; take(id: string): QueuedSend | undefined },
  active: string | undefined,
  setDraft: Dispatch<SetStateAction<string>>,
): (id: string) => void {
  const held = !!active && queue.held(active)
  useEffect(() => {
    const taken = active && held ? queue.take(active) : undefined
    if (taken) setDraft((now) => [taken.display ?? taken.text, now.trim()].filter(Boolean).join('\n'))
  }, [active, held])
  return (id) => {
    queue.hold(id)
    void window.litecode.stopTurn(id)
  }
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
