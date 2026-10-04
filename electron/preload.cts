import { contextBridge, ipcRenderer } from 'electron'
import type { LitecodeBridge } from '../shared/ipc.ts'

// preload 는 Electron 이 항상 require() 로 읽어서(ESM 불가) .cts 로 따로 컴파일한다.
// shared/ipc.ts 는 ESM 이라 런타임 import 를 못 쓰므로, 채널 이름만 그대로 옮겨 적는다 —
// shared/ipc.ts 의 Channel 과 반드시 같아야 한다.
const Channel = {
  LIST_PROVIDERS: 'providers:list',
  SAVE_PROVIDER: 'providers:save',
  REMOVE_PROVIDER: 'providers:remove',
  FETCH_PROVIDER_MODELS: 'providers:fetch-models',
  SEND_MESSAGE: 'chat:send',
  TAKE_QUEUE: 'chat:take-queue',
  CHAT_SNAPSHOT: 'chat:snapshot',
  TURN_STARTED: 'chat:turn-started',
  TURN_ENDED: 'chat:turn-ended',
  QUEUE_CHANGED: 'chat:queue',
  CONVERSATIONS_CHANGED: 'chat:conversations-changed',
  PICK_ATTACHMENTS: 'chat:pick-attachments',
  LIST_PROJECTS: 'projects:list',
  OPEN_PROJECT: 'projects:open',
  PICK_PROJECT_FOLDER: 'projects:pick-folder',
  SET_PROJECT_FAVORITE: 'projects:set-favorite',
  REMOVE_PROJECT: 'projects:remove',
  RENAME_PROJECT: 'projects:rename',
  LIST_CONVERSATIONS: 'sessions:list',
  SAVE_CONVERSATION: 'sessions:save',
  PATCH_CONVERSATION: 'sessions:patch',
  REMOVE_CONVERSATION: 'sessions:remove',
  LOAD_CONVERSATION: 'sessions:history',
  QUERY_TRIGGER: 'triggers:query',
  PICK_TRIGGER: 'triggers:pick',
  SUBMIT_TRIGGER: 'triggers:submit',
  OPEN_TERMINAL: 'terminal:open',
  WRITE_TERMINAL: 'terminal:write',
  RESIZE_TERMINAL: 'terminal:resize',
  TERMINAL_DATA: 'terminal:data',
  TERMINAL_EXIT: 'terminal:exit',
  OPEN_EXTERNAL: 'shell:open-external',
  LOAD_TRAJECTORY: 'trajectory:load',
  TURN_PROGRESS: 'chat:progress',
  TURN_ATTENTION: 'chat:attention',
  REPLY_ATTENTION: 'chat:reply-attention',
  STOP_TURN: 'chat:stop',
  STOP_SUBTASK: 'chat:stop-subtask',
  RESOLVE_FILES: 'chat:resolve-files',
  REVEAL_FILE: 'chat:reveal-file',
  PREVIEW_FILE: 'chat:preview-file',
  PREVIEW_ASSETS: 'chat:preview-assets',
  LIST_DIRECTORY: 'chat:list-directory',
  RUN_SHELL: 'shell:run',
  STOP_SHELL: 'shell:stop',
  SHELL_DATA: 'shell:data',
  SHARE_SHELL: 'shell:share',
  GET_SETTINGS: 'settings:get',
  SET_SETTINGS: 'settings:set',
  OPEN_SETTINGS_FILE: 'settings:open-file',
  GET_APP_VERSION: 'app:version',
  GET_NOTIFICATIONS: 'notifications:get',
  VIEW_CONVERSATION: 'notifications:view',
  TAKE_PENDING_OPEN: 'notifications:take-open',
  NOTIFICATIONS_CHANGED: 'notifications:changed',
  NOTIFICATION_TOAST: 'notifications:toast',
  NOTIFICATION_OPEN: 'notifications:open',
  OPEN_IN_APPS: 'openIn:apps',
  OPEN_IN: 'openIn:open',
  OPEN_FILE_IN: 'openIn:open-file',
  GET_FEATURES: 'features:get',
  FEATURES_CHANGED: 'features:changed',
  WINDOW_FULLSCREEN: 'window:fullscreen',
  LIST_SKILLS: 'skills:list',
  OPEN_SKILLS_FOLDER: 'skills:open-folder',
  LIST_MCP: 'mcp:list',
  SAVE_MCP: 'mcp:save',
  REMOVE_MCP: 'mcp:remove',
  SET_MCP_ENABLED: 'mcp:set-enabled',
  TEST_MCP: 'mcp:test',
  APP_MCP_VIEW: 'appMcp:view',
  APP_MCP_OPEN_FILE: 'appMcp:open-file',
  APP_MCP_OPEN_TERMINAL: 'appMcp:open-terminal',
  REMOTE_STATUS: 'remote:status',
  REMOTE_SET_ENABLED: 'remote:set-enabled',
  REMOTE_START_PAIRING: 'remote:start-pairing',
  REMOTE_CANCEL_PAIRING: 'remote:cancel-pairing',
  REMOTE_ANSWER_PAIR: 'remote:answer-pair',
  REMOTE_REVOKE: 'remote:revoke',
  REMOTE_CHANGED: 'remote:changed',
} as const

