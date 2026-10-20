/** 확장 퍼즐 — 설정의 확장 카드(이슈 #489)·오른쪽 패널의 확장 탭과 `+` 메뉴(이슈 #511)가 같이 쓴다 */
export function PuzzleIcon({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 4h4v3a2 2 0 1 0 4 0v3h-3a2 2 0 1 0 0 4h3v4h-4v-3a2 2 0 1 0-4 0v3H6v-4h3a2 2 0 1 0 0-4H6V7h4z" />
    </svg>
  )
}
