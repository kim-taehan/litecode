import { useEffect, useState } from 'react'
import type { MessageKey } from '../shared/i18n/index.ts'
import type { UpdateStatus } from '../shared/ipc.ts'

// 새 버전 알림 (기능 `updates`, 이슈 #273) — 상태의 정본은 메인(ctx.updates)이고 화면은 받아서 그린다.
// 설정 > 일반의 결과 한 줄과 사이드바 아래 알림이 같이 쓴다.

const IDLE: UpdateStatus = { state: 'idle' }

/** 기능이 켜져 있을 때만 묻고 듣는다 (꺼져 있으면 채널이 없다) */
export function useUpdateStatus(enabled: boolean): UpdateStatus {
  const [status, setStatus] = useState<UpdateStatus>(IDLE)
  useEffect(() => {
    if (!enabled) {
      setStatus(IDLE)
      return
    }
    const off = window.litecode.onUpdateChanged(setStatus)
    void window.litecode.updateStatus().then(setStatus, () => {})
    return off
  }, [enabled])
  return status
}

/** 설정 > 일반의 결과 한 줄 — 아직 묻지 않았으면 없다 */
export function updateResult(status: UpdateStatus): { key: MessageKey; vars?: Record<string, string> } | undefined {
  switch (status.state) {
    case 'checking':
      return { key: 'settings.updateCheck.checking' }
    case 'up-to-date':
      return { key: 'settings.updateCheck.upToDate', vars: { version: status.latest ?? '' } }
    case 'available':
      return { key: 'settings.updateCheck.available', vars: { version: status.latest ?? '' } }
    case 'failed':
      return { key: 'settings.updateCheck.failed' }
    default:
      return undefined
  }
}

/** 사이드바 알림을 띄울까 — 새 버전이 있고 그 버전을 닫은 적이 없을 때 */
export function showUpdateNotice(status: UpdateStatus, dismissed: string | undefined): boolean {
  return status.state === 'available' && !!status.latest && !!status.url && status.latest !== dismissed
}
