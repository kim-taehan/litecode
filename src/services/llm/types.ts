import type { Mode } from '../../../shared/modes.ts'
import type { TurnUsage } from '../turnUsage.ts'
import type { EngineMessageInfo, EnginePart, TurnItem, TurnTracker } from '../turnProgress.ts'
import type { ToolCalls } from '../toolCalls.ts'
import type { Attention } from '../../../shared/contract.ts'

/** 실행 직전의 도구 호출 하나 (중립 모양) */
export interface PreTool {
  /** 그 턴의 엔진 세션 — 하위 작업의 도구여도 부모 턴의 세션이다 */
  sessionId: string
  /** 작업 폴더 (realpath) */
  directory: string
  /** 도구 이름 (bash·edit·write·read…, MCP 는 `<서버>_<도구>`) */
  tool: string
  /** 도구 인자 */
  input: unknown
  /** 파일 하나를 다루는 도구면 그 파일 (절대 경로) */
  file?: string
  /** 하위 작업이 불렀다 */
  child: boolean
  /** 턴이 끝나거나 멈추면 걸린다 — 판정을 기다릴 이유가 없어졌다 */
  signal: AbortSignal
}

export type PreToolDecision = 'allow' | 'ask' | { deny: true; reason: string }

/** 끝난 도구 호출 하나 (중립 모양) */
export interface ToolDone {
  /** 그 턴의 엔진 세션 — 하위 작업의 도구여도 부모 턴의 세션이다 */
  sessionId: string
  /** 작업 폴더 (realpath) */
  directory: string
  /** 도구 이름 (bash·edit·write·read…, MCP 는 `<서버>_<도구>`) */
  tool: string
  /** 도구 인자 */
  input: unknown
  /** 결과 글 — 실패면 없다 */
  output?: string
  error?: string
  /** 파일 하나를 다루는 도구면 그 파일 (절대 경로) */
  file?: string
  /** 하위 작업이 불렀다 */
  child: boolean
}

/** 실행에 들어간 도구 호출 하나 (중립 모양 — ToolDone 과 같은 자리) */
export interface ToolStarted {
  sessionId: string
  /** 작업 폴더 (realpath) */
  directory: string
  tool: string
  input: unknown
  callID: string
  /** 하위 작업이 불렀다 */
  child: boolean
}

/** opencode 의 MCP 서버 상태 (레거시 GET /mcp — connected·disabled·failed·needs_auth·needs_client_registration) */
export interface McpStatus {
  status: string
  error?: string
}

export interface TurnInfo {
  sessionId: string
  directory: string
}

export interface ChatResult {
  ok: boolean
  sessionId?: string
  text?: string
  error?: string
  /** 이 턴의 사용량·시간 (중립 모양 — turnUsage.ts). 끝난 스텝이 없으면 없다 */
  usage?: TurnUsage
  /** 실패가 아니라 엔진 재시작·크래시·스트림 끊김으로 끝났다 (error 는 "중단됨 …") */
  interrupted?: boolean
  /** 사용자가 승인·질문을 거절해 끝났다 — 실패가 아니다 (ok 는 true) */
  declined?: boolean
  /** 이 턴에 끼워 넣은(reserve) 말 중 답을 못 받은 것의 메시지 id — 승인 거절·중지로 루프가 끝났거나 보내지 못했다 (이슈 #250). 없으면 빠진다 */
  unanswered?: string[]
}

/** 도는 턴에 잡아 둔 끼워 넣기 자리 하나 (reserve, 이슈 #250) — send 나 cancel 중 하나를 꼭 부른다 (그때까지 턴이 이 말을 기다린다) */
export interface Interjection {
  /** 끼워 넣을 말을 보낸다 — 모델·모드·지시문·도구는 도는 턴 것 그대로, context 는 이 말에 더할 맥락 (지시문 뒤에 붙는다).
   *  턴이 이미 끝났거나(멈춤 등) 엔진이 거절하면 보내지 못하고 false — 그 말은 답 없음(unanswered)으로 남는다 */
  send(input: { prompt: string; images?: readonly ChatImage[]; context?: string; synthetic?: boolean }): Promise<boolean>
  /** 보내지 않기로 했다 — 턴이 이 말을 더 기다리지 않는다 (답 없음으로 남는다) */
  cancel(): void
}

