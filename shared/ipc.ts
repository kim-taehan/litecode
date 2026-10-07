// 렌더러 ↔ 메인 IPC 계약. 채널 이름과 페이로드 모양을 한 곳에 둔다.
// 타입은 서비스 쪽 정의를 그대로 재수출한다 — 같은 모양을 두 곳에 베끼지 않는다.

import type { ModelCatalogEntry, ProviderInput, ProviderSummary } from '../src/services/providers.ts'
import type { Mode } from './modes.ts'
import type { AttachmentKind, AttachmentPick, Attention, AttentionAnswer, AttentionTarget, Conversation, History, NoticeState, Project, ShellCard, TurnItem } from './contract.ts'
import type { ChatEventMap, ChatModel, ChatSnapshot, QueuedSend, SendResult } from './chat.ts'
import type { TriggerQuery, TriggerResult, TriggerScope } from '../src/services/triggers.ts'
import type { Trajectory } from '../src/services/trajectory.ts'
import type { ReportResult } from '../src/services/report.ts'
import type { Settings } from '../src/services/settings.ts'
import type { OpenTarget, Toast } from '../src/services/notifications.ts'
import type { OpenInApp } from '../src/services/openIn.ts'
import type { FilePreview, HtmlAsset } from '../src/services/filePreview.ts'
import type { DirectoryListing } from '../src/services/fileTree.ts'
import type { FeatureId, FeatureStatuses } from './features.ts'
import type { SkillInfo, SkillScope } from '../src/services/skills.ts'
import type { McpServerInput, McpServerSummary, McpTestResult } from '../src/services/mcp.ts'
import type { McpToolSelection } from './mcpTools.ts'
import type { HookCandidate, HookDraft, HookRecent, HookRow, HookScope, HookTestResult } from './hooks.ts'
import type { RemoteStatus } from '../src/services/remote.ts'
import type { SpeechLanguage, SpeechReply, SpeechStatus, SpeechStreamEvent, SpeechStreamOpened } from './speech.ts'

export type { ProviderConfig, ProviderSummary, ProviderInput, ModelCatalogEntry } from '../src/services/providers.ts'
export type { Mode } from './modes.ts'
export type { Attachment, AttachmentKind, AttachmentPick, Attention, AttentionAnswer, AttentionQuestion, AttentionSubtask, AttentionTarget, Conversation, ConversationStatus, FileDiff, History, HistoryMessage, McpToolRef, NoticeState, PickedAttachment, Project, ShellCard, Subtask, TurnItem, TurnUsage } from './contract.ts'
export type { ChatEvent, ChatEventMap, ChatLive, ChatModel, ChatSnapshot, QueuedSend, SendResult } from './chat.ts'
export type { AppCommand, TriggerCandidate, TriggerQuery, TriggerResult, TriggerScope } from '../src/services/triggers.ts'
export type { Trajectory, TrajectoryRecord } from '../src/services/trajectory.ts'
export type { ReportResult } from '../src/services/report.ts'
export type { Appearance, Settings } from '../src/services/settings.ts'
export type { NoticeKind, OpenTarget, Toast } from '../src/services/notifications.ts'
export type { OpenInApp } from '../src/services/openIn.ts'
export type { FilePreview, HtmlAsset } from '../src/services/filePreview.ts'
export type { DirectoryEntry, DirectoryListing } from '../src/services/fileTree.ts'
export type { FeatureId, FeatureReason, FeatureStatus, FeatureStatuses, FeatureSwitches } from './features.ts'
export type { SkillInfo, SkillScope } from '../src/services/skills.ts'
export type { SkillSource } from './skills.ts'
export type { McpScope, McpServerInput, McpServerSummary, McpTestResult, McpVarSummary } from '../src/services/mcp.ts'
export type { McpTool } from '../src/services/mcpClient.ts'
export type { McpToolSelection } from './mcpTools.ts'
export type { HookCandidate, HookDraft, HookEvent, HookRecent, HookRow, HookScope, HookTestResult } from './hooks.ts'
export type { RemoteDeviceInfo, RemotePairRequest, RemoteStatus } from '../src/services/remote.ts'
export type { SpeechErrorCode, SpeechLanguage, SpeechPartial, SpeechReply, SpeechState, SpeechStatus, SpeechStreamEvent, SpeechStreamOpened, SpeechTranscript, SpeechUnavailable } from './speech.ts'

