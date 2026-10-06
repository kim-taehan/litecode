import { useState } from 'react'
import { TOOL_HOOK_EVENTS } from '../shared/hooks.ts'
import { SECRET_MASK, type MakeScope } from '../shared/make.ts'
import { useT } from './settingsStore.ts'
import { useDelegation } from './Delegation.tsx'
import type { MakeCard } from './makeView.ts'
import './make.css'

// 만들기 도구(스킬·MCP 서버·훅, 이슈 #145)의 승인 카드 내용 (시안 _workspace/mock-make) — 무엇을 등록하는지 전부 보이고, 저장할 곳을 사용자가
// 고른다(AI 가 준 곳이 먼저 선택). 틀(주황 띠·버튼)은 Attention.tsx 의 승인 카드, 라디오 줄·경고 상자는 보내기 카드(delegation.css)의 것을 쓴다

const SCOPES: readonly MakeScope[] = ['project', 'all']

function Field({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <>
      <span className="make-card__label">{label}</span>
      <span className="make-card__value" data-mono={mono || undefined}>
        {children}
      </span>
    </>
  )
}

function SkillDetail({ card }: { card: Extract<MakeCard, { kind: 'skill' }> }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <div className="make-card__box make-card__box--stack">
      <div className="make-card__name">{card.name}</div>
      <div className="make-card__description">{card.description}</div>
      <div className="make-card__body" data-open={open || undefined}>
        {open ? card.body : card.more > 0 ? `${card.preview}\n${t('make.skill.more', { count: card.more })}` : card.preview}
      </div>
      {card.more > 0 && (
        <button type="button" className="make-card__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? t('make.skill.hideBody') : t('make.skill.showBody')}
        </button>
      )}
    </div>
  )
}

function McpDetail({ card }: { card: Extract<MakeCard, { kind: 'mcp' }> }) {
  const t = useT()
  return (
    <div className="make-card__box make-card__box--grid">
      <Field label={t('mcp.name')}>
        <b>{card.name}</b>
      </Field>
      <Field label={t('mcp.type')}>{t(`make.mcp.type.${card.type}`)}</Field>
      <Field label={card.type === 'remote' ? t('mcp.url') : t('mcp.command')} mono>
        {card.target}
      </Field>
      {card.vars.length > 0 && (
        <Field label={card.type === 'remote' ? t('mcp.headers') : t('mcp.env')} mono>
          {card.vars.map((entry) => (
            <span key={entry.name} className="make-card__var">
              {entry.name}: {entry.secret ? <span className="make-card__secret">{`${SECRET_MASK} ${t('make.mcp.secret')}`}</span> : entry.value}
            </span>
          ))}
        </Field>
      )}
    </div>
  )
}

function HookDetail({ card }: { card: Extract<MakeCard, { kind: 'hook' }> }) {
  const t = useT()
  return (
    <div className="make-card__box make-card__box--grid">
      <Field label={t('make.hook.when')}>
        <b>{t(`hooks.event.${card.event}`)}</b> <span className="make-card__secret">({card.event})</span>
      </Field>
      {TOOL_HOOK_EVENTS.includes(card.event) && (
        <Field label={t('make.hook.tool')} mono>
          {card.matcher || t('hooks.popup.matcherAll')}
        </Field>
      )}
      <Field label={t('make.hook.command')} mono>
        <span className="make-card__command">{card.command}</span>
      </Field>
    </div>
  )
}

/** 라디오 줄 오른쪽의 설명 — 그 자리에 고르면 어디에 저장되나 */
function useScopeMeta(card: MakeCard): Record<MakeScope, string | undefined> {
  const t = useT()
  const { self } = useDelegation()
  if (card.kind === 'skill') return { project: card.file, all: t('make.skill.all') }
  if (card.kind === 'mcp') return { project: card.inApp ? t('make.mcp.project.inApp') : '.mcp.json', all: t('make.mcp.all') }
  return { project: self.project, all: undefined }
}

export function MakeBody({ card, scope, disabled, onScope }: { card: MakeCard; scope: MakeScope; disabled: boolean; onScope(scope: MakeScope): void }) {
  const t = useT()
  const meta = useScopeMeta(card)
  return (
    <>
      <div className="attention-card__headline">{t(`make.${card.kind}.head`)}</div>
      {card.kind === 'skill' ? <SkillDetail card={card} /> : card.kind === 'mcp' ? <McpDetail card={card} /> : <HookDetail card={card} />}
      <div className="target-picker__label">{t(`make.${card.kind}.scope`)}</div>
      <div className="target-picker" role="radiogroup" aria-label={t(`make.${card.kind}.scope`)}>
        {SCOPES.map((value) => (
          <button key={value} type="button" role="radio" className="target-picker__row" aria-checked={value === scope} data-scope={value} disabled={disabled} onClick={() => onScope(value)}>
            <span className="target-picker__dot" aria-hidden="true" />
            <span className="target-picker__title">{t(`plus.scope.${value}`)}</span>
            {meta[value] && <span className="target-picker__meta make-card__where">{meta[value]}</span>}
          </button>
        ))}
      </div>
      {card.kind === 'mcp' && (
        <div className="target-picker__warn" role="note">
          {t('make.mcp.warn')}
          {card.type === 'local' && ` ${t('make.mcp.warnLocal')}`}
        </div>
      )}
      {card.kind === 'hook' && (
        <div className="target-picker__warn" role="note">
          {t('make.hook.warn')}
        </div>
      )}
    </>
  )
}
