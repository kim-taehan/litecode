import { useFeatures } from './featuresStore.ts'
import { updateSettings, useSettings, useT } from './settingsStore.ts'
import { showUpdateNotice, useUpdateStatus } from './updates.ts'

// 사이드바 아래(설정 줄 바로 위) 한 줄 — "새 버전 v0.1.3 [내려받기] ×". 기능 `updates` 가 켜져 있고 새 버전이 있을 때만.
// [내려받기] 는 메인이 주소를 다시 보고 기본 브라우저로 연다. × 는 그 버전을 settings.dismissedUpdate 에 적어 다시 안 띄운다
export function UpdateNotice() {
  const t = useT()
  const settings = useSettings()
  const status = useUpdateStatus(useFeatures().has('updates'))
  if (!showUpdateNotice(status, settings.dismissedUpdate)) return null
  return (
    <div className="update-notice" role="status">
      <span className="update-notice__text">{t('updates.notice', { version: status.latest! })}</span>
      <button type="button" className="update-notice__download" onClick={() => void window.litecode.openUpdate(status.url!).catch(() => {})}>
        {t('updates.download')}
      </button>
      <button
        type="button"
        className="update-notice__close"
        aria-label={t('updates.dismiss')}
        title={t('updates.dismiss')}
        onClick={() => void updateSettings({ dismissedUpdate: status.latest! }).catch(() => {})}
      >
        ×
      </button>
    </div>
  )
}
