import type { RemoteService } from './remote/service.ts'
import type { RemoteStatus } from './remote/types.ts'

export { RemoteService } from './remote/service.ts'
export type { RemoteServiceOptions, RemotePairRequest, RemoteDeviceInfo, RemoteStatus } from './remote/types.ts'
export { REMOTE_DEFAULT_PORT, REMOTE_PORT_TRIES } from './remote/limits.ts'

// 모바일 연결 (ctx.remote, 이슈 #56 — 설계 _workspace/01t_mobile_arch.md 의 R1). 폰 앱이 붙는 문: 짝짓기·기기 관리·REST·SSE.
// 대화는 ctx.chat 이 쥔다 — 여기는 그 손님 하나를 네트워크로 내보내는 얇은 서비스다(모바일은 단독으로 대화를 유지하지 않는다).
// **엔진(opencode)을 모른다**: 쓰기는 전부 ctx.chat, 읽기는 ctx.sessions·ctx.projects·ctx.providers 로만 한다.
// 계약은 shared/remote.ts — 모바일 클라이언트(mobile/src/core)와 가짜 데스크탑(mobile/dev/fake-desktop.mts)이 같은 것을 본다.
//
// **운반을 모른다** (이슈 #68, 설계 _workspace/01ab_mobile_bluetooth.md 5절): 이 서비스는 계약·인증·기기·짝짓기·이벤트 링을 쥐고,
// 요청은 운반 중립 모양(`handle(RemoteRequest, peer, exchange)` — remote/carrier.ts)으로만 받는다. HTTP·블루투스는 이 밑의
// **운반 플러그인**이다(`inject: ['remote']`, 자기 ctx 키 없음 — remote/http.ts): `ctx.remote.carrier(…)` 로 자신을 올리고 받은 요청을
// handle 에 넘긴다. 이 서비스가 떠 있는 동안 올라온 운반을 띄운다(start) — 내려가면 전부 닫는다(stop).
// 리스너·`Origin` 거절·본문 상한처럼 HTTP 에만 있는 것은 HTTP 운반에 있다. 인증 실패 제한의 열쇠는 운반이 준 peer 다.
//
// 경계 (01t 3절):
// - 짝짓기: 코드 12자(2분·1회용, 틀리면 5회째 폐기) + 데스크탑 [허용] 확인(최대 60초 롱폴) → 256bit 토큰(해시만 저장)
// - 그 밖의 모든 요청은 `Authorization: Bearer`. peer(HTTP 면 IP) 당 인증 실패 10회/분 → 5분 차단. 해제하면 그 토큰은 401, 열린 스트림은 `device.revoked` 뒤 끊김
// - 폰에 열지 않는 것: pty·fs·`!`·`@`·설정·키·MCP·스킬 관리·**전체 권한 모드**(full 모드 대화엔 못 보낸다 — 403).
//   보낸 글은 그대로 프롬프트다(입력 트리거를 풀지 않는다). 프로젝트는 등록된 것만
// - 켜짐은 하나다: 이 서비스가 떠 있음 = 켜짐 (기능 `remote`, 기본 꺼짐 — #124). 서비스가 내려가면(기능 끄기·앱 종료) 운반을 닫는다(포트를 닫는다)
// - 느린 운반에서 이벤트가 밀리면 같은 진행 줄(`turn.progress` 의 cid·item.id)은 최신 하나로 합친다 (remote/streamQueue.ts)
//
// 이 파일은 진입점이다 — 이벤트 계약(아래 declare module)과 다시 내보내기만 둔다 (이슈 #298 에서 나눔, 동작 변경 없음):
// - remote/service.ts     RemoteService — 상태(설정 화면)·운반 올리기/띄우기/닫기·블루투스 키(지연 읽기)·짝짓기 코드 발급·[허용] 답·해제·이벤트 링/스트림·요청 인증과 경로 고르기
// - remote/routes.ts      짝지은 기기의 REST 요청 표 — hello·프로젝트·대화 목록·새 대화·대화 스냅샷·보내기·중지·대기열·승인 답·모델
// - remote/pairRequest.ts POST /v1/pair — 코드 대조·[허용] 대기·같은 키 옛 짝 교체
// - remote/chatEvents.ts  ctx.chat·알림 이벤트 → 폰 이벤트 (turn.*·queue.changed·notices.changed), 폰 글의 전체 권한 막기
// - remote/wire.ts        계약 모양으로 바꾸는 순수 함수 (이벤트 글자·합칠 열쇠·출처·대화 목록 줄)
// - remote/types.ts       모양 (옵션·상태·짝짓기 요청·스트림)
// - remote/limits.ts      기한·상한 상수
// 그 밖의 remote/*(devices·eventLog·pairing·streamQueue·noiseIdentity·carrier 와 운반 http·https·bluetooth)은 앞서 나뉜 것이다

declare module 'cordis' {
  interface Context {
    remote: RemoteService
  }
  interface Events {
    /** 연결 상태·짝짓기·기기 목록이 바뀌었다 — 설정 > 모바일과 [허용] 확인이 그린다 */
    'remote/changed'(status: RemoteStatus): void
  }
}
