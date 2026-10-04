import type { MessageOrigin } from '../shared/contract.ts'
import { FromIcon } from './Delegation.tsx'
import { useT } from './settingsStore.ts'
import './background.css'

// 답하는 중에 쌓인 메시지 미리보기 — 입력 카드 바로 위에 붙은 판 (dsh ui-conversation QueueDock 의 치수: 머리 36px·13/500,
// 줄 36px·13px 한 줄 말줄임, 줄 사이 0.5px 선, 위만 둥근 모서리). 되돌리기는 closed-code ComposerQueue 처럼 전체를 입력창으로.
// 턴이 끝나면 저절로 한 번에 보내지므로(ctx.chat) 줄마다의 편집·삭제는 두지 않는다. 대기열은 메인이 쥔다 — items 는 줄마다 보일 글
// (보일 글·본문, 글 없이 첨부만 쌓았으면 파일 이름 — shared/chat.ts queueLabel)
// 다른 대화가 보낸 줄 (이슈 #55 — sources 에 보낸 대화가 있는 자리): 딱지·보낸 대화 이름과 함께 보이고, 입력창으로 되돌릴 글이 아니라 "빼기" 로 뺀다.
// 되돌리기는 사람이 친 줄만 가져간다 — 사람 줄이 없으면 버튼이 없다

interface QueueDockProps {
  items: string[]
  /** items 와 같은 순서 — 그 줄을 보낸 대화 (사람이 친 줄은 null) */
  sources?: readonly (MessageOrigin | null)[]
  onRestore(): void
  onDrop(index: number): void
}

export function QueueDock({ items, sources = [], onRestore, onDrop }: QueueDockProps) {
  const t = useT()
  if (items.length === 0) return null
  return (
    <div className="queue-dock" role="region" aria-label={t('composer.queueList')}>
      <div className="queue-dock__head">
        <span className="queue-dock__count">{t('composer.queued', { count: items.length })}</span>
        {items.some((_, index) => !sources[index]) && (
          <button type="button" className="queue-dock__restore" onClick={onRestore}>
            {t('composer.queueRestore')}
          </button>
        )}
      </div>
      <ul className="queue-dock__list">
        {items.map((shown, index) => {
          const from = sources[index]
          const text = shown.replace(/\s+/g, ' ')
          if (!from) {
            return (
              <li key={index} className="queue-dock__item" title={shown}>
                {text}
              </li>
            )
          }
          return (
            <li key={index} className="queue-dock__item queue-dock__item--from" title={shown} data-from={from.conversationId}>
              <span className="queue-dock__from">
                <FromIcon label={t('delegate.queue.from')} />
                {from.title}
              </span>
              <span className="queue-dock__text">{text}</span>
              <button type="button" className="queue-dock__drop" onClick={() => onDrop(index)}>
                {t('delegate.queue.drop')}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
