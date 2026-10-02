import { Context, Service } from 'cordis'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Agent } from 'undici'
import { normalizeBaseURL } from './providers.ts'
import { MODE_AGENT, type EngineConnection } from './engine.ts'
import { DEFAULT_MODE, MODES, type Mode } from '../../shared/modes.ts'
import { messageTokens, TurnMeter, type TurnUsage } from './turnUsage.ts'
import { openPty, type TerminalEvents, type TerminalHandle } from './opencodePty.ts'
import { contextText, messageItems, TurnTracker, type TurnItem } from './turnProgress.ts'
import { tr } from '../i18n.ts'
import './engine.ts'

// opencode 를 감싸는 서비스 — 위층(세션·UI)은 이 ctx.llm 키만 알고 opencode 를 직접 모른다.
// 나중에 엔진을 바꾸더라도 이 서비스만 교체하면 된다 (Cordis: 서비스는 키로 찾는다).
//
// opencode 프로토콜은 실측(2026-09-29, opencode 1.x /doc)으로 확인했다 — 신규 세대
// (session.next.*) 이벤트를 쓴다 (Q1=G2 결정).
// 흐름: POST /api/session 으로 세션을 만들고, GET /api/session/{id}/event (SSE) 를
// 먼저 구독한 뒤 POST /api/session/{id}/prompt 로 프롬프트를 밀어 넣는다 — 순서가
// 바뀌면(구독 전에 prompt) 초반 이벤트를 놓친다.
// 텍스트는 session.next.text.ended 의 data.text 에 완성된 조각으로 온다(델타 아님).
// 턴 종료는 session.next.step.ended(finish !== 'tool-calls') 또는
// session.next.step.failed. 그리고 앱이 거절한 도구의 session.next.tool.failed — 권한·질문 거절은 그것 하나로 끝나고 step.* 가 안 온다
// (01f 1-d 6/6, 01i 2-c 5/5).
//
// 승인 요청(권한)·AI 질문(question 도구)은 세션 SSE 에 안 온다 (01f 1-c) — 턴 동안 전역 /api/event 의 permission.*·question.* 를 신호로,
// 정본 목록(GET /api/session/{id}/permission·question)을 다시 읽어 카드(onAttention)와 'llm/attention*' 이벤트로 낸다. 답은 reply.
//
// 모드 = opencode 에이전트 (ctx.engine 이 정의, MODE_AGENT). 세션을 만들 때·이어갈 때 그 에이전트로 맞춘다 — 없는 이름도 opencode 는 받고
// 모든 도구 허용으로 돌므로 /api/agent 목록에 나올 때까지 확인한다 (01f).
//
// opencode 서버는 ctx.engine 이 띄우고 관리한다 — 여기서는 주소·인증(connection())만 받아 모든 요청에 싣는다.
// 서버가 재시작·크래시로 끝나면 진행 중 턴은 끝 이벤트 없이 사라진다(01_probe Q3) → connection().closed 를 보고 "중단됨" 으로 끝낸다.
//
// 작업 디렉터리: 한 opencode 서버에서 세션마다 location.directory 를 준다 — 도구 cwd·시스템 프롬프트의 작업 디렉터리·
// 그 폴더의 AGENTS.md·opencode.json 이 전부 그 폴더 기준이 되고, 동시에 돌려도 안 섞인다 (2026-09-30 실측,
// _workspace/01_probe.md Q1).

declare module 'cordis' {
  interface Context {
    llm: LlmService
  }
  interface Events {
    /** 프롬프트가 엔진에 받아들여졌다 (턴 하나에 한 번). directory 는 chat 에 넘긴 프로젝트 폴더 그대로 */
    'llm/turn-started'(info: TurnInfo): void
    /** 받아들여진 턴이 끝났다 (started 마다 정확히 한 번). 받아들여지기 전에 거절된 턴(모델 없음 등)은 둘 다 안 나간다 */
    'llm/turn-ended'(info: TurnInfo & { outcome: 'done' | 'failed' | 'interrupted'; error?: string }): void
    /** 턴이 사람을 기다린다 — 승인 요청(permission)이나 AI 의 질문(question). 요청마다 한 번. title 은 짧은 설명(명령·질문 문장) */
    'llm/attention'(info: TurnInfo & { kind: Attention['kind']; title: string }): void
    /** 그 세션에 기다리는 것이 더는 없다 (답했다). 턴이 끝나면 따로 안 나간다 — turn-ended 가 덮는다 */
    'llm/attention-resolved'(info: TurnInfo): void
  }
}

/** 턴이 기다리는 사람의 답 하나 — 승인 요청(권한) 또는 AI 의 질문. 화면이 카드로 그리고 reply 로 답한다 */
export type Attention = PermissionAttention | QuestionAttention

export interface PermissionAttention {
  kind: 'permission'
  /** 답할 때 쓰는 요청 id (per_…) */
  id: string
  sessionId: string
  /** opencode 권한 이름 — bash·edit·read·external_directory·webfetch 등 */
  action: string
  /** 명령·파일·폴더 패턴 (edit 요청엔 diff 가 없다 — 01f 1-c) */
  resources: string[]
}

export interface QuestionAttention {
  kind: 'question'
  /** que_… */
  id: string
  sessionId: string
  questions: AttentionQuestion[]
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

/** GET /api/session/{id}/message 의 메시지 중 우리가 읽는 필드 (01c Q2 실측) */
interface OpencodeMessage {
  id?: string
  type: string
  text?: string
  /** assistant: 그 메시지를 낸 에이전트. agent-switched: 바꾼 에이전트 (01k) */
  agent?: string
  time?: { created?: number; completed?: number }
  content?: Parameters<typeof messageItems>[1][number][]
  error?: { message?: string }
}

// /message 의 limit 상한은 200 이다 — 넘기면 400 InvalidRequestError, 안 주면 50 (2026-10-01 실측, opencode 1.18.18, 메시지 260개 세션).
// 상한보다 낮게 잡고 cursor 로 끝까지 넘긴다
const MESSAGE_PAGE = 100

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

interface TurnOutcome {
  ok: boolean
  text: string
  error?: string
  usage?: TurnUsage
  interrupted?: boolean
  declined?: boolean
}

interface OpencodeEventEnvelope {
  type: string
  durable?: { seq?: number }
  data: Record<string, unknown>
}

interface CatalogModel {
  id: string
  providerID: string
  api?: { url?: string }
}

export const MODEL_CATALOG_TIMEOUT_MS = 10_000
/** 에이전트 목록도 지연 로드된다(01f: 첫 응답 빈 목록, ~1.5초) — 모델 카탈로그와 같은 기한 */
export const AGENT_LIST_TIMEOUT_MS = 10_000
/** 엔진 재시작·크래시로 끊긴 턴의 사유 — 지금 언어로 (그래서 상수가 아니다. 중단 판정은 문구가 아니라 interrupted 로 한다) */
export function interruptedError(): string {
  return tr('error.interrupted')
}

export interface LlmConfig {
  /** 세션 SSE 의 무바이트 한도(ms). 0 = 없음(기본). 시험이 끊김을 짧게 재현할 때만 준다 */
  streamTimeoutMs?: number
}

export class LlmService extends Service {
  static readonly inject = ['providers', 'engine']

