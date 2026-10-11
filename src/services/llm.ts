import type { LlmService } from './llm/service.ts'
import type { McpToolRef } from './turnProgress.ts'
import type { PreTool, PreToolDecision, ToolDone, ToolStarted, TurnInfo } from './llm/types.ts'
import type { Attention } from '../../shared/contract.ts'

export { LlmService } from './llm/service.ts'
export type { PreTool, PreToolDecision, ToolDone, ToolStarted, McpStatus, TurnInfo, ChatResult, Interjection, ChatImage, ChatOptions, EngineMessage, FileEntry, EngineCommand, EngineSkill, LlmConfig } from './llm/types.ts'
export { MODEL_CATALOG_TIMEOUT_MS, AGENT_LIST_TIMEOUT_MS, MAX_COMPACTIONS_PER_TURN, MAX_RETRIES_PER_TURN, connectionRefused, CALLER_WAIT_MS, PRE_TOOL_WAIT_MS, STREAM_IDLE_TIMEOUT_MS, MODEL_STALL_TIMEOUT_MS } from './llm/limits.ts'
export { ascendingId, MCP_TOOLS_MARKER, promptTools, promptParts } from './llm/prompt.ts'
export { finishedTool } from './llm/follow.ts'

// 화면에 실리는 타입의 정의는 shared/contract.ts 에 있다 (모바일 앱과 같이 쓴다 — 이슈 #42). 여기서는 다시 내보내기만 한다
export type { Attention, PermissionAttention, QuestionAttention, AttentionSubtask, AttentionQuestion, AttentionAnswer, HistoryMessage, History } from '../../shared/contract.ts'

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
//
// 이 파일은 진입점이다 — 이벤트 계약(아래 declare module)과 다시 내보내기만 둔다 (이슈 #289에서 나눔, 동작 변경 없음):
// - llm/service.ts   LlmService — 상태·턴 흐름(chat·compact·askOnce·끼워 넣기)·폴더 문(engineFolder)·엔진 읽기(트리거 목록·기록·MCP)
// - llm/follow.ts    /event 구독으로 한 턴 따라가기 — 끝 판정·재시도/요약 상한·무응답 감시·도구 이벤트
// - llm/attention.ts 승인·질문 — 대기 목록·도구 실행 전 판정·답(reply)·[항상 허용]
// - llm/engineApi.ts 엔진 레거시/신규 REST 호출 (상태 없음)
// - llm/prompt.ts    prompt_async 본문 모양·메시지 id
// - llm/limits.ts    기한·상한 상수
// - llm/types.ts     중립 모양 타입

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
    /** 그 폴더(realpath)에 프롬프트를 보내기 직전 — ctx.mcp 가 그 폴더 인스턴스에 MCP 서버를 붙인다(이슈 #28). 실패해도 턴은 간다 */
    'llm/before-turn'(directory: string): Promise<void> | void
    /** 도는 턴의 도구 호출 하나가 끝났다 (성공·실패, 호출마다 한 번) — 하위 작업이 부른 도구도 온다 (이슈 #102, 듣는 쪽은 ctx.hooks) */
    'llm/tool-done'(info: ToolDone): void
    /** 도는 턴의 도구 호출 하나가 실행에 들어갔다 (running — 입력이 정해졌다, callID 마다 한 번). 입력을 만드는 중(pending)에는 안 나간다.
     *  엔진은 도구가 끝나면 곧바로 다음 요청을 만들어서, 그 요청에 실을 끼워 넣기는 이때 해야 한다 (이슈 #284 실측, 듣는 쪽은 ctx.repeatGuard) */
    'llm/tool-started'(info: ToolStarted): void
    /** 도는 턴의 도구 호출 하나가 실행되기 직전 — 엔진이 그 호출의 승인을 물었을 때만 온다 (모드가 원래 묻는 도구 + gateTools 로 정한 도구,
     *  이슈 #102 2단계). ctx.serial 로 차례로 묻고 처음 나온 판정을 쓴다: 'allow'(통과) · { deny, reason }(막는다 — 사유가 모델에 가고 턴은 이어진다) ·
     *  'ask'(사용자에게 묻는다 — 승인 카드). 답이 없으면(undefined) 판정한 쪽이 없는 것이다. 통과·무응답이어도 **모드가 원래 묻는 호출은 승인 카드가 뜬다** */
    'llm/pre-tool'(info: PreTool): Promise<PreToolDecision | undefined> | PreToolDecision | undefined
    /** 승인 카드에 MCP 도구 호출의 인자를 싣기 직전 (ctx.bail — 처음 나온 값을 쓴다). 그 도구를 아는 쪽이 화면에 가면 안 되는 값(비밀)을 가린
     *  인자를 돌려준다 (이슈 #145). 답이 없으면 인자 그대로 싣는다. 도구가 받는 인자·부른 대화 찾기(callerOf)는 원래 값 그대로다 */
    'llm/attention-input'(ref: McpToolRef, input: unknown): unknown
  }
}
