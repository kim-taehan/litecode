// 렌더러 ↔ 메인 IPC 계약. 채널 이름과 페이로드 모양을 한 곳에 둔다.
// 타입은 서비스 쪽 정의를 그대로 재수출한다 — 같은 모양을 두 곳에 베끼지 않는다.

import type { ModelCatalogEntry, ProviderInput, ProviderSummary } from '../src/services/providers.ts'
import type { ChatResult, History } from '../src/services/llm.ts'
import type { Project } from '../src/services/projects.ts'
import type { Conversation } from '../src/services/sessions.ts'
import type { TriggerQuery, TriggerResult, TriggerScope } from '../src/services/triggers.ts'

export type { ProviderConfig, ProviderSummary, ProviderInput, ModelCatalogEntry } from '../src/services/providers.ts'
export type { ChatResult, History, HistoryMessage } from '../src/services/llm.ts'
export type { TurnUsage } from '../src/services/turnUsage.ts'
export type { Project } from '../src/services/projects.ts'
export type { Conversation } from '../src/services/sessions.ts'
export type { TriggerCandidate, TriggerQuery, TriggerResult, TriggerScope } from '../src/services/triggers.ts'

export const Channel = {
  LIST_PROVIDERS: 'providers:list',
  SAVE_PROVIDER: 'providers:save',
  REMOVE_PROVIDER: 'providers:remove',
  FETCH_PROVIDER_MODELS: 'providers:fetch-models',
  SEND_MESSAGE: 'chat:send',
  LIST_PROJECTS: 'projects:list',
  OPEN_PROJECT: 'projects:open',
  PICK_PROJECT_FOLDER: 'projects:pick-folder',
  SET_PROJECT_FAVORITE: 'projects:set-favorite',
  REMOVE_PROJECT: 'projects:remove',
  RENAME_PROJECT: 'projects:rename',
  LIST_CONVERSATIONS: 'sessions:list',
  SAVE_CONVERSATION: 'sessions:save',
  REMOVE_CONVERSATION: 'sessions:remove',
  LOAD_CONVERSATION: 'sessions:history',
  QUERY_TRIGGER: 'triggers:query',
  PICK_TRIGGER: 'triggers:pick',
  SUBMIT_TRIGGER: 'triggers:submit',
  OPEN_TERMINAL: 'terminal:open',
  WRITE_TERMINAL: 'terminal:write',
  RESIZE_TERMINAL: 'terminal:resize',
  /** 메인 → 화면 (directory, chunk, end) */
  TERMINAL_DATA: 'terminal:data',
  /** 메인 → 화면 (directory) */
  TERMINAL_EXIT: 'terminal:exit',
} as const

export interface LitecodeBridge {
  /** 키는 안 오고 설정 여부(hasKey)만 */
  listProviders(): Promise<ProviderSummary[]>
  /** 설정 > 모델의 [적용] — 새로 추가하거나 고치고 바뀐 목록을 준다. apiKey 가 비었으면 저장된 키 유지 */
  saveProvider(input: ProviderInput): Promise<ProviderSummary[]>
  removeProvider(id: string): Promise<ProviderSummary[]>
  /** 메인 프로세스가 `GET {baseURL}/models` 로 묻는다. 키는 입력한 것, 없으면 id 의 저장된 키 */
  fetchProviderModels(draft: { id?: string; baseURL: string; apiKey?: string }): Promise<ModelCatalogEntry[]>
  /** sessionId 를 안 주면 directory(작업 디렉터리)에서 세션을 새로 만든다 — 결과의 sessionId 를 다음 호출에 넘긴다.
   *  conversationId 는 저장된 대화(saveConversation) — 새 세션이 생기자마자 거기에 붙인다 (답 대기 중 앱이 꺼져도 다시 열리게).
   *  display 를 주면 다시 열었을 때 prompt 대신 그 글이 말풍선에 보인다 (`/` 명령: prompt 는 풀어 쓴 template) */
  sendMessage(
    conversationId: string,
    providerId: string,
    modelId: string,
    directory: string,
    prompt: string,
    sessionId?: string,
    display?: string,
  ): Promise<ChatResult>
  /** 최근 프로젝트 — 맨 앞이 마지막으로 연 프로젝트 */
  listProjects(): Promise<Project[]>
  /** 그 폴더를 열어 최근 목록 맨 앞에 올린다 */
  openProject(directory: string): Promise<Project>
  /** OS 폴더 대화상자로 골라 연다. 취소하면 undefined */
  pickProjectFolder(): Promise<Project | undefined>
  /** 즐겨찾기 표시를 바꾸고 바뀐 목록을 준다 */
  setProjectFavorite(directory: string, favorite: boolean): Promise<Project[]>
  /** 목록에서만 뺀다(폴더는 그대로) — 바뀐 목록을 준다 */
  removeProject(directory: string): Promise<Project[]>
  /** 보이는 이름만 바꾼다 (폴더 이름은 그대로). 빈 이름이면 폴더 이름으로 */
  renameProject(directory: string, name: string): Promise<Project[]>
  /** 저장된 대화 목록 정보 — 모든 프로젝트, 맨 앞이 가장 최근에 만든 것 */
  listConversations(): Promise<Conversation[]>
  /** 넣거나 고친다. 그 프로젝트가 보관 개수를 넘어 지운 대화 id 를 준다 */
  saveConversation(conversation: Conversation): Promise<string[]>
  /** 목록에서 빼고 엔진 세션도 지운다 (되돌리기 없음) */
  removeConversation(id: string): Promise<void>
  /** 저장된 대화의 말풍선. 작업 폴더가 없으면 엔진에 묻지 않고 missingFolder */
  loadConversation(id: string): Promise<History>
  /** 캐럿 자리의 입력 트리거와 후보 — 트리거가 아니면 null. 화면은 어떤 문자가 트리거인지 모른다 (ctx.triggers) */
  queryTrigger(scope: TriggerScope, draft: string, caret: number): Promise<TriggerQuery | null>
  /** 후보 하나를 고른다 (drill: 폴더로 들어가기) */
  pickTrigger(scope: TriggerScope, char: string, id: string, action: 'pick' | 'drill'): Promise<TriggerResult>
  /** 입력 전체를 Enter 로 낸다 — null 이면 평범한 프롬프트로 보낸다 */
  submitTrigger(scope: TriggerScope, draft: string): Promise<TriggerResult | null>
  /** 그 폴더의 터미널 (없으면 띄운다) — 지금까지의 출력과 끝 위치. end 이하의 onTerminalData 조각은 이미 들어 있다 */
  openTerminal(directory: string): Promise<{ output: string; end: number }>
  writeTerminal(directory: string, data: string): Promise<void>
  resizeTerminal(directory: string, rows: number, cols: number): Promise<void>
  /** 해제 함수를 준다 */
  onTerminalData(listener: (directory: string, chunk: string, end: number) => void): () => void
  onTerminalExit(listener: (directory: string) => void): () => void
}

declare global {
  interface Window {
    litecode: LitecodeBridge
  }
}
