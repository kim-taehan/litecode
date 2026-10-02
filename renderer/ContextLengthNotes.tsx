import { COMPACTION_MIN_CONTEXT, isLowContext } from './compaction.ts'
import { useT } from './settingsStore.ts'
import './compaction.css'

// 설정 > 모델 목록 아래 컨텍스트 길이 안내 (01o 권고 ①). 빈 칸에 기본값을 지어 넣지 않는다 — 실제보다 크면 요약 전에 한도를 넘어
// 그 대화가 영구 실패하고, 작으면 요약이 끝없이 돈다. 비우면 미리 요약하지 않는다는 것(레거시는 게이트웨이가 한도 초과로 거절할 때는 요약한다 — #20)과,
// 너무 작은 값만 알린다

export function ContextLengthNotes({ models }: { models: readonly { id: string; contextLength?: number }[] }) {
  const t = useT()
  const low = models.filter((model) => isLowContext(model.contextLength))
  return (
    <>
      <p className="context-length-hint">{t('models.contextLengthHint')}</p>
      {low.map((model, index) => (
        <p key={index} className="context-length-hint context-length-hint--warn" role="status">
          {t('models.contextLengthLow', { model: model.id || '?', min: COMPACTION_MIN_CONTEXT })}
        </p>
      ))}
    </>
  )
}