  /** 답을 기다리는 턴 수 — DB 정리는 0 일 때만 돈다 (정리 잠금이 길면 그 사이 opencode 쓰기가 실패한다, 01_probe) */
  private turns = 0
  private purgeWanted = false
  /** 턴이 도는 세션 — addContext 가 막는다 */
  private busy = new Set<string>()
  /** 기다리는 요청 id → 그 세션·종류·도구 호출 (reply 가 쓴다). 턴이 끝나면 지운다 */
  private requests = new Map<string, { sessionId: string; kind: Attention['kind']; callID?: string }>()
  /** 턴이 도는 세션 → 앱이 거절한 도구 호출 id. 그 호출의 tool.failed 가 그 턴의 끝이다 */
  private declined = new Map<string, Set<string>>()
  /** 턴이 도는 세션 → 그 턴의 대기 목록 (reply 가 답한 요청을 바로 뺀다) */
  private watchers = new Map<string, { answered(requestId: string): void }>()

  /** 세션 SSE 를 여는 dispatcher. 전역 fetch(undici) 기본 bodyTimeout·headersTimeout 은 300초인데 세션 SSE 는 스텝의 LLM 스트림·도구 실행·
   *  승인 대기 동안 0바이트라 그보다 오래 조용하면 끊긴다 (01q, 재현함). 끊김 감지는 시간이 아니라 엔진 생존(conn.closed)으로 한다.
   *  undici 는 Electron 33 메인의 Node 20.18.3 내장(6.21.1)과 같은 버전을 쓴다 */
  private streamDispatcher: Agent

  constructor(ctx: Context, config: LlmConfig = {}) {
    super(ctx, 'llm')
    const timeout = config.streamTimeoutMs ?? 0
    this.streamDispatcher = new Agent({ bodyTimeout: timeout, headersTimeout: timeout })
    ctx.effect(() => () => void this.streamDispatcher.close().catch(() => {}))
  }

  // model 을 꼭 명시한다 — {} 로 보내면 opencode 가 opencode.json 의 model 을 무시하고 models.dev 카탈로그의
  // 외부 provider(실측: nano-gpt/...)로 세션을 만들 때가 있다 (2026-09-30 실측, 5회 중 2~5회).
  // 우리 provider/모델 id 를 opencode 의 providerID/모델 id 로 그대로 쓴다 — 매핑 설정 화면이 생기면 이 자리만 바꾼다.
  private async createSession(conn: EngineConnection, providerId: string, modelId: string, directory: string, agent?: string): Promise<string> {
    const res = await fetch(`${conn.url}/api/session`, {
      method: 'POST',
      headers: { ...conn.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ model: { providerID: providerId, id: modelId }, location: { directory }, ...(agent && { agent }) }),
    })
    if (!res.ok) throw new Error(tr('error.sessionCreate', { status: res.status }))
    const body = (await res.json()) as { data: { id: string } }
    return body.data.id
  }

