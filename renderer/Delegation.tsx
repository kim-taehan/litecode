import { createContext, useContext, useEffect, useState } from 'react'
import type { Mode } from '../shared/ipc.ts'
import type { MessageOrigin } from '../shared/contract.ts'
import { DEFAULT_MODE } from '../shared/modes.ts'
import { useT } from './settingsStore.ts'
import { formatDuration } from './turnView.ts'
import { NEW_TARGET, type DelegationLine, type Peer, type TargetPicker } from './delegationView.ts'
import './delegation.css'

// 다른 대화에 지시 보내기의 화면 조각 (이슈 #55 — 시안 _workspace/mock-delegate, 구조는 시안·부품 모양은 기존 줄·카드):
// - 보낸 대화: 진행 줄 "지시 보냄 → 제목 · 도는 중 · N초"(제목을 누르면 그 대화로)·"결과 읽기 · 제목 · 아직 도는 중", 승인 카드의 내용
// - 받는 대화: 내 말 자리 위의 "다른 대화에서 온 지시 · 보낸 대화" 딱지(누르면 그 대화로)
// 같은 프로젝트의 대화 목록(제목·상태·모드)과 대화 열기는 App 이 컨텍스트로 준다 — 진행 줄은 깊이 있어 속성으로 내려보내지 않는다

export interface DelegationValue {
  /** 같은 프로젝트의 (저장된) 대화 */
  peers: readonly Peer[]
  /** 지금 보는 대화 — 승인 카드의 받을 대화 목록에서 빼고(id), 받는 대화의 모드와 견준다 */
  self: { id?: string; mode: Mode }
  open(conversationId: string): void
}

export const DelegationContext = createContext<DelegationValue>({ peers: [], self: { mode: DEFAULT_MODE }, open: () => {} })

export function useDelegation(): DelegationValue {
  return useContext(DelegationContext)
}

/** 다른 대화에서 왔다 — 되돌아 나가는 화살표 (시안의 딱지·사이드바·대기열 줄이 같은 것을 쓴다) */
export function FromIcon({ size = 13, label }: { size?: number; label?: string }) {
  return (
    <svg className="delegation-icon" width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <path d="M2 4h7a3 3 0 0 1 0 6H5" />
      <path d="M7 7.5L4.5 10 7 12.5" />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg className="turn-row__icon" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 7h9" />
      <path d="M8 4l3 3-3 3" />
    </svg>
  )
}

function ReadIcon() {
  return (
    <svg className="turn-row__icon" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="7" cy="7" r="5" />
      <path d="M7 4.5V7l1.8 1.2" />
    </svg>
  )
}

/** 1초마다 지금 시각 — on 일 때만 돈다 (ChatTurn 의 useNow 와 같다. 그 파일이 이 파일을 쓰므로 여기 따로 둔다) */
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [on])
  return now
}

/** 그 대화로 가는 제목 — 대화가 지워졌으면 글자만 */
function Target({ title, targetId }: { title: string; targetId?: string }) {
  const { open } = useDelegation()
  if (!targetId) return <span className="delegation-row__target">{title}</span>
  return (
    <button type="button" className="delegation-row__target delegation-row__target--link" onClick={() => open(targetId)}>
      {title}
    </button>
  )
}

/** 보낸 대화의 진행 줄 — 받는 대화의 지금 상태를 따라간다 (도는 중이면 그 턴의 초가 오른다) */
export function DelegationRow({ line }: { line: DelegationLine }) {
  const t = useT()
  const running = line.kind === 'sent' && line.state === 'running' && line.startedAt !== undefined
  const now = useNow(running)
  if (line.kind === 'read') {
    return (
      <div className="turn-row delegation-row" data-kind="delegation-read" data-state={line.state}>
        <div className="turn-row__line">
          <ReadIcon />
          <span className="turn-row__title">{t('delegate.read')}</span>
          <span className="turn-row__dot" aria-hidden="true" />
          <Target title={line.title} targetId={line.targetId} />
          <span className="turn-row__dot" aria-hidden="true" />
          <span className="delegation-row__state">{t(`delegate.read.${line.state}`)}</span>
        </div>
      </div>
    )
  }
  return (
    <div className="turn-row delegation-row" data-kind="delegation-sent" data-state={line.state}>
      <div className="turn-row__line">
        <SendIcon />
        <span className="turn-row__title">{t('delegate.sent')}</span>
        <Target title={line.title} targetId={line.targetId} />
        <span className="delegation-row__state">
          {running ? t('delegate.state.runningFor', { duration: formatDuration(t, now - line.startedAt!) }) : t(`delegate.state.${line.state}`)}
        </span>
      </div>
    </div>
  )
}

/** 받는 대화의 내 말 자리 위 딱지 — 누르면 보낸 대화로 (지워졌으면 적어 둔 제목만 보인다) */
export function OriginTag({ origin }: { origin: MessageOrigin }) {
  const t = useT()
  const { peers, open } = useDelegation()
  const peer = peers.find((candidate) => candidate.id === origin.conversationId)
  const label = t('delegate.from', { title: peer?.title || origin.title })
  return (
    <button type="button" className="origin-tag" disabled={!peer} onClick={() => peer && open(peer.id)}>
      <FromIcon />
      {label}
    </button>
  )
}

/** 승인 카드의 내용 (이슈 #67 — 시안 _workspace/mock-delegate/Pick) — 받을 대화를 사용자가 고른다: 대화 목록(라디오, AI 가 고른 줄이 먼저 선택),
 *  맨 아래 "새 대화를 만들어 보내기", 보낼 글 전문. 모드 경고·"대기열에 들어갑니다" 는 줄마다 보인다. 틀(주황 띠·버튼)은 Attention.tsx 의 승인 카드 */
export function TargetPickerBody({ picker, selected, disabled, onSelect }: { picker: TargetPicker; selected: string | undefined; disabled: boolean; onSelect(key: string): void }) {
  const t = useT()
  return (
    <>
      <div className="attention-card__headline">{t('delegate.card.send')}</div>
      <div className="target-picker__label">{t('delegate.pick.head')}</div>
      {picker.missing !== undefined && (
        <div className="target-picker__missing" role="alert">
          {t('delegate.pick.missing', { id: picker.missing })}
        </div>
      )}
      <div className="target-picker" role="radiogroup" aria-label={t('delegate.pick.head')}>
        {picker.choices.map((choice) => {
          const fresh = choice.key === NEW_TARGET
          const state = fresh ? t('delegate.pick.newMeta') : [choice.mode && t(`mode.${choice.mode}`), choice.busy ? t('delegate.card.targetBusy') : t('delegate.pick.idle')].filter(Boolean).join(' · ')
          return (
            <button
              key={choice.key}
              type="button"
              role="radio"
              className="target-picker__row"
              aria-checked={choice.key === selected}
              data-target={choice.key}
              disabled={disabled}
              onClick={() => onSelect(choice.key)}
            >
              <span className="target-picker__dot" aria-hidden="true" />
              <span className="target-picker__title">{fresh ? [t('delegate.pick.new'), choice.title].filter(Boolean).join(' · ') : choice.title}</span>
              {choice.byAi && <span className="target-picker__ai">{t('delegate.pick.byAi')}</span>}
              <span className="target-picker__meta" data-wider={choice.wider || undefined} title={choice.wider ? t('delegate.card.modeWider') : undefined}>
                {state}
              </span>
            </button>
          )
        })}
      </div>
      <div className="target-picker__label">{t('delegate.pick.message')}</div>
      <div className="delegation-card__message">{picker.message}</div>
    </>
  )
}
