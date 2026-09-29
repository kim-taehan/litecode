import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { ProviderRegistry } from '../src/services/providers.ts'
import { LlmService } from '../src/services/llm.ts'
import { Channel } from '../shared/ipc.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Cordis 컨텍스트는 메인 프로세스에 하나만 둔다 — 렌더러는 IPC 로만 닿는다.
const ctx = new Context()
ctx.plugin(ProviderRegistry)
ctx.plugin(LlmService, { opencodeUrl: process.env.OPENCODE_URL ?? 'http://127.0.0.1:4096' })

// 서비스는 비동기로 마운트된다 — ctx.providers 를 바로 쓰지 않고, inject 로
// 선언한 플러그인 안에서만 접근한다 (Cordis 원칙: 순서는 inject 로 표현한다).
function bootstrap(ctx: Context): void {
  // 개발 중 확인용 기본 provider. 실제 설정 화면이 생기면 이 자리를 대체한다.
  ctx.providers.register({
    id: 'internal-gateway',
    displayName: 'Internal LiteLLM Gateway',
    baseURL: process.env.LITECODE_GATEWAY_URL ?? 'http://127.0.0.1:8080/v1',
    protocol: 'openai-chat-completions',
    models: [{ id: 'qwen3.8-27b', displayName: 'Qwen3.8 27B' }],
  })

  ipcMain.handle(Channel.LIST_PROVIDERS, async () => ctx.providers.all())
  ipcMain.handle(Channel.SEND_MESSAGE, async (_event, providerId: string, modelId: string, prompt: string) =>
    ctx.llm.chat(providerId, modelId, prompt),
  )
}
bootstrap.inject = ['providers', 'llm']
ctx.plugin(bootstrap)

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      // 컴파일된 산출물(dist-electron/electron/preload.cjs) 기준 — 이 파일 자신도 거기서 돈다.
      // .cjs 인 이유: Electron 은 preload 를 항상 require() 로 읽는다(ESM import 불가).
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[preload-error]', preloadPath, error)
  })
  win.webContents.on('console-message', (_event, _level, message) => {
    console.log('[renderer console]', message)
  })

  const devServerUrl = process.env.LITECODE_DEV_SERVER_URL
  if (devServerUrl) {
    void win.loadURL(devServerUrl)
  } else {
    void win.loadFile(path.join(__dirname, '../dist/renderer/index.html'))
  }
}

void app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