  // 세션을 만들기 전에 opencode 모델 카탈로그에 그 모델이 있는지 본다. 두 가지 이유 (2026-09-30 실측):
  // - 카탈로그는 GET /api/model·/api/provider 가 처음 불릴 때에야 로드된다(지연 로드). 로드 전에 프롬프트가 오면
  //   opencode 는 로그에만 ModelUnavailableError("Failed to drain Session")를 남기고 턴을 버린다 — SSE 에는
  //   step.failed 도 없이 prompt.admitted·prompted 뒤로 아무것도 안 와서 턴이 영원히 멈춘다.
  //   빈도 (opencode 1.18.18): 준비 없이 첫 턴 5회 중 1회만 완료, /api/model·/api/provider 선호출 후 10회 중 10회 완료.
  //   목록은 세 단계로 바뀐다: 빈 목록(로드 시작, 첫 조회) → models.dev 원본 8306개(설정 provider 가 **없다**) →
  //   설정 반영 목록. "비어 있지 않음" 을 완료로 보면 가운데 목록에서 있는 모델도 없다고 판단한다 — 그래서
  //   **찾는 모델이 나올 때까지** 다시 묻는다. 이 머신에서 설정 반영까지 0.7~1.1초(5회 기동).
  // - 없는 providerID/모델이어도 세션 생성은 200 으로 성공하고 같은 식으로 멈춘다 — 기한까지 안 나오면 없다고 본다.
  //   기한은 실측 최대의 ~10배. 느린 머신의 콜드 스타트에서 있는 모델을 거절하는 쪽이 설정 오류를 늦게 알리는 쪽보다 나쁘다.
  // - 이어가는 턴도 매번 확인한다 (리더 결정 2026-09-30): 설정 적용으로 opencode 가 재시작되면 카탈로그가 다시 지연 로드되고,
  //   폴더 opencode.json 도 다시 읽혀 주소가 바뀌었을 수 있다 (아래 주소 대조).
  // - 카탈로그는 디렉터리별이다(전역 설정 + 그 폴더의 opencode.json) — 세션을 만들 폴더의 카탈로그를 본다.
  private async waitForModel(conn: EngineConnection, providerId: string, modelId: string, directory: string): Promise<CatalogModel | undefined> {
    const deadline = Date.now() + MODEL_CATALOG_TIMEOUT_MS
    while (true) {
      const models = await this.listModels(conn, directory)
      const found = models.find((model) => model.providerID === providerId && model.id === modelId)
      if (found) return found
      if (Date.now() >= deadline) return undefined
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  // 쿼리 이름은 `location[directory]` (deepObject). 틀린 이름(`?directory=`)이면 opencode 는 200 에 서버 cwd 의
  // 카탈로그를 조용히 준다 (2026-09-30 실측) — llm.live.test.ts 의 "폴더에만 있는 모델" 시나리오가 이것을 지킨다.
  private async listModels(conn: EngineConnection, directory: string): Promise<CatalogModel[]> {
    const query = new URLSearchParams({ 'location[directory]': directory })
    const res = await fetch(`${conn.url}/api/model?${query}`, { headers: conn.headers })
    if (!res.ok) throw new Error(tr('error.modelList', { status: res.status }))
    return ((await res.json()) as { data: CatalogModel[] }).data
  }

  // 모드의 에이전트가 그 폴더의 에이전트 목록에 있는지 — **없는 이름도 opencode 는 세션 생성 200·전환 204 로 받고 모든 도구 허용 + 기본
  // system 없이 돌린다** (01f — 오타가 곧 전체 권한). 목록은 지연 로드라 첫 응답이 빈 목록일 수 있다(01f ~1.5초, 01k 는 바로 옴) — 모델처럼
  // 나올 때까지 묻는다. subagent·hidden 은 primary 로 못 쓴다
  private async waitForAgent(conn: EngineConnection, agent: string, directory: string): Promise<boolean> {
    const deadline = Date.now() + AGENT_LIST_TIMEOUT_MS
    const query = new URLSearchParams({ 'location[directory]': directory })
    while (true) {
      const res = await fetch(`${conn.url}/api/agent?${query}`, { headers: conn.headers })
      if (!res.ok) throw new Error(tr('error.agentList', { status: res.status }))
      const agents = ((await res.json()) as { data: { id: string; mode?: string; hidden?: boolean }[] }).data
      if (agents.some((entry) => entry.id === agent && entry.mode !== 'subagent' && !entry.hidden)) return true
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  // 이어가는 세션의 모델 바꾸기 — prompt 본문엔 model 이 없고(additionalProperties:false), 이 호출(204)이 다음 턴부터 바꾼다.
  // 앞 턴 맥락은 그대로 실린다 (2026-10-01 실측 5/5, _workspace/01_probe.md). 세션의 지금 모델은 GET 으로 본다 — SSE 의
  // model.switched 가 이전 턴 step.started 보다 먼저 올 수 있어 이벤트 순서로 추론하지 않는다.
  // opencode 는 모델이 있는지 검증하지 않는다(없어도 204, 다음 턴이 step.* 없이 매달린다) — 그래서 chat 이 모델·주소 확인을
  // 통과한 뒤에만 부른다.
  // 에이전트(모드)도 같은 자리에서 맞춘다 — POST /api/session/{id}/agent(204)는 다음 스텝부터 먹고 기록에 agent-switched 를 남긴다 (01k 5/5).
  // agent 를 안 주고 만든 세션엔 agent 필드가 없다 = build. agent 를 안 넘기면(addContext) 에이전트는 그대로 둔다
  private async alignSession(conn: EngineConnection, sessionId: string, providerId: string, modelId: string, agent?: string): Promise<void> {
    const res = await fetch(`${conn.url}/api/session/${sessionId}`, { headers: conn.headers })
    if (!res.ok) throw new Error(tr('error.sessionRead', { status: res.status }))
    const current = ((await res.json()) as { data: { model?: { providerID?: string; id?: string }; agent?: string } }).data
    if (current.model?.providerID !== providerId || current.model.id !== modelId) {
      const switched = await fetch(`${conn.url}/api/session/${sessionId}/model`, {
        method: 'POST',
        headers: { ...conn.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ model: { providerID: providerId, id: modelId } }),
      })
      if (!switched.ok) throw new Error(tr('error.modelSwitch', { status: switched.status }))
    }
    if (agent && (current.agent ?? MODE_AGENT.build) !== agent) {
      const switched = await fetch(`${conn.url}/api/session/${sessionId}/agent`, {
        method: 'POST',
        headers: { ...conn.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ agent }),
      })
      if (!switched.ok) throw new Error(tr('error.agentSwitch', { status: switched.status }))
    }
  }

  /** directory 는 새 세션의 작업 디렉터리(절대 경로). 이어가는 세션(sessionId)은 만들 때 정한 폴더를 따르고, 모델이 다르면
   *  보내기 전에 그 세션의 모델을 바꾼다 — 이어갈 때도 그 세션의 폴더를 넘긴다(모델·주소 확인에 쓴다).
   *  onSession 은 새 세션을 만든 직후, 프롬프트를 보내기 전에 불린다 — 답을 기다리는 중에 앱이 꺼져도 그 대화를 다시 열 수 있게.
   *  messageId(newMessageId)를 주면 이 입력의 엔진 메시지 id 가 그것이 된다 — history 의 id 로 돌아온다.
   *  onProgress 는 턴 중 진행 줄(생각·도구·글)이 바뀔 때마다 불린다 — 화면의 실시간 진행 표시용. 턴 끝은 여전히 반환값이 정본이다.
   *  mode 는 이 턴을 돌릴 모드 — 엔진 세션의 에이전트를 그것으로 맞추고 보낸다(이어가는 세션도). 안 주면 기본 모드.
   *  onAttention 은 턴이 기다리는 승인·질문 목록이 바뀔 때마다 (빈 목록 = 더 기다리는 것 없음) — 화면의 카드. 답은 reply */
  async chat(
    providerId: string,
    modelId: string,
    directory: string,
    prompt: string,
    sessionId?: string,
    onSession?: (sessionId: string) => Promise<void>,
    messageId?: string,
    onProgress?: (item: TurnItem) => void,
    mode: Mode = DEFAULT_MODE,
    onAttention?: (requests: Attention[]) => void,
  ): Promise<ChatResult> {
    this.turns++
    /** busy: 이 턴이 쥔 세션(addContext 를 막는다), sessionId: 받아들여진 턴의 세션 — 그때만 turn-started/ended 를 낸다 */
    const admitted: { busy?: string; sessionId?: string } = {}
    try {
      const result = await this.turn(providerId, modelId, directory, prompt, sessionId, onSession, messageId, onProgress, admitted, mode, onAttention)
      const interrupted = !result.ok && !!result.interrupted
      if (admitted.sessionId) {
        this.ctx.emit('llm/turn-ended', {
          sessionId: admitted.sessionId,
          directory,
          outcome: result.ok ? 'done' : interrupted ? 'interrupted' : 'failed',
          ...(result.error !== undefined && { error: result.error }),
        })
      }
      return result
    } finally {
      if (admitted.busy) this.busy.delete(admitted.busy)
      this.turns--
      this.purgeIfIdle()
    }
  }

  /** 세션을 쓸 준비 — 매 턴 보내기 전에 그 폴더 카탈로그로 모델·주소를 보고, 이어가는 세션은 모델(과 모드를 주면 에이전트)을 맞추고,
   *  없으면 만든다. 이어가는 세션도 directory(그 대화의 프로젝트)로 본다 */
  private async prepare(
    conn: EngineConnection,
    providerId: string,
    modelId: string,
    directory: string,
    sessionId: string | undefined,
    onSession?: (sessionId: string) => Promise<void>,
    mode?: Mode,
  ): Promise<{ id: string } | { error: string }> {
    const workdir = await realDirectory(directory)
    if (!workdir) return { error: tr('error.noWorkdir', { dir: directory }) }
    const model = await this.waitForModel(conn, providerId, modelId, workdir)
    if (!model) return { error: tr('error.noModel', { provider: providerId, model: modelId }) }
    // 세션 폴더의 opencode.json 은 우리 provider 의 baseURL 까지 덮는다 — 그러면 프롬프트(와 프록시 토큰)가 그 주소로 간다.
    // OPENCODE_DISABLE_PROJECT_CONFIG 로는 못 막는다 — 대신 그 폴더 카탈로그의 api.url 에 덮인 주소가 보인다 (01_probe Q4, 5/5).
    // 우리가 적은 주소는 키 프록시 주소다 (engine.ts)
    if (normalizeBaseURL(model.api?.url ?? '') !== normalizeBaseURL(conn.providerBaseURL(providerId))) {
      return { error: tr('error.baseUrlOverridden', { url: String(model.api?.url) }) }
    }
    const agent = mode && MODE_AGENT[mode]
    if (agent && !(await this.waitForAgent(conn, agent, workdir))) return { error: tr('error.noAgent', { agent }) }
    if (sessionId) {
      await this.alignSession(conn, sessionId, providerId, modelId, agent)
      return { id: sessionId }
    }
    const id = await this.createSession(conn, providerId, modelId, workdir, agent)
    await onSession?.(id)
    return { id }
  }

  /** 대화 맥락에만 넣는다 — LLM 을 돌리지 않고 입력만 저장해 다음 턴에 실린다(`resume:false`, 01d). `!` 카드의 "AI 에게 보내기".
   *  **그 세션의 턴이 도는 중이면 거절한다**: 그때 넣으면 진행 중 턴에 끼어들어 모델이 답하거나(steer) 턴 뒤 새 턴이 저절로 돈다
   *  (queue) — 01h §4.2, 각 5/5. 세션이 없으면 만든다(onSession). messageId 는 newMessageId — 다시 열 때 이 입력을 가려낸다 */
  async addContext(
    providerId: string,
    modelId: string,
    directory: string,
    text: string,
    messageId: string,
    sessionId?: string,
    onSession?: (sessionId: string) => Promise<void>,
  ): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
    if (sessionId && this.busy.has(sessionId)) return { ok: false, sessionId, error: tr('error.contextBusy') }
    if (!this.ctx.providers.get(providerId)) return { ok: false, sessionId, error: tr('error.noProvider', { id: providerId }) }
    let id = sessionId
    try {
      const conn = await this.ctx.engine.connection()
      const ready = await this.prepare(conn, providerId, modelId, directory, sessionId, onSession)
      if ('error' in ready) return { ok: false, sessionId, error: ready.error }
      id = ready.id
      if (this.busy.has(id)) return { ok: false, sessionId: id, error: tr('error.contextBusy') }
      const res = await fetch(`${conn.url}/api/session/${id}/prompt`, {
        method: 'POST',
        headers: { ...conn.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ id: messageId, prompt: { text }, resume: false }),
      })
      if (!res.ok) return { ok: false, sessionId: id, error: tr('error.contextAdd', { status: res.status }) }
      return { ok: true, sessionId: id }
    } catch (error) {
      return { ok: false, sessionId: id, error: tr('error.opencodeConnect', { message: (error as Error).message }) }
    }
  }

