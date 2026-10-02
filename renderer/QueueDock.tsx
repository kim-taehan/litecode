import type { QueuedSend } from './useSendQueue.ts'
import { useT } from './settingsStore.ts'
import './background.css'

// 답하는 중에 쌓인 메시지 미리보기 — 입력 카드 바로 위에 붙은 판 (dsh ui-conversation QueueDock 의 치수: 머리 36px·13/500,
// 줄 36px·13px 한 줄 말줄임, 줄 사이 0.5px 선, 위만 둥근 모서리). 되돌리기는 closed-code ComposerQueue 처럼 전체를 입력창으로.
// 턴이 끝나면 저절로 한 번에 보내지므로(useSendQueue) 줄마다의 편집·삭제는 두지 않는다

export function QueueDock({ items, onRestore }: { items: QueuedSend[]; onRestore(): void }) {
  const t = useT()
  if (items.length === 0) return null
  return (
    <div className="queue-dock" role="region" aria-label={t('composer.queueList')}>
      <div className="queue-dock__head">
        <span className="queue-dock__count">{t('composer.queued', { count: items.length })}</span>
        <button type="button" className="queue-dock__restore" onClick={onRestore}>
          {t('composer.queueRestore')}
        </button>
      </div>
      <ul className="queue-dock__list">
        {items.map((item, index) => {
          const shown = item.display ?? item.text
          return (
            <li key={index} className="queue-dock__item" title={shown}>
              {shown.replace(/\s+/g, ' ')}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
