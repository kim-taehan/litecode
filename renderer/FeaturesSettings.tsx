import { useState, type ReactNode } from 'react'
import { FEATURE_GROUPS, FEATURE_REQUIRES, featureDefault, featureOn, type FeatureId, type FeatureReason } from '../shared/features.ts'
import type { MessageKey } from '../shared/i18n/index.ts'
import { useFeatureStatuses } from './featuresStore.ts'
import { ALWAYS_ON_FEATURES, filterByQuery } from './featuresView.ts'
import { SessionSearch, type SearchLabels } from './SessionListTools.tsx'
import { updateSettings, useSettings, useT } from './settingsStore.ts'

// 설정 > 기능 (이슈 #8) — 한 줄에 기능 하나 (사용자 2026-10-07 "그냥 한줄에 하나씩 넣고", "상세 볼 수 있게", 시안 _workspace/mock-features
// Main·Detail). 묶음마다 둥근 테두리 목록 한 장, 줄 = 펼침 버튼(▸ + 이름 + 한 줄 요약, 말줄임) · 스위치(따로 눌리는 요소, 일반 페이지와 같은 36×20).
// 줄을 누르면 아래로 늘어나 자세한 설명(`feature.<id>.detail` — 첫 줄은 문단, 나머지 줄은 불릿)과 칩(필요한 기능 · 기본값 · 쓰는 곳)을 보인다.
// 칩의 필요·기본값은 shared/features.ts 에서 만든다(문구를 손으로 중복하지 않는다). 펼침은 화면 안 상태 — 저장하지 않고 한 번에 하나만(#251 — 줄 하나를 펼치면
// 열려 있던 줄은 접히고, 열려 있는 줄을 다시 누르면 접힌다).
// 바꾸면 곧바로 메인(ctx.settings)에 저장하고, 메인(ctx.features)이 재시작 없이 그 기능 묶음을 올리거나 내린다.
// 줄은 중분류(FEATURE_GROUPS — 작업 화면 / AI 도구 / 자동화 / 입력·연결·알림)로 나눠 묶음마다 제목 + 한 줄 설명 아래에 둔다 (사용자 결정 2026-10-06).
// 기능 상태 (이슈 #224, 시안 _workspace/mock-features/Detail 의 블루투스 줄) — 켰는데 못 뜬 기능(ctx.features 의 failed)은 스위치 앞에 빨간 알약
// "켜지 못함", 펼치면 설명 맨 위에 빨간 상자 "켜지 못한 이유 — 사유". 정상 상태(올리는 중·켜짐)엔 아무것도 달지 않는다(태그 소음 금지).
// 켜 두었는데 필요한 기능이 꺼져 못 뜬 기능은 그 필요 칩만 강조한다 — 사내망 연결(기본 켜짐)은 모바일 연결을 켜기 전까지 늘 이 상태라 줄 머리 태그는 소음이다.
// 항상 켜짐과 찾기 (이슈 #277, 보고서 _workspace/report-plugins/builtin-plugins.html 4절 — dsh ui-settings-plugin-inventory 의 찾기 참조):
// 네 소묶음 맨 아래에 접힌 "항상 켜짐"(고정된 필수 기능 FEATURE_FIXED — 스위치 없이 "항상 켜짐" 알약, 2026-10-03 에 숨겼던 것을 읽기 전용으로).
// 앱 전체(Global)/대화마다(Session) 큰 묶음과 모드 권한 표는 없앴다 (#281, 사용자 "별로다, 구분 없애자").
// 맨 위 찾기 칸(사이드바 SessionSearch 를 문구만 바꿔 쓴다)은 이름·한 줄 요약을 대소문자 무시 부분일치로 거른다 — 찾는 동안은 "항상 켜짐" 도 펼치고
// 일치하는 줄이 없는 묶음 제목은 숨긴다. 하나도 없으면 "일치하는 기능이 없습니다."

const SEARCH_LABELS: SearchLabels = { label: 'settings.features.search', placeholder: 'settings.features.searchPlaceholder', clear: 'settings.features.searchClear' }