export const Channel = {
  LIST_PROVIDERS: 'providers:list',
  SAVE_PROVIDER: 'providers:save',
  REMOVE_PROVIDER: 'providers:remove',
  FETCH_PROVIDER_MODELS: 'providers:fetch-models',
  SEND_MESSAGE: 'chat:send',
  TAKE_QUEUE: 'chat:take-queue',
  /** 대기열에서 다른 대화가 보낸 줄 하나를 뺀다 (이슈 #55) */
  DROP_QUEUED: 'chat:drop-queued',
  CHAT_SNAPSHOT: 'chat:snapshot',
  /** 메인 → 화면 (ChatEventMap['turn.started']) — 턴이 시작됐다: 그 턴의 내 말과 저장된 목록 정보 */
  TURN_STARTED: 'chat:turn-started',
  /** 메인 → 화면 (ChatEventMap['turn.ended']) — 턴이 끝났다: 답과 합산한 목록 정보 */
  TURN_ENDED: 'chat:turn-ended',
  /** 메인 → 화면 (ChatEventMap['queue.changed']) — 그 대화의 대기열 */
  QUEUE_CHANGED: 'chat:queue',
  /** 메인 → 화면 (ChatEventMap['conversations.changed']) */
  CONVERSATIONS_CHANGED: 'chat:conversations-changed',
  PICK_ATTACHMENTS: 'chat:pick-attachments',
  /** 붙여넣거나 끌어다 놓은 파일 (이슈 #80) — 본문은 preload 가 File 객체에서 만든다 (화면이 경로 문자열을 실어 보낼 길이 없다) */
  ATTACH_DROPPED: 'chat:attach-dropped',
  DISCARD_ATTACHMENTS: 'chat:discard-attachments',
  /** 이미지 칩의 썸네일·크게 보기 (이슈 #214) — 메인이 칩으로 내준 경로만 data: 주소로 */
  ATTACHMENT_PREVIEW: 'chat:attachment-preview',
  LIST_PROJECTS: 'projects:list',
  OPEN_PROJECT: 'projects:open',
  PICK_PROJECT_FOLDER: 'projects:pick-folder',
  SET_PROJECT_FAVORITE: 'projects:set-favorite',
  REMOVE_PROJECT: 'projects:remove',
  RENAME_PROJECT: 'projects:rename',
  LIST_CONVERSATIONS: 'sessions:list',
  MARK_VIEWED: 'sessions:viewed',
  LAST_VIEWED: 'sessions:last-viewed',
  SAVE_CONVERSATION: 'sessions:save',
  PATCH_CONVERSATION: 'sessions:patch',
  RENAME_CONVERSATION: 'sessions:rename',
  PIN_CONVERSATION: 'sessions:pin',
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
  COMPACT_CHAT: 'chat:compact',
  STOP_SUBTASK: 'chat:stop-subtask',
  RESOLVE_FILES: 'chat:resolve-files',
  REVEAL_FILE: 'chat:reveal-file',
  PREVIEW_FILE: 'chat:preview-file',
  PREVIEW_ASSETS: 'chat:preview-assets',
  LIST_DIRECTORY: 'chat:list-directory',
  RUN_SHELL: 'shell:run',
  STOP_SHELL: 'shell:stop',
  /** 메인 → 화면 (runId, chunk) */
  SHELL_DATA: 'shell:data',
  SHARE_SHELL: 'shell:share',
  GET_SETTINGS: 'settings:get',
  SET_SETTINGS: 'settings:set',
  OPEN_SETTINGS_FILE: 'settings:open-file',
  GET_APP_VERSION: 'app:version',
  /** 대화 내보내기·문제 신고 묶음 (ctx.report, 이슈 #177) */
  EXPORT_CONVERSATION: 'report:export-conversation',
  CREATE_REPORT: 'report:create',
  OPEN_REPORT: 'report:open',
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
  /** 패널의 PDF 를 OS 기본 앱으로 (이슈 #214) */
  OPEN_IN_FILE: 'openIn:open-file',
  GET_FEATURES: 'features:get',
  /** 메인 → 화면 (FeatureId[]) — 켜진 기능이 바뀌었다 (묶음을 다 올리고 내린 뒤) */
  FEATURES_CHANGED: 'features:changed',
  /** 켜진 기능의 상태 (ctx.features.statuses, 이슈 #224) — FeatureStatuses. 설정 > 기능이 "켜지 못함" 을 그린다 */
  GET_FEATURE_STATUSES: 'features:statuses',
  /** 메인 → 화면 (FeatureStatuses) — 기능 상태가 바뀌었다 */
  FEATURE_STATUSES_CHANGED: 'features:statuses-changed',
  /** 메인 → preload (boolean) — 창이 전체 화면인가. preload 가 html[data-fullscreen] 으로 옮긴다 (화면 코드는 CSS 만 본다) */
  WINDOW_FULLSCREEN: 'window:fullscreen',
  LIST_SKILLS: 'skills:list',
  OPEN_SKILLS_FOLDER: 'skills:open-folder',
  LIST_MCP: 'mcp:list',
  SAVE_MCP: 'mcp:save',
  REMOVE_MCP: 'mcp:remove',
  SET_MCP_ENABLED: 'mcp:set-enabled',
  TEST_MCP: 'mcp:test',
  /** 화면 → 메인 (name, selection | undefined, directory) — 그 프로젝트에서 MCP 서버 안의 도구를 고른다 (이슈 #164) */
  SET_MCP_TOOLS: 'mcp:set-tools',
  /** 훅 팝업 (이슈 #102 — `+` 메뉴 > 훅). 기능 `hooks` 가 켜져 있을 때만 걸려 있다. directory 는 지금 프로젝트(등록된 프로젝트만) */
  LIST_HOOKS: 'hooks:list',
  SAVE_HOOK: 'hooks:save',
  REMOVE_HOOK: 'hooks:remove',
  SET_HOOK_ENABLED: 'hooks:set-enabled',
  TEST_HOOK: 'hooks:test',
  HOOK_CANDIDATES: 'hooks:candidates',
  IMPORT_HOOKS: 'hooks:import',
  RECENT_HOOKS: 'hooks:recent',
  /** 화면 → 메인 (directory?) — 화면이 지금 보여 주는 프로젝트 (앱 MCP 서버의 화면 도구가 본다, 이슈 #51) */
  APP_MCP_VIEW: 'appMcp:view',
  /** 메인 → 화면 (directory, path, line?) — AI 가 open(파일) 을 불렀다 */
  APP_MCP_OPEN_FILE: 'appMcp:open-file',
  /** 메인 → 화면 (directory) — AI 가 open(터미널) 을 불렀다 (명령은 메인이 이미 채웠다) */
  APP_MCP_OPEN_TERMINAL: 'appMcp:open-terminal',
  REMOTE_STATUS: 'remote:status',
  REMOTE_START_PAIRING: 'remote:start-pairing',
  REMOTE_CANCEL_PAIRING: 'remote:cancel-pairing',
  REMOTE_ANSWER_PAIR: 'remote:answer-pair',
  REMOTE_REVOKE: 'remote:revoke',
  /** 메인 → 화면 (RemoteStatus) — 모바일 연결 상태·짝짓기 요청·기기 목록이 바뀌었다 (이슈 #56) */
  REMOTE_CHANGED: 'remote:changed',
  /** 음성 입력(ctx.speech) — 기능 `voice` 가 켜졌을 때만 있다 */
  SPEECH_STATUS: 'speech:status',
  /** 메인 → 화면 (SpeechStatus) */
  SPEECH_CHANGED: 'speech:changed',
  /** 실시간 받아쓰기 — 화면 → 메인 (language?) → SpeechStreamOpened. 열려 있던 스트림은 버리고 새로 연다 (화면은 한 번에 하나만 녹음한다) */
  SPEECH_STREAM_START: 'speech:stream-start',
  /** 화면 → 메인 (stream, Int16Array 16kHz mono — 0.1초쯤, 최대 1초). 번호가 다르거나 모양이 틀린 조각은 버린다 */
  SPEECH_STREAM_CHUNK: 'speech:stream-chunk',
  /** 화면 → 메인 (stream) → SpeechReply — 남은 구간까지 확정한 글 */
  SPEECH_STREAM_STOP: 'speech:stream-stop',
  /** 화면 → 메인 (stream) — 버린다 */
  SPEECH_STREAM_CANCEL: 'speech:stream-cancel',
  /** 메인 → 화면 (SpeechStreamEvent) — 지금까지 확정된 글·임시 글, 또는 그 스트림이 죽었다(error) */
  SPEECH_PARTIAL: 'speech:partial',
} as const

