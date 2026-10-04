import { useEffect, useState, useSyncExternalStore } from 'react'
import { Keyboard } from 'react-native'
import type { ConnectionStatus, RemoteState } from '../core/index.ts'
import type { AppSession } from './session.ts'

/** 세션의 리듀서 상태 — 바뀌면 다시 그린다 */
export function useRemoteState(session: AppSession): RemoteState {
  return useSyncExternalStore(session.subscribe, session.getState)
}

export function useConnectionStatus(session: AppSession): ConnectionStatus {
  return useSyncExternalStore(session.subscribe, session.getStatus)
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
