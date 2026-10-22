import { useLayoutEffect, useRef } from 'react'
import { CompactionMark } from './Compaction.tsx'
import { WorkRow } from './ChatTurn.tsx'
import { useT } from './settingsStore.ts'
import { useTurnDetail } from './turnDetailStore.ts'
import { formatDuration, turnHeadText } from './turnView.ts'
import { useNow } from './useNow.ts'
import './turnTab.css'

// 오른쪽 패널 "턴 작업" 탭 (이슈 #416) — 도는 턴의 전체 진행(생각·도구·글 줄)을 실시간으로, 턴이 끝나도 닫힌 채 남는다.
// 데이터는 채팅의 진행 줄과 같은 출처(turnDetailStore — 채팅 이벤트로 이어 붙는다, 다시 뜨면 스냅샷). 줄은 채팅의 작업 줄과
// 같은 컴포넌트(WorkRow)로 그리므로 안에 들어 있는 모습과 같다. 맨 아래를 보고 있으면 따라 내려간다 (TaskTab 과 같은 길)

export function TurnTab({ conversationId, startedAt, directory, title, here, onJump }: { conversationId: string; startedAt: number; directory: string; title?: string; here?: boolean; onJump?: () => void }) {
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
      {/* 머리 (이슈 #462 시안 C) — 위: 내 질문, 아래: 상태 칩(점+작업 중)과 이 턴이 속한 대화 */}
      <div className="turn-tab__head turn-tab__head--c">
        {/* 그 턴을 시작한 내 말 — 없으면(첨부만·오래된 기록) 라벨 없이 질문만 */}
        {detail.userQuery && (
          <div className="turn-tab__query" role="note">
            <span className="turn-tab__query-label">{t('turnTab.query')}</span>
            <span className="turn-tab__query-text">{detail.userQuery}</span>
          </div>
        )}
        <div className="turn-tab__bar">
          <span className="turn-tab__chip" aria-label={head}>
            <span className="turn-tab__dot" aria-hidden="true" />
            <span className="turn-tab__chip-text">{head}</span>
          </span>
          {/* 이 턴이 속한 대화 (이슈 #462) — 다른 대화면 눌러 그 대화로 이동, 지금 보는 대화면 화살표 없이 제목만 */}
          {title !== undefined && title !== '' && (
            here ? (
              <div className="turn-tab__conv" role="note">
                <ChatIcon className="turn-tab__conv-icon" />
                <span className="turn-tab__conv-name">{title}</span>
              </div>
            ) : (
              <button type="button" className="turn-tab__conv turn-tab__conv--other" title={t('turnTab.jumpTo')} aria-label={`${t('turnTab.jumpTo')} — ${title}`} onClick={onJump}>
                <ChatIcon className="turn-tab__conv-icon" />
                <span className="turn-tab__conv-name">{title}</span>
                <span className="turn-tab__conv-arrow" aria-hidden="true">
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2.5 8H12.5M9 4.5L12.5 8L9 11.5" />
                  </svg>
                </span>
              </button>
            )
          )}
        </div>
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

/** 대화 줄의 말풍선 (이슈 #462) */
function ChatIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3.25H13C13.8 3.25 14.25 3.7 14.25 4.5V9C14.25 9.8 13.8 10.25 13 10.25H7.5L4.5 12.75V10.25H3C2.2 10.25 1.75 9.8 1.75 9V4.5C1.75 3.7 2.2 3.25 3 3.25Z" />
    </svg>
  )
}
