import { Context, Service } from 'cordis'
import { randomInt } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Agent } from 'undici'
import { normalizeBaseURL } from './providers.ts'
import { MODE_AGENT, type EngineConnection } from './engine.ts'
import { DEFAULT_MODE, MODES, type Mode } from '../../shared/modes.ts'
import { messageTokens, TurnMeter, type TurnUsage } from './turnUsage.ts'
import { openPty, type TerminalEvents, type TerminalHandle } from './opencodePty.ts'
import { messageItems, TurnScope, TurnTracker, type EngineMessageInfo, type EnginePart, type TurnItem } from './turnProgress.ts'
import { projectInstructions } from './instructions.ts'
import { turnError } from './contextOverflow.ts'
import { tr } from '../i18n.ts'
import './engine.ts'

// opencode 를 감싸는 서비스 — 위층(세션·UI)은 이 ctx.llm 키만 알고 opencode 를 직접 모른다.
// 나중에 엔진을 바꾸더라도 이 서비스만 교체하면 된다 (Cordis: 서비스는 키로 찾는다).
//
// 채팅은 opencode **레거시 경로**로 한다 (이슈 #13 L1, 2026-10-02 결정 — 실측 _workspace/01w_legacy_migration.md). 이유는 MCP·task 서브에이전트·
// `.claude/skills` 다 (신규 세대 `/api/session/*` 에는 없다). 모델 카탈로그·에이전트 목록·입력 트리거 목록·pty 는 읽기 전용 신규 세대를 그대로 쓴다.
// 흐름: POST /session?directory= {model, title} 로 세션을 만들고, 그 폴더의 GET /event?directory= 를 **먼저** 구독해 server.connected 를 받은 뒤
// POST /session/{id}/prompt_async?directory= {messageID, model, agent, system, parts} (204) 로 보낸다. 끝은 session.idle 하나다.
// 레거시 함정 (01w 1절):
// - **모든 레거시 호출에 `?directory=`** — 빠지면 다른 폴더 인스턴스로 가서 404(승인 답 등)이거나 엉뚱한 목록이 온다
// - 재구독해도 과거 이벤트를 재생하지 않는다(그래서 구독을 먼저 걸고 연결 확인 뒤 보낸다). heartbeat 가 10초마다 온다
// - 모델은 마지막 user 메시지의 것을 따라가고(sticky) 에이전트는 매번 build 로 돌아간다 → 둘 다 매 프롬프트에 싣는다
// - 결과는 assistant 의 parentID(= 내가 정한 user messageID)로 고른다 — 같은 세션에 다른 클라이언트가 보낸 턴·task 자식 세션이 섞이지 않게.
//   같은 messageID 를 두 번 보내면 409 없이 앞 메시지에 조용히 합쳐지므로 id 는 매번 새로 (opencode 형식, 시간 오름차순 — newMessageId)
// - 중지 = POST /session/{id}/abort (idle 이 두 번 온다). 없는 에이전트는 session.error 만 오고 idle 이 없다 → 상태를 물어 끝낸다
// - 세션 생성 때 title 을 주면 제목을 만드는 LLM 호출이 없다 (제목은 앱이 정한다 — ctx.sessions)
//
// 승인 요청(권한)·AI 질문(question 도구)은 같은 /event 에 permission.*·question.* 로 온다 — 신호로만 쓰고 정본 목록(GET /permission·/question
// ?directory=, 폴더 전부)을 다시 읽어 이 턴 답 메시지(tool.messageID)의 것만 카드(onAttention)와 'llm/attention*' 이벤트로 낸다. 중지 뒤 남은
// 요청이 목록에 그대로 남기 때문이다(01w). 거절하면 그 도구가 error 로 끝나고 곧바로 idle 이 온다.
//
// 모드 = opencode 에이전트 (ctx.engine 이 정의, MODE_AGENT). 매 프롬프트의 agent 로 준다 — 레거시는 없는 이름을 거절하지만(session.error)
// 그 경우 idle 이 없어서, 보내기 전에 /api/agent 목록으로 확인한다.
//
// 프로젝트 지시문(AGENTS.md·CLAUDE.md)은 앱이 읽어 매 턴 system 으로 넣는다 (instructions.ts — 프로젝트 설정 차단 플래그가 그 읽기도 끈다).
//
// opencode 서버는 ctx.engine 이 띄우고 관리한다 — 여기서는 주소·인증(connection())만 받아 모든 요청에 싣는다.
// 서버가 재시작·크래시로 끝나면 진행 중 턴은 끝 이벤트 없이 사라진다(01_probe Q3) → connection().closed 를 보고 "중단됨" 으로 끝낸다.
//
// 작업 디렉터리: 한 opencode 서버에서 세션마다 폴더를 준다 — 도구 cwd·시스템 프롬프트의 작업 디렉터리가 그 폴더 기준이 되고, 동시에 돌려도
// 안 섞인다 (2026-09-30 실측, _workspace/01_probe.md Q1).

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

interface TurnOutcome {
  ok: boolean
  text: string
  error?: string
  usage?: TurnUsage
  interrupted?: boolean
  declined?: boolean
}

interface EngineEvent {
  type: string
  properties: Record<string, unknown>
}

interface CatalogModel {
  id: string
  providerID: string
  api?: { url?: string }
}

export const MODEL_CATALOG_TIMEOUT_MS = 10_000
/** 에이전트 목록도 지연 로드된다(01f: 첫 응답 빈 목록, ~1.5초) — 모델 카탈로그와 같은 기한 */
export const AGENT_LIST_TIMEOUT_MS = 10_000
/** 한 턴에 자동 요약이 이만큼 넘게 돌면 멈춘다 — 레거시는 요약 뒤 스스로 "Continue" 턴을 돌리고, 모델 한도가 작으면(한도 − 32000 이 프롬프트보다
 *  작으면 — renderer/compaction.ts) 요약 → 다시 넘침이 끝없이 돈다 (01w 자동 요약 행, 가짜 LLM 30초에 10회 이상). 요약 줄·이음 답은 TurnScope */
