// Git 탭 아이콘 (기록 탭 칩이 Git.tsx 와 서로 붙지 않게(#405) 따로 둔다)

export function BranchIcon({ className = 'git-icon' }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5.5" r="1.5" />
      <path d="M4.5 5V11M11.5 7C11.5 9.5 4.5 8.5 4.5 11" />
    </svg>
  )
}

export function TagIcon({ className = 'git-icon' }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 2h5.2L14 8.8a1.5 1.5 0 0 1 0 2.1l-3.1 3.1a1.5 1.5 0 0 1-2.1 0L2 7.2V2Z" />
      <circle cx="5.5" cy="5.5" r="0.5" fill="currentColor" />
    </svg>
  )
}