  private async turn(
    providerId: string,
    modelId: string,
    directory: string,
    prompt: string,
    sessionId: string | undefined,
    onSession: ((sessionId: string) => Promise<void>) | undefined,
    messageId: string | undefined,
    onProgress: ((item: TurnItem) => void) | undefined,
    admittedTurn: { busy?: string; sessionId?: string },
    mode: Mode,
    onAttention: ((requests: Attention[]) => void) | undefined,
  ): Promise<ChatResult> {
    const provider = this.ctx.providers.get(providerId)
    if (!provider) return { ok: false, error: tr('error.noProvider', { id: providerId }) }

    let conn: EngineConnection | undefined
    let id = sessionId
    try {
      conn = await this.ctx.engine.connection()
      const ready = await this.prepare(conn, providerId, modelId, directory, id, onSession, mode)
      if ('error' in ready) return { ok: false, sessionId: id, error: ready.error }
      id = ready.id
      const turnSession = id
      this.busy.add(id) // addContext 가 이 세션을 막는다 (prompt 보내기 전부터 — 그 사이에 끼어들지 않게)
      admittedTurn.busy = id
      const declined = new Set<string>()
      this.declined.set(id, declined)

      let admitted!: (seq: number) => void
      const tracker = new TurnTracker()
      const report = (item: TurnItem | undefined) => {
        if (item) onProgress?.(item)
      }
      const events = this.subscribe(conn, id, new Promise<number>((resolve) => (admitted = resolve)), tracker, report, declined)
      const attention = this.watchAttention(conn, id, directory, onAttention)
      // 조각(생각·글이 쓰이는 중)과 승인·질문 요청은 전역 스트림에만 온다. 조각은 장식이다: 끊기거나 실패해도 턴은 세션 SSE 로 끝난다 (01g).
      // 요청은 신호로만 쓰고 정본 목록을 다시 읽는다 — 구독이 붙기 전에 생긴 요청도 붙은 직후 한 번 읽어 잡는다 (01f 1-c)
      const global = this.followGlobal(conn, id, (event) => {
        if (event.type.endsWith('.delta')) {
          if (onProgress) report(tracker.observe(event.type, event.data))
        } else if (event.type.startsWith('permission.') || event.type.startsWith('question.')) attention.refresh()
      }, () => attention.refresh())
      try {
        const admit = await fetch(`${conn.url}/api/session/${id}/prompt`, {
          method: 'POST',
          headers: { ...conn.headers, 'content-type': 'application/json' },
          body: JSON.stringify({ ...(messageId && { id: messageId }), prompt: { text: prompt } }),
        }).catch((error: unknown) => {
          events.stop()
          throw error
        })
        if (!admit.ok) {
          events.stop()
          return { ok: false, sessionId: id, error: tr('error.promptSend', { status: admit.status }) }
        }
        admitted(((await admit.json()) as { data: { admittedSeq: number } }).data.admittedSeq)
        admittedTurn.sessionId = id
        this.ctx.emit('llm/turn-started', { sessionId: id, directory })

        const result = await events.result
        const usage = result.usage && { ...result.usage, messageTokens: await this.messageTokens(conn, id) }
        return {
          ok: result.ok,
          sessionId: id,
          text: result.text,
          error: result.error,
          usage,
          ...(result.interrupted && { interrupted: true }),
          ...(result.declined && { declined: true }),
        }
      } finally {
        global()
        attention.stop()
        this.declined.delete(turnSession)
      }
    } catch (error) {
      if (conn?.closed.aborted) return { ok: false, sessionId: id, error: interruptedError(), interrupted: true }
      return { ok: false, sessionId: id, error: tr('error.opencodeConnect', { message: (error as Error).message }) }
    }
  }

