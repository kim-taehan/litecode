import { createContext, Fragment, useContext, useEffect, useState } from 'react'
import type { Mode } from '../shared/ipc.ts'
import type { MessageOrigin } from '../shared/contract.ts'
import { DEFAULT_MODE } from '../shared/modes.ts'
import { useT } from './settingsStore.ts'
import { formatDuration } from './turnView.ts'
import type { DelegationLine, Peer, ProjectTarget, TargetChoice, TargetPicker } from './delegationView.ts'
import { useNow } from './useNow.ts'
import './delegation.css'

// 다른 프로젝트에 지시 보내기의 화면 조각 (이슈 #55·#137 — 시안 _workspace/mock-delegate·mock-cross-project, 구조는 시안·부품 모양은 기존 줄·카드):
// - 보낸 대화: 진행 줄 "지시 보냄 → 프로젝트 · 대화 · 도는 중 · N초"(누르면 그 프로젝트의 그 대화로)·"결과 읽기 · … · 아직 도는 중", 승인 카드의 내용
// - 받는 대화: 내 말 자리 위의 "다른 프로젝트에서 온 지시 · 보낸 프로젝트 · 보낸 대화" 딱지(누르면 그 대화로)
// 저장된 대화(제목·상태·모드)·다른 프로젝트의 받을 대화·대화 열기는 App 이 컨텍스트로 준다 — 진행 줄은 깊이 있어 속성으로 내려보내지 않는다

export interface DelegationValue {
  /** 저장된 대화 전부 (모든 프로젝트) */
  peers: readonly Peer[]
  /** 프로젝트마다 사용자가 마지막에 보던 대화 하나 — 지시를 받는 곳 (#351: 지금 프로젝트 포함) */
  targets: readonly ProjectTarget[]
  /** 지금 보는 대화의 모드(받는 대화의 모드와 견른다)·지금 프로젝트의 이름·지금 대화의 id (카드에서 "이 대화" 를 빼는 것) */
  self: { mode: Mode; project?: string; id?: string }
  /** 그 대화를 연다 — 다른 프로젝트의 대화면 그 프로젝트로 넘어간다 */
  open(conversationId: string): void
}

export const DelegationContext = createContext<DelegationValue>({ peers: [], targets: [], self: { mode: DEFAULT_MODE }, open: () => {} })

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

/** 받는 대화의 내 말 자리 위 딱지 — 누르면 보낸 대화로 (지워졌으면 적어 둔 제목만 보인다).
 *  "다른 프로젝트에서 온 지시" 는 보낸 쪽이 **다른** 프로젝트일 때만 — 같은 프로젝트의 대화가 보낸 것은 "다른 대화에서 온 지시" (#351) */
export function OriginTag({ origin }: { origin: MessageOrigin }) {
  const t = useT()
  const { peers, self, open } = useDelegation()
  const peer = peers.find((candidate) => candidate.id === origin.conversationId)
  const title = peer?.title || origin.title
  // 보낸 프로젝트 이름이 없는 것은 같은 프로젝트의 대화가 보낸 옛 기록이다 (이슈 #137 전). 이름이 지금 프로젝트와 같으면(#351)도 같은 프로젝트
  const fromProject = origin.project
  const crossProject = fromProject !== undefined && fromProject !== self.project
  const label = crossProject ? t('delegate.fromProject', { project: fromProject, title }) : t('delegate.from', { title })
  return (
    <button type="button" className="origin-tag" disabled={!peer} onClick={() => peer && open(peer.id)}>
      <FromIcon />
      {label}
    </button>
  )
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.5 4.5v8h13v-7h-6l-1.5-2h-5.5z" />
    </svg>
  )
}

/** 승인 카드의 내용 (이슈 #67·#137·#348·#351 — 시안 _workspace/mock-cross-project) — 받을 **프로젝트와 그 대화**를 사용자가 고른다:
 *  프로젝트 줄(폴더·이름·경로) 아래 그 프로젝트의 "**새 대화**" 줄 + 대화 목록(라디오, 최근 활동 순 · 상한, 넘어간 대話は "N개 더 보기" 로
 *  접혀 있다, AI 가 고른 곳의 마지막에 보던 대화가 먼저 선택), 안내 한 줄, 보낼 글 전문, 고른 곳의 폴더·모드 경고 상자.
 *  "대기열에 들어갑니다" 는 줄마다 보인다. 틀(주황 띠·버튼)은 Attention.tsx 의 승인 카드 (카드가 요청 id 로 keyed 라 새 요청이면 여기 상태도 다시 시작) */
