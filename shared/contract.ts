// 화면에 실리는 중립 타입 (타입만, 런타임 코드 없음) — 메인·데스크탑 화면·모바일 앱이 한 정의를 쓴다 (이슈 #42, 01t 2절).
// 원래 서비스 파일(turnProgress·toolDiffs·turnUsage·llm·sessions·shell·notifications·projects)에 있던 정의를 그대로 옮겼다.
// 그 파일들은 node:fs·cordis·undici 를 import 해서 모바일 앱(Metro·앱 tsconfig)이 따라 들어갈 수 없다. 원래 자리는 re-export 로 남겼다.
// **여기에 Node·Electron·opencode 를 아는 코드를 넣지 않는다** — 값을 만드는 쪽(opencode 형식 → 이 모양)은 서비스 파일에 그대로 있다.

import type { Mode } from './modes.ts'
import type { SkillSource } from './skills.ts'

/** 파일 하나의 변경. patch 는 unified diff (@@ hunk 들, 앞에 파일 머리가 있을 수 있다) */
export interface FileDiff {
  path: string
  status: 'added' | 'modified' | 'deleted'
  added: number
  removed: number
  patch: string
  /** write 로 덮어써서 이전 내용을 모른다 — patch 는 새 내용 전부를 추가로 */
  unknownBefore?: true
}

/** 진행 줄 하나. 같은 id 의 새 값이 오면 통째로 바꾼다 (누적 전체를 싣는다 — 조각을 놓쳐도 화면이 틀어지지 않는다) */
export type TurnItem =
  | { kind: 'think'; id: string; text: string; done: boolean }
  | { kind: 'text'; id: string; text: string; done: boolean }
  /** summary: 도구가 무엇을 하는지 한 줄 (bash 는 description, 없으면 command 등). input 은 인자 JSON, result 는 결과 글 */
  | { kind: 'tool'; id: string; name: string; status: 'preparing' | 'running' | 'done' | 'error'; summary?: string; input?: string; result?: string; error?: string; diffs?: FileDiff[]; skill?: ToolSkill; mcp?: McpToolRef }
  /** 대화 중 지시문(AGENTS.md 등)이 바뀌었다 — opencode 에 도구 목록 변화 이력은 없다 (01e) */
  | { kind: 'context'; id: string; text: string }
  /** 엔진이 앞 대화를 요약(자동 압축)한다 — running 동안 "요약 중", done 이면 그 자리에 구분선, failed(요약 요청 실패 — ended 없이 스텝이
   *  이어졌다)는 그리지 않는다 (01o) */
  | { kind: 'compaction'; id: string; status: 'running' | 'done' | 'failed' }
  /** LLM 요청이 재시도할 수 있는 오류(500 등)로 실패해 엔진이 다시 보내려고 기다린다 — waiting 동안 "재시도 중 (n번째)", 다시 보내면 done
   *  (그리지 않는다). 레거시는 5번까지 재시도한다(합계 ~71초, 01w) */
  | { kind: 'retry'; id: string; attempt: number; message: string; status: 'waiting' | 'done' }
  /** 하위 작업 (task 도구 — 엔진이 자식 세션에서 따로 돌린다). items 는 그 자식의 진행 줄(생각·도구·글), tokens 는 자식 스텝 토큰 합(입력+출력+생각+캐시).
   *  startedAt·endedAt 은 엔진 시각(ms) — 진행 중이면 화면이 startedAt 부터 초를 센다 */
  | Subtask

export interface Subtask {
  kind: 'subtask'
  id: string
  /** 하위 에이전트 이름 (general·explore·general-ask …) — 준비 중엔 빈 글 */
  agent: string
  /** AI 가 붙인 짧은 설명 */
  description: string
  /** stopped: 부모 턴을 멈춰 엔진이 취소했다 (실패가 아니다) */
  status: 'preparing' | 'running' | 'done' | 'error' | 'stopped'
  startedAt?: number
  endedAt?: number
  error?: string
  tokens?: number
  items: TurnItem[]
}

/** skill 도구 줄 (이슈 #7) — 부른 스킬 이름과 출처(배지). 출처는 끝난 결과의 metadata.dir 로 안다 — 그 전엔 없다 */
export interface ToolSkill {
  name: string
  source?: SkillSource
}

/** MCP 도구 호출의 서버·도구 (이슈 #28) — 화면이 "MCP · 서버 · 도구" 로 그린다 */
export interface McpToolRef {
  server: string
  tool: string
}

export interface TurnUsage {
  /** step.ended + step.failed 수 */
  steps: number
  /** 스텝 합. input 은 캐시 안 된 입력 */
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  /** 스텝마다 첫 출력 → 스텝 끝의 합 */
  llmMs: number
  /** 도구 호출 → 결과의 합 */
  toolMs: number
  /** 첫 토큰까지 걸린 시간의 합과 그 표본 수 — 평균은 위층이 대화 단위로 낸다 */
  ttftMs: number
  ttftSteps: number
  /** 마지막 스텝의 컨텍스트 크기 (프롬프트 + 출력) */
  lastContextTokens: number
  /** 그중 대화 메시지 몫 — 추정치 (messageTokens). 못 구하면 없다 */
  messageTokens?: number
}