  /** chat 에 넘길 새 메시지 id. opencode 는 클라이언트가 정한 id 를 그대로 쓴다(`^msg_` 면 된다, 같은 id 두 번은 409) —
   *  `/` 명령처럼 보낸 본문과 보일 글이 다를 때, 앱이 이 id 로 보일 글을 따로 적어 둔다 (01d "말풍선 문제") */
  newMessageId(): string {
    return `msg_litecode_${randomUUID().replaceAll('-', '')}`
  }

  // 입력 트리거용 목록 (01d). 쿼리 이름은 모두 `location[directory]` — 틀리면 서버 cwd 기준으로 조용히 온다. 폴더는 chat 과 같은
  // realDirectory 를 거친다(없는 경로를 opencode 에 넘기면 그 경로가 재시작 전까지 500 이 된다 — 01c Q5)

  /** 퍼지 검색 (opencode 기본 상한 50). 새 파일은 몇 초 뒤에야 잡힌다 */
  async findFiles(directory: string, query: string, limit: number, signal?: AbortSignal): Promise<FileEntry[]> {
    return this.engineGet<FileEntry[]>('/api/fs/find', directory, { query, limit: String(limit) }, signal)
  }

  /** 폴더 바로 아래 (rel 은 프로젝트 기준 상대 경로, 빈 글자면 맨 위). 숨김·무시 파일도 다 온다. 폴더 밖은 opencode 가 500 */
  async listDirectory(directory: string, rel: string, signal?: AbortSignal): Promise<FileEntry[]> {
    return this.engineGet<FileEntry[]>('/api/fs/list', directory, rel ? { path: rel } : {}, signal)
  }

  /** 그 폴더의 명령. 새 폴더의 첫 호출은 빈 배열이라(0.1~0.3초 뒤 채워진다, 01d) 비면 잠깐 뒤 한 번 더 묻는다. 캐시하지 않는다 */
  async listCommands(directory: string): Promise<EngineCommand[]> {
    const first = await this.engineGet<EngineCommand[]>('/api/command', directory)
    if (first.length > 0) return first
    await new Promise((resolve) => setTimeout(resolve, 300))
    return this.engineGet<EngineCommand[]>('/api/command', directory)
  }

  /** 그 폴더에서 셸 하나를 띄워 붙는다 (opencode pty — opencodePty.ts) */
  async openTerminal(directory: string, on: TerminalEvents): Promise<TerminalHandle> {
    const workdir = await realDirectory(directory)
    if (!workdir) throw new Error(tr('error.noWorkdir', { dir: directory }))
    return openPty(await this.ctx.engine.connection(), workdir, on)
  }

  private async engineGet<T>(route: string, directory: string, params: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
    const workdir = await realDirectory(directory)
    if (!workdir) throw new Error(tr('error.noWorkdir', { dir: directory }))
    const conn = await this.ctx.engine.connection()
    const query = new URLSearchParams({ 'location[directory]': workdir, ...params })
    const res = await fetch(`${conn.url}${route}?${query}`, { headers: conn.headers, signal })
    if (!res.ok) throw new Error(tr('error.engineRoute', { route, status: res.status }))
    return ((await res.json()) as { data: T }).data
  }

  /** 지난 대화의 말풍선. directory 는 그 세션의 작업 폴더 — 없으면 opencode 에 묻지 않는다: 폴더가 없어진 세션은 내용 요청이
   *  500 이고, 한 번 실패한 경로는 폴더를 되살려도 opencode 를 재시작할 때까지 계속 500 이다 (01c Q5). 재시작 뒤에도 내용은
   *  그대로 온다(01c Q2) — 이벤트 재생 대신 조립된 메시지 목록을 쓴다.
   *  hidden 은 말풍선으로 안 그릴 엔진 메시지 id — addContext 로 넣은 `!` 카드 본문 (카드는 앱이 따로 그린다) */
  async history(directory: string, sessionId: string, hidden: ReadonlySet<string> = new Set()): Promise<History> {
    if (!(await realDirectory(directory))) return { messages: [], missingFolder: true }
    try {
      const conn = await this.ctx.engine.connection()
      const raw = await this.readMessages(conn, sessionId)
      const active = await fetch(`${conn.url}/api/session/active`, { headers: conn.headers })
      if (!active.ok) throw new Error(tr('error.activeSessions', { status: active.status }))
      const running = sessionId in ((await active.json()) as { data: Record<string, unknown> }).data
      return { messages: historyMessages(raw.filter((message) => !message.id || !hidden.has(message.id)), running) }
    } catch (error) {
      return { messages: [], error: tr('error.historyLoad', { message: (error as Error).message }) }
    }
  }

  /** 세션의 메시지 전부 (asc). 읽기만 한다 — 화면별 모양 변환(historyMessages 등)은 따로 둔다: 같은 응답을 다른 모양으로 쓸 화면이 있다.
   *  cursor 는 order 와 같이 못 준다(/doc). 마지막 쪽에도 cursor.next 가 오므로 받은 개수 < limit 이거나 빈 쪽이면 끝이다 (01c Q1) */
  async readMessages(conn: EngineConnection, sessionId: string): Promise<OpencodeMessage[]> {
    const messages: OpencodeMessage[] = []
    let query = `order=asc&limit=${MESSAGE_PAGE}`
    while (true) {
      const res = await fetch(`${conn.url}/api/session/${sessionId}/message?${query}`, { headers: conn.headers })
      if (!res.ok) throw new Error(tr('error.messageRead', { status: res.status }))
      const page = (await res.json()) as { data: OpencodeMessage[]; cursor?: { next?: string | null } }
      messages.push(...page.data)
      if (page.data.length < MESSAGE_PAGE || !page.cursor?.next) return messages
      query = new URLSearchParams({ cursor: page.cursor.next, limit: String(MESSAGE_PAGE) }).toString()
    }
  }

  /** 지운 대화의 본문을 DB 파일에서 걷어낸다 (ctx.engine.purgeDeleted). 답을 기다리는 턴이 있으면 다 끝난 뒤로 미룬다 */
  purgeDeleted(): void {
    this.purgeWanted = true
    this.purgeIfIdle()
  }

