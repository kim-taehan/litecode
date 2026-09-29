import { contextBridge, ipcRenderer } from 'electron'
import type { LitecodeBridge } from '../shared/ipc.ts'

// preload 는 Electron 이 항상 require() 로 읽어서(ESM 불가) .cts 로 따로 컴파일한다.
// shared/ipc.ts 는 ESM 이라 런타임 import 를 못 쓰므로, 채널 이름만 그대로 옮겨 적는다 —
// shared/ipc.ts 의 Channel 과 반드시 같아야 한다.
const Channel = {
  LIST_PROVIDERS: 'providers:list',
  SEND_MESSAGE: 'chat:send',
} as const

const bridge: LitecodeBridge = {
  listProviders: () => ipcRenderer.invoke(Channel.LIST_PROVIDERS),
  sendMessage: (providerId, modelId, prompt) =>
    ipcRenderer.invoke(Channel.SEND_MESSAGE, providerId, modelId, prompt),
}

contextBridge.exposeInMainWorld('litecode', bridge)
