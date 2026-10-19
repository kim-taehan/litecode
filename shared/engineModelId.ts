// 엔진 쪽 모델 키 (이슈 #497, 시안 E) — 설정의 모델 id 는 게이트웨이의 실제 모델 이름이고, 같은 id 를 사고 켬·끔 두 항목에 쓸 수 있다.
// opencode 는 모델 정의가 키 하나당 하나라 둘을 가리려면 키가 달라야 한다 — 사고 끔 항목은 id 뒤에 고정 접미사를 붙인 키를 쓴다.
// 이 키가 opencode.json 의 모델 키·`providerID/modelID` 참조·대화에 저장되는 modelId·마지막 선택·폰의 모델 목록으로 흐르고,
// 키 프록시가 게이트웨이로 보내기 직전에 그 항목의 id 로 되돌린다. 사용자에게는 표시 이름만 보인다.
// **키를 손으로 만들지 않는다** — 모두 이 함수를 쓴다.
//
// 접미사 `--nothink`: opencode 는 `provider/model` 문자열을 첫 `/` 에서만 자르고 나머지를 modelID 로 둔다(1.18.18 바이너리 확인) —
// `/`·공백·`:`·`@` 없이 영소문자와 `-` 만 써서 참조·설정 키·SSE 의 modelID 어디서도 다르게 읽힐 일이 없게 했다. 접미사는 끝에만 붙어
// opencode 가 모델 id 에 `includes('qwen')`·`gpt-` 처럼 보는 판단도 id 와 같게 나온다. 진짜 id 와 겹칠 수 있으므로(`x--nothink` 모델)
// 저장 검증이 이 키 기준으로 겹침을 거절한다 (ctx.providers)
const THINKING_OFF_SUFFIX = '--nothink'

export function engineModelId(model: { id: string; thinkingOff?: boolean }): string {
  return model.thinkingOff === true ? `${model.id}${THINKING_OFF_SUFFIX}` : model.id
}
