import { useState } from 'react'
import { FEATURE_GROUPS, FEATURE_REQUIRES, featureDefault, featureOn, type FeatureId, type FeatureReason } from '../shared/features.ts'
import type { MessageKey } from '../shared/i18n/index.ts'
import { useFeatureStatuses } from './featuresStore.ts'
import { updateSettings, useSettings, useT } from './settingsStore.ts'

// 설정 > 기능 (이슈 #8) — 한 줄에 기능 하나 (사용자 2026-10-07 "그냥 한줄에 하나씩 넣고", "상세 볼 수 있게", 시안 _workspace/mock-features
// Main·Detail). 묶음마다 둥근 테두리 목록 한 장, 줄 = 펼침 버튼(▸ + 이름 + 한 줄 요약, 말줄임) · 스위치(따로 눌리는 요소, 일반 페이지와 같은 36×20).
// 줄을 누르면 아래로 늘어나 자세한 설명(`feature.<id>.detail` — 첫 줄은 문단, 나머지 줄은 불릿)과 칩(필요한 기능 · 기본값 · 쓰는 곳)을 보인다.
// 칩의 필요·기본값은 shared/features.ts 에서 만든다(문구를 손으로 중복하지 않는다). 펼침은 화면 안 상태 — 저장하지 않고 여러 줄을 함께 펼 수 있다.
// 바꾸면 곧바로 메인(ctx.settings)에 저장하고, 메인(ctx.features)이 재시작 없이 그 기능 묶음을 올리거나 내린다.
// 줄은 중분류(FEATURE_GROUPS — 작업 화면 / AI 도구 / 자동화 / 입력·연결·알림)로 나눠 묶음마다 제목 + 한 줄 설명 아래에 둔다 (사용자 결정 2026-10-06).
// 기능 상태 (이슈 #224, 시안 _workspace/mock-features/Detail 의 블루투스 줄) — 켰는데 못 뜬 기능(ctx.features 의 failed)은 스위치 앞에 빨간 알약
// "켜지 못함", 펼치면 설명 맨 위에 빨간 상자 "켜지 못한 이유 — 사유". 정상 상태(올리는 중·켜짐)엔 아무것도 달지 않는다(태그 소음 금지).
// 켜 두었는데 필요한 기능이 꺼져 못 뜬 기능은 그 필요 칩만 강조한다 — 사내망 연결(기본 켜짐)은 모바일 연결을 켜기 전까지 늘 이 상태라 줄 머리 태그는 소음이다.
// 고정된 기능(shared/features.ts FEATURE_FIXED — 필수인 입력 트리거·!명령 실행·스킬·MCP)은 줄이 없다 (사용자 결정 2026-10-03).

export function FeaturesPage({ initialExpanded = [] }: { initialExpanded?: readonly FeatureId[] }) {
  const t = useT()
  const settings = useSettings()
  const statuses = useFeatureStatuses()
  const [error, setError] = useState<string>()
  const [expanded, setExpanded] = useState<ReadonlySet<FeatureId>>(() => new Set(initialExpanded))
  const stored = settings.features ?? {}

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

  function toggleExpanded(feature: FeatureId): void {
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(feature)) next.add(feature)
      return next
    })
  }

  return (
    <div className="features-page">
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      <p className="features-page__intro">{t('settings.features.intro')}</p>
      {FEATURE_GROUPS.map((group) => (
        <section key={group.id} className="feature-group" data-feature-group={group.id} aria-labelledby={`feature-group-${group.id}`}>
          <div className="feature-group__head">
            <h3 className="feature-group__title" id={`feature-group-${group.id}`}>
              {t(`settings.features.group.${group.id}`)}
            </h3>
            <span className="feature-group__hint">{t(`settings.features.group.${group.id}.hint`)}</span>
          </div>
          <ul className="feature-rows">
            {group.features.map((feature) => {
              const on = featureOn(stored, feature)
              const open = expanded.has(feature)
              const [paragraph, ...bullets] = t(`feature.${feature}.detail`).split('\n')
              const status = statuses[feature]
              const failure = status?.state === 'failed' ? status.reason : undefined
              const wanted = stored[feature] ?? featureDefault(feature) // 이 기능 스스로의 스위치 값 (필요한 기능과 무관)
              return (
                <li key={feature} className="feature-row" data-feature={feature} data-expanded={open || undefined}>
                  <div className="feature-row__head">
                    <button
                      type="button"
                      className="feature-row__toggle"
                      aria-expanded={open}
                      aria-controls={`feature-detail-${feature}`}
                      onClick={() => toggleExpanded(feature)}
                    >
                      <svg className="feature-row__chevron" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                        <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <span className="feature-row__text">
                        <span className="feature-row__title">{t(`feature.${feature}`)}</span>
                        <span className="feature-row__summary">{t(`feature.${feature}.description`)}</span>
                      </span>
                    </button>
                    {failure !== undefined && <span className="feature-row__status feature-row__status--failed">{t('features.status.failed')}</span>}
                    <button
                      type="button"
                      role="switch"
                      className="settings-switch"
                      aria-checked={on}
                      aria-label={t(`feature.${feature}`)}
                      onClick={() => toggle(feature)}
                    >
                      <span className="settings-switch__thumb" />
                    </button>
                  </div>
                  {open && (
                    <div className="feature-row__detail" id={`feature-detail-${feature}`}>
                      {failure !== undefined && (
                        <div className="feature-row__failure" role="alert">
                          <b>{t('features.status.failedReason')}</b> — {reasonText(failure)}
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
                          const blocked = wanted && !neededOn
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
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
