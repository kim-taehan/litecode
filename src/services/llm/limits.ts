export const MODEL_CATALOG_TIMEOUT_MS = 10_000
/** 에이전트 목록도 지연 로드된다(01f: 첫 응답 빈 목록, ~1.5초) — 모델 카탈로그와 같은 기한 */
export const AGENT_LIST_TIMEOUT_MS = 10_000
/** 한 턴에 자동 요약이 이만큼 넘게 돌면 멈춘다 — 레거시는 요약 뒤 스스로 "Continue" 턴을 돌리고, 모델 한도가 작으면(한도 − 출력 한도가 프롬프트보다
 *  작으면 — renderer/compaction.ts) 요약 → 다시 넘침이 끝없이 돈다 (01w 자동 요약 행, 가짜 LLM 30초에 10회 이상). 출력 한도를 넣은 뒤(#27)로는 안전망. 요약 줄·이음 답은 TurnScope */
export const MAX_COMPACTIONS_PER_TURN = 3
/** 한 스텝의 재시도가 이만큼 넘으면(attempt > 이 값) 앱이 멈추고 실패로 끝낸다 (이슈 #207). opencode 1.18.18 은 일시 오류를 5번까지
 *  지수 백오프(2·4·8·16·30초 상한)로 재시도해 꺼진 게이트웨이에 1분 반을 기다린다 (바이너리 SessionRetry: RETRY_MAX_RETRIES=5).
 *  attempt 는 한 스텝(한 번의 모델 호출) 안의 순번이다 — 재시도 사이 busy 에도 이어지고, 다음 스텝은 1 부터 다시 */
export const MAX_RETRIES_PER_TURN = 3
/** 연결 자체가 안 되는 재시도 사유 — 서버가 꺼져 있으면 몇 초 더 기다려도 안 켜진다 → 1번째 알림에서 멈춘다. retry status 의 message 는
 *  게이트웨이 오류 본문의 error.message 다 (바이너리 SessionRetry.retryable: APIError 면 e.data.message) — 키 프록시가 "(ECONNREFUSED)" 처럼 코드를 싣는다 */
export const UNREACHABLE = /\b(?:ECONNREFUSED|ENOTFOUND|EHOSTUNREACH)\b/i
/** 키 프록시가 게이트웨이 연결 실패를 답하는 상태 (keyProxy.ts — tr('error.proxyGateway')) */
export const UNREACHABLE_STATUS = 502

export function connectionRefused(message: string): boolean {
  return UNREACHABLE.test(message)
}
/** 저장된 모델 키를 못 푼다 (이슈 #231, providers.ts KEY_STORE_CODE) — 키 프록시가 502 에 안내 문구째 싣는다. 키체인 허용은 앱을 다시 열어야 바뀌어
 *  몇 번을 다시 보내도 풀리지 않는다 → 1번째 알림에서 멈추고, 안내 문구가 그대로 보이게 turnError(HTTP 문구 덧씌우기)를 거치지 않는다 */
export const KEY_STORE = /\bEKEYSTORE\b/
/** MCP 호출 요청을 받고 그 running 도구 파트를 기다리는 한도 — 이벤트는 요청 1~3ms 뒤에 온다 (01z 1-2, 10/10) */
export const CALLER_WAIT_MS = 2_000
/** 승인 요청을 받고 그 running 도구 파트(도구 이름·인자)를 기다리는 한도 — 묻는 순간 이미 running 이다 (01z 1-3, 3/3). 넘기면 요청에 실린 것으로 */
export const PRE_TOOL_WAIT_MS = 300
/** 구독을 걸고 server.connected 를 기다리는 한도 — 헤더와 함께 바로 온다(01w) */
export const CONNECT_TIMEOUT_MS = 10_000
/** /event 의 무바이트 한도 기본값 — 레거시 /event 는 10초마다 heartbeat 를 보낸다(01w). 세 번 연달아 안 오면 연결이 FIN 없이 죽은 것으로 보고
 *  "중단됨" 으로 끝낸다 (끊긴 연결을 기다리며 턴이 영원히 도는 것을 막는다 — 01q 와 같은 정책) */
export const STREAM_IDLE_TIMEOUT_MS = 30_000
/** 모델 무응답 한도 (이슈 #264) — 엔진이 프롬프트를 받은 뒤 이 턴 메시지·하위 작업 이벤트가 이만큼 하나도 없으면 게이트웨이가 요청을 받고 답하지
 *  않는 것으로 보고 멈추고(abort) 실패로 끝낸다. server.heartbeat(10초, sessionID 없음)는 진행이 아니다(01w). 도구가 running 인 동안은 세지 않는다
 *  (긴 bash·승인 대기 — 묻는 순간 그 도구는 이미 running 이다, PRE_TOOL_WAIT_MS) */
export const MODEL_STALL_TIMEOUT_MS = 120_000