/** 펼침 버튼 — ▸ + 이름 + 한 줄 요약. 기능 줄·항상 켜짐 줄이 같이 쓴다 */
function RowToggle({ id, open, title, summary, onToggle }: { id: string; open: boolean; title: string; summary: string; onToggle(): void }) {
  return (
    <button type="button" className="feature-row__toggle" aria-expanded={open} aria-controls={`feature-detail-${id}`} onClick={onToggle}>
      <Chevron className="feature-row__chevron" />
      <span className="feature-row__text">
        <span className="feature-row__title">{title}</span>
        <span className="feature-row__summary">{summary}</span>
      </span>
    </button>
  )
}

function Chevron({ className }: { className: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function FeaturesPage({ initialExpanded = undefined, initialQuery = '' }: { initialExpanded?: FeatureId; initialQuery?: string }) {
  const t = useT()
  const settings = useSettings()
  const statuses = useFeatureStatuses()
  const [error, setError] = useState<string>()
  const [expanded, setExpanded] = useState<FeatureId | undefined>(initialExpanded)
  const [query, setQuery] = useState(initialQuery)
  const [alwaysOnOpen, setAlwaysOnOpen] = useState(() => initialExpanded !== undefined && ALWAYS_ON_FEATURES.includes(initialExpanded))
  const stored = settings.features ?? {}
  const searching = query.trim() !== ''

  function toggle(feature: FeatureId): void {
    const next = { ...stored }
    const on = !(stored[feature] ?? featureDefault(feature))
    if (on === featureDefault(feature)) delete next[feature] // 없는 키 = 기본값 — 파일에는 기본과 다른 값만 남긴다
    else next[feature] = on
    void updateSettings({ features: next }).then(
      () => setError(undefined),
      () => setError(t('settings.saveError')),
    )
  }

  function reasonText(reason: FeatureReason): string {
    return typeof reason === 'string' ? reason : t(reason.key, reason.vars)
  }

  function toggleExpanded(row: FeatureId): void {
    // 한 번에 하나 — 열려 있던 줄은 자동으로 접히고, 이미 열린 줄을 누르면 접힌다 (#251)
    setExpanded((current) => (current === row ? undefined : row))
  }

  const featureTexts = (feature: FeatureId): string[] => [t(`feature.${feature}`), t(`feature.${feature}.description`)]
  const groups = FEATURE_GROUPS.map((group) => ({ id: group.id, features: filterByQuery(group.features, query, featureTexts) })).filter(
    (group) => group.features.length > 0,
  )
  const alwaysOn = filterByQuery(ALWAYS_ON_FEATURES, query, featureTexts)

  /** 펼친 아래의 자세한 설명 + 칩 — 고르는 기능은 기본값 칩도 단다 */
  function featureDetail(feature: FeatureId, extra: { failure?: FeatureReason; wanted?: boolean; showDefault: boolean }): ReactNode {
    const [paragraph, ...bullets] = t(`feature.${feature}.detail`).split('\n')
    return (
      <div className="feature-row__detail" id={`feature-detail-${feature}`}>
        {extra.failure !== undefined && (
          <div className="feature-row__failure" role="alert">
            <b>{t('features.status.failedReason')}</b> — {reasonText(extra.failure)}
          </div>
        )}
        <p className="feature-row__paragraph">{paragraph}</p>
        {bullets.length > 0 && (
          <ul className="feature-row__bullets">
            {bullets.map((bullet) => (
              <li key={bullet}>{bullet}</li>
            ))}
          </ul>
        )}
        <div className="feature-row__chips">
          {(FEATURE_REQUIRES[feature] ?? []).map((needed) => {
            const neededOn = featureOn(stored, needed)
            const blocked = extra.wanted === true && !neededOn
            return (
              <span
                key={needed}
                className={blocked ? 'feature-row__chip feature-row__chip--blocked' : 'feature-row__chip'}
                title={blocked ? t('features.status.blocked') : undefined}
              >
                {t(neededOn ? 'settings.features.requires' : 'settings.features.requires.off', { name: t(`feature.${needed}` as MessageKey) })}
              </span>
            )
          })}
          {extra.showDefault && <span className="feature-row__chip">{t(featureDefault(feature) ? 'settings.features.default.on' : 'settings.features.default.off')}</span>}
          <span className="feature-row__chip">{t(`feature.${feature}.where`)}</span>
        </div>
      </div>
    )
  }

  function choosableRow(feature: FeatureId): ReactNode {
    const on = featureOn(stored, feature)
    const open = expanded === feature
    const status = statuses[feature]
    const failure = status?.state === 'failed' ? status.reason : undefined
    const wanted = stored[feature] ?? featureDefault(feature) // 이 기능 스스로의 스위치 값 (필요한 기능과 무관)
    return (
      <li key={feature} className="feature-row" data-feature={feature} data-expanded={open || undefined}>
        <div className="feature-row__head">
          <RowToggle id={feature} open={open} title={t(`feature.${feature}`)} summary={t(`feature.${feature}.description`)} onToggle={() => toggleExpanded(feature)} />
          {failure !== undefined && <span className="feature-row__status feature-row__status--failed">{t('features.status.failed')}</span>}
          <button type="button" role="switch" className="settings-switch" aria-checked={on} aria-label={t(`feature.${feature}`)} onClick={() => toggle(feature)}>
            <span className="settings-switch__thumb" />
          </button>
        </div>
        {open && featureDetail(feature, { failure, wanted, showDefault: true })}
      </li>
    )
  }

  /** 필수 기능 — 스위치 대신 "항상 켜짐" 알약 */
  function alwaysOnRow(feature: FeatureId): ReactNode {
    const open = expanded === feature
    return (
      <li key={feature} className="feature-row" data-feature={feature} data-always-on="" data-expanded={open || undefined}>
        <div className="feature-row__head">
          <RowToggle id={feature} open={open} title={t(`feature.${feature}`)} summary={t(`feature.${feature}.description`)} onToggle={() => toggleExpanded(feature)} />
          <span className="feature-row__status feature-row__status--fixed">{t('settings.features.alwaysOn')}</span>
        </div>
        {open && featureDetail(feature, { showDefault: false })}
      </li>
    )
  }

  return (
    <div className="features-page">
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      <p className="features-page__intro">{t('settings.features.intro')}</p>
      <div className="features-page__search">
        <SessionSearch value={query} onChange={setQuery} labels={SEARCH_LABELS} />
      </div>
      {groups.length === 0 && alwaysOn.length === 0 && <p className="features-page__empty">{t('settings.features.noMatch')}</p>}
      {groups.map((group) => (
        <section key={group.id} className="feature-group" data-feature-group={group.id} aria-labelledby={`feature-group-${group.id}`}>
          <div className="feature-group__head">
            <h3 className="feature-group__title" id={`feature-group-${group.id}`}>
              {t(`settings.features.group.${group.id}`)}
            </h3>
            <span className="feature-group__hint">{t(`settings.features.group.${group.id}.hint`)}</span>
          </div>
          <ul className="feature-rows">{group.features.map(choosableRow)}</ul>
        </section>
      ))}
      {alwaysOn.length > 0 && (
        <section className="feature-group" data-feature-group="alwaysOn" aria-labelledby="feature-group-alwaysOn">
          <div className="feature-group__head">
            <h3 className="feature-group__title" id="feature-group-alwaysOn">
              <button
                type="button"
                className="feature-scope__toggle"
                aria-expanded={alwaysOnOpen || searching}
                disabled={searching}
                onClick={() => setAlwaysOnOpen((open) => !open)}
              >
                <Chevron className="feature-row__chevron" />
                {t('settings.features.group.alwaysOn')}
              </button>
            </h3>
            <span className="feature-group__hint">{t('settings.features.group.alwaysOn.hint')}</span>
          </div>
          {(alwaysOnOpen || searching) && <ul className="feature-rows">{alwaysOn.map(alwaysOnRow)}</ul>}
        </section>
      )}
    </div>
  )
}
