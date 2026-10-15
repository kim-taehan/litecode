import type { ChoosableFeatureId } from '../shared/features.ts'

// 설정 > 기능 줄 왼쪽 아이콘 칸 (2026-10-12, 사용자 시안 D) — 20×20 선 아이콘. 새 고르는 기능은 여기에도 넣는다(타입이 댄다).
const PATHS: Record<ChoosableFeatureId, string> = {
  trajectory: 'M3 5h8M3 10h12M3 15h6',
  git: 'M6 7v6M6 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 17a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM14 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM14 11c0 2-8 0-8 2',
  appMcp: 'M3 3h6v6H3zM11 3h6v6h-6zM3 11h6v6H3zM11 11h6v6h-6z',
  web: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM3 10h14M10 3c-3 3-3 11 0 14M10 3c3 3 3 11 0 14',
  browser: 'M3 4h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM2 8h16',
  voice: 'M10 12a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v4a3 3 0 0 0 3 3zM5 9a5 5 0 0 0 10 0M10 14v3',
  remote: 'M7 2h6a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM9 15h2',
  notifications: 'M5 14V9a5 5 0 0 1 10 0v5l1 2H4zM8 18h4',
  lan: 'M3 15h14M5 15V9h10v6M10 9V5M7 5h6',
  bluetooth: 'M6 6l8 8-4 3V3l4 3-8 8',
  updates: 'M10 3v10M6 9l4 4 4-4M4 17h12',
  design: 'M3 3h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM13 17V7M10.5 9.5L13 7l2.5 2.5',
}

export function FeatureIcon({ feature }: { feature: ChoosableFeatureId }) {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[feature]} />
    </svg>
  )
}
