import { useState, type ReactNode } from 'react'
import { speechLanguage, type SpeechLanguage } from '../shared/speech.ts'
import { LANGUAGES } from '../shared/i18n/index.ts'
import { OptionSelect } from './GeneralSettings.tsx'
import { NOTIFY_CHANNELS, channelsOn, type NotifyChannel, type NotifyChannels } from '../shared/notifyChannels.ts'
import { FEATURE_REQUIRES, featureDefault, featureOn, type ChoosableFeatureId, type FeatureReason } from '../shared/features.ts'
import type { MessageKey } from '../shared/i18n/index.ts'
import { useFeatureStatuses } from './featuresStore.ts'
import { FeatureIcon } from './featureIcons.tsx'
import { FEATURE_ROWS, filterByQuery } from './featuresView.ts'
import { SessionSearch, type SearchLabels } from './SessionListTools.tsx'
import { updateSettings, useSettings, useT } from './settingsStore.ts'
import { ExtensionAddButton, ExtensionsNotice, ExtensionsSection } from './ExtensionsSettings.tsx'
import { useExtensions } from './extensionsStore.ts'
import { filterExtensions } from './extensionsView.ts'

// 설정 > 기능 (이슈 #8) — 한 줄에 기능 하나 (사용자 2026-10-07 "그냥 한줄에 하나씩 넣고", "상세 볼 수 있게", 시안 _workspace/mock-features
// Main·Detail). 묶음마다 둥근 테두리 목록 한 장, 줄 = 펼침 버튼(▸ + 이름 + 한 줄 요약, 말줄임) · 스위치(따로 눌리는 요소, 일반 페이지와 같은 36×20).
// 줄을 누르면 아래로 늘어나 자세한 설명(`feature.<id>.detail` — 첫 줄은 문단, 나머지 줄은 불릿)과 칩(필요한 기능 · 기본값 · 쓰는 곳)을 보인다.
// 칩의 필요·기본값은 shared/features.ts 에서 만든다(문구를 손으로 중복하지 않는다). 펼침은 화면 안 상태 — 저장하지 않고 한 번에 하나만(#251 — 줄 하나를 펼치면
// 열려 있던 줄은 접히고, 열려 있는 줄을 다시 누르면 접힌다).
// 바꾸면 곧바로 메인(ctx.settings)에 저장하고, 메인(ctx.features)이 재시작 없이 그 기능 묶음을 올리거나 내린다.
// 줄은 둥근 테두리 목록 한 장에 평평하게 놓는다 (#302, 사용자 "작업 화면, ai 도구 등으로 구분하지 말고 뱃지로") — 중분류(FEATURE_GROUPS) 순서대로 이어 붙이고,
// 묶음 이름은 줄 첫 줄의 이름 옆 회색 알약 뱃지. 줄 = 두 줄(이름 + 뱃지 / 한 줄 요약) + 오른쪽 스위치.
// 기능 상태 (이슈 #224, 시안 _workspace/mock-features/Detail 의 블루투스 줄) — 켰는데 못 뜬 기능(ctx.features 의 failed)은 스위치 앞에 빨간 알약
// "켜지 못함", 펼치면 설명 맨 위에 빨간 상자 "켜지 못한 이유 — 사유". 정상 상태(올리는 중·켜짐)엔 아무것도 달지 않는다(태그 소음 금지).
// 켜 두었는데 필요한 기능이 꺼져 못 뜬 기능은 그 필요 칩만 강조한다 — 사내망 연결(기본 켜짐)은 모바일 연결을 켜기 전까지 늘 이 상태라 줄 머리 태그는 소음이다.
// 찾기 (이슈 #277, 보고서 _workspace/report-plugins/builtin-plugins.html 4절 — dsh ui-settings-plugin-inventory 의 찾기 참조):
// 고정된 필수 기능(FEATURE_FIXED)은 줄이 없다 (#302, 사용자 "애들은 그냥 안 보여도 될 것 같아" — #277 의 접힌 "항상 켜짐" 구역을 뺐다).
// 앱 전체(Global)/대화마다(Session) 큰 묶음과 모드 권한 표는 없앴다 (#281, 사용자 "별로다, 구분 없애자").
// 맨 위 찾기 칸(사이드바 SessionSearch 를 문구만 바꿔 쓴다)은 이름·한 줄 요약·뱃지 이름을 대소문자 무시 부분일치로 거른다. 하나도 없으면 "일치하는 기능이 없습니다."
// 설치한 확장 (이슈 #489) — 찾기 칸 옆 [확장 추가 (zip)], 보류가 있으면 노란 배너, 기능 카드 아래 "설치한 확장" 카드. 찾기는 확장도 거른다 (ExtensionsSettings.tsx)