/** 메인 → 화면 알림을 구독하고 해제 함수를 준다 */
function listen<T extends unknown[]>(channel: string, listener: (...args: T) => void): () => void {
  const handler = (_event: unknown, ...args: unknown[]) => listener(...(args as T))
  ipcRenderer.on(channel, handler)
  return () => void ipcRenderer.removeListener(channel, handler)
}

const bridge: LitecodeBridge = {
  listProviders: () => ipcRenderer.invoke(Channel.LIST_PROVIDERS),
  saveProvider: (input) => ipcRenderer.invoke(Channel.SAVE_PROVIDER, input),
  removeProvider: (id) => ipcRenderer.invoke(Channel.REMOVE_PROVIDER, id),
  fetchProviderModels: (draft) => ipcRenderer.invoke(Channel.FETCH_PROVIDER_MODELS, draft),
  sendMessage: (conversationId, input) => ipcRenderer.invoke(Channel.SEND_MESSAGE, conversationId, input),
  takeQueue: (conversationId) => ipcRenderer.invoke(Channel.TAKE_QUEUE, conversationId),
  chatSnapshot: () => ipcRenderer.invoke(Channel.CHAT_SNAPSHOT),
  onTurnStarted: (listener) => listen(Channel.TURN_STARTED, listener),
  onTurnEnded: (listener) => listen(Channel.TURN_ENDED, listener),
  onQueueChanged: (listener) => listen(Channel.QUEUE_CHANGED, listener),
  onConversationsChanged: (listener) => listen(Channel.CONVERSATIONS_CHANGED, listener),
  pickAttachments: (kind, directory, held) => ipcRenderer.invoke(Channel.PICK_ATTACHMENTS, kind, directory, held),
  listProjects: () => ipcRenderer.invoke(Channel.LIST_PROJECTS),
  openProject: (directory) => ipcRenderer.invoke(Channel.OPEN_PROJECT, directory),
  pickProjectFolder: () => ipcRenderer.invoke(Channel.PICK_PROJECT_FOLDER),
  setProjectFavorite: (directory, favorite) => ipcRenderer.invoke(Channel.SET_PROJECT_FAVORITE, directory, favorite),
  removeProject: (directory) => ipcRenderer.invoke(Channel.REMOVE_PROJECT, directory),
  renameProject: (directory, name) => ipcRenderer.invoke(Channel.RENAME_PROJECT, directory, name),
  listConversations: () => ipcRenderer.invoke(Channel.LIST_CONVERSATIONS),
  saveConversation: (conversation) => ipcRenderer.invoke(Channel.SAVE_CONVERSATION, conversation),
  patchConversation: (id, patch) => ipcRenderer.invoke(Channel.PATCH_CONVERSATION, id, patch),
  removeConversation: (id) => ipcRenderer.invoke(Channel.REMOVE_CONVERSATION, id),
  loadConversation: (id) => ipcRenderer.invoke(Channel.LOAD_CONVERSATION, id),
  queryTrigger: (scope, draft, caret) => ipcRenderer.invoke(Channel.QUERY_TRIGGER, scope, draft, caret),
  pickTrigger: (scope, char, id, action) => ipcRenderer.invoke(Channel.PICK_TRIGGER, scope, char, id, action),
  submitTrigger: (scope, draft) => ipcRenderer.invoke(Channel.SUBMIT_TRIGGER, scope, draft),
  openTerminal: (directory) => ipcRenderer.invoke(Channel.OPEN_TERMINAL, directory),
  writeTerminal: (directory, data) => ipcRenderer.invoke(Channel.WRITE_TERMINAL, directory, data),
  resizeTerminal: (directory, rows, cols) => ipcRenderer.invoke(Channel.RESIZE_TERMINAL, directory, rows, cols),
  onTerminalData: (listener) => {
    const handler = (_event: unknown, directory: string, chunk: string, end: number) => listener(directory, chunk, end)
    ipcRenderer.on(Channel.TERMINAL_DATA, handler)
    return () => void ipcRenderer.removeListener(Channel.TERMINAL_DATA, handler)
  },
  onTerminalExit: (listener) => {
    const handler = (_event: unknown, directory: string) => listener(directory)
    ipcRenderer.on(Channel.TERMINAL_EXIT, handler)
    return () => void ipcRenderer.removeListener(Channel.TERMINAL_EXIT, handler)
  },
  openExternal: (url) => ipcRenderer.invoke(Channel.OPEN_EXTERNAL, url),
  loadTrajectory: (directory, sessionId) => ipcRenderer.invoke(Channel.LOAD_TRAJECTORY, directory, sessionId),
  onTurnProgress: (listener) => {
    const handler = (_event: unknown, conversationId: string, item: Parameters<typeof listener>[1]) => listener(conversationId, item)
    ipcRenderer.on(Channel.TURN_PROGRESS, handler)
    return () => void ipcRenderer.removeListener(Channel.TURN_PROGRESS, handler)
  },
  onTurnAttention: (listener) => listen(Channel.TURN_ATTENTION, listener),
  replyAttention: (sessionId, requestId, answer) => ipcRenderer.invoke(Channel.REPLY_ATTENTION, sessionId, requestId, answer),
  stopTurn: (conversationId) => ipcRenderer.invoke(Channel.STOP_TURN, conversationId),
  stopSubtask: (subtaskId) => ipcRenderer.invoke(Channel.STOP_SUBTASK, subtaskId),
  resolveFiles: (directory, tokens) => ipcRenderer.invoke(Channel.RESOLVE_FILES, directory, tokens),
  revealFile: (directory, token) => ipcRenderer.invoke(Channel.REVEAL_FILE, directory, token),
  previewFile: (directory, token) => ipcRenderer.invoke(Channel.PREVIEW_FILE, directory, token),
  previewAssets: (directory, token, references) => ipcRenderer.invoke(Channel.PREVIEW_ASSETS, directory, token, references),
  listDirectory: (directory, relative) => ipcRenderer.invoke(Channel.LIST_DIRECTORY, directory, relative),
  runShell: (conversationId, runId, directory, command, position) =>
    ipcRenderer.invoke(Channel.RUN_SHELL, conversationId, runId, directory, command, position),
  stopShell: (runId) => ipcRenderer.invoke(Channel.STOP_SHELL, runId),
  onShellData: (listener) => {
    const handler = (_event: unknown, runId: string, chunk: string) => listener(runId, chunk)
    ipcRenderer.on(Channel.SHELL_DATA, handler)
    return () => void ipcRenderer.removeListener(Channel.SHELL_DATA, handler)
  },
  shareShell: (conversationId, cardId, providerId, modelId) => ipcRenderer.invoke(Channel.SHARE_SHELL, conversationId, cardId, providerId, modelId),
  getSettings: () => ipcRenderer.invoke(Channel.GET_SETTINGS),
  setSettings: (patch) => ipcRenderer.invoke(Channel.SET_SETTINGS, patch),
  openSettingsFile: () => ipcRenderer.invoke(Channel.OPEN_SETTINGS_FILE),
  getAppVersion: () => ipcRenderer.invoke(Channel.GET_APP_VERSION),
  getNotifications: () => ipcRenderer.invoke(Channel.GET_NOTIFICATIONS),
  viewConversation: (conversationId) => ipcRenderer.invoke(Channel.VIEW_CONVERSATION, conversationId),
  takePendingOpen: () => ipcRenderer.invoke(Channel.TAKE_PENDING_OPEN),
  onNotificationsChanged: (listener) => listen(Channel.NOTIFICATIONS_CHANGED, listener),
  onNotificationToast: (listener) => listen(Channel.NOTIFICATION_TOAST, listener),
  onNotificationOpen: (listener) => listen(Channel.NOTIFICATION_OPEN, listener),
  openInApps: () => ipcRenderer.invoke(Channel.OPEN_IN_APPS),
  openIn: (appId, directory) => ipcRenderer.invoke(Channel.OPEN_IN, appId, directory),
  openFileIn: (appId, directory, token) => ipcRenderer.invoke(Channel.OPEN_FILE_IN, appId, directory, token),
  getFeatures: () => ipcRenderer.invoke(Channel.GET_FEATURES),
  onFeaturesChanged: (listener) => listen(Channel.FEATURES_CHANGED, listener),
  listSkills: (directory) => ipcRenderer.invoke(Channel.LIST_SKILLS, directory),
  openSkillsFolder: (scope, directory) => ipcRenderer.invoke(Channel.OPEN_SKILLS_FOLDER, scope, directory),
  listMcp: (directory) => ipcRenderer.invoke(Channel.LIST_MCP, directory),
  saveMcp: (input, directory) => ipcRenderer.invoke(Channel.SAVE_MCP, input, directory),
  removeMcp: (name, directory) => ipcRenderer.invoke(Channel.REMOVE_MCP, name, directory),
  setMcpEnabled: (name, enabled, directory) => ipcRenderer.invoke(Channel.SET_MCP_ENABLED, name, enabled, directory),
  testMcp: (input, directory) => ipcRenderer.invoke(Channel.TEST_MCP, input, directory),
  viewProject: (directory) => ipcRenderer.invoke(Channel.APP_MCP_VIEW, directory),
  onAppMcpOpenFile: (listener) => listen(Channel.APP_MCP_OPEN_FILE, listener),
  onAppMcpOpenTerminal: (listener) => listen(Channel.APP_MCP_OPEN_TERMINAL, listener),
  remoteStatus: () => ipcRenderer.invoke(Channel.REMOTE_STATUS),
  setRemoteEnabled: (enabled) => ipcRenderer.invoke(Channel.REMOTE_SET_ENABLED, enabled),
  startRemotePairing: () => ipcRenderer.invoke(Channel.REMOTE_START_PAIRING),
  cancelRemotePairing: () => ipcRenderer.invoke(Channel.REMOTE_CANCEL_PAIRING),
  answerRemotePair: (requestId, allow) => ipcRenderer.invoke(Channel.REMOTE_ANSWER_PAIR, requestId, allow),
  revokeRemoteDevice: (deviceId) => ipcRenderer.invoke(Channel.REMOTE_REVOKE, deviceId),
  onRemoteChanged: (listener) => listen(Channel.REMOTE_CHANGED, listener),
}

contextBridge.exposeInMainWorld('litecode', bridge)

// 창 모양 표시 (이슈 #25) — 화면 CSS 가 html[data-platform] 으로 창 버튼 자리를 비우고(macOS), html[data-fullscreen] 이면 그 여백을
// 거둔다(전체 화면엔 창 버튼이 없다). 화면 코드는 이 값을 모른다. preload 가 도는 때엔 아직 <html> 이 없을 수 있다
function markWindow(apply: (root: HTMLElement) => void): void {
  if (document.documentElement) apply(document.documentElement)
  else document.addEventListener('DOMContentLoaded', () => apply(document.documentElement), { once: true })
}
markWindow((root) => (root.dataset.platform = process.platform))
ipcRenderer.on(Channel.WINDOW_FULLSCREEN, (_event, fullScreen: boolean) =>
  markWindow((root) => root.toggleAttribute('data-fullscreen', fullScreen === true)),
)