  private purgeIfIdle(): void {
    if (this.turns > 0 || !this.purgeWanted) return
    this.purgeWanted = false
    void this.ctx.engine.purgeDeleted()
  }

  /** 세션을 지운다. 신규 세대(/api/*)에는 세션 삭제가 없어 **레거시 `DELETE /session/{id}` 를 쓰는 유일한 자리**다 (01c Q3).
   *  레거시 호출이라 CONFIG_DIR 에 npm 설치를 한 번 일으킨다 — 폐쇄망에선 조용히 실패하고 기능 영향은 없다 (01b).
   *  이미 없는 세션(404)은 지워진 것으로 본다. 지운 본문은 DB 의 WAL 에 남는다 (01c Q3) */
  async deleteSession(sessionId: string): Promise<void> {
    const conn = await this.ctx.engine.connection()
    const res = await fetch(`${conn.url}/session/${sessionId}`, { method: 'DELETE', headers: conn.headers })
    if (!res.ok && res.status !== 404) throw new Error(tr('error.sessionDelete', { status: res.status }))
  }

  /** 컨텍스트 중 대화 메시지 몫 (추정). 통계용이라 못 구해도 턴은 그대로 돌려준다 */
  private async messageTokens(conn: EngineConnection, sessionId: string): Promise<number | undefined> {
    try {
      const res = await fetch(`${conn.url}/api/session/${sessionId}/context`, { headers: conn.headers })
      return res.ok ? messageTokens(((await res.json()) as { data: Parameters<typeof messageTokens>[0] }).data) : undefined
    } catch {
      return undefined
    }
  }

