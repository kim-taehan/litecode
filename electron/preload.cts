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
} as const

const bridge: LitecodeBridge = {
  listProviders: () => ipcRenderer.invoke(Channel.LIST_PROVIDERS),
  saveProvider: (input) => ipcRenderer.invoke(Channel.SAVE_PROVIDER, input),
  removeProvider: (id) => ipcRenderer.invoke(Channel.REMOVE_PROVIDER, id),
  fetchProviderModels: (draft) => ipcRenderer.invoke(Channel.FETCH_PROVIDER_MODELS, draft),
  sendMessage: (conversationId, providerId, modelId, directory, prompt, sessionId) =>
    ipcRenderer.invoke(Channel.SEND_MESSAGE, conversationId, providerId, modelId, directory, prompt, sessionId),
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
}

contextBridge.exposeInMainWorld('litecode', bridge)
