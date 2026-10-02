import type { CompactionItem } from './compaction.ts'
import { useT } from './settingsStore.ts'
import './compaction.css'

// 자동 요약 표시 (01o): 도는 동안 턴 안에 "앞 대화 요약 중" 줄, 끝나면 "앞 대화를 요약했습니다" 구분선. 요약이 실패하면
// (ended 없이 스텝이 이어짐) 아무것도 남기지 않는다 — 턴은 원래 요청으로 그대로 간다

export function CompactionMark({ item }: { item: CompactionItem }) {
  const t = useT()
  if (item.status === 'failed') return null
  if (item.status === 'running') {
    return (
      <div className="compaction-running" role="status">
        <span className="compaction-running__text">{t('chat.compacting')}</span>
      </div>
    )
  }
  return (
    <div className="compaction-divider" role="separator">
      {t('chat.compacted')}
    </div>
  )
}
