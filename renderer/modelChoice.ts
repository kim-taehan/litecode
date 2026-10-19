// 입력창 아래 모델 드롭다운의 선택 규칙. 선택은 id 쌍으로 쥔다 — 표시 이름은 설정에서 바뀌어도 선택은 그대로다
import type { ModelCatalogEntry } from '../shared/ipc.ts'
import { engineModelId } from '../shared/engineModelId.ts'

/** 고른 모델 — modelId 는 엔진의 내부 키(engineModelId, 이슈 #497). 같은 id 의 사고 켬·끔 두 항목은 키가 달라 이것 하나로 가린다 */
export interface ModelRef {
  providerId: string
  modelId: string
}

type ProviderLike = { id: string; displayName: string; models: ModelCatalogEntry[] }

/** 설정에 그 모델(키)이 있으면 provider 와 함께 준다. 설정에서 지워졌으면 undefined */
export function findModel<P extends ProviderLike>(providers: P[], ref: ModelRef | undefined): { provider: P; model: ModelCatalogEntry } | undefined {
  const provider = providers.find((candidate) => candidate.id === ref?.providerId)
  const model = provider?.models.find((candidate) => engineModelId(candidate) === ref?.modelId)
  return provider && model ? { provider, model } : undefined
}

/** 새 대화의 모델 — 마지막으로 고른 것, 그것이 지워졌거나 없으면 설정의 첫 모델 */
export function initialModel(providers: ProviderLike[], last: ModelRef | undefined): ModelRef | undefined {
  if (findModel(providers, last)) return last
  const provider = providers.find((candidate) => candidate.models.length > 0)
  return provider && { providerId: provider.id, modelId: engineModelId(provider.models[0]!) }
}

/** localStorage 에 둔 마지막 선택 — 모양이 깨졌으면 없는 것으로. 이전 저장값 `{modelId, thinkingOff}`(80b58cd~#491)는 키로 읽는다 —
 *  thinkingOff true 면 그 id 의 사고 끔 키 */
export function parseModelRef(raw: string | null): ModelRef | undefined {
  try {
    const value = JSON.parse(raw ?? 'null') as (Partial<ModelRef> & { thinkingOff?: unknown }) | null
    if (typeof value?.providerId !== 'string' || typeof value.modelId !== 'string') return undefined
    return { providerId: value.providerId, modelId: engineModelId({ id: value.modelId, thinkingOff: value.thinkingOff === true }) }
  } catch {
    return undefined
  }
}
