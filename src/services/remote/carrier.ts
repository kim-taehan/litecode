// 운반 중립 계약 (이슈 #68, 설계 _workspace/01ab_mobile_bluetooth.md 5절 "Cordis 서비스 경계").
// ctx.remote 가 서비스(계약·인증·기기·짝짓기·이벤트 링)이고, HTTP·블루투스는 그 밑의 **운반 플러그인**이다(`inject: ['remote']`,
// 자기 ctx 키 없음). 운반이 ctx.remote 에 하는 일은 둘뿐이다: `ctx.remote.carrier(…)` 로 자신을 올리고(effect),
// 받은 요청을 `ctx.remote.handle(request, peer, exchange)` 에 넘긴다. 여기에는 http 도 블루투스도 없다 — 타입뿐이다.

/** 요청 하나 — 어느 운반으로 왔든 같은 모양 */
export interface RemoteRequest {
  /** 'GET' · 'POST' (그 밖은 405) */
  method: string
  /** `/v1/…` — 쿼리 없이, 퍼센트 인코딩된 그대로 */
  path: string
  query: URLSearchParams
  headers: { authorization?: string }
  /** JSON 글 (없으면 본문 없음) */
  body?: string
}

/** 블루투스 운반의 id — ctx.remote 가 이 운반이 올라와 있으면 짝짓기 응답·QR 에 블루투스 키(bk)를 싣는다 */
export const BLUETOOTH_CARRIER = 'bluetooth'

/** 누가 보냈나 — 인증 실패 제한의 열쇠다 (HTTP 는 IP, 블루투스는 연결 id) */
export interface RemotePeer {
  /** 운반의 id ('http' · 'bluetooth' …) */
  carrier: string
  key: string
  /** 이 통로가 지문으로 고정돼 있으면(TLS) 그 지문 — 짝짓기 확인 코드가 지문 앞 8자가 된다. 평문·블루투스는 없다 */
  fingerprint?: string
}

export interface RemoteReply {
  status: number
  /** JSON 으로 실을 값 */
  body: unknown
  /** 운반이 실을 수 있으면 싣는 머리 (retry-after) */
  headers?: Record<string, string>
}

/** 이벤트 스트림의 통로 — 운반이 만든다. ctx.remote 는 SSE 글자를 그대로 쓴다 */
export interface RemoteStreamSink {
  /** 글 조각을 보낸다. false 면 밀렸다 — onDrain 이 불릴 때까지 ctx.remote 는 더 쓰지 않고, 그동안 쌓이는 것을 합친다 */
  write(text: string): boolean
  onDrain(listener: () => void): void
  /** 곱게 닫는다 (마지막 글을 주면 그것까지 보내고) */
  end(text?: string): void
  /** 그냥 끊는다 */
  destroy(): void
  /** 닫혔다 — 상대가 끊었거나 우리가 닫았다. 한 번 */
  onClose(listener: () => void): void
}

/** 요청 하나를 다루는 동안 운반이 내주는 것 */
export interface RemoteExchange {
  /** 상대가 응답을 기다리다 떠났다 (연결 끊김·취소) */
  signal: AbortSignal
  /** 이 요청을 이벤트 스트림으로 연다 — 부르면 운반이 "열렸다(200)" 를 상대에게 알린다 */
  openStream(): RemoteStreamSink
}

/** handle 의 결과 — 응답 하나, 또는 스트림으로 열었다(openStream 을 불렀다) */
export type RemoteOutcome = RemoteReply | { stream: true }

export interface RemoteCarrierStatus {
  /** 지금 폰이 붙을 수 있다 */
  up: boolean
  /** 듣고 있는 주소 (`ip:port`) — 주소가 없는 운반(블루투스)은 빈 목록 */
  addresses: string[]
  /** 듣는(또는 들을) 포트 — 포트가 없는 운반은 없다 */
  port?: number
  /** 켰는데 못 뜬 사유 */
  error?: { code?: string; message: string }
  /** 폰이 공개키 지문으로 고정하는 운반(TLS)의 지문 — SPKI SHA-256 base64url */
  fingerprint?: string
  /** 마지막으로 접속이 들어온 시각 (막은 것도) — 진단용. 세지 않는 운반은 없다 */
  lastAttemptAt?: number
  /** 라디오 운반(블루투스)의 상태 — 설정 > 모바일의 상태 한 줄. 라디오가 꺼져 있거나 권한이 없는 것은 "못 뜬 사유"(error)가 아니라 여기에 둔다 */
  radio?: RemoteRadioStatus
}

/** starting: 모듈·라디오를 기다린다 · advertising: 광고 중(폰이 붙을 수 있다) · poweredOff: 블루투스가 꺼져 있다 · unauthorized: 권한 없음 ·
 *  unsupported: 이 PC 에서 못 쓴다(모듈 로드 실패·어댑터가 주변기기 역할을 못 한다 — reason) · failed: 그 밖의 이유로 못 켰다(키를 못 열었다 — reason) */
export type RemoteRadioState = 'starting' | 'advertising' | 'poweredOff' | 'unauthorized' | 'unsupported' | 'failed'

export interface RemoteRadioStatus {
  state: RemoteRadioState
  reason?: string
  /** 핸드셰이크를 마친 연결 수 */
  links: number
}

/** 운반 하나 — `ctx.remote.carrier(carrier)` 로 올린다. 모바일 연결이 켜져 있는 동안만 ctx.remote 가 start 한다 */
export interface RemoteCarrier {
  id: string
  /** 듣기 시작한다. 못 뜨면 던지지 않고 status().error 에 사유를 남긴다 */
  start(): Promise<void>
  /** 닫고 붙어 있던 것을 끊는다. 사유도 지운다 */
  stop(): Promise<void>
  status(): RemoteCarrierStatus
}
