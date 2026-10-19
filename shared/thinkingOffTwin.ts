import type { ModelCatalogEntry } from '../src/services/providers.ts'

// 사고 끔 항목 (이슈 #491 방법 B) — 사고 끄기를 켜면 기존 항목은 그대로 두고 "사고 끔" 항목을 새로 만든다.
// 기존 항목의 id 를 바꾸면 그 id 를 가리키던 대화·마지막 선택이 끊긴다. 새 항목은 유일한 id + upstreamId(원래 id) 라
// 키 프록시가 id 하나로 사고 끄기 여부와 게이트웨이 이름을 함께 찾는다. 가상 id 인지는 upstreamId 로만 본다 — `-off` 로 추측하지 않는다
// (진짜 `…-off` 모델이 있다). 설정 화면의 토글과 ctx.providers 의 구버전 이주가 같은 id 규칙을 쓴다.

/** 사고 끔 항목의 id — `<id>-off`, 이미 쓰이면 `-off-2`, `-off-3` … */
export function thinkingOffTwinId(id: string, taken: (candidate: string) => boolean): string {
  const base = `${id}-off`
  let twin = base
  for (let n = 2; taken(twin); n++) twin = `${base}-${n}`
  return twin
}

/** 설정 화면의 사고 끄기 토글 — 새 배열을 준다(받은 배열·항목은 바꾸지 않는다). suffix 는 사고 끔 항목의 표시 이름 뒤에 붙는 말 */
export function toggleThinkingOff(models: ModelCatalogEntry[], index: number, on: boolean, suffix: string): ModelCatalogEntry[] {
  const target = models[index]
  if (!target) return models
  if (!on) {
    // 끄면 thinkingOff 만 — id·upstreamId 는 남는다 (별칭이 있으면 별칭으로 사고 켬)
    const { thinkingOff: _off, ...rest } = target
    return models.map((model, at) => (at === index ? rest : model))
  }
  if (target.thinkingOff === true) return models
  const id = target.id.trim()
  // 별칭이 이미 있거나(사고 끔 항목·일반 별칭) id 가 비었으면 짝을 만들지 않고 그 항목만 켠다
  if (target.upstreamId || !id) return models.map((model, at) => (at === index ? { ...model, thinkingOff: true } : model))
  const twin: ModelCatalogEntry = {
    id: thinkingOffTwinId(id, (candidate) => models.some((model) => model.id.trim() === candidate)),
    displayName: `${target.displayName.trim() || id}${suffix}`,
    upstreamId: id,
    thinkingOff: true,
    ...(target.contextLength !== undefined && { contextLength: target.contextLength }),
    ...(target.maxOutput !== undefined && { maxOutput: target.maxOutput }),
    ...(target.imageInput !== undefined && { imageInput: target.imageInput }),
  }
  return [...models.slice(0, index + 1), twin, ...models.slice(index + 1)]
}