export const MAX_COMPACTIONS_PER_TURN = 3
/** 구독을 걸고 server.connected 를 기다리는 한도 — 헤더와 함께 바로 온다(01w) */
const CONNECT_TIMEOUT_MS = 10_000
/** 엔진 재시작·크래시로 끊긴 턴의 사유 — 지금 언어로 (그래서 상수가 아니다. 중단 판정은 문구가 아니라 interrupted 로 한다) */
export function interruptedError(): string {
  return tr('error.interrupted')
}

/** /event 의 무바이트 한도 기본값 — 레거시 /event 는 10초마다 heartbeat 를 보낸다(01w). 세 번 연달아 안 오면 연결이 FIN 없이 죽은 것으로 보고
 *  "중단됨" 으로 끝낸다 (끊긴 연결을 기다리며 턴이 영원히 도는 것을 막는다 — 01q 와 같은 정책) */
export const STREAM_IDLE_TIMEOUT_MS = 30_000

export interface LlmConfig {
  /** /event SSE 의 무바이트 한도(ms). 기본 STREAM_IDLE_TIMEOUT_MS, 0 = 없음. 시험이 끊김을 짧게 재현할 때 준다 */
  streamTimeoutMs?: number
}

/** 레거시 호출의 폴더 쿼리 (01w: 모든 레거시 호출에 붙인다) */
function at(directory: string): string {
  return `directory=${encodeURIComponent(directory)}`
}

export class LlmService extends Service {
  static readonly inject = ['providers', 'engine']

  /** 답을 기다리는 턴 수 — DB 정리는 0 일 때만 돈다 (정리 잠금이 길면 그 사이 opencode 쓰기가 실패한다, 01_probe) */
  private turns = 0
  private purgeWanted = false
  /** 턴이 도는 세션 — addContext 가 막는다 */
  private busy = new Set<string>()
  /** 기다리는 요청 id → 그 세션·폴더·종류·도구 호출 (reply 가 쓴다). 턴이 끝나면 지운다 */
  private requests = new Map<string, { sessionId: string; directory: string; kind: Attention['kind']; callID?: string }>()
  /** 턴이 도는 세션 → 앱이 거절한 도구 호출 id. 그 도구가 error 로 끝나고 idle 이 오면 거절로 끝난 턴이다 */
  private declined = new Map<string, Set<string>>()
  /** 턴이 도는 세션 → 그 턴의 대기 목록 (reply 가 답한 요청을 바로 뺀다) */
  private watchers = new Map<string, { answered(requestId: string): void }>()

  /** /event 를 여는 dispatcher. 전역 fetch(undici) 기본 bodyTimeout·headersTimeout 은 300초다 — 레거시 /event 는 heartbeat 가 10초마다 오므로
   *  무바이트 한도를 STREAM_IDLE_TIMEOUT_MS 로 줄여 죽은 연결을 30초 안에 알아챈다(이슈 #20). 시험은 더 짧게 줄 수 있다 (01q).
   *  끊김 감지는 엔진 생존(conn.closed)으로도 한다.
   *  undici 는 Electron 33 메인의 Node 20.18.3 내장(6.21.1)과 같은 버전을 쓴다 */
  private streamDispatcher: Agent

  constructor(ctx: Context, config: LlmConfig = {}) {
    super(ctx, 'llm')
    const timeout = config.streamTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS
    this.streamDispatcher = new Agent({ bodyTimeout: timeout, headersTimeout: timeout })
    ctx.effect(() => () => void this.streamDispatcher.close().catch(() => {}))
  }

