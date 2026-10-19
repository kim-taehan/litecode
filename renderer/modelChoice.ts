// 입력창 아래 모델 드롭다운의 선택 규칙. 선택은 id 쌍으로 쥔다 — 표시 이름은 설정에서 바뀌어도 선택은 그대로다
import type { ModelCatalogEntry } from '../shared/ipc.ts'

/** 고른 모델 — 사고 끄기는 같은 id 의 다른 항목이므로 thinkingOff 로 구분한다 (이전 저장값엔 없을 수 있다) */
export interface ModelRef {
  providerId: string
  modelId: string
  /** false(이 전 저장값) 와의 차이를 보려면 === true 으로 */
  thinkingOff?: boolean
}

type ProviderLike = { id: string; displayName: string; models: ModelCatalogEntry[] }

/** 설정에 그 모델(id + 사고 끄기) 이 있으면 provider 와 함께 준다. 사고 끄기는 id 가 아닌 항목으로 걸기 때문에
 *  thinkingOff 를 주면 그 값과 같은 항목만, 안 주면(이전 저장값) 기존처럼 id 로만 맞춘다. 설정에서 지워졌으면 undefined */
export function findModel<P extends ProviderLike>(providers: P[], ref: ModelRef | undefined): { provider: P; model: ModelCatalogEntry } | undefined {
  const provider = providers.find((candidate) => candidate.id === ref?.providerId)
  const model = provider?.models.find((candidate) => candidate.id === ref?.modelId && (ref === undefined || ref.thinkingOff === undefined || candidate.thinkingOff === ref.thinkingOff))
  return provider && model ? { provider, model } : undefined
}

/** 새 대화의 모델 — 마지막으로 고른 것, 그것이 지워졌거나 없으면 설정의 첫 모델 */
export function initialModel(providers: ProviderLike[], last: ModelRef | undefined): ModelRef | undefined {
  if (findModel(providers, last)) return last
  const provider = providers.find((candidate) => candidate.models.length > 0)
  return provider && { providerId: provider.id, modelId: provider.models[0]!.id }
}

/** localStorage 에 둔 마지막 선택 — 모양이 깨졌으면 없는 것으로 */
export function parseModelRef(raw: string | null): ModelRef | undefined {
  try {
    const value = JSON.parse(raw ?? 'null') as Partial<ModelRef> | null
    const base: ModelRef = { providerId: value!.providerId!, modelId: value!.modelId! }
    return typeof value?.providerId === 'string' && typeof value.modelId === 'string' ? (typeof value.thinkingOff === 'boolean' ? { ...base, thinkingOff: value.thinkingOff } : base) : undefined
  } catch {
    return undefined
  }
}