/** 턴이 기다리는 사람의 답 하나 — 승인 요청(권한) 또는 AI 의 질문. 화면이 카드로 그리고 reply 로 답한다 */
export type Attention = PermissionAttention | QuestionAttention

export interface PermissionAttention {
  kind: 'permission'
  /** 답할 때 쓰는 요청 id (per_…) */
  id: string
  /** 요청한 엔진 세션 — 하위 작업이 물으면 그 자식 세션이다 (reply 에 그대로 넘긴다) */
  sessionId: string
  /** 하위 작업(자식 세션)이 물었다 — 카드에 어느 하위 작업인지 보인다 */
  subtask?: AttentionSubtask
  /** opencode 권한 이름 — bash·edit·read·external_directory·webfetch 등 */
  action: string
  /** 명령·파일·폴더 패턴 (edit 요청엔 diff 가 없다 — 01f 1-c) */
  resources: string[]
  /** MCP 도구 실행 요청이면 그 서버·도구 (action 이 `<서버>_<도구>`, 이슈 #28) */
  mcp?: McpToolRef
  /** MCP 도구 요청의 인자 (JSON) — 묻는 이벤트에는 없어 그 도구 호출(callID)의 진행 줄에서 이어 붙인다 (이슈 #55). 못 찾으면 없다 */
  input?: string
}

export interface QuestionAttention {
  kind: 'question'
  /** que_… */
  id: string
  sessionId: string
  subtask?: AttentionSubtask
  questions: AttentionQuestion[]
}

/** 승인·질문을 낸 하위 작업 — 하위 에이전트 이름과 AI 가 붙인 설명 */
export interface AttentionSubtask {
  agent: string
  description: string
}

/** opencode QuestionV2Info (01i 2-a) */
export interface AttentionQuestion {
  question: string
  header?: string
  options: { label: string; description?: string }[]
  /** 여럿 고르기 */
  multiple?: boolean
}

/** 카드의 답 — 권한: 'once'(한 번 허용)|'reject'. 질문: 질문 순서대로 고른(또는 쓴) 답 목록, 또는 'reject'. "항상 허용" 은 없다(사용자 결정) */
export type AttentionAnswer = 'once' | 'reject' | string[][]

/** 첨부 종류 (이슈 #44) — file: 글 파일(본문에 `@경로` 나 글로 풀려 간다), image: png·jpeg (엔진에 이미지로 간다) */
export type AttachmentKind = 'file' | 'image'

/** 말풍선·입력 카드의 첨부 칩 하나 — 이름과(알면) 크기뿐. 파일 내용·data: 주소는 화면으로 넘기지 않는다 */
export interface Attachment {
  kind: AttachmentKind
  /** 파일 이름 (경로 없이) */
  name: string
  /** 바이트 — 다시 연 대화의 이미지 칩엔 없다 */
  size?: number
}

/** 입력 카드에 붙여 둔(아직 안 보낸) 첨부 — 화면은 경로만 들고, 읽기는 보낼 때 메인이 한다 */
export interface PickedAttachment extends Attachment {
  /** OS 파일 고르기가 준 절대 경로 */
  path: string
  size: number
}

/** 파일 고르기의 결과 — 칩이 된 것과, 칩을 만들지 않은 사유(지금 언어, 파일마다 한 줄) */
export interface AttachmentPick {
  picked: PickedAttachment[]
  rejected: string[]
}

/** 다른 대화가 보낸 지시의 출처 (이슈 #55) — 보낸 대화의 앱 id 와 보낸 그때의 제목. 보낸 대화가 지워져도 제목은 남는다 */
export interface MessageOrigin {
  conversationId: string
  title: string
}

/** 지난 대화의 말풍선 하나 (중립 모양 — 화면은 opencode 메시지 형식을 모른다). assistant 의 error 는 실패·중단 사유 */
export interface HistoryMessage {
  /** 엔진 메시지 id (user 만) — chat 에 messageId 로 넘긴 값이 그대로 온다 */
  id?: string
  role: 'user' | 'assistant'
  text: string
  error?: string
  /** user: 보낸 시각(ms) */
  at?: number
  /** user: 이 턴을 돌린 모드 (그 턴 답의 에이전트, 없으면 앞서 바꾼 에이전트) — 화면이 모드가 바뀐 자리에 구분선을 긋는다 */
  mode?: Mode
  /** user: 이 메시지에 붙인 파일·이미지 칩 (이슈 #44) */
  attachments?: Attachment[]
  /** user: 사람이 친 글이 아니라 다른 대화가 보낸 지시다 (이슈 #55) — 화면이 "다른 대화에서 온 지시" 딱지를 단다 */
  origin?: MessageOrigin
  /** assistant: 그 턴의 진행 줄 (생각·도구·글·지시문) — 실시간 턴의 chat onProgress 와 같은 모양 */
  items?: TurnItem[]
  /** assistant: 그 턴에 걸린 시간(ms) — user 보낸 시각부터 마지막 스텝 완료까지. 끝나지 않았으면 없다 */
  duration?: number
  /** assistant: 끊겨서 끝났다 (error 는 interruptedError()) — 실패와 가른다 */
  interrupted?: boolean
  /** assistant: 승인·질문을 거절해 끝났다 */
  declined?: boolean
}

