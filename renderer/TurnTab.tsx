import { useLayoutEffect, useRef } from 'react'
import { CompactionMark } from './Compaction.tsx'
import { WorkRow } from './ChatTurn.tsx'
import { useT } from './settingsStore.ts'
import { useTurnDetail } from './turnDetailStore.ts'
import { formatDuration, turnHeadText } from './turnView.ts'
import { useNow } from './useNow.ts'
import './turnTab.css'

// 오른쪽 패널 "이 턴의 작업" 탭 (이슈 #416) — 도는 턴의 전체 진행(생각·도구·글 줄)을 실시간으로, 턴이 끝나도 닫힌 채 남는다.
// 데이터는 채팅의 진행 줄과 같은 출처(turnDetailStore — 채팅 이벤트로 이어 붙는다, 다시 뜨면 스냅샷). 줄은 채팅의 작업 줄과
// 같은 컴포넌트(WorkRow)로 그리므로 안에 들어 있는 모습과 같다. 맨 아래를 보고 있으면 따라 내려간다 (TaskTab 과 같은 길)

export function TurnTab({ conversationId, startedAt, directory }: { conversationId: string; startedAt: number; directory: string }) {
  const t = useT()
  const detail = useTurnDetail(conversationId, startedAt)
  const live = detail !== undefined && detail.endedAt === undefined
  const now = useNow(live)
  const body = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  // 이어 붙을 때 맨 아래를 보고 있었으면 따라 내려간다 — 위로 올려 읽는 중이면 그대로
  useLayoutEffect(() => {
    const element = body.current
    if (element && atBottom.current) element.scrollTop = element.scrollHeight
  }, [detail?.items, live])

  if (detail === undefined) {
    return (
      <div className="turn-tab">
        <p className="file-preview__empty">{t('turnTab.gone')}</p>
      </div>
    )
  }
  const state = live ? 'running' : detail.interrupted ? 'interrupted' : detail.failed ? 'failed' : 'done'
  const head = live
    ? startedAt === undefined
      ? t('chat.working')
      : t('chat.workingFor', { duration: formatDuration(t, now - startedAt) })
    : turnHeadText(t, detail.duration, !!detail.failed, detail.interrupted, detail.declined)

  return (
    <div className="turn-tab" data-state={state}>
      <div className="turn-tab__head">
        <span className="turn-tab__dot" aria-hidden="true" />
        <strong className="turn-tab__title">{head}</strong>
      </div>
      <div
        ref={body}
        className="turn-tab__body"
        onScroll={(event) => {
          const element = event.currentTarget
          atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
        }}
      >
        {detail.items.length === 0 ? (
          <p className="file-preview__empty">{t('chat.working')}</p>
        ) : (
          <div className="turn__work turn-tab__work">
            {detail.items.map((item) =>
              item.kind === 'compaction' ? <CompactionMark key={item.id} item={item} /> : <WorkRow key={item.id} item={item} directory={directory} turnRunning={live} />,
            )}
          </div>
        )}
      </div>
    </div>
  )
}
