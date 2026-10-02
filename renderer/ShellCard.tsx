import { useState } from 'react'
import type { ShellCard as ShellCardData } from '../shared/ipc.ts'
import { useT, type Translate } from './settingsStore.ts'
import './chat.css'

// 대화 안의 `!명령` 결과 카드 (closed-code shellRecord·TurnExtras 참조) — 명령 · 끝난 사정(종료 코드) · 고정폭 출력(길면 접기).
// 이 카드는 대화 맥락에 들어가지 않는다. "AI 에게 보내기" 를 누를 때만 맥락에 넣는다(LLM 은 안 돌고 다음 질문에 함께 실린다).
// 그 대화의 턴이 도는 동안은 막는다 — 그때 넣으면 진행 중 턴에 끼어들거나 새 턴이 저절로 돈다 (01h §4.2)

/** 화면의 카드 — 돌고 있는 동안은 running (출력이 조각으로 쌓인다) */
export type ShellCardView = ShellCardData & { running?: boolean }

const COLLAPSE_LINES = 12
const OUTPUT_KB = 100

interface ShellCardProps {
  card: ShellCardView
  /** 보내기를 막는 사유 (턴이 도는 중·모델 없음) — 없으면 보낼 수 있다 */
  shareBlocked?: string
  onStop(): void
  onShare(): Promise<string | undefined>
}

export function ShellCard({ card, shareBlocked, onStop, onShare }: ShellCardProps) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [error, setError] = useState<string>()
  const output = card.output.replace(/\n+$/, '')
  const long = output.split('\n').length > COLLAPSE_LINES
  const shared = !!card.sharedMessageId
  const state = card.running ? 'running' : card.status === 'done' ? (card.exitCode === 0 ? 'ok' : 'failed') : card.status

  return (
    <div className="shell-card" data-state={state}>
      <div className="shell-card__head">
        <span className="shell-card__prompt" aria-hidden="true">$</span>
        <code className="shell-card__command">{card.command}</code>
        <span className="shell-card__badge">{badge(t, card)}</span>
        {card.running && (
          <button type="button" className="shell-card__stop" aria-label={t('shellCard.stop')} title={t('shellCard.stop')} onClick={onStop}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect width="10" height="10" rx="1.5" fill="currentColor" />
            </svg>
          </button>
        )}
      </div>
      <pre className="shell-card__output" data-collapsed={long && !expanded ? true : undefined}>
        {output || (card.running ? '' : t('shellCard.noOutput'))}
      </pre>
      {long && (
        <button type="button" className="shell-card__more" aria-expanded={expanded} onClick={() => setExpanded((now) => !now)}>
          {expanded ? t('shellCard.collapse') : t('shellCard.expand')}
        </button>
      )}
      {card.truncated && <div className="shell-card__note">{t('shellCard.truncated', { kb: OUTPUT_KB })}</div>}
      {!card.running && (
        <div className="shell-card__foot">
          <span className="shell-card__note">{shared ? t('shellCard.sharedNote') : t('shellCard.localOnly')}</span>
          {/* 막힌 버튼은 툴팁을 못 띄워 감싼 쪽에 둔다 */}
          <span title={!shared && shareBlocked ? shareBlocked : undefined}>
            <button
              type="button"
              className="shell-card__share"
              disabled={shared || sharing || !!shareBlocked}
              onClick={() => {
                setSharing(true)
                setError(undefined)
                void onShare().then((failure) => {
                  setSharing(false)
                  setError(failure)
                })
              }}
            >
              {shared ? t('shellCard.shared') : t('shellCard.share')}
            </button>
          </span>
        </div>
      )}
      {error && (
        <div className="shell-card__error" role="alert">
          {t('shellCard.shareFailed', { reason: error })}
        </div>
      )}
    </div>
  )
}

function badge(t: Translate, card: ShellCardView): string {
  if (card.running) return t('shellCard.running')
  if (card.status === 'stopped') return t('shellCard.stopped')
  if (card.status === 'timeout') return t('shellCard.timeout', { seconds: 60 })
  if (card.status === 'error') return t('shellCard.error', { reason: card.error ?? '' })
  return card.exitCode === null ? t('shellCard.stopped') : t('shellCard.exit', { code: card.exitCode })
}
