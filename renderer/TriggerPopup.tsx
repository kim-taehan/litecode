import { useEffect, useRef } from 'react'
import type { TriggerCandidate } from '../shared/ipc.ts'
import { optionId, type Triggers } from './useTriggers.ts'
import './triggers.css'
import { useT } from './settingsStore.ts'

// 입력창 위에 뜨는 공용 트리거 메뉴 하나 — 어떤 트리거의 후보인지 모른다. 모양은 dsh ui-input-trigger MenuView 를 따른다:
// 그룹 제목 + 행(아이콘·이름·오른쪽 정렬 설명), 강조는 하나(키보드·마우스 공용), 폴더 행은 강조됐을 때 Tab 안내와 › (들어가기).
// `/` 메뉴의 줄(앱·명령·스킬, 이슈 #144 시안 B)은 그룹마다 다른 16px 선 아이콘 + `/` 를 뺀 이름 — 보이는 글만 그렇다(읽히는 이름·넣는 글은 `/이름`).
// 행은 mousedown 으로 고른다 — 포커스가 입력창을 떠나지 않게. 메뉴가 없으면 트리거의 안내(`!` 셸)나 막은 사유(모르는 `/xxx`)를 한 줄로.

/** `/` 메뉴 줄의 아이콘 — 앱: 둥근 네모 안의 +, 명령: 터미널 프롬프트, 스킬: 별 */
const SLASH_ICONS: Partial<Record<TriggerCandidate['icon'], React.ReactNode>> = {
  app: (
    <>
      <rect x="2" y="2" width="12" height="12" rx="3" />
      <path d="M5.5 8h5" />
      <path d="M8 5.5v5" />
    </>
  ),
  command: (
    <>
      <path d="M3 4.5l3.5 3.5L3 11.5" />
      <path d="M8.5 11.5H13" />
    </>
  ),
  skill: <path d="M8 2l1.7 3.9L14 6.4l-3.2 2.9.9 4.2L8 11.4l-3.7 2.1.9-4.2L2 6.4l4.3-.5z" />,
}

function Icon({ kind }: { kind: TriggerCandidate['icon'] }) {
  const slash = SLASH_ICONS[kind]
  if (slash) {
    return (
      <svg className="trigger-menu__icon trigger-menu__icon--slash" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {slash}
      </svg>
    )
  }
  const path =
    kind === 'folder' ? 'M2 4.5C2 3.67 2.67 3 3.5 3H6.3L7.8 4.5H12.5C13.33 4.5 14 5.17 14 6V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z'
    : 'M4 2.5H9.5L12 5V13.5H4V2.5ZM9.5 2.5V5H12'
  return (
    <svg className="trigger-menu__icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path d={path} />
    </svg>
  )
}

/** 줄에 보이는 이름 — `/` 메뉴 줄은 앞의 `/` 를 뺀다 (아이콘이 종류를 말한다). 파일·폴더는 그대로 */
export function slashName(candidate: Pick<TriggerCandidate, 'icon' | 'label'>): string {
  return candidate.icon !== 'file' && candidate.icon !== 'folder' && candidate.label.startsWith('/') ? candidate.label.slice(1) : candidate.label
}

export function TriggerPopup({ trigger }: { trigger: Triggers }) {
  const { query, open, active, notice } = trigger
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const dismiss = useRef(trigger.dismiss)
  dismiss.current = trigger.dismiss
  // 입력 카드 바깥을 누르면 닫는다 — 입력창·아래 줄을 누르는 것은 아니다 (dsh MenuView)
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!ref.current?.closest('.composer__box')?.contains(event.target as Node)) dismiss.current()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])
  // 포커스가 입력창에 있어 브라우저가 강조 행을 스크롤해 주지 않는다
  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' })
  }, [open, active])
  if (!open || !query) {
    const line = notice ?? query?.hint
    if (!line) return null
    return (
      <div className={`trigger-note${notice ? ' trigger-note--error' : ''}`} role={notice ? 'alert' : 'status'}>
        {line}
      </div>
    )
  }
  return (
    <div className="trigger-menu" ref={ref} role="listbox" aria-label={t('trigger.candidates')}>
      {query.candidates.map((candidate, index) => (
        <div key={candidate.id} role="presentation">
          {candidate.group && candidate.group !== query.candidates[index - 1]?.group && (
            <div className="trigger-menu__group" role="presentation">
              {candidate.group}
            </div>
          )}
          <div
            id={optionId(index)}
            role="option"
            aria-selected={index === active}
            aria-label={SLASH_ICONS[candidate.icon] ? [candidate.label, candidate.detail].filter(Boolean).join(' ') : undefined}
            className={`trigger-menu__item${index === active ? ' trigger-menu__item--active' : ''}`}
            onMouseEnter={() => trigger.setActive(index)}
            onMouseDown={(event) => {
              event.preventDefault()
              trigger.choose(index, 'pick')
            }}
          >
            <Icon kind={candidate.icon} />
            <span className={`trigger-menu__name${SLASH_ICONS[candidate.icon] ? ' trigger-menu__name--slash' : ''}`}>{slashName(candidate)}</span>
            {candidate.detail && <span className="trigger-menu__detail">{candidate.detail}</span>}
            {candidate.drill && (
              <span className="trigger-menu__drill">
                <kbd className="trigger-menu__key">Tab</kbd>
                <span
                  className="trigger-menu__chevron"
                  aria-label={t('trigger.drill')}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    trigger.choose(index, 'drill')
                  }}
                >
                  ›
                </span>
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
