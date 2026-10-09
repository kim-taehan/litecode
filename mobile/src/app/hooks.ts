import { useEffect, useState, useSyncExternalStore } from 'react'
import { Keyboard } from 'react-native'
import type { ModelChoice } from '../../../shared/remote.ts'
import type { ConnectionStatus, RemoteState } from '../core/index.ts'
import type { DesktopLink, LinkState } from './link.ts'
import type { Preferences, Prefs } from './prefs.ts'
import type { AppSession, SessionNotice } from './session.ts'

/** 세션의 리듀서 상태 — 바뀌면 다시 그린다 */
export function useRemoteState(session: AppSession): RemoteState {
  return useSyncExternalStore(session.subscribe, session.getState)
}

/** 그 대화의 모델 — 폰에서 고르면 바로 바뀐다 (#269) */
export function useModelOf(session: AppSession, cid: string): ModelChoice | undefined {
  return useSyncExternalStore(session.subscribe, () => session.modelOf(cid))
}

export function useConnectionStatus(session: AppSession): ConnectionStatus {
  return useSyncExternalStore(session.subscribe, session.getStatus)
}

export function useNotice(session: AppSession): SessionNotice | undefined {
  return useSyncExternalStore(session.subscribe, session.getNotice)
}

/** 마지막으로 붙지 못한 까닭 (연결 화면의 사유) */
export function useFailure(session: AppSession): unknown {
  return useSyncExternalStore(session.subscribe, session.getFailure)
}

/** 이 세션이 한 번이라도 붙었나 (아직이면 연결 화면) */
export function useHasConnected(session: AppSession): boolean {
  return useSyncExternalStore(session.subscribe, session.hasConnected)
}

/** active 인 동안 링크로 받은 바이트 — active 가 켜진 때부터 센다(0.5초마다). 블루투스로 긴 대화를 받는 진행 표시 */
export function useReceivedSince(session: AppSession, active: boolean): number {
  const [bytes, setBytes] = useState(0)
  useEffect(() => {
    if (!active) return
    const from = session.receivedBytes()
    setBytes(0)
    const timer = setInterval(() => setBytes(session.receivedBytes() - from), 500)
    return () => clearInterval(timer)
  }, [session, active])
  return bytes
}

/** 데스크탑과의 짝이 지금 어느 단계인가 */
export function useLinkState(link: DesktopLink): LinkState {
  return useSyncExternalStore(
    (listener) => link.subscribe(listener),
    () => link.state,
  )
}

export function usePrefs(preferences: Preferences): Prefs {
  return useSyncExternalStore(
    (listener) => preferences.subscribe(listener),
    () => preferences.value,
  )
}

/** 1초마다 오르는 지금 시각 — 진행 초·"12초 전"·"다시 연결 중 · n초" */
export function useNow(active = true): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/** 키보드가 떠 있는가 */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(() => Keyboard.isVisible())
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () => setVisible(true))
    const hidden = Keyboard.addListener('keyboardDidHide', () => setVisible(false))
    return () => {
      shown.remove()
      hidden.remove()
    }
  }, [])
  return visible
}