const SEARCH_LABELS: SearchLabels = { label: 'settings.features.search', placeholder: 'settings.features.searchPlaceholder', clear: 'settings.features.searchClear' }

/** 펼침 버튼 — 아이콘 칸 + 두 줄(이름 + 묶음 뱃지 / 한 줄 요약) */
function RowToggle({ id, feature, open, title, badge, summary, onToggle }: { id: string; feature: ChoosableFeatureId; open: boolean; title: string; badge: string; summary: string; onToggle(): void }) {
  return (
    <button type="button" className="feature-row__toggle" aria-expanded={open} aria-controls={`feature-detail-${id}`} onClick={onToggle}>
      <span className="feature-row__tile"><FeatureIcon feature={feature} /></span>
      <span className="feature-row__text">
        <span className="feature-row__line">
          <span className="feature-row__title">{title}</span>
          <span className="feature-row__badge">{badge}</span>
        </span>
        <span className="feature-row__summary">{summary}</span>
      </span>
    </button>
  )
}

export function FeaturesPage({ initialExpanded = undefined, initialQuery = '' }: { initialExpanded?: ChoosableFeatureId; initialQuery?: string }) {
  const t = useT()
  const settings = useSettings()
  const statuses = useFeatureStatuses()
  const [error, setError] = useState<string>()
  const [expanded, setExpanded] = useState<ChoosableFeatureId | undefined>(initialExpanded)
  const [query, setQuery] = useState(initialQuery)
  const stored = settings.features ?? {}
  const extensions = useExtensions()

  function toggle(feature: ChoosableFeatureId): void {
    const next = { ...stored }
    const on = !(stored[feature] ?? featureDefault(feature))
    if (on === featureDefault(feature)) delete next[feature] // 없는 키 = 기본값 — 파일에는 기본과 다른 값만 남긴다
    else next[feature] = on
    void updateSettings({ features: next }).then(
      () => setError(undefined),
      () => setError(t('settings.saveError')),
    )
  }

  /** 알림 채널 자 스위치 (이슈 #372) — 기본(켜짐)으로 돌아오면 키를 빼고, 전부 기본이면 빈 객체로 저장한다 */
  function toggleChannel(channel: NotifyChannel): void {
    const next: NotifyChannels = { ...settings.notifyChannels }
    if (channelsOn(settings.notifyChannels)[channel]) delete next[channel]
    else next[channel] = false
    void updateSettings({ notifyChannels: next }).then(
      () => setError(undefined),
      () => setError(t('settings.saveError')),
    )
  }

  function reasonText(reason: FeatureReason): string {
    return typeof reason === 'string' ? reason : t(reason.key, reason.vars)
  }

  function toggleExpanded(row: ChoosableFeatureId): void {
    // 한 번에 하나 — 열려 있던 줄은 자동으로 접히고, 이미 열린 줄을 누르면 접힌다 (#251)
    setExpanded((current) => (current === row ? undefined : row))
  }

  const rows = filterByQuery(FEATURE_ROWS, query, ({ feature, group }) => [
    t(`feature.${feature}`),
    t(`feature.${feature}.description`),
    t(`settings.features.group.${group}`),
  ])
  const extensionRows = filterExtensions(extensions, query)

  /** 펼친 아래의 자세한 설명 + 칩(필요 · 기본값 · 쓰는 곳) */
  function featureDetail(feature: ChoosableFeatureId, extra: { failure?: FeatureReason; wanted: boolean }): ReactNode {
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
        {/* 알림 채널 자 스위치 (이슈 #372) — 외부(PC 알림·dock 배지)·내부(토스트) 를 따로 켜고 끈다. 점 은 채널과 무관해 여기서 안 꺼진다 */}
        {feature === 'notifications' &&
          NOTIFY_CHANNELS.map((channel) => {
            const on = channelsOn(settings.notifyChannels)[channel]
            return (
              <div className="settings-row" key={channel} data-setting={`notifyChannels.${channel}`}>
                <div className="settings-row__text">
                  <div className="settings-row__title">{t(`feature.notifications.channel.${channel}` as MessageKey)}</div>
                  <div className="settings-row__description">{t(`feature.notifications.channel.${channel}.hint` as MessageKey)}</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  className="settings-switch"
                  aria-checked={on}
                  aria-label={t(`feature.notifications.channel.${channel}` as MessageKey)}
                  onClick={() => toggleChannel(channel)}
                >
                  <span className="settings-switch__thumb" />
                </button>
              </div>
            )
          })}
        {feature === 'voice' && (
          <div className="settings-row" data-setting="speechLanguage">
            <div className="settings-row__text">
              <div className="settings-row__title">{t('settings.speechLanguage')}</div>
              <div className="settings-row__description">{t('settings.speechLanguage.description')}</div>
            </div>
            <OptionSelect<SpeechLanguage>
              value={speechLanguage(settings)}
              options={[{ id: 'auto', label: t('settings.speechLanguage.auto') }, ...LANGUAGES]}
              onChange={(next) => void updateSettings({ speechLanguage: next }).then(() => setError(undefined), () => setError(t('settings.saveError')))}
            />
          </div>
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
          <span className="feature-row__chip">{t(featureDefault(feature) ? 'settings.features.default.on' : 'settings.features.default.off')}</span>
          <span className="feature-row__chip">{t(`feature.${feature}.where`)}</span>
        </div>
      </div>
    )
  }

  function choosableRow({ feature, group }: (typeof FEATURE_ROWS)[number]): ReactNode {
    const on = featureOn(stored, feature)
    const open = expanded === feature
    const status = statuses[feature]
    const failure = status?.state === 'failed' ? status.reason : undefined
    const wanted = stored[feature] ?? featureDefault(feature) // 이 기능 스스로의 스위치 값 (필요한 기능과 무관)
    return (
      <li key={feature} className="feature-row" data-feature={feature} data-expanded={open || undefined} data-on={on || undefined}>
        <div className="feature-row__head">
          <RowToggle
            id={feature}
            feature={feature}
            open={open}
            title={t(`feature.${feature}`)}
            badge={t(`settings.features.group.${group}`)}
            summary={t(`feature.${feature}.description`)}
            onToggle={() => toggleExpanded(feature)}
          />
          {failure !== undefined && <span className="feature-row__status feature-row__status--failed">{t('features.status.failed')}</span>}
          <button type="button" role="switch" className="settings-switch" aria-checked={on} aria-label={t(`feature.${feature}`)} onClick={() => toggle(feature)}>
            <span className="settings-switch__thumb" />
          </button>
        </div>
        {open && featureDetail(feature, { failure, wanted })}
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
        <ExtensionAddButton />
      </div>
      <ExtensionsNotice extensions={extensions} />
      {rows.length === 0 && extensionRows.length === 0 ? (
        <p className="features-page__empty">{t('settings.features.noMatch')}</p>
      ) : (
        <>
          {rows.length > 0 && <ul className="feature-rows">{rows.map(choosableRow)}</ul>}
          <ExtensionsSection extensions={extensionRows} />
        </>
      )}
    </div>
  )
}
