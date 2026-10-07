import { useSyncExternalStore } from 'react'
import type { FeatureId, FeatureStatuses } from '../shared/ipc.ts'

// 화면 쪽 켜진 기능 — 정본은 메인의 ctx.features. 첫 그림 전에 한 번 읽고(main.tsx), 바뀌면 메인이 밀어 준다(features:changed —
// 묶음을 다 올리고 내린 뒤라 목록에 있는 기능의 IPC 는 이미 걸려 있다). 꺼진 기능의 버튼·탭·메뉴·단축키는 그리지 않는다.

let current: ReadonlySet<FeatureId> = new Set()
/** 켜진 기능의 상태 (이슈 #224) — 설정 > 기능이 "켜지 못함" 을 그린다. 메인이 바뀔 때마다 밀어 준다(features:statuses-changed) */
let statuses: FeatureStatuses = {}
const listeners = new Set<() => void>()

function apply(enabled: FeatureId[]): void {
  current = new Set(enabled)
  for (const listener of listeners) listener()
}

function applyStatuses(next: FeatureStatuses): void {
  statuses = next
  for (const listener of listeners) listener()
}

export async function loadFeatures(): Promise<void> {
  window.litecode.onFeaturesChanged(apply)
  window.litecode.onFeatureStatusesChanged(applyStatuses)
  const [enabled, initial] = await Promise.all([window.litecode.getFeatures(), window.litecode.getFeatureStatuses()])
  apply(enabled)
  applyStatuses(initial)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useFeatures(): ReadonlySet<FeatureId> {
  return useSyncExternalStore(subscribe, () => current)
}

export function useFeatureStatuses(): FeatureStatuses {
  return useSyncExternalStore(subscribe, () => statuses, () => statuses)
}
