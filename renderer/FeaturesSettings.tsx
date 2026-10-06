import { useState } from 'react'
import { FEATURE_GROUPS, featureDefault, featureOn, type FeatureId } from '../shared/features.ts'
import { updateSettings, useSettings, useT } from './settingsStore.ts'

// 설정 > 기능 (이슈 #8) — 끌 수 있는 기능마다 카드 하나: 이름 + 스위치, 아래 회색 한 줄 설명. 치수·모양은 dsh "Built-in plugins"
// (ui-settings-plugin-inventory) 카드 목록을 따른다: 두 칸 격자·간격 10, 카드 12×14 안쪽 여백·0.5px 선·큰 모서리, 제목 14/500, 설명 12/18
// 두 줄까지. 읽기 전용 목록인 dsh 와 달리 카드에 켜기 스위치(일반 페이지와 같은 36×20)를 둔다.
// 바꾸면 곧바로 메인(ctx.settings)에 저장하고, 메인(ctx.features)이 재시작 없이 그 기능 묶음을 올리거나 내린다.
// 카드는 중분류(FEATURE_GROUPS — 작업 화면 / AI 도구 / 자동화 / 입력·연결·알림)로 나눠 묶음마다 제목 + 한 줄 설명 아래에 둔다 (사용자 결정 2026-10-06).
// 고정된 기능(shared/features.ts FEATURE_FIXED — 필수인 입력 트리거·!명령 실행·스킬·MCP)은 카드가 없다 (사용자 결정 2026-10-03).

export function FeaturesPage() {
  const t = useT()
  const settings = useSettings()
  const [error, setError] = useState<string>()
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
          <ul className="feature-cards">
            {group.features.map((feature) => {
              const on = featureOn(stored, feature)
              return (
                <li key={feature} className="feature-card" data-feature={feature}>
                  <div className="feature-card__head">
                    <span className="feature-card__title">{t(`feature.${feature}`)}</span>
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
                  <p className="feature-card__description">{t(`feature.${feature}.description`)}</p>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
