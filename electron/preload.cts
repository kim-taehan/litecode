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
  TERMINAL_DATA: 'terminal:data',
  TERMINAL_EXIT: 'terminal:exit',
  OPEN_EXTERNAL: 'shell:open-external',
  LOAD_TRAJECTORY: 'trajectory:load',
  TURN_PROGRESS: 'chat:progress',
  RESOLVE_FILES: 'chat:resolve-files',
  REVEAL_FILE: 'chat:reveal-file',
  RUN_SHELL: 'shell:run',
  STOP_SHELL: 'shell:stop',
  SHELL_DATA: 'shell:data',
  SHARE_SHELL: 'shell:share',
} as const

const bridge: LitecodeBridge = {
  listProviders: () => ipcRenderer.invoke(Channel.LIST_PROVIDERS),
  saveProvider: (input) => ipcRenderer.invoke(Channel.SAVE_PROVIDER, input),
  removeProvider: (id) => ipcRenderer.invoke(Channel.REMOVE_PROVIDER, id),
  fetchProviderModels: (draft) => ipcRenderer.invoke(Channel.FETCH_PROVIDER_MODELS, draft),
  sendMessage: (conversationId, providerId, modelId, directory, prompt, sessionId, display) =>
    ipcRenderer.invoke(Channel.SEND_MESSAGE, conversationId, providerId, modelId, directory, prompt, sessionId, display),
  listProjects: () => ipcRenderer.invoke(Channel.LIST_PROJECTS),
  openProject: (directory) => ipcRenderer.invoke(Channel.OPEN_PROJECT, directory),
  pickProjectFolder: () => ipcRenderer.invoke(Channel.PICK_PROJECT_FOLDER),
  setProjectFavorite: (directory, favorite) => ipcRenderer.invoke(Channel.SET_PROJECT_FAVORITE, directory, favorite),
  removeProject: (directory) => ipcRenderer.invoke(Channel.REMOVE_PROJECT, directory),
  renameProject: (directory, name) => ipcRenderer.invoke(Channel.RENAME_PROJECT, directory, name),
  listConversations: () => ipcRenderer.invoke(Channel.LIST_CONVERSATIONS),
  saveConversation: (conversation) => ipcRenderer.invoke(Channel.SAVE_CONVERSATION, conversation),
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
  resolveFiles: (directory, tokens) => ipcRenderer.invoke(Channel.RESOLVE_FILES, directory, tokens),
  revealFile: (directory, token) => ipcRenderer.invoke(Channel.REVEAL_FILE, directory, token),
  runShell: (conversationId, runId, directory, command, position) =>
    ipcRenderer.invoke(Channel.RUN_SHELL, conversationId, runId, directory, command, position),
  stopShell: (runId) => ipcRenderer.invoke(Channel.STOP_SHELL, runId),
  onShellData: (listener) => {
    const handler = (_event: unknown, runId: string, chunk: string) => listener(runId, chunk)
    ipcRenderer.on(Channel.SHELL_DATA, handler)
    return () => void ipcRenderer.removeListener(Channel.SHELL_DATA, handler)
  },
  shareShell: (conversationId, cardId, providerId, modelId) => ipcRenderer.invoke(Channel.SHARE_SHELL, conversationId, cardId, providerId, modelId),
}

contextBridge.exposeInMainWorld('litecode', bridge)