export function TargetPickerBody({ picker, selected, disabled, onSelect }: { picker: TargetPicker; selected: string | undefined; disabled: boolean; onSelect(key: string): void }) {
  const t = useT()
  const { self } = useDelegation()
  const chosen = picker.choices.find((choice) => choice.key === selected)
  // 상한(PICK_CONVERSATION_LIMIT)을 넘어 접힌 대화 펼치기 (#351) — 프로젝트 id 로. 새 요청은 카드가 다시 태어나 이 상태도 비어 시작한다
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const toggle = (projectId: string): void =>
    setExpanded((now) => {
      const next = new Set(now)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  const foldedByProject = new Map<string, number>()
  for (const choice of picker.choices) if (choice.folded) foldedByProject.set(choice.projectId, (foldedByProject.get(choice.projectId) ?? 0) + 1)
  // 프로젝트 그룹 — 접힌 줄(hidden)은 펼칠 때까지 목록에 안 넣는다
  const groups: { project: { name: string; displayPath: string }; projectId: string; rows: TargetChoice[]; hidden: number }[] = []
  for (const choice of picker.choices) {
    const last = groups[groups.length - 1]
    if (!last || last.projectId !== choice.projectId) groups.push({ project: choice.project, projectId: choice.projectId, rows: [], hidden: 0 })
    const group = groups[groups.length - 1]!
    if (choice.folded && !expanded.has(choice.projectId)) group.hidden++
    else group.rows.push(choice)
  }
  // 폴더 경로만 굵게 — 번역 글의 {folder} 자리에서 가른다. 새 대화면 그 프로젝트의 대화 모드가 아니라 새 대화 문장
  const warn = chosen && (chosen.newConversation ? t('delegate.pick.warnNew', { folder: '\u0000', mode: t(`mode.${chosen.mode ?? DEFAULT_MODE}`) }) : t('delegate.pick.warn', { folder: '\u0000', mode: t(`mode.${chosen.mode ?? DEFAULT_MODE}`) }))
  const [before = '', after = ''] = warn ? warn.split('\u0000') : []
  return (
    <>
      <div className="attention-card__headline">{t('delegate.card.send')}</div>
      <div className="target-picker__label">{t('delegate.pick.head')}</div>
      {picker.missing !== undefined && (
        <div className="target-picker__missing" role="alert">
          {t('delegate.pick.missing', { id: picker.missing })}
        </div>
      )}
      {picker.choices.length > 0 && (
        <div className="target-picker" role="radiogroup" aria-label={t('delegate.pick.head')}>
          {groups.map((group) => (
            <Fragment key={group.projectId}>
              <div className="target-picker__project">
                <FolderIcon />
                <span className="target-picker__project-name">{group.project.name}</span>
                <span className="target-picker__project-path">{group.project.displayPath}</span>
              </div>
              {group.rows.map((choice) => {
                const title = choice.newConversation ? t('delegate.pick.newConversation') : choice.title
                return (
                  <button
                    key={choice.key}
                    type="button"
                    role="radio"
                    className="target-picker__row"
                    aria-checked={choice.key === selected}
                    aria-label={`${group.project.name} · ${title}`}
                    data-target={choice.key}
                    disabled={disabled}
                    onClick={() => onSelect(choice.key)}
                  >
                    <span className="target-picker__dot" aria-hidden="true" />
                    <span className="target-picker__title">{title}</span>
                    {choice.byAi && <span className="target-picker__ai">{t('delegate.pick.byAi')}</span>}
                    {choice.lastViewed && <span className="target-picker__last">{t('delegate.pick.lastViewed')}</span>}
                    <span className="target-picker__meta" data-wider={choice.wider || undefined} title={choice.wider ? t('delegate.card.modeWider') : undefined}>
                      {[choice.mode && t(`mode.${choice.mode}`), !choice.newConversation && (choice.busy ? t('delegate.card.targetBusy') : t('delegate.pick.idle'))].filter(Boolean).join(' · ')}
                    </span>
                  </button>
                )
              })}
              {(foldedByProject.get(group.projectId) ?? 0) > 0 && (
                <button type="button" className="target-picker__more" disabled={disabled} onClick={() => toggle(group.projectId)}>
                  {expanded.has(group.projectId) ? t('delegate.pick.less') : t('delegate.pick.more', { count: group.hidden })}
                </button>
              )}
            </Fragment>
          ))}
        </div>
      )}
      <div className="target-picker__hint">{self.project ? t('delegate.pick.hint', { project: self.project }) : t('delegate.pick.hintNoName')}</div>
      <div className="target-picker__label">{t('delegate.pick.message')}</div>
      <div className="delegation-card__message">{picker.message}</div>
      {chosen && (
        <div className="target-picker__warn">
          {before}
          <b>{chosen.project.displayPath}</b>
          {after}
        </div>
      )}
    </>
  )
}