  /** SSE 를 구독하고, 턴이 끝나면(성공/실패 모두) 풀리는 결과를 준다.
   *
   *  구독은 그 세션의 과거 이벤트를 seq 1 부터 재생한다 (2026-09-30 실측) — 거르지 않으면 이어가는 세션에서
   *  이전 턴의 step.ended 를 보고 이전 답을 돌려준다. `?after=<seq>` 로 자를 수 있지만 구독을 먼저 걸어야 해서
   *  그 시점엔 이번 턴의 seq 를 모른다. 그래서 프롬프트 응답의 admittedSeq(= 이번 턴 prompt.admitted 의 seq)가
   *  올 때까지 프레임 처리를 미루고, durable.seq 가 그 이하인 이벤트는 버린다. */
  private subscribe(
    conn: EngineConnection,
    sessionId: string,
    admittedSeq: Promise<number>,
    tracker: TurnTracker,
    report: (item: TurnItem | undefined) => void,
    declined: ReadonlySet<string>,
  ): { result: Promise<TurnOutcome>; stop: () => void } {
    const controller = new AbortController()
    const result = (async () => {
      const res = await fetch(`${conn.url}/api/session/${sessionId}/event`, {
        headers: conn.headers,
        signal: AbortSignal.any([controller.signal, conn.closed]), // 서버가 끝나면 읽기를 바로 멈춘다
        dispatcher: this.streamDispatcher,
      } as RequestInit) // dispatcher 는 Node(undici) fetch 확장이라 DOM RequestInit 타입에 없다
      if (!res.ok || !res.body) throw new Error(tr('error.subscribe', { status: res.status }))

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const texts: string[] = []
      const meter = new TurnMeter()

      try {
        while (true) {
          const read = await reader.read().catch((error: unknown) => {
            if (controller.signal.aborted) throw error // 우리가 멈췄다 (stop)
            return undefined // 연결이 잘렸다 (undici: "terminated")
          })
          if (!read || read.done) {
            const error = await interruption(conn.closed)
            // 엔진이 살아 있으면 opencode 의 턴은 계속 돈다 — 그대로 두면 다음 프롬프트가 그 뒤에 줄 서고 이 턴의 답을 받는다(답이 한 칸 밀림, 01q 5/5).
            // interrupt 는 204 후 즉시 idle (01q 10/10)
            if (!conn.closed.aborted) {
              await fetch(`${conn.url}/api/session/${sessionId}/interrupt`, {
                method: 'POST',
                headers: { ...conn.headers, 'content-type': 'application/json' },
                body: '{}',
              }).catch(() => {})
            }
            return { ok: false, text: texts.join(''), error, usage: meter.usage(), interrupted: true }
          }
          const { value } = read
          buffer += decoder.decode(value, { stream: true })

          let frameEnd: number
          while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, frameEnd)
            buffer = buffer.slice(frameEnd + 2)
            const outcome = this.handleFrame(frame, texts, meter, await admittedSeq, tracker, report, declined)
            if (outcome) return outcome
          }
        }
      } finally {
        void reader.cancel().catch(() => {})
      }
    })()
    result.catch(() => {}) // stop() 뒤의 거절은 기다리는 쪽이 없다 — 처리 안 된 거절로 남기지 않는다

    return { result, stop: () => controller.abort() }
  }

  private handleFrame(
    frame: string,
    texts: string[],
    meter: TurnMeter,
    admittedSeq: number,
    tracker: TurnTracker,
    report: (item: TurnItem | undefined) => void,
    declined: ReadonlySet<string>,
  ): TurnOutcome | undefined {
    const event = parseFrame(frame)
    if (!event) return undefined
    if ((event.durable?.seq ?? Infinity) <= admittedSeq) return undefined // 이전 턴의 재생분
    meter.observe(event.type, event.data)
    report(tracker.observe(event.type, event.data))

    if (event.type === 'session.next.text.ended') {
      const text = event.data['text']
      if (typeof text === 'string') texts.push(text)
      return undefined
    }
    if (event.type === 'session.next.step.ended') {
      if (event.data['finish'] === 'tool-calls') return undefined // 다음 스텝이 이어진다
      return { ok: true, text: texts.join(''), usage: meter.usage() }
    }
    if (event.type === 'session.next.step.failed') {
      const error = event.data['error'] as { message?: string } | undefined
      return { ok: false, text: texts.join(''), error: error?.message ?? tr('error.unknown'), usage: meter.usage() }
    }
    // 앱이 거절한 승인·질문 — 그 도구의 tool.failed("Tool execution interrupted") 하나로 끝나고 step.* 가 안 온다 (01f 1-d, 01i 2-c)
    if (event.type === 'session.next.tool.failed' && declined.has(String(event.data['callID']))) {
      return { ok: true, text: texts.join(''), usage: meter.usage(), declined: true }
    }
    return undefined
  }

  /** 승인·질문 대기 목록을 지켜본다. refresh 마다 정본 목록(세션별 permission·question)을 다시 읽어, 바뀌었으면 onAttention 을 부르고
   *  새 요청마다 'llm/attention', 다 풀렸으면 'llm/attention-resolved' 를 낸다. 읽기는 한 줄로 세운다(뒤늦은 응답이 새 목록을 덮지 않게) */
  private watchAttention(
    conn: EngineConnection,
    sessionId: string,
    directory: string,
    onAttention: ((requests: Attention[]) => void) | undefined,
  ): { refresh(): void; stop(): void } {
    let pending: Attention[] = []
    let stopped = false
    /** 목록을 바꾸고 알린다 — 새 요청마다 attention, 다 풀리면 resolved */
    const publish = (next: Attention[]): void => {
      const before = new Set(pending.map((entry) => entry.id))
      const changed = next.length !== pending.length || next.some((entry) => !before.has(entry.id))
      const resolved = pending.length > 0 && next.length === 0
      pending = next
      if (!changed) return
      onAttention?.(next)
      for (const entry of next) if (!before.has(entry.id)) this.ctx.emit('llm/attention', { sessionId, directory, kind: entry.kind, title: attentionTitle(entry) })
      if (resolved) this.ctx.emit('llm/attention-resolved', { sessionId, directory })
    }
    let chain: Promise<void> = Promise.resolve()
    const list = async <T>(kind: Attention['kind']): Promise<T[]> => {
      const res = await fetch(`${conn.url}/api/session/${sessionId}/${kind}`, { headers: conn.headers, signal: conn.closed })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return ((await res.json()) as { data: T[] }).data
    }
    const read = async (): Promise<void> => {
      if (stopped) return
      const [permissions, questions] = await Promise.all([
        list<{ id: string; action: string; resources?: string[]; source?: { callID?: string } }>('permission'),
        list<{ id: string; questions: AttentionQuestion[]; tool?: { callID?: string } }>('question'),
      ])
      if (stopped) return
      const next: Attention[] = [
        ...permissions.map((entry): Attention => ({ kind: 'permission', id: entry.id, sessionId, action: entry.action, resources: entry.resources ?? [] })),
        ...questions.map((entry): Attention => ({ kind: 'question', id: entry.id, sessionId, questions: entry.questions })),
      ]
      for (const entry of permissions) this.requests.set(entry.id, { sessionId, kind: 'permission', callID: entry.source?.callID })
      for (const entry of questions) this.requests.set(entry.id, { sessionId, kind: 'question', callID: entry.tool?.callID })
      publish(next)
    }
    // 답한 요청은 목록 읽기를 기다리지 않고 바로 뺀다 — 카드가 곧장 사라지고, 답 직후 턴이 끝나도(stop) resolved 를 놓치지 않는다
    this.watchers.set(sessionId, { answered: (requestId) => !stopped && publish(pending.filter((entry) => entry.id !== requestId)) })
    return {
      refresh: () => {
        chain = chain.then(read).catch(() => {}) // 못 읽으면 다음 신호에 다시 — 턴 끝은 세션 SSE 가 정한다
      },
      stop: () => {
        stopped = true
        this.watchers.delete(sessionId)
        for (const [id, request] of this.requests) if (request.sessionId === sessionId) this.requests.delete(id)
      },
    }
  }

  /** 카드의 답을 엔진에 보낸다 (01f 1-d·01i 2-b·2-c). 권한: once|reject. 질문: 질문마다 고른 답(빈 답은 막는다 — opencode 는 검증하지 않는다)
   *  또는 reject. 거절은 그 도구 호출을 적어 둔다 — 그 tool.failed 가 턴의 끝이다. 이미 풀렸거나 모르는 요청이면 던진다 */
  async reply(sessionId: string, requestId: string, answer: AttentionAnswer): Promise<void> {
    const request = this.requests.get(requestId)
    if (!request || request.sessionId !== sessionId) throw new Error(tr('error.attentionGone'))
    const valid =
      answer === 'reject' ||
      (request.kind === 'permission'
        ? answer === 'once'
        : Array.isArray(answer) && answer.length > 0 && answer.every((entry) => Array.isArray(entry) && entry.length > 0 && entry.every((label) => typeof label === 'string' && label.trim() !== '')))
    if (!valid) throw new Error(tr('error.attentionAnswer'))
    const conn = await this.ctx.engine.connection()
    const declined = answer === 'reject' && request.callID ? this.declined.get(sessionId) : undefined
    declined?.add(request.callID!) // 보내기 전에 — tool.failed 가 응답보다 먼저 올 수 있다
    const base = `${conn.url}/api/session/${sessionId}/${request.kind}/${requestId}`
    const res =
      request.kind === 'permission'
        ? await fetch(`${base}/reply`, { method: 'POST', headers: { ...conn.headers, 'content-type': 'application/json' }, body: JSON.stringify({ reply: answer }) })
        : answer === 'reject'
          ? await fetch(`${base}/reject`, { method: 'POST', headers: conn.headers })
          : await fetch(`${base}/reply`, { method: 'POST', headers: { ...conn.headers, 'content-type': 'application/json' }, body: JSON.stringify({ answers: answer }) })
    if (!res.ok) {
      declined?.delete(request.callID!)
      throw new Error(tr('error.attentionReply', { status: res.status }))
    }
    this.requests.delete(requestId)
    this.watchers.get(sessionId)?.answered(requestId)
  }

  /** 전역 `GET /api/event` 에서 이 세션(data.sessionID)의 이벤트만 onEvent 로 넘긴다. 해제 함수를 준다. 쓰는 쪽은 세션 SSE 에 없는 것만
   *  골라 쓴다(조각 `*.delta`, 승인·질문 요청) — 둘 다 쓰면 같은 이벤트를 두 번 본다. 구독 응답을 기다리지 않는다(프롬프트를 늦추지
   *  않게) — 그 사이 조각은 *.ended 가 덮고, 요청은 붙은 직후 onConnected 에서 목록을 읽어 잡는다 */
  private followGlobal(conn: EngineConnection, sessionId: string, onEvent: (event: OpencodeEventEnvelope) => void, onConnected: () => void): () => void {
    const controller = new AbortController()
    void (async () => {
      const res = await fetch(`${conn.url}/api/event`, { headers: conn.headers, signal: AbortSignal.any([controller.signal, conn.closed]) })
      if (!res.ok || !res.body) return
      onConnected()
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) return
          buffer += decoder.decode(value, { stream: true })
          let frameEnd: number
          while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
            const event = parseFrame(buffer.slice(0, frameEnd))
            buffer = buffer.slice(frameEnd + 2)
            if (event && event.data?.['sessionID'] === sessionId) onEvent(event)
          }
        }
      } finally {
        void reader.cancel().catch(() => {})
      }
    })().catch(() => {}) // 끊겨도 턴은 세션 SSE 로 끝난다
    return () => controller.abort()
  }
}