/** 메시지에 붙여 보낼 이미지 하나 (이슈 #44) — 읽은 바이트 그대로. 종류는 부르는 쪽이 매직 바이트로 정한다 (attachments.ts) */
export interface ChatImage {
  mime: 'image/png' | 'image/jpeg'
  filename: string
  data: Buffer
}

/** chat() 의 인자 — 각 필드의 뜻은 chat() 주석 (이슈 #182: 위치 인자 13개였다) */
export interface ChatOptions {
  providerId: string
  modelId: string
  directory: string
  prompt: string
  sessionId?: string
  onSession?: (sessionId: string) => Promise<void>
  messageId?: string
  onProgress?: (item: TurnItem) => void
  mode?: Mode
  onAttention?: (requests: Attention[]) => void
  stop?: AbortSignal
  images?: readonly ChatImage[]
  context?: string
  /** 이 턴에만 모델에 안 보일 MCP 도구 (서버 → MCP 서버가 준 도구 이름) — 폴더의 숨김(hideMcpTools)에 더한다. 백그라운드 작업 턴이 작업 도구를 뺀다 (#319) */
  hideMcpTools?: Readonly<Record<string, readonly string[]>>
  /** 이 턴의 무응답 한도 — 주면 평소 한도(MODEL_STALL_TIMEOUT_MS·도구 인자 TOOL_INPUT_STALL_TIMEOUT_MS) 대신 이것 하나로만 끊는다.
   *  백그라운드 작업 턴이 하드 한도만 남긴다 (shared/tasks.ts TASK_STALL_TIMEOUT_MS — 조용함은 끊지 않고 알린다) */
  stallTimeoutMs?: number
}

/** 레거시 GET /session/{id}/message 의 항목 (01w 실측 — 감싸지 않은 배열, 오래된 것부터) */
export interface EngineMessage {
  info: EngineMessageInfo
  parts: EnginePart[]
}

/** 입력 트리거(@ 파일)용 폴더 항목 — 폴더는 path 끝에 `/` */
export interface FileEntry {
  path: string
  type: 'file' | 'directory'
}

/** 입력 트리거(/ 명령)용 명령 — template 의 `$ARGUMENTS`·`$1`… 는 부르는 쪽이 푼다 */
export interface EngineCommand {
  name: string
  template: string
  description?: string
}

/** 레거시 GET /skill 의 한 항목 (이슈 #7 실측 2026-10-02). location 은 SKILL.md 절대 경로, 내장은 `<built-in>`. content 는 frontmatter 를 뺀 본문 —
 *  opencode 가 폴더별로 캐시해 재시작 전까지 옛것이다 */
export interface EngineSkill {
  name: string
  description?: string
  location: string
  content?: string
}

/** 도는 턴 하나 (LlmService.running) — turnMessageId 는 그 턴을 시작한 user 메시지, reserve 는 엔진이 그 턴을 받은 뒤에만 있다 */
export interface RunningTurn {
  tracker: TurnTracker
  workdir: string
  sessionId: string
  calls: ToolCalls
  turnMessageId: string
  reserve?: (messageId: string) => Interjection | undefined
  /** remind 로 끼워 넣은 알림의 메시지 id — 사람의 말이 아니라 답 없음(unanswered)에 안 싣는다 */
  reminders: Set<string>
}

export interface TurnOutcome {
  ok: boolean
  text: string
  error?: string
  usage?: TurnUsage
  interrupted?: boolean
  declined?: boolean
}

export interface EngineEvent {
  type: string
  properties: Record<string, unknown>
}

export interface CatalogModel {
  id: string
  providerID: string
  api?: { url?: string }
}

export interface LlmConfig {
  /** /event SSE 의 무바이트 한도(ms). 기본 STREAM_IDLE_TIMEOUT_MS, 0 = 없음. 시험이 끊김을 짧게 재현할 때 준다 */
  streamTimeoutMs?: number
}
