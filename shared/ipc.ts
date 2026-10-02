// 렌더러 ↔ 메인 IPC 계약. 채널 이름과 페이로드 모양을 한 곳에 둔다.
// 타입은 서비스 쪽 정의를 그대로 재수출한다 — 같은 모양을 두 곳에 베끼지 않는다.

import type { ModelCatalogEntry, ProviderInput, ProviderSummary } from '../src/services/providers.ts'
import type { Attention, AttentionAnswer, ChatResult, History } from '../src/services/llm.ts'
import type { Mode } from './modes.ts'
import type { Project } from '../src/services/projects.ts'
import type { Conversation, ShellCard } from '../src/services/sessions.ts'
import type { TriggerQuery, TriggerResult, TriggerScope } from '../src/services/triggers.ts'
import type { Trajectory } from '../src/services/trajectory.ts'
import type { TurnItem } from '../src/services/turnProgress.ts'
import type { Settings } from '../src/services/settings.ts'
import type { NoticeState, OpenTarget, Toast } from '../src/services/notifications.ts'
import type { OpenInApp } from '../src/services/openIn.ts'
import type { FeatureId } from './features.ts'

export type { ProviderConfig, ProviderSummary, ProviderInput, ModelCatalogEntry } from '../src/services/providers.ts'
export type { Attention, AttentionAnswer, AttentionQuestion, ChatResult, History, HistoryMessage } from '../src/services/llm.ts'
export type { Mode } from './modes.ts'
export type { TurnUsage } from '../src/services/turnUsage.ts'
export type { TurnItem } from '../src/services/turnProgress.ts'
export type { FileDiff } from '../src/services/toolDiffs.ts'
export type { Project } from '../src/services/projects.ts'
export type { Conversation, ShellCard } from '../src/services/sessions.ts'
export type { TriggerCandidate, TriggerQuery, TriggerResult, TriggerScope } from '../src/services/triggers.ts'
export type { Trajectory, TrajectoryRecord } from '../src/services/trajectory.ts'
export type { Appearance, Settings } from '../src/services/settings.ts'
export type { ConversationStatus, NoticeKind, NoticeState, OpenTarget, Toast } from '../src/services/notifications.ts'
export type { OpenInApp } from '../src/services/openIn.ts'
export type { FeatureId, FeatureSwitches } from './features.ts'

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
  OPEN_EXTERNAL: 'shell:open-external',
  LOAD_TRAJECTORY: 'trajectory:load',
  /** 메인 → 화면 (conversationId, item) — 답을 기다리는 턴의 진행 줄 */
  TURN_PROGRESS: 'chat:progress',
  /** 메인 → 화면 (conversationId, Attention[]) — 답을 기다리는 턴의 승인·질문 목록 (빈 목록 = 없음) */
  TURN_ATTENTION: 'chat:attention',
  REPLY_ATTENTION: 'chat:reply-attention',
  STOP_TURN: 'chat:stop',
  RESOLVE_FILES: 'chat:resolve-files',
  REVEAL_FILE: 'chat:reveal-file',
  RUN_SHELL: 'shell:run',
  STOP_SHELL: 'shell:stop',
  /** 메인 → 화면 (runId, chunk) */
  SHELL_DATA: 'shell:data',
  SHARE_SHELL: 'shell:share',
  GET_SETTINGS: 'settings:get',
  SET_SETTINGS: 'settings:set',
  OPEN_SETTINGS_FILE: 'settings:open-file',
  GET_APP_VERSION: 'app:version',
  GET_NOTIFICATIONS: 'notifications:get',
  VIEW_CONVERSATION: 'notifications:view',
  TAKE_PENDING_OPEN: 'notifications:take-open',
  /** 메인 → 화면 (NoticeState) */
  NOTIFICATIONS_CHANGED: 'notifications:changed',
  /** 메인 → 화면 (Toast) */
  NOTIFICATION_TOAST: 'notifications:toast',
  /** 메인 → 화면 — PC 알림을 눌렀다. 화면은 takePendingOpen 으로 열 곳을 당겨 간다 */
  NOTIFICATION_OPEN: 'notifications:open',
  OPEN_IN_APPS: 'openIn:apps',
  OPEN_IN: 'openIn:open',
  GET_FEATURES: 'features:get',
  /** 메인 → 화면 (FeatureId[]) — 켜진 기능이 바뀌었다 (묶음을 다 올리고 내린 뒤) */
  FEATURES_CHANGED: 'features:changed',
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
   *  display 를 주면 다시 열었을 때 prompt 대신 그 글이 말풍선에 보인다 (`/` 명령: prompt 는 풀어 쓴 template).
   *  mode 는 이 턴을 돌릴 모드 (입력창 칩) — 엔진 세션을 그 모드로 맞추고 보낸다 */
  sendMessage(
    conversationId: string,
    providerId: string,
    modelId: string,
    directory: string,
    prompt: string,
    sessionId?: string,
    display?: string,
    mode?: Mode,
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
  /** 답의 링크를 OS 기본 브라우저로 연다 — 메인이 절대 http(s) 만 연다(그 밖은 false) */
  openExternal(url: string): Promise<boolean>
  /** 대화 하나의 스텝·도구 기록 (Trajectory 탭). directory 는 그 대화의 작업 폴더 — 없으면 엔진에 묻지 않고 missingFolder */
  loadTrajectory(directory: string, sessionId: string): Promise<Trajectory>
  /** 답을 기다리는 턴의 진행 줄(생각·도구·글)이 바뀔 때마다 — 같은 id 는 바꿔 끼운다. 해제 함수를 준다 */
  onTurnProgress(listener: (conversationId: string, item: TurnItem) => void): () => void
  /** 답을 기다리는 턴이 기다리는 승인·질문 목록이 바뀔 때마다 (빈 목록 = 없음) — 대화 안 카드 */
  onTurnAttention(listener: (conversationId: string, requests: Attention[]) => void): () => void
  /** 카드의 답 — 권한 'once'|'reject', 질문은 질문 순서대로 고른 답 또는 'reject'. 이미 풀린 요청·빈 답이면 거절 */
  replyAttention(sessionId: string, requestId: string, answer: AttentionAnswer): Promise<void>
  /** 답변 중지 — 그 대화의 도는 턴을 멈춘다(엔진 턴도). 그 턴의 sendMessage 가 "중단됨"(interrupted) 으로 끝난다. 도는 턴이 없으면 false */
  stopTurn(conversationId: string): Promise<boolean>
  /** 답의 인라인 코드 중 그 프로젝트 안의 실제 파일인 것만 (받은 글자 그대로) — 파일 언급 칩 */
  resolveFiles(directory: string, tokens: string[]): Promise<string[]>
  /** 프로젝트 안의 그 파일을 OS 파일 관리자에서 보여 준다 (열지·실행하지 않는다). 프로젝트 밖·없는 파일이면 false */
  revealFile(directory: string, token: string): Promise<boolean>
  /** `!명령` — 그 대화의 프로젝트 폴더에서 한 번 돌리고, 끝나면 그 대화에 카드로 저장한 것을 준다. runId 는 화면이 정한다(출력 조각을
   *  onShellData 로 받으려고). position 은 대화 안 자리(앞 말풍선 수). 결과는 대화 맥락에 안 들어간다 */
  runShell(conversationId: string, runId: string, directory: string, command: string, position: number): Promise<ShellCard>
  /** ■ — 돌고 있으면 멈춘다 */
  stopShell(runId: string): Promise<boolean>
  onShellData(listener: (runId: string, chunk: string) => void): () => void
  /** 카드를 AI 에게 — 그 대화 엔진 세션의 맥락에만 넣는다(LLM 은 안 돈다). 세션이 없으면 그 모델로 만든다. 턴이 도는 중이면 거절 */
  shareShell(conversationId: string, cardId: string, providerId: string, modelId: string): Promise<{ ok: boolean; sessionId?: string; error?: string }>
  /** 설정 > 일반의 값 (ctx.settings) */
  getSettings(): Promise<Settings>
  /** 바꿀 값만 — 저장된 전체 값을 준다. 잘못된 값이면 지금 언어의 사유로 거절 */
  setSettings(patch: Partial<Settings>): Promise<Settings>
  /** userData/settings.json 을 OS 연결 프로그램으로 연다 (없으면 만든다). 못 열면 지금 언어의 사유로 거절 */
  openSettingsFile(): Promise<void>
  /** 앱 버전 (package.json version) — 설정 > 일반 맨 아래 "현재 버전" */
  getAppVersion(): Promise<string>
  /** 대화별 알림 상태 (실행 중·답 필요·안 본 끝남) — 대화 행·프로젝트 점 (ctx.notifications) */
  getNotifications(): Promise<NoticeState>
  /** 화면이 지금 보여 주는 대화 — 앱이 앞이면 읽음, 그 대화의 사건은 알리지 않는다 */
  viewConversation(conversationId?: string): Promise<void>
  /** 누른 PC 알림의 열 곳 — 한 번 당겨 가면 비워진다 */
  takePendingOpen(): Promise<OpenTarget | undefined>
  onNotificationsChanged(listener: (state: NoticeState) => void): () => void
  onNotificationToast(listener: (toast: Toast) => void): () => void
  onNotificationOpen(listener: () => void): () => void
  /** "다른 앱에서 열기" — 이 기계에 깔린 허용 목록 앱 (메뉴 순서). mac 이 아니면 빈 목록 (ctx.openIn) */
  openInApps(): Promise<OpenInApp[]>
  /** 그 프로젝트 폴더를 그 앱으로 연다. 목록 밖 앱·등록 안 된 폴더·실행 실패면 지금 언어의 사유로 거절 */
  openIn(appId: string, directory: string): Promise<void>
  /** 켜진 기능 (ctx.features) — 꺼진 기능의 버튼·탭·메뉴·단축키는 그리지 않는다. 켜고 끄기는 setSettings({ features }) */
  getFeatures(): Promise<FeatureId[]>
  onFeaturesChanged(listener: (enabled: FeatureId[]) => void): () => void
}

declare global {
  interface Window {
    litecode: LitecodeBridge
  }
}
