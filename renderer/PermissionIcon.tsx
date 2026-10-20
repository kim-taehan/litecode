import type { ExtensionPermission } from '../shared/extensions.ts'

/** 확장 권한 아이콘 (이슈 #536, 시안 _workspace/mock-sonarqube-ext Confirm·Ask) — network: 지구 · secrets: 자물쇠 · project: 폴더 · server: 서버 상자(#537).
 *  설치 확인의 권한 줄과 확장 탭의 동의 띠(지구)가 같이 쓴다 */
export function PermissionIcon({ permission, className }: { permission: ExtensionPermission; className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {permission === 'network' ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18" />
        </>
      ) : permission === 'secrets' ? (
        <>
          <rect x="5" y="11" width="14" height="10" rx="2" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </>
      ) : permission === 'server' ? (
        <>
          <rect x="4" y="4" width="16" height="7" rx="1.5" />
          <rect x="4" y="13" width="16" height="7" rx="1.5" />
          <path d="M8 7.5h.01M8 16.5h.01" />
        </>
      ) : (
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      )}
    </svg>
  )
}