  // model 을 꼭 명시한다 — 빼면 opencode 가 opencode.json 의 model 을 무시하고 models.dev 카탈로그의 외부 provider(실측: nano-gpt/...)로
  // 세션을 만들 때가 있다 (2026-09-30 실측). 우리 provider/모델 id 를 opencode 의 providerID/모델 id 로 그대로 쓴다.
  // title 을 주면 opencode 가 제목을 만들려고 LLM 을 한 번 더 부르지 않는다 (01w — 제목은 앱이 정한다). 응답은 감싸지 않은 세션 그대로
  private async createSession(conn: EngineConnection, providerId: string, modelId: string, directory: string, title: string): Promise<string> {
    const res = await fetch(`${conn.url}/session?${at(directory)}`, {
      method: 'POST',
      headers: { ...conn.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ model: { providerID: providerId, id: modelId }, title }),
    })
    if (!res.ok) throw new Error(tr('error.sessionCreate', { status: res.status }))
    return ((await res.json()) as { id: string }).id
  }

  // 보내기 전에 opencode 모델 카탈로그에 그 모델이 있는지 본다 (신규 세대 /api/model — 읽기 전용). 레거시는 없는 모델을 session.error 로 거절하지만
  // (01w), 화면에 알맞은 사유("모델 없음")를 주고 보내지 않으려고 먼저 본다. 카탈로그는 지연 로드라 첫 응답이 빈 목록일 수 있고 세 단계로 채워진다
  // (빈 목록 → models.dev 원본 → 설정 반영, 2026-09-30 실측) — **찾는 모델이 나올 때까지** 다시 묻는다. 기한까지 안 나오면 없다고 본다.
  // 카탈로그는 디렉터리별이다(전역 설정 + 그 폴더의 opencode.json) — 세션의 폴더 것을 본다.
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
  // 카탈로그를 조용히 준다 (2026-09-30 실측) — engine.live.test.ts 의 "주소를 바꾸면 거부" 시나리오가 이것을 지킨다.
  private async listModels(conn: EngineConnection, directory: string): Promise<CatalogModel[]> {
    const query = new URLSearchParams({ 'location[directory]': directory })
    const res = await fetch(`${conn.url}/api/model?${query}`, { headers: conn.headers })
    if (!res.ok) throw new Error(tr('error.modelList', { status: res.status }))
    return ((await res.json()) as { data: CatalogModel[] }).data
  }

  // 모드의 에이전트가 그 폴더의 에이전트 목록에 있는지 — 레거시는 없는 이름을 session.error 로 거절하지만 idle 이 오지 않는다(01w).
  // 목록은 지연 로드라 첫 응답이 빈 목록일 수 있다(01f ~1.5초) — 모델처럼 나올 때까지 묻는다. subagent·hidden 은 primary 로 못 쓴다
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

  /** directory 는 새 세션의 작업 디렉터리(절대 경로). 이어가는 세션(sessionId)은 만들 때 정한 폴더를 따른다 — 이어갈 때도 그 세션의 폴더를 넘긴다
   *  (모델·주소 확인과 모든 레거시 호출의 ?directory= 에 쓴다). 모델·모드는 매 프롬프트에 싣는다 — 대화 중에 바꾸면 다음 턴부터 그것으로 돈다.
   *  onSession 은 새 세션을 만든 직후, 프롬프트를 보내기 전에 불린다 — 답을 기다리는 중에 앱이 꺼져도 그 대화를 다시 열 수 있게.
   *  messageId(newMessageId)를 주면 이 입력의 엔진 메시지 id 가 그것이 된다 — history 의 id 로 돌아온다. 안 주면 새로 만든다.
   *  onProgress 는 턴 중 진행 줄(생각·도구·글)이 바뀔 때마다 불린다 — 화면의 실시간 진행 표시용. 턴 끝은 여전히 반환값이 정본이다.
   *  onAttention 은 턴이 기다리는 승인·질문 목록이 바뀔 때마다 (빈 목록 = 더 기다리는 것 없음) — 화면의 카드. 답은 reply.
   *  stop 이 걸리면 사용자가 멈춘 것이다 — 보내기 전이면 안 보내고, 받아들여진 뒤면 opencode 턴도 멈추고(abort) "중단됨" 으로 끝낸다.
   *  세션이 아직 없을 때(첫 턴)도 멈출 수 있게 세션 id 가 아니라 신호로 받는다 */
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
    stop?: AbortSignal,
  ): Promise<ChatResult> {
    this.turns++
    /** busy: 이 턴이 쥔 세션(addContext 를 막는다), sessionId: 받아들여진 턴의 세션 — 그때만 turn-started/ended 를 낸다 */
    const admitted: { busy?: string; sessionId?: string } = {}
    try {
      const result = await this.turn(providerId, modelId, directory, prompt, sessionId, onSession, messageId, onProgress, admitted, mode, onAttention, stop)
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

  /** 세션을 쓸 준비 — 매 턴 보내기 전에 그 폴더 카탈로그로 모델·주소를 보고, 모드를 주면 그 에이전트가 있는지 보고, 세션이 없으면 만든다.
   *  이어가는 세션도 directory(그 대화의 프로젝트)로 본다. workdir 은 realpath — 레거시 호출의 ?directory= 로 쓴다 */
  private async prepare(
    conn: EngineConnection,
    providerId: string,
    modelId: string,
    directory: string,
    sessionId: string | undefined,
    title: string,
    onSession?: (sessionId: string) => Promise<void>,
    mode?: Mode,
  ): Promise<{ id: string; workdir: string } | { error: string }> {
    const workdir = await realDirectory(directory)
    if (!workdir) return { error: tr('error.noWorkdir', { dir: directory }) }
    const model = await this.waitForModel(conn, providerId, modelId, workdir)
    if (!model) return { error: tr('error.noModel', { provider: providerId, model: modelId }) }
    // 세션 폴더의 opencode.json 은 우리 provider 의 baseURL 까지 덮는다 — 그러면 프롬프트(와 프록시 토큰)가 그 주소로 간다 (01_probe Q4, 신규 세대).
    // 레거시는 CONFIG_DIR 을 맨 마지막에 합쳐 우리 주소로 보냈다(01w 4변형) — 그래도 카탈로그엔 덮인 주소가 보이므로 이 검사는 안전 쪽으로 남긴다.
    // 우리가 적은 주소는 키 프록시 주소다 (engine.ts)
    if (normalizeBaseURL(model.api?.url ?? '') !== normalizeBaseURL(conn.providerBaseURL(providerId))) {
      return { error: tr('error.baseUrlOverridden', { url: String(model.api?.url) }) }
    }
    const agent = mode && MODE_AGENT[mode]
    if (agent && !(await this.waitForAgent(conn, agent, workdir))) return { error: tr('error.noAgent', { agent }) }
    if (sessionId) return { id: sessionId, workdir }
    const id = await this.createSession(conn, providerId, modelId, workdir, title)
    await onSession?.(id)
    return { id, workdir }
  }

  /** 대화 맥락에만 넣는다 — LLM 을 돌리지 않고 입력만 저장해 다음 턴에 실린다(레거시 `noReply`, 01w). `!` 카드의 "AI 에게 보내기".
   *  **그 세션의 턴이 도는 중이면 거절한다**: 그때 넣으면 진행 중 턴이 그 입력에 이어서 답한다 (루프가 최신 user 를 본다 — 01w, 신규 세대도 01h).
   *  세션이 없으면 만든다(onSession). messageId 는 newMessageId — 다시 열 때 이 입력을 가려낸다 */
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
      const ready = await this.prepare(conn, providerId, modelId, directory, sessionId, sessionTitle(text), onSession)
      if ('error' in ready) return { ok: false, sessionId, error: ready.error }
      id = ready.id
      if (this.busy.has(id)) return { ok: false, sessionId: id, error: tr('error.contextBusy') }
      const res = await fetch(`${conn.url}/session/${id}/prompt_async?${at(ready.workdir)}`, {
        method: 'POST',
        headers: { ...conn.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ messageID: messageId, noReply: true, model: { providerID: providerId, modelID: modelId }, parts: [{ type: 'text', text }] }),
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
    stop: AbortSignal | undefined,
  ): Promise<ChatResult> {
    const provider = this.ctx.providers.get(providerId)
    if (!provider) return { ok: false, error: tr('error.noProvider', { id: providerId }) }

    let conn: EngineConnection | undefined
    let id = sessionId
    try {
      conn = await this.ctx.engine.connection()
      const ready = await this.prepare(conn, providerId, modelId, directory, id, sessionTitle(prompt), onSession, mode)
      if ('error' in ready) return { ok: false, sessionId: id, error: ready.error }
      id = ready.id
      const { workdir } = ready
      if (stop?.aborted) return { ok: false, sessionId: id, error: tr('error.stopped'), interrupted: true } // 보내기 전에 멈췄다
      const turnSession = id
      this.busy.add(id) // addContext 가 이 세션을 막는다 (prompt 보내기 전부터 — 그 사이에 끼어들지 않게)
      admittedTurn.busy = id
      const declined = new Set<string>()
      this.declined.set(id, declined)
      const userMessageId = messageId ?? this.newMessageId()
      const system = await projectInstructions(workdir)

      let admitted!: (sent: boolean) => void
      const scope = new TurnScope(id, userMessageId)
      const attention = this.watchAttention(conn, id, workdir, directory, scope, onAttention)
      const events = this.follow(conn, scope, workdir, new Promise<boolean>((resolve) => (admitted = resolve)), onProgress, declined, attention.refresh, stop)
      try {
        await events.connected
        if (stop?.aborted) {
          admitted(false)
          return { ok: false, sessionId: id, error: tr('error.stopped'), interrupted: true } // 구독하는 사이에 멈췄다 — 보내지 않는다
        }
        const send = await fetch(`${conn.url}/session/${id}/prompt_async?${at(workdir)}`, {
          method: 'POST',
          headers: { ...conn.headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            messageID: userMessageId,
            model: { providerID: providerId, modelID: modelId },
            agent: MODE_AGENT[mode],
            ...(system && { system }),
            parts: [{ type: 'text', text: prompt }],
          }),
        }).catch((error: unknown) => {
          admitted(false)
          events.stop()
          throw error
        })
        if (!send.ok) {
          admitted(false)
          events.stop()
          return { ok: false, sessionId: id, error: tr('error.promptSend', { status: send.status }) }
        }
        admitted(true)
        admittedTurn.sessionId = id
        this.ctx.emit('llm/turn-started', { sessionId: id, directory })

        const result = await events.result
        const usage = result.usage && { ...result.usage, messageTokens: await this.messageTokens(conn, id, workdir) }
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
        events.stop()
        attention.stop()
        this.declined.delete(turnSession)
      }
    } catch (error) {
      if (conn?.closed.aborted) return { ok: false, sessionId: id, error: interruptedError(), interrupted: true }
      return { ok: false, sessionId: id, error: tr('error.opencodeConnect', { message: (error as Error).message }) }
    }
  }

  /** chat·addContext 에 넘길 새 메시지 id — opencode 형식(`msg_` + 시각·순번 12자리 hex + 무작위 14자)이라 시간 순으로 정렬된다.
   *  opencode 는 메시지를 id 순으로 다루므로(01w 9절) 앱이 정한 id 도 그 순서를 지켜야 한다. `/` 명령처럼 보낸 본문과 보일 글이 다를 때,
   *  앱이 이 id 로 보일 글을 따로 적어 둔다 (01d "말풍선 문제"). 같은 id 를 두 번 보내면 조용히 합쳐지므로 매번 새로 만든다 */
  newMessageId(): string {
    return ascendingId('msg')
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
   *  그대로 온다 — 이벤트 재생 대신 조립된 메시지 목록을 쓴다. 돌고 있는지는 GET /session/status (돌고 있는 세션만 실린다 — 01w).
   *  hidden 은 말풍선으로 안 그릴 엔진 메시지 id — addContext 로 넣은 `!` 카드 본문 (카드는 앱이 따로 그린다) */
  async history(directory: string, sessionId: string, hidden: ReadonlySet<string> = new Set()): Promise<History> {
    const workdir = await realDirectory(directory)
    if (!workdir) return { messages: [], missingFolder: true }
    try {
      const conn = await this.ctx.engine.connection()
      const raw = await this.engineMessages(conn, sessionId, workdir)
      const status = await fetch(`${conn.url}/session/status?${at(workdir)}`, { headers: conn.headers })
      if (!status.ok) throw new Error(tr('error.activeSessions', { status: status.status }))
      const running = sessionId in ((await status.json()) as Record<string, unknown>)
      return { messages: historyMessages(raw.filter((message) => !hidden.has(message.info.id)), running, workdir) }
    } catch (error) {
      return { messages: [], error: tr('error.historyLoad', { message: (error as Error).message }) }
    }
  }

  /** 레거시 세션의 메시지 전부 (오래된 것부터). limit 없이 부르면 한 번에 다 온다 (01w — limit=N 은 최근 N개) */
  private async engineMessages(conn: EngineConnection, sessionId: string, workdir: string): Promise<EngineMessage[]> {
    const res = await fetch(`${conn.url}/session/${sessionId}/message?${at(workdir)}`, { headers: conn.headers })
    if (!res.ok) throw new Error(tr('error.messageRead', { status: res.status }))
    return (await res.json()) as EngineMessage[]
  }

  /** 레거시 기록 그대로 (오래된 것부터) — Trajectory 탭이 읽는다. workdir 는 realDirectory 를 거친 세션 폴더 (?directory= 에 쓴다) */
  async readMessages(workdir: string, sessionId: string): Promise<EngineMessage[]> {
    return this.engineMessages(await this.ctx.engine.connection(), sessionId, workdir)
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

  /** 세션을 지운다 — 레거시 `DELETE /session/{id}` (01c Q3, 01w: 그대로). 폴더를 몰라도 지워진다(목록에서 뺀 세션만 남아 폴더가 없다).
   *  이미 없는 세션(404)은 지워진 것으로 본다. 지운 본문은 DB 의 WAL 에 남는다 (01c Q3) */
  async deleteSession(sessionId: string): Promise<void> {
    const conn = await this.ctx.engine.connection()
    const res = await fetch(`${conn.url}/session/${sessionId}`, { method: 'DELETE', headers: conn.headers })
    if (!res.ok && res.status !== 404) throw new Error(tr('error.sessionDelete', { status: res.status }))
  }

  /** 컨텍스트 중 대화 메시지 몫 (추정). 통계용이라 못 구해도 턴은 그대로 돌려준다 */
  private async messageTokens(conn: EngineConnection, sessionId: string, workdir: string): Promise<number | undefined> {
    try {
      return messageTokens(await this.engineMessages(conn, sessionId, workdir))
    } catch {
      return undefined
    }
  }

  /** opencode 의 그 세션 턴을 멈춘다 — `POST /session/{id}/abort?directory=` 는 200 true 뒤 session.error(MessageAbortedError) → idle(두 번) (01w 8회).
   *  실패는 삼킨다(결과는 어차피 "중단됨") */
  private async abort(conn: EngineConnection, sessionId: string, workdir: string): Promise<void> {
    await fetch(`${conn.url}/session/${sessionId}/abort?${at(workdir)}`, { method: 'POST', headers: conn.headers }).catch(() => {})
  }

  /** 그 폴더의 /event 를 구독해 이 턴(scope)의 이벤트로 진행 줄·사용량·결과를 모은다. connected 는 server.connected 를 받으면 풀린다 — 그 뒤에 보내야
   *  첫 이벤트를 놓치지 않는다(재생이 없다). result 는 턴이 끝나면(성공/실패/중단 모두) 풀린다.
   *  끝: 이 턴 user 메시지를 본 뒤의 session.idle. 이 user 메시지를 보기 전의 idle 은 앞 턴(중지 뒤 두 번째 idle 등)의 것이다.
   *  session.error 는 사유로 적어 두고 idle 을 기다린다 — 다만 없는 에이전트처럼 메시지가 생기지 않고 idle 도 없는 경우가 있어(01w) 그때 상태를 묻는다 */
  private follow(
    conn: EngineConnection,
    scope: TurnScope,
    workdir: string,
    admitted: Promise<boolean>,
    onProgress: ((item: TurnItem) => void) | undefined,
    declined: ReadonlySet<string>,
    onAttentionSignal: () => void,
    userStop?: AbortSignal,
  ): { connected: Promise<void>; result: Promise<TurnOutcome>; stop: () => void } {
    const sessionId = scope.sessionId
    const controller = new AbortController()
    const tracker = new TurnTracker(workdir)
    const meter = new TurnMeter()
    let connected!: () => void
    let failConnect!: (error: unknown) => void
    const connecting = new Promise<void>((resolve, reject) => ((connected = resolve), (failConnect = reject)))
    connecting.catch(() => {})
    let seenUser = false
    let compactions = 0
    /** 게이트웨이가 한도 초과로 거절했다 — opencode 는 자동 요약으로 줄여 이어 간다. 요약이 안 돌고 끝나면 실패다 */
    let overflowed = false
    let compactionSeen = false
    let failure: EngineMessageInfo['error']
    let declinedEnd = false
    let finish!: (outcome: TurnOutcome) => void
    const finished = new Promise<TurnOutcome>((resolve) => (finish = resolve))
    const outcome = (base: Omit<TurnOutcome, 'text' | 'usage'>): TurnOutcome => ({ text: tracker.text(), usage: meter.usage(), ...base })
    /** 사용자가 멈췄다 — 프롬프트가 받아들여진 뒤에 opencode 턴을 멈춘다(먼저 보내면 뒤에 받아들여진 프롬프트가 그대로 돈다).
     *  idle 을 기다리지 않는다 — 승인 대기 중이어도 abort 응답 뒤 바로 끝낸다. 뒤따르는 idle 은 다음 턴이 자기 user 메시지 전이라 버린다 */
    const stopped = async (): Promise<TurnOutcome> => {
      if (await admitted) await this.abort(conn, sessionId, workdir)
      return outcome({ ok: false, error: tr('error.stopped'), interrupted: true })
    }
    const ended = (): TurnOutcome => {
      if (overflowed && !compactionSeen) failure ??= { name: 'ContextOverflowError' }
      if (failure) {
        if (failure.name === 'MessageAbortedError') return outcome({ ok: false, error: tr('error.stopped'), interrupted: true }) // 다른 클라이언트가 멈췄다
        return outcome({ ok: false, error: failureText(failure) })
      }
      return declinedEnd ? outcome({ ok: true, declined: true }) : outcome({ ok: true })
    }
    /** user 메시지가 생기기 전의 session.error — idle 없이 끝나는 거절(없는 에이전트 등)일 수 있다. 그 세션이 돌고 있지 않고 여전히 이 턴 user
     *  메시지가 없으면 끝이다. 앞 턴을 멈춘 MessageAbortedError 가 늦게 온 것은 이 턴과 무관하다 */
    const settleError = async (error: EngineMessageInfo['error']): Promise<void> => {
      if (error?.name === 'MessageAbortedError') return
      const res = await fetch(`${conn.url}/session/status?${at(workdir)}`, { headers: conn.headers, signal: conn.closed }).catch(() => undefined)
      if (!res?.ok) return
      const running = sessionId in ((await res.json()) as Record<string, unknown>)
      if (!running && !seenUser) {
        failure = error
        finish(ended())
      }
    }
    const handle = (event: EngineEvent): void => {
      const props = event.properties ?? {}
      if (event.type === 'server.connected') return connected()
      const role = scope.of(event.type, props)
      if (role === 'summary') {
        // 요약 답 — 글은 답이 아니다. 끝나면 요약 줄을 구분선으로, 실패(한도 초과로 요약도 못 함)면 그 사유로 턴이 끝난다 (idle 이 뒤따른다)
        if (event.type !== 'message.updated') return
        const info = props['info'] as EngineMessageInfo
        const item = info.error ? tracker.compaction(info.parentID!, 'failed') : info.time?.completed !== undefined ? tracker.compaction(info.parentID!, 'done') : undefined
        if (item) onProgress?.(item)
        if (info.error) failure = info.error
        return
      }
      if (role) {
        if (role === 'assistant' || event.type === 'message.updated') meter.observe(event.type, props) // user 의 글 파트는 출력이 아니다
        if (role === 'user' && event.type === 'message.updated') seenUser = true
        if (role === 'user' && (props['part'] as EnginePart | undefined)?.type === 'compaction') {
          compactionSeen = true
          const item = tracker.compaction((props['part'] as EnginePart).messageID!, 'running')
          if (item) onProgress?.(item)
        }
        if (role === 'assistant') {
          if (event.type === 'message.updated') {
            const info = props['info'] as EngineMessageInfo
            if (info.error) failure = info.error
          } else {
            const item = tracker.observe(event.type, props)
            if (item) onProgress?.(item)
            const part = props['part'] as EnginePart | undefined
            if (part?.type === 'tool' && part.state?.status === 'error' && part.callID && declined.has(part.callID)) declinedEnd = true
          }
        }
        return
      }
      if (props['sessionID'] !== sessionId) return
      if (event.type.startsWith('permission.') || event.type.startsWith('question.')) return onAttentionSignal()
      if (event.type === 'session.status' && seenUser) {
        const item = tracker.status(props['status'] as Parameters<TurnTracker['status']>[0])
        if (item) onProgress?.(item)
        return
      }
      if (event.type === 'session.error') {
        const error = props['error'] as EngineMessageInfo['error']
        // 게이트웨이의 한도 초과는 끝이 아니다 — opencode 가 자동 요약으로 줄여 이어 간다(L2 실측). 요약도 못 하면 요약 답의 error 로 온다
        if (seenUser && error?.name === 'ContextOverflowError') overflowed = true
        else if (seenUser) failure ??= error // 이 턴의 실패 — idle 이 뒤따른다
        else void settleError(error)
        return
      }
      if (event.type === 'session.idle' && seenUser) finish(ended())
      if (event.type === 'session.compacted' && seenUser && ++compactions > MAX_COMPACTIONS_PER_TURN) {
        void this.abort(conn, sessionId, workdir)
        finish(outcome({ ok: false, error: tr('error.contextOverflow') }))
      }
    }

    const result = (async (): Promise<TurnOutcome> => {
      const signal = AbortSignal.any([controller.signal, conn.closed, ...(userStop ? [userStop] : [])]) // 서버가 끝나거나 사용자가 멈추면 읽기를 바로 멈춘다
      const res = await fetch(`${conn.url}/event?${at(workdir)}`, {
        headers: conn.headers,
        signal,
        dispatcher: this.streamDispatcher,
      } as RequestInit).catch((error: unknown) => {
        if (userStop?.aborted && !controller.signal.aborted) return undefined // 연결 전에 멈췄다
        throw error
      }) // dispatcher 는 Node(undici) fetch 확장이라 DOM RequestInit 타입에 없다
      if (!res) {
        connected() // 보내는 쪽이 stop 을 보게
        return stopped()
      }
      if (!res.ok || !res.body) throw new Error(tr('error.subscribe', { status: res.status }))

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const read = (): Promise<ReadableStreamReadResult<Uint8Array> | undefined> =>
        reader.read().catch((error: unknown) => {
          if (controller.signal.aborted) throw error // 우리가 멈췄다 (stop)
          return undefined // 연결이 잘렸다 (undici: "terminated")
        })
      try {
        while (true) {
          const next = await Promise.race([read(), finished.then(() => 'finished' as const)])
          if (next === 'finished') return await finished
          if (userStop?.aborted) return await stopped()
          if (!next || next.done) {
            const error = await interruption(conn.closed)
            // 엔진이 살아 있으면 opencode 의 턴은 계속 돈다 — 재생이 없어 끝을 다시 받을 길이 없으니 멈추고 "중단됨" 으로 끝낸다 (01q 와 같은 정책)
            if (!conn.closed.aborted && (await admitted)) await this.abort(conn, sessionId, workdir)
            return outcome({ ok: false, error, interrupted: true })
          }
          buffer += decoder.decode(next.value, { stream: true })
          let frameEnd: number
          while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
            const event = parseFrame(buffer.slice(0, frameEnd))
            buffer = buffer.slice(frameEnd + 2)
            if (event) handle(event)
          }
        }
      } finally {
        void reader.cancel().catch(() => {})
      }
    })()
    result.catch((error: unknown) => failConnect(error)) // 구독 자체가 실패했으면 보내는 쪽도 알게
    const timer = setTimeout(() => failConnect(new Error(tr('error.subscribe', { status: 'timeout' }))), CONNECT_TIMEOUT_MS)
    void connecting.finally(() => clearTimeout(timer)).catch(() => {})

    return { connected: connecting, result, stop: () => controller.abort() }
  }

  /** 승인·질문 대기 목록을 지켜본다. refresh 마다 정본 목록(GET /permission·/question?directory= — 그 폴더 전부)을 다시 읽어 이 턴 답 메시지의
   *  요청만 남기고, 바뀌었으면 onAttention 을 부르고 새 요청마다 'llm/attention', 다 풀렸으면 'llm/attention-resolved' 를 낸다.
   *  중지한 턴의 요청이 목록에 남아 있어도(01w) 그 턴의 답 메시지가 아니라 안 보인다. 읽기는 한 줄로 세운다(뒤늦은 응답이 새 목록을 덮지 않게) */
  private watchAttention(
    conn: EngineConnection,
    sessionId: string,
    workdir: string,
    directory: string,
    scope: TurnScope,
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
    type Request = { id: string; sessionID?: string; tool?: { messageID?: string; callID?: string } }
    const list = async <T extends Request>(kind: Attention['kind']): Promise<T[]> => {
      const res = await fetch(`${conn.url}/${kind}?${at(workdir)}`, { headers: conn.headers, signal: conn.closed })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return ((await res.json()) as T[]).filter((entry) => entry.sessionID === sessionId && scope.owns(entry.tool?.messageID))
    }
    const read = async (): Promise<void> => {
      if (stopped) return
      const [permissions, questions] = await Promise.all([
        list<Request & { permission: string; patterns?: string[] }>('permission'),
        list<Request & { questions: AttentionQuestion[] }>('question'),
      ])
      if (stopped) return
      const next: Attention[] = [
        ...permissions.map((entry): Attention => ({ kind: 'permission', id: entry.id, sessionId, action: entry.permission, resources: entry.patterns ?? [] })),
        ...questions.map((entry): Attention => ({ kind: 'question', id: entry.id, sessionId, questions: entry.questions })),
      ]
      for (const entry of permissions) this.requests.set(entry.id, { sessionId, directory: workdir, kind: 'permission', callID: entry.tool?.callID })
      for (const entry of questions) this.requests.set(entry.id, { sessionId, directory: workdir, kind: 'question', callID: entry.tool?.callID })
      publish(next)
    }
    // 답한 요청은 목록 읽기를 기다리지 않고 바로 뺀다 — 카드가 곧장 사라지고, 답 직후 턴이 끝나도(stop) resolved 를 놓치지 않는다
    this.watchers.set(sessionId, { answered: (requestId) => !stopped && publish(pending.filter((entry) => entry.id !== requestId)) })
    return {
      refresh: () => {
        chain = chain.then(read).catch(() => {}) // 못 읽으면 다음 신호에 다시 — 턴 끝은 idle 이 정한다
      },
      stop: () => {
        stopped = true
        this.watchers.delete(sessionId)
        for (const [id, request] of this.requests) if (request.sessionId === sessionId) this.requests.delete(id)
      },
    }
  }

  /** 카드의 답을 엔진에 보낸다 — 레거시 POST /permission/{id}/reply·/question/{id}/reply|reject (?directory= 필수 — 빠지면 404 이고 턴이 멈춘다, 01w).
   *  권한: once|reject. 질문: 질문마다 고른 답(빈 답은 막는다 — opencode 는 검증하지 않는다) 또는 reject. 거절은 그 도구 호출을 적어 둔다 —
   *  그 도구가 error 로 끝나고 오는 idle 이 거절로 끝난 턴이다. 이미 풀렸거나 모르는 요청이면 던진다 */
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
    declined?.add(request.callID!) // 보내기 전에 — 도구 error 가 응답보다 먼저 올 수 있다
    const base = `${conn.url}/${request.kind}/${requestId}`
    const query = at(request.directory)
    const json = { ...conn.headers, 'content-type': 'application/json' }
    const res =
      request.kind === 'permission'
        ? await fetch(`${base}/reply?${query}`, { method: 'POST', headers: json, body: JSON.stringify({ reply: answer }) })
        : answer === 'reject'
          ? await fetch(`${base}/reject?${query}`, { method: 'POST', headers: json, body: '{}' })
          : await fetch(`${base}/reply?${query}`, { method: 'POST', headers: json, body: JSON.stringify({ answers: answer }) })
    if (!res.ok) {
      declined?.delete(request.callID!)
      throw new Error(tr('error.attentionReply', { status: res.status }))
    }
    this.requests.delete(requestId)
    this.watchers.get(sessionId)?.answered(requestId)
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

/** 새 세션의 제목 — 앱이 따로 들고 있어 쓰이지 않는다. 주는 이유는 opencode 의 제목 LLM 호출을 막는 것 (01w) */
function sessionTitle(text: string): string {
  return text.trim().split('\n')[0]?.slice(0, 80) || 'litecode'
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
let lastIdTime = 0
let idCounter = 0

/** opencode Identifier 형식의 오름차순 id — `<prefix>_` + (ms × 0x1000 + 순번)의 아래 48비트 hex 12자 + base62 무작위 14자.
 *  opencode 가 만든 id(msg_0fb2398b20010dJ8a8bQ1z0neE = 1790919809202 ms, 순번 1 — 01w 기록)와 같은 규칙이라 서로 섞여도 시간 순으로 선다 */
export function ascendingId(prefix: string, now = Date.now()): string {
  if (now !== lastIdTime) {
    lastIdTime = now
    idCounter = 0
  }
  idCounter++
  const value = (BigInt(now) * 0x1000n + BigInt(idCounter)) & 0xffffffffffffn
  let random = ''
  for (let i = 0; i < 14; i++) random += BASE62[randomInt(62)]
  return `${prefix}_${value.toString(16).padStart(12, '0')}${random}`
}

/** SSE 프레임 하나의 `data:` JSON. 없거나 깨졌으면 undefined */
function parseFrame(frame: string): EngineEvent | undefined {
  const dataLine = frame.split('\n').find((line) => line.startsWith('data:'))
  if (!dataLine) return undefined
  try {
    return JSON.parse(dataLine.slice('data:'.length).trim()) as EngineEvent
  } catch {
    return undefined
  }
}

/** 레거시 메시지(asc) → 말풍선. 한 턴의 assistant 여럿(도구 스텝)은 한 답으로 합치고 텍스트만 쓴다 — 실시간 턴이 글 줄만 모으는 것과 같은 모양.
 *  끊긴 턴: 엔진 재시작 뒤 그 턴은 완료 시각 없는 assistant(+ running 도구)로 남는다(01w) — 그 세션이 돌고 있지 않은데 마지막이 답 없는 user 이거나
 *  완료 시각 없는 assistant 면 끝에 "중단됨" 을 단다. 마지막이 아닌 턴도 같은 모양이면 중단이다. 사용자가 멈춘 턴은 MessageAbortedError 다.
 *  자동 요약(L2): 요약 user(compaction 파트)는 그 턴 답의 요약 줄(끝나면 done — 화면은 구분선)이고, 요약 답(summary:true)의 글은 답이 아니다.
 *  요약 뒤 user 하나(합성 Continue·한도 초과 뒤 앞 user 의 복사본)는 말풍선이 아니라 이음이다 — 그 답은 같은 턴 답에 붙는다 (TurnScope 와 같은 규칙).
 *  root 는 세션 폴더 — 바꾼 파일 경로를 그 기준 상대로 보인다 */
export function historyMessages(raw: readonly EngineMessage[], running: boolean, root = ''): HistoryMessage[] {
  const messages: HistoryMessage[] = []
  let sentAt: number | undefined
  let asked: HistoryMessage | undefined
  /** 지금 답의 마지막 assistant — 다음 user 가 오면 그 턴이 끝났는지 본다 */
  let lastStep: EngineMessage | undefined
  /** 요약 user 를 봤다 — 다음 user 는 이음이다 (요약이 실패하면 이음이 없다) */
  let awaitingContinuation = false
  const closeTurn = (final: boolean): void => {
    if (final && running) return
    const reply = messages.at(-1)
    if (!asked) return
    if (reply?.role === 'assistant') {
      if (lastStep && !lastStep.info.time?.completed && !reply.error && !reply.declined) Object.assign(reply, { error: interruptedError(), interrupted: true })
    } else if (final) messages.push({ role: 'assistant', text: '', error: interruptedError(), interrupted: true })
  }
  /** 지금 턴의 답 말풍선 — 없으면 만든다 */
  const currentReply = (): HistoryMessage => {
    const previous = messages.at(-1)
    if (previous?.role === 'assistant') return previous
    const reply: HistoryMessage = { role: 'assistant', text: '', items: [] }
    messages.push(reply)
    return reply
  }
  const finishedAt = (completed: number | undefined, reply: HistoryMessage): void => {
    if (completed !== undefined && sentAt !== undefined) reply.duration = completed - sentAt
    else delete reply.duration // 마지막 스텝이 안 끝났다
  }
  for (const message of raw) {
    const { info, parts } = message
    if (info.role === 'user') {
      if (asked && parts.some((part) => part.type === 'compaction')) {
        const reply = currentReply()
        reply.items = [...(reply.items ?? []), { kind: 'compaction', id: `${info.id}:compaction`, status: 'running' }]
        awaitingContinuation = true
        continue
      }
      if (awaitingContinuation) {
        awaitingContinuation = false
        continue
      }
      const text = parts.filter((part) => part.type === 'text' && !part.synthetic).map((part) => part.text ?? '').join('')
      if (!parts.some((part) => part.type === 'text' && !part.synthetic)) continue // 합성 글뿐
      closeTurn(false)
      sentAt = info.time?.created
      lastStep = undefined
      const mode = modeOf(info.agent)
      asked = { id: info.id, role: 'user', text, ...(sentAt !== undefined && { at: sentAt }), ...(mode && { mode }) }
      messages.push(asked)
      continue
    }
    if (info.summary === true) {
      const reply = currentReply()
      const id = `${info.parentID ?? ''}:compaction`
      const status = info.error ? 'failed' : info.time?.completed !== undefined ? 'done' : 'running'
      reply.items = (reply.items ?? []).map((item) => (item.kind === 'compaction' && item.id === id ? { ...item, status } : item))
      if (info.error) {
        awaitingContinuation = false
        reply.error = failureText(info.error)
      }
      lastStep = message
      finishedAt(info.time?.completed, reply)
      continue
    }
    const reply = currentReply()
    reply.text += parts.filter((part) => part.type === 'text' && !part.synthetic).map((part) => part.text ?? '').join('')
    reply.items = [...(reply.items ?? []), ...messageItems(parts, root)]
    lastStep = message
    finishedAt(info.time?.completed, reply)
    if (info.error?.name === 'MessageAbortedError') Object.assign(reply, { error: tr('error.stopped'), interrupted: true })
    else if (info.error) reply.error = failureText(info.error)
    // 턴의 마지막 답 메시지가 정한다 — 앞 스텝의 실패한 도구는 다음 스텝이 이어 덮는다
    if (!info.error && endedByDecline(parts)) reply.declined = true
    else delete reply.declined
  }
  closeTurn(true)
  return messages
}

/** 엔진 실패 → 화면 사유. 한도 초과(게이트웨이 오류가 자동 요약으로도 안 줄었다 — opencode 가 ContextOverflowError 로 분류)는 "새 대화로" 안내 */
export function failureText(error: EngineMessageInfo['error']): string {
  if (error?.name === 'ContextOverflowError') return tr('error.contextOverflow')
  const message = error?.data?.message
  return message ? turnError(message) : tr('error.unknown')
}

/** 답 메시지의 마지막 파트가 오류로 끝난 도구인가 — 턴의 마지막 메시지가 이러면 승인·질문 거절이다: 거절하면 그 도구가 error 로 끝나고 다음 스텝
 *  없이 idle 이 온다 (01w). 그 밖의 도구 오류는 다음 스텝이 이어 덮는다 (step-finish 는 거르고 본다) */
function endedByDecline(parts: readonly EnginePart[]): boolean {
  const last = parts.filter((part) => part.type !== 'step-finish' && part.type !== 'step-start' && part.type !== 'patch').at(-1)
  return last?.type === 'tool' && last.state?.status === 'error'
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
