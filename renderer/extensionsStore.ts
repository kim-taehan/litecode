import { useEffect, useState } from 'react'
import type { ExtensionSummary } from '../shared/extensions.ts'

/** 설치한 확장 목록 (이슈 #489) — 정본은 메인의 ctx.extensions. 처음 한 번 읽고 그 뒤는 메인이 밀어 준다(extensions:changed).
 *  구독을 먼저 걸고, 밀어 준 값이 먼저 왔으면 늦게 온 첫 읽기로 덮지 않는다 (useRemoteStatus 와 같은 모양) */
export function useExtensions(): ExtensionSummary[] {
  const [extensions, setExtensions] = useState<ExtensionSummary[]>([])
  useEffect(() => {
    let alive = true
    let pushed = false
    const off = window.litecode.onExtensionsChanged((next) => {
      pushed = true
      if (alive) setExtensions(next)
    })
    void window.litecode.listExtensions().then(
      (first) => void (alive && !pushed && setExtensions(first)),
      () => {},
    )
    return () => {
      alive = false
      off()
    }
  }, [])
  return extensions
}
