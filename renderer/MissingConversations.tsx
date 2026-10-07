import { useState } from 'react'
import type { Session } from './App.tsx'
import { useT } from './settingsStore.ts'
import { TrashIcon } from './SidebarIcons.tsx'

/** 못 연(폴더가 없는) 프로젝트의 저장된 대화 — 열 수 없고 지우기만 된다. 내용을 부르지 않는다(없는 경로를 opencode 에 넘기면
 *  그 경로가 재시작 전까지 500 — 01c Q5). 지우기는 대화 목록 행과 같은 휴지통 → "삭제 확인" */
export function MissingConversations({ sessions, onRemove }: { sessions: Session[]; onRemove(session: Session): Promise<void> }) {
  const t = useT()
  const [confirming, setConfirming] = useState<string>()
  if (sessions.length === 0) return null
  return (
    <ul className="missing-list" aria-label={t('missing.list')}>
      {sessions.map((session) => (
        <li key={session.id} className="missing-list__item">
          <span className="missing-list__title">{session.title}</span>
          <span className="missing-list__note">{t('missing.note')}</span>
          {confirming === session.id ? (
            <button
              type="button"
              className="session-item__confirm"
              autoFocus
              onClick={() => void onRemove(session)}
              onBlur={() => setConfirming(undefined)}
              onKeyDown={(event) => event.key === 'Escape' && setConfirming(undefined)}
            >
              {t('sidebar.confirmDelete')}
            </button>
          ) : (
            <button type="button" className="session-item__action" aria-label={t('sidebar.deleteChat')} title={t('sidebar.deleteChat')} onClick={() => setConfirming(session.id)}>
              <TrashIcon />
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}