export interface LitecodeBridge {
  /** 키는 안 오고 설정 여부(hasKey)만 */
  listProviders(): Promise<ProviderSummary[]>
  /** 설정 > 모델의 [적용] — 새로 추가하거나 고치고 바뀐 목록을 준다. apiKey 가 비었으면 저장된 키 유지 */
  saveProvider(input: ProviderInput): Promise<ProviderSummary[]>
  removeProvider(id: string): Promise<ProviderSummary[]>
  /** 메인 프로세스가 `GET {baseURL}/models` 로 묻는다. 키는 입력한 것, 없으면 id 의 저장된 키 */
  fetchProviderModels(draft: { id?: string; baseURL: string; apiKey?: string }): Promise<ModelCatalogEntry[]>
  /** 그 대화에 보낸다 (ctx.chat, 이슈 #52) — 바로 돌아온다: 'sent'(턴이 시작됐다) 또는 'queued'(그 대화의 턴이 도는 중이라 대기열에 쌓였다 —
   *  턴이 끝나면 메인이 합쳐 보낸다). 내 말·진행 줄·답은 onTurnStarted·onTurnProgress·onTurnEnded 로 온다. 제목·저장·통계 합산은 메인이 한다.
   *  input.project 는 아직 저장 안 된 새 대화가 만들어질 폴더. display 를 주면 다시 열었을 때 text 대신 그 글이 말풍선에 보인다 (`/` 명령: text 는
   *  풀어 쓴 template). mode·model 은 이 턴부터 그 대화의 것이 된다.
   *  attachments 는 붙인 파일·이미지 (pickAttachments 가 준 것만 — 그 밖의 경로는 거절). 메인이 읽는다: 이미지는 엔진에 이미지로, 글 파일은
   *  프로젝트 안이면 본문 끝 `@경로`, 밖이면 본문에 풀어서. 그 모델이 이미지를 안 받으면(설정 > 모델) 이미지가 붙은 메시지는 실패한 턴으로 끝난다 */
  sendMessage(conversationId: string, input: QueuedSend): Promise<SendResult>
  /** 대기열 되돌리기 — 그 대화에 쌓인 것을 합쳐 받고 비운다 (입력창으로). 멈춰서 붙잡힌 대기열도 이것으로 푼다. 없으면 undefined */
  takeQueue(conversationId: string): Promise<QueuedSend | undefined>
  /** 대기열의 "빼기" (이슈 #55) — 다른 대화가 보낸 줄 하나를 뺀다 (index 는 onQueueChanged 의 items 자리). 사람이 친 줄은 못 뺀다(되돌리기는
   *  takeQueue). 뺐으면 true */
  dropQueued(conversationId: string, index: number): Promise<boolean>
  /** 메인이 쥔 지금 모습 — 대화마다 도는 턴(내 말·진행 줄·승인 카드)과 대기열. 화면이 (다시) 뜰 때 한 번 받고 그 뒤는 이벤트로 */
  chatSnapshot(): Promise<ChatSnapshot>
  onTurnStarted(listener: (event: ChatEventMap['turn.started']) => void): () => void
  onTurnEnded(listener: (event: ChatEventMap['turn.ended']) => void): () => void
  onQueueChanged(listener: (event: ChatEventMap['queue.changed']) => void): () => void
  onConversationsChanged(listener: (event: ChatEventMap['conversations.changed']) => void): () => void
  /** `+` 메뉴의 파일 추가·이미지 추가 (이슈 #44) — OS 파일 고르기(여러 개)를 띄워 고른 것을 칩 정보로 준다. 화면은 경로만 들고 내용은 안 읽는다.
   *  held 는 그 메시지에 이미 붙은 같은 종류의 수. 못 붙이는 것(이미지: png·jpeg 아님, 파일: 글자 아님·폴더, 크기·개수 상한)은 rejected 에 사유로.
   *  취소하면 둘 다 빈 목록. directory 는 파일 고르기가 처음 여는 폴더(파일 추가만) */
  pickAttachments(kind: AttachmentKind, directory: string, held: number): Promise<AttachmentPick>
  /** 붙여넣거나 끌어다 놓은 파일을 칩으로 (이슈 #80). **File 객체만 받는다** — 경로는 preload 가 `webUtils.getPathForFile` 로 얻는다(사용자가
   *  실제로 놓거나 붙여넣은 파일만 경로가 나온다. 화면이 지어낸 File 은 경로가 없다). 경로가 없는 것(스크린숏)은 png·jpeg 이미지일 때만 —
   *  preload 가 바이트를 메인에 넘기고 메인이 임시 파일로 둔다. 종류는 메인이 파일을 보고 정한다. held 는 종류별로 이미 붙은 수,
   *  model 은 그 대화의 모델(이미지를 안 받으면 이미지는 사유와 함께 거절). 폴더·바이너리·상한의 사유는 고르기와 같다 */
  attachFiles(conversationId: string, files: File[], held: Record<AttachmentKind, number>, model: ChatModel | undefined): Promise<AttachmentPick>
  /** 초안에서 뺀 칩을 알린다 — 붙여넣은 이미지의 임시 파일을 지운다 (메인이 만든 것만 지운다. 고른 파일은 건드리지 않는다) */
  discardAttachments(paths: string[]): Promise<void>
  /** 이미지 칩의 미리보기 (이슈 #214) — 메인이 이미지 칩으로 내준(아직 빼거나 보내지 않은) 경로면 data:image/png|jpeg 주소, 아니면 undefined.
   *  화면은 이것을 <img> 로만 그린다 */
  attachmentPreview(path: string): Promise<string | undefined>
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
  /** 사용자가 그 (저장된) 대화를 열어 보고 있다 — 그 프로젝트의 "마지막에 보던 대화" 로 저장한다 (이슈 #137, ctx.sessions.noteViewed) */
  markViewed(conversationId: string): Promise<void>
  /** 프로젝트 경로 → 그 프로젝트에서 마지막에 보던 대화 id (앱을 껐다 켜도 남는다) — 다른 프로젝트에 지시를 보낼 때 받는 대화 */
  lastViewed(): Promise<Record<string, string>>
  /** 넣거나 고친다. 그 프로젝트가 보관 개수를 넘어 지운 대화 id 를 준다. 보낸 대화의 저장은 메인(ctx.chat)이 한다 — 화면은 `!명령` 만
   *  돌린 새 대화를 목록에 넣을 때만 쓴다 */
  saveConversation(conversation: Conversation): Promise<string[]>
  /** 저장된 대화의 고른 모델·모드·마지막 활동 시각만 고친다 (저장 안 된 새 대화면 아무것도 안 한다 — 첫 보내기가 정한다) */
  patchConversation(id: string, patch: { model?: ChatModel; mode?: Mode; updatedAt?: number }): Promise<void>
  /** 대화 이름을 바꾼다 (이슈 #63) — 제목은 메인(ctx.chat)이 적는다. 고친 목록 정보를 준다. 빈 이름·저장 안 된 대화면 undefined */
  renameConversation(id: string, name: string): Promise<Conversation | undefined>
  /** 대화를 고정하거나 푼다 (이슈 #79) — 메인(ctx.chat)이 적는다. 고친 목록 정보를 준다. 저장 안 된 대화면 undefined */
  pinConversation(id: string, pinned: boolean): Promise<Conversation | undefined>
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
  replyAttention(sessionId: string, requestId: string, answer: AttentionAnswer, target?: AttentionTarget): Promise<void>
  /** 답변 중지 — 그 대화의 도는 턴을 멈춘다(엔진 턴도). 그 턴은 "중단됨"(interrupted) 으로 끝난다 (onTurnEnded). 쌓인 대기열은 보내지 않고
   *  붙잡힌다(onQueueChanged 의 held) — takeQueue 로 입력창에 되돌린다. 도는 턴이 없으면 false */
  stopTurn(conversationId: string): Promise<boolean>
  /** `/compact` — 그 대화를 요약해 컨텍스트를 줄인다. 요약은 한 턴처럼 돈다 (onTurnStarted → 요약 줄 onTurnProgress → onTurnEnded, 멈춤은 stopTurn).
   *  턴이 도는 중이거나 아직 한 번도 안 보낸 대화면 시작하지 않고 그 사유를 준다 */
  compactChat(conversationId: string): Promise<{ ok: true } | { ok: false; error: string }>
  /** 도는 턴의 하위 작업 하나만 멈춘다 (subtaskId = 그 하위 작업 진행 줄의 id) — 턴은 이어 간다. 도는 턴의 하위 작업이 아니면 false */
  stopSubtask(subtaskId: string): Promise<boolean>
  /** 답의 인라인 코드 중 그 프로젝트 안의 실제 파일인 것만 (받은 글자 그대로) — 파일 언급 칩 */
  resolveFiles(directory: string, tokens: string[]): Promise<string[]>
  /** 프로젝트 안의 그 파일을 OS 파일 관리자에서 보여 준다 (열지·실행하지 않는다). 프로젝트 밖·없는 파일이면 false */
  revealFile(directory: string, token: string): Promise<boolean>
  /** 파일 미리보기 패널 — 칩과 같은 (프로젝트, 답의 글자) 로 그 파일 내용(앞 1MB). 등록 안 된 폴더·밖·링크로 밖·없는 파일이면
   *  unavailable, 이진이면 내용 없이 binary. 읽기만 한다 */
  previewFile(directory: string, token: string): Promise<FilePreview>
  /** HTML 미리보기 — 그 HTML 파일 폴더 기준 상대 경로 리소스(스크립트·스타일 글, 이미지 data: 주소). 프로젝트 밖·링크로 밖·없는 것은 빠진다 */
  previewAssets(directory: string, token: string, references: string[]): Promise<HtmlAsset[]>
  /** 오른쪽 패널 Files 탭 — 프로젝트 안 폴더 한 단계(relative '' = 루트). 밖을 가리키는 링크는 빠지고, 등록 안 된 폴더·밖이면 unavailable */
  listDirectory(directory: string, relative: string): Promise<DirectoryListing>
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
  /** 대화 머리 ⋯ "대화 내보내기" — 저장 위치를 묻고 그 대화 전체(말·도구 호출·결과·시각)를 JSON 파일 하나로. 못 읽으면 지금 언어의 사유로 거절 */
  exportConversation(conversationId: string): Promise<ReportResult>
  /** 설정 > 일반 "문제 신고 묶음" — 폴더를 묻고 그 안에 litecode-report-<시각>/ 을 만든다 (비밀·대화 내용 없음, 로컬 저장만) */
  createReport(): Promise<ReportResult>
  /** 이 실행에서 만든 묶음 폴더를 OS 파일 관리자로 연다. 다른 경로·실패면 거절 */
  openReport(dir: string): Promise<void>
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
  /** 오른쪽 패널의 PDF 를 OS 기본 앱으로 (이슈 #214) — 등록된 프로젝트 안의 .pdf(머리 %PDF-)만. 그 밖·실행 실패는 지금 언어의 사유로 거절 */
  openFileIn(directory: string, token: string): Promise<void>
  /** 켜진 기능 (ctx.features) — 꺼진 기능의 버튼·탭·메뉴·단축키는 그리지 않는다. 켜고 끄기는 setSettings({ features }) */
  getFeatures(): Promise<FeatureId[]>
  onFeaturesChanged(listener: (enabled: FeatureId[]) => void): () => void
  /** 켜진 기능의 상태 (이슈 #224) — 꺼진 기능은 빠진다. failed 면 사유가 있다 */
  getFeatureStatuses(): Promise<FeatureStatuses>
  onFeatureStatusesChanged(listener: (statuses: FeatureStatuses) => void): () => void
  /** 그 프로젝트에서 모델이 쓸 수 있는 스킬 (`+` 메뉴의 스킬 팝업, ctx.skills) — 이름순, 묶음(scope)은 위치로, 본문은 파일에서 지금 읽은 것 */
  listSkills(directory: string): Promise<SkillInfo[]>
  /** 스킬 팝업의 "폴더 열기" — 그 묶음의 스킬 폴더를 OS 파일 관리자로 연다 (없으면 만든다). project 는 `<프로젝트>/.opencode/skills`, all 은 앱 스킬 폴더 */
  openSkillsFolder(scope: SkillScope, directory: string): Promise<void>
  /** `+` 메뉴의 MCP 팝업 목록 (ctx.mcp) — directory 는 지금 프로젝트(그 폴더의 상태·그 프로젝트의 서버와 켜기 값). 비밀 값은 안 오고 설정 여부만 */
  listMcp(directory?: string): Promise<McpServerSummary[]>
  /** 앱 서버를 넣거나 고친다 (originalName 이 있으면 고침). 비밀 var 의 빈 값은 저장된 값 유지.
   *  input.scope 가 project 면 directory(지금 프로젝트)에만 저장한다 — 앱 안에 프로젝트 경로별로 */
  saveMcp(input: McpServerInput, directory?: string): Promise<void>
  /** directory 의 전용 서버를 먼저 찾아 지우고, 없으면 모든 프로젝트 서버 */
  removeMcp(name: string, directory?: string): Promise<void>
  /** 그 프로젝트에서만 켜고 끈다 */
  setMcpEnabled(name: string, enabled: boolean, directory: string): Promise<void>
  /** 저장하지 않고 붙어 본다 — 도구 목록 또는 사유 */
  testMcp(input: McpServerInput, directory?: string): Promise<McpTestResult>
  /** 그 프로젝트에서만 서버 안의 도구를 고른다 (이슈 #164) — undefined 면 전부 켜짐. 다음 턴부터 꺼진 도구는 모델에 안 보인다 */
  setMcpTools(name: string, selection: McpToolSelection | undefined, directory: string): Promise<void>
  /** `+` 메뉴의 훅 팝업 (ctx.hooks, 이슈 #102) — **기능 `hooks` 가 켜져 있을 때만 부른다** (꺼져 있으면 채널이 없다).
   *  그 프로젝트에서 본 훅: 모든 프로젝트 것 먼저 → 이 프로젝트만 (도는 순서) */
  listHooks(directory: string): Promise<HookRow[]>
  /** 훅 하나를 넣거나 고친다 (draft.original 이 있으면 고침). 메인이 검증한다 — 틀리면 사유와 함께 거절. 다음 턴부터 돈다 */
  saveHook(draft: HookDraft, directory: string): Promise<void>
  removeHook(scope: HookScope, key: string, directory: string): Promise<void>
  /** 그 프로젝트에서만 켜고 끈다 — 모든 프로젝트 훅도 */
  setHookEnabled(key: string, enabled: boolean, directory: string): Promise<void>
  /** 저장하지 않고 견본 입력으로 한 번 돌려 본다 — 대화에는 아무것도 남지 않는다 */
  testHook(draft: HookDraft, directory: string): Promise<HookTestResult>
  /** 프로젝트 폴더의 `.claude/settings.json`·`.claude/settings.local.json` 에서 찾은, 아직 가져오지 않은 훅 (읽기만 — 실행하지 않는다) */
  hookCandidates(directory: string): Promise<HookCandidate[]>
  /** 고른 후보(열쇠)만 "이 프로젝트만" 에 복사한다 — 가져온 수 */
  importHooks(keys: string[], directory: string): Promise<number>
  /** 그 프로젝트에서 돈 최근 실행 (오래된 것부터 — 앱을 끄면 사라진다) */
  recentHooks(directory: string): Promise<HookRecent[]>
  /** 화면이 지금 보여 주는 프로젝트를 알린다 (없으면 undefined) — 앱 MCP 서버의 화면 도구(open(파일·터미널))는 보고 있는 프로젝트에만 닿는다 */
  viewProject(directory?: string): Promise<void>
  /** AI 가 그 프로젝트의 파일을 열라고 했다 — path 는 프로젝트 기준 상대 경로(메인이 프로젝트 안의 파일임을 확인했다), line 은 1부터 */
  onAppMcpOpenFile(listener: (directory: string, path: string, line?: number) => void): () => void
  /** AI 가 그 프로젝트의 터미널 칸을 열라고 했다 — 명령은 메인이 이미 채웠다(실행하지 않았다) */
  onAppMcpOpenTerminal(listener: (directory: string) => void): () => void
  /** 모바일 연결(ctx.remote, 이슈 #56)의 지금 상태 — 듣는 주소(또는 못 뜬 사유)·짝짓기 코드·[허용] 을 기다리는 요청·짝지은 기기.
   *  기능 `remote` 가 켜졌을 때만 있다 (꺼져 있으면 이 채널들은 거절된다) */
  remoteStatus(): Promise<RemoteStatus>
  /** [기기 연결] — 새 짝짓기 코드 (2분·1회용, 앞 코드는 버린다). 듣고 있지 않으면 거절 */
  startRemotePairing(): Promise<RemoteStatus>
  cancelRemotePairing(): Promise<RemoteStatus>
  /** 짝짓기 요청의 [허용]/[거절] */
  answerRemotePair(requestId: string, allow: boolean): Promise<RemoteStatus>
  /** 기기 해제 — 그 기기의 토큰은 곧바로 못 쓰고 붙어 있던 연결은 끊긴다 */
  revokeRemoteDevice(deviceId: string): Promise<RemoteStatus>
  onRemoteChanged(listener: (status: RemoteStatus) => void): () => void
  /** 음성 입력(ctx.speech)의 지금 상태 — 준비 안 됨(사유)·준비됨·엔진 뜨는 중, 기본 언어 힌트.
   *  기능 `voice` 가 켜졌을 때만 있다 (꺼져 있으면 이 채널들은 거절된다 — 마이크 권한도 거절된다) */
  speechStatus(): Promise<SpeechStatus>
  onSpeechChanged(listener: (status: SpeechStatus) => void): () => void
  /** 실시간 받아쓰기를 연다 — 녹음 조각을 sendSpeechChunk 로 흘리면 onSpeechPartial 로 확정 글·임시 글이 오고, stopSpeechStream 이 최종 글을 준다.
   *  한 번에 하나: 다른 받아쓰기가 돌면 { ok: false, code: 'busy' }. 녹음 상한(120초)을 넘는 조각은 메인이 버린다 */
  startSpeechStream(language?: SpeechLanguage): Promise<SpeechStreamOpened>
  /** 녹음 조각 — 16kHz mono PCM16 (shared/speech.ts SPEECH_CHUNK_SAMPLES, 최대 1초). 답을 기다리지 않는다 */
  sendSpeechChunk(stream: number, pcm: Int16Array): void
  /** 녹음이 끝났다 — 남은 구간까지 받아쓴 글. 던지지 않는다 (실패는 { ok: false, code, message }), 모르는 번호는 cancelled */
  stopSpeechStream(stream: number): Promise<SpeechReply>
  cancelSpeechStream(stream: number): Promise<void>
  onSpeechPartial(listener: (event: SpeechStreamEvent) => void): () => void
}

declare global {
  interface Window {
    litecode: LitecodeBridge
  }
}