export interface History {
  messages: HistoryMessage[]
  /** 작업 폴더가 없어 opencode 에 묻지 않았다 */
  missingFolder?: boolean
  /** 불러오지 못한 사유 */
  error?: string
}

/** 끝난 명령 하나 */
export interface ShellResult {
  command: string
  output: string
  /** 종료 코드 — 시그널로 끝났거나 실행이 안 됐으면 null */
  exitCode: number | null
  /** done: 스스로 끝남, stopped: ■ 로 멈춤, timeout: 기한 초과, error: 실행 자체가 안 됨(셸 없음·폴더 없음) */
  status: 'done' | 'stopped' | 'timeout' | 'error'
  /** 출력이 OUTPUT_LIMIT 에서 잘렸다 */
  truncated: boolean
  error?: string
}

/** 대화 하나의 목록 정보 */
export interface Conversation {
  /** 앱 대화 id */
  id: string
  /** 작업 디렉터리 (ctx.projects 의 path 그대로) */
  project: string
  /** 엔진 세션 id — 첫 메시지를 보낼 때 생긴다 */
  engineSessionId?: string
  title: string
  /** 사용자가 이름을 바꿨다 (이슈 #63) — 그 뒤로 제목은 이름 바꾸기로만 바뀐다 (통째 저장이 덮지 않는다) */
  renamed?: boolean
  /** 마지막 활동 시각(ms) — 목록의 `38min`·`1d` 와 보관 개수 제한의 기준 */
  updatedAt: number
  /** 이 대화에서 고른 모델 */
  model?: { providerId: string; modelId: string }
  /** 이 대화의 모드 (입력창 칩). 없으면 새 대화 기본 모드(설정)를 따른다 — 보낼 때 ctx.llm 이 엔진 세션의 에이전트를 맞춘다 */
  mode?: Mode
  /** 화면이 턴마다 더한 통계 합계 — 모양은 화면(renderer/stats.ts)이 정하고 여기는 그대로 보관한다 */
  usage?: unknown
  /** 엔진 메시지 id → 말풍선에 보일 글. `/` 명령처럼 보낸 본문(풀어 쓴 template)과 사용자가 친 글이 다른 입력만 (label) */
  labels?: Record<string, string>
  /** 엔진 메시지 id → 그 메시지에 붙인 글 파일 칩 (이슈 #44). 글 파일은 본문에 풀려 가서 엔진 기록에 첨부로 안 남는다 — 이미지 칩은 엔진 기록에서 온다 */
  attachments?: Record<string, Attachment[]>
  /** 엔진 메시지 id → 그 지시를 보낸 대화 (이슈 #55). 엔진 기록엔 감싼 글만 있어 다시 열 때 이것으로 딱지를 단다 */
  origins?: Record<string, MessageOrigin>
  /** `!명령` 결과 카드 — opencode 는 모르는 로컬 기록이다(AI 에게 보내기 전까지). 메인만 고친다(addShell·shareShell) */
  shells?: ShellCard[]
}

/** 대화 안의 `!명령` 결과 카드 하나 */
export interface ShellCard extends ShellResult {
  id: string
  /** 실행한 시각(ms) */
  at: number
  /** 대화 안 자리 — 이 카드 앞에 있던 말풍선(내 말·답) 수 */
  position: number
  /** "AI 에게 보내기" 로 맥락에 넣은 엔진 메시지 id — 다시 열 때 그 메시지는 말풍선으로 안 그린다(카드가 대신 "보냄") */
  sharedMessageId?: string
}

/** 대화 행 점 — 답 필요(attention) > 실행 중 > 안 본 끝남(done·failed·interrupted) */
export type ConversationStatus = 'running' | 'attention' | 'done' | 'failed' | 'interrupted'

export interface NoticeEntry {
  /** 그 대화의 프로젝트(작업 폴더) — 프로젝트 전환 버튼·팝오버 점에 쓴다 */
  project: string
  status: ConversationStatus
}

/** 대화 id → 상태. 아무 표시도 없는 대화는 빠진다 */
export type NoticeState = Record<string, NoticeEntry>

export interface Project {
  /** realpath 한 절대 경로 — 식별자이자 작업 디렉터리 */
  path: string
  /** 화면에 보이는 이름 — 붙인 별명, 없으면 폴더 이름 */
  name: string
  /** 홈 아래면 `~/…` 로 줄인 경로 (화면 표시용) */
  displayPath: string
  favorite: boolean
}
