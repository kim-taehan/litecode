// 엔진 쪽 모델 키 (이슈 #497 → #500 시안) — 설정의 모델 id 는 게이트웨이의 실제 모델 이름이다. "Thinking 모델" 로 선언한 항목은
// 대화마다 Thinking 을 디폴트·켬·끔으로 고르고, 그 선택은 키에 실린다: 디폴트=id, 켬=id--think, 끔=id--nothink.
// 이 키가 opencode.json 의 모델 키·`providerID/modelID` 참조·대화에 저장되는 modelId·마지막 선택·폰의 모델 선택으로 흐르고,
// 키 프록시가 게이트웨이로 보내기 직전에 id 로 되돌리며 켬·끔이면 enable_thinking 을 싣는다. 사용자에게는 표시 이름만 보인다.
// **키를 손으로 만들거나 풀지 않는다** — 만들 때 engineModelId, 되찾을 때 resolveModelKey.
//
// 접미사: opencode 는 `provider/model` 문자열을 첫 `/` 에서만 자르고 나머지를 modelID 로 둔다(1.18.18 바이너리 확인) —
// `/`·공백·`:`·`@` 없이 영소문자와 `-` 만 써서 참조·설정 키·SSE 의 modelID 어디서도 다르게 읽힐 일이 없게 했다. 접미사는 끝에만 붙어
// opencode 가 모델 id 에 `includes('qwen')`·`gpt-` 처럼 보는 판단도 id 와 같게 나온다. 끔 접미사는 #497 과 같다 — 이미 저장된 `x--nothink`
// 대화가 그대로 끔으로 이어진다. 진짜 id 와 겹칠 수 있으므로(`x--think` 모델) 저장 검증이 engineModelKeys 기준으로 겹침을 거절한다 (ctx.providers)

export type Thinking = 'default' | 'on' | 'off'

const SUFFIX = { on: '--think', off: '--nothink' } as const

export function engineModelId(model: { id: string }, thinking: Thinking = 'default'): string {
  return thinking === 'default' ? model.id : `${model.id}${SUFFIX[thinking]}`
}

/** 그 항목을 가리키는 모든 키 — Thinking 모델이면 셋, 아니면 id 하나. opencode.json 에 등록할 키이자 저장 검증의 겹침 기준 */
export function engineModelKeys(model: { id: string; thinking?: boolean }): string[] {
  return model.thinking === true ? [model.id, engineModelId(model, 'on'), engineModelId(model, 'off')] : [model.id]
}

/** 키 → (항목, Thinking 값). 규칙: ① id 가 키와 같은 항목이 있으면 그것의 디폴트 (진짜 id 가 접미사로 끝나도 그 항목이다) ② 아니면 키가
 *  `--think`/`--nothink` 로 끝나고 접미사를 뗀 것이 **Thinking 모델로 선언된** 항목의 id 일 때만 켬/끔 ③ 그 밖은 없음.
 *  id 가 겹치는 목록(읽기에서 남은 것 — 저장은 거절)은 첫 항목 */
export function resolveModelKey<M extends { id: string; thinking?: boolean }>(models: readonly M[], key: string | undefined): { model: M; thinking: Thinking } | undefined {
  if (key === undefined) return undefined
  const exact = models.find((model) => model.id === key)
  if (exact) return { model: exact, thinking: 'default' }
  for (const thinking of ['on', 'off'] as const) {
    if (!key.endsWith(SUFFIX[thinking])) continue
    const id = key.slice(0, -SUFFIX[thinking].length)
    const model = id ? models.find((candidate) => candidate.id === id && candidate.thinking === true) : undefined
    if (model) return { model, thinking }
  }
  return undefined
}