/** 'llm/attention' 의 짧은 설명 — 명령·파일(권한) 또는 첫 질문 */
function attentionTitle(request: Attention): string {
  return request.kind === 'permission' ? `${request.action} ${request.resources.join(', ')}`.trim() : (request.questions[0]?.question ?? '')
}

/** opencode 에이전트 → 모드 (모르는 에이전트면 없음) */
function modeOf(agent: string | undefined): Mode | undefined {
  return agent === undefined ? undefined : MODES.find((mode) => MODE_AGENT[mode] === agent)
}

/** SSE 프레임 하나의 `data:` JSON. 없거나 깨졌으면 undefined (전역 스트림의 `: heartbeat` 주석 프레임 포함) */
function parseFrame(frame: string): OpencodeEventEnvelope | undefined {
  const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
  if (!dataLine) return undefined
  try {
    return JSON.parse(dataLine.slice('data: '.length)) as OpencodeEventEnvelope
  } catch {
    return undefined
  }
}

/** opencode 메시지(asc) → 말풍선. 도구 턴의 assistant 여럿은 한 답으로 합치고 텍스트만 쓴다 — 실시간 턴이 text.ended 만
 *  모으는 것과 같은 모양. 끊긴 턴(01c Q6): 그 세션이 돌고 있지 않은데 마지막이 답 없는 user 이거나 완료 시각 없는 assistant 면
 *  끝에 "중단됨" 을 단다 (재시작 뒤 opencode 는 그 턴을 다시 돌리지 않는다) */
export function historyMessages(raw: OpencodeMessage[], running: boolean): HistoryMessage[] {
  const messages: HistoryMessage[] = []
  let sentAt: number | undefined
  /** 지시문 바뀜(system 메시지)은 다음 답의 진행 줄 맨 앞에 — 실시간 턴에서 context.updated 가 오는 자리 */
  let context: TurnItem[] = []
  /** 지금 에이전트 — agent-switched 로 바뀌고 답의 agent 가 확정한다 (01k: 생성 때 고른 에이전트는 기록이 없다) */
  let agent: string | undefined
  let asked: HistoryMessage | undefined
  for (const message of raw) {
    if (message.type === 'agent-switched') {
      agent = message.agent
      continue
    }
    if (message.type === 'user') {
      sentAt = message.time?.created
      const mode = modeOf(agent)
      asked = { id: message.id, role: 'user', text: message.text ?? '', ...(sentAt !== undefined && { at: sentAt }), ...(mode && { mode }) }
      messages.push(asked)
      continue
    }
    if (message.type === 'system') {
      context.push({ kind: 'context', id: `context:${message.id ?? context.length}`, text: contextText(message.text ?? '') })
      continue
    }
    if (message.type !== 'assistant') continue // 모델 바꿈·압축 등은 말풍선이 아니다
    if (message.agent) {
      agent = message.agent
      const mode = modeOf(agent)
      if (asked && mode) asked.mode = mode
    }
    const previous = messages.at(-1)
    const reply: HistoryMessage = previous?.role === 'assistant' ? previous : { role: 'assistant', text: '', items: [] }
    if (reply !== previous) messages.push(reply)
    reply.text += (message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('')
    reply.items = [...(reply.items ?? []), ...context, ...messageItems(message.id ?? String(messages.length), message.content ?? [])]
    context = []
    const completed = message.time?.completed
    if (completed !== undefined && sentAt !== undefined) reply.duration = completed - sentAt
    else delete reply.duration // 마지막 스텝이 안 끝났다
    if (message.error) reply.error = message.error.message ?? tr('error.unknown')
    // 턴의 마지막 답 메시지가 정한다 — 앞 스텝의 실패한 도구(예: 계획의 "Unknown tool")는 다음 스텝이 이어 덮는다
    if (endedByDecline(message)) reply.declined = true
    else delete reply.declined
  }

  const last = raw.filter((message) => message.type === 'user' || message.type === 'assistant').at(-1)
  // 거절로 끝난 턴도 (다음 턴 전까지) 완료 시각이 없다(2026-10-02 실측) — 마지막 도구가 오류로 끝났으면 끊긴 게 아니다(끊긴 도구는 running 으로
  // 남는다, 01i 2-e)
  if (!running && last && !endedByDecline(last) && (last.type === 'user' || !last.time?.completed)) {
    const reply = messages.at(-1)
    if (reply?.role === 'assistant') Object.assign(reply, { error: interruptedError(), interrupted: true })
    else messages.push({ role: 'assistant', text: '', error: interruptedError(), interrupted: true })
  }
  return messages
}

/** 답 메시지의 마지막이 오류로 끝난 도구인가 — 턴의 마지막 메시지가 이러면 승인·질문 거절이다 (tool.failed 하나로 턴이 끝나고 다음 스텝이 없다).
 *  거절 직후엔 완료 시각이 없고 다음 턴 때 채워진다 (2026-10-02 실측) — 완료 시각으로 가르지 않는다 */
function endedByDecline(message: OpencodeMessage): boolean {
  if (message.type !== 'assistant') return false
  const part = message.content?.at(-1) as { type?: string; state?: { status?: string } } | undefined
  return part?.type === 'tool' && part.state?.status === 'error'
}

/** 끝 이벤트 없이 스트림이 끊겼을 때의 사유. 서버가 끝나면 소켓이 exit 보다 먼저 닫혀(실측 2026-09-30, 앱 실물 테스트에서
 *  "terminated" 가 먼저 왔다) closed 가 아직 안 걸렸을 수 있다 — 잠깐 기다려 원인을 가린다. 어느 쪽이든 턴은 "중단됨" 이다 */
async function interruption(closed: AbortSignal): Promise<string> {
  if (!closed.aborted) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000)
      closed.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
    })
  }
  return closed.aborted ? interruptedError() : tr('error.streamBroken')
}

/** 폴더면 realpath 를, 아니면(없는 경로·파일·상대 경로) undefined 를 준다.
 *  opencode 는 없는 경로로도 세션을 200 으로 만들지만 그 세션은 모든 요청이 500 이고, 그 경로는 서버 재시작 전까지
 *  계속 500 이다 (폴더를 나중에 만들어도) — 사용자 opencode 를 오염시키므로 opencode 에 닿기 전에 거른다.
 *  realpath 인 이유: opencode 는 경로를 문자열 그대로 저장·비교한다 (2026-09-30 실측, 01_probe Q3). */
export async function realDirectory(directory: string): Promise<string | undefined> {
  if (!path.isAbsolute(directory)) return undefined
  try {
    const real = await fs.realpath(directory)
    return (await fs.stat(real)).isDirectory() ? real : undefined
  } catch {
    return undefined
  }
}
