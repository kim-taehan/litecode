// ctx.remote 의 기한·상한 상수 (이슈 #298 에서 remote.ts 에서 옮김, 값은 그대로)

/** 가짜 데스크탑과 같은 기본 포트 — 폰에 저장된 주소·방화벽 규칙이 오래 맞게 고정한다 (HTTP 운반이 듣는다) */
export const REMOTE_DEFAULT_PORT = 47600
export const PAIR_CODE_TTL_MS = 2 * 60_000
export const PAIR_WAIT_MS = 60_000
/** 긴 코드·짧은 코드를 합쳐 이만큼 틀리면 세션을 버린다 — 2자리 코드를 추측으로 맞힐 확률 3/100 (사용자 2026-10-06, 전에는 5) */
export const PAIR_MAX_FAILURES = 3
/** 기억하는 clientMessageId 수 — 재시도는 보낸 직후에만 온다 */
export const SENT_MEMORY = 1000
/** 폰이 만들고 아직 아무것도 안 보낸 새 대화 수 */
export const DRAFT_LIMIT = 20
export const DEVICE_NAME_MAX = 64
