import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { ProviderRegistry, type ProviderInput } from '../src/services/providers.ts'
import { LlmService } from '../src/services/llm.ts'
import { EngineService } from '../src/services/engine.ts'
import { ProjectsService } from '../src/services/projects.ts'
import { Channel } from '../shared/ipc.ts'
import { canSealKeys } from './keyStorage.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Cordis 컨텍스트는 메인 프로세스에 하나만 둔다 — 렌더러는 IPC 로만 닿는다.
const ctx = new Context()
// userData 는 --user-data-dir 스위치를 따른다 (실물 테스트가 이걸로 격리한다).
const userData = app.getPath('userData')
ctx.plugin(ProviderRegistry, {
  file: path.join(userData, 'providers.json'),
  keysFile: path.join(userData, 'provider-keys.json'),
  // safeStorage 는 app ready 뒤에만 쓸 수 있다 — 키 저장은 설정 화면에서만 일어나므로 그때는 늘 ready 다.
  // macOS 는 Keychain, 쓸 수 없는 환경(키링 없는 Linux 의 basic_text 포함 — keyStorage.ts)이면 서비스가 키 저장을 거부한다.
  cipher: {
    available: () =>
      canSealKeys(
        process.platform,
        safeStorage.isEncryptionAvailable(),
        process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : undefined,
      ),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (sealed) => safeStorage.decryptString(sealed),
  },
  // 첫 실행 기본값 — 이후로는 providers.json 이 정본이다.
  defaults: [
    {
      // id 는 opencode providerID 로 그대로 쓰인다 (ctx.engine 이 생성하는 opencode.json·ctx.llm 이 넘기는 모델).
      id: 'gateway-local',
      displayName: 'Internal LiteLLM Gateway',
      baseURL: process.env.LITECODE_GATEWAY_URL ?? 'http://127.0.0.1:8080/v1',
      protocol: 'openai-chat-completions',
      models: [{ id: 'qwen3.8-27b', displayName: 'Qwen3.8 27B' }],
    },
  ],
})
// opencode 는 앱이 직접 띄운다 (서버 하나). 사용자가 따로 띄운 opencode 에 붙는 길은 두지 않는다 — 폐쇄망에서는 사용자가
// `opencode serve` 를 칠 수 없고, 제품이 안 쓰는 분기는 낡는다 (closed-code 결정과 같다). 실물 테스트도 앱이 띄운 것을 쓴다.
ctx.plugin(EngineService, {
  configDir: path.join(userData, 'opencode'),
  db: path.join(userData, 'opencode.db'),
  pidFile: path.join(userData, 'opencode-server.json'),
})
ctx.plugin(LlmService)
ctx.plugin(ProjectsService, { file: path.join(userData, 'projects.json') })

// 서비스는 비동기로 마운트된다 — ctx.providers 를 바로 쓰지 않고, inject 로
// 선언한 플러그인 안에서만 접근한다 (Cordis 원칙: 순서는 inject 로 표현한다).
function bootstrap(ctx: Context): void {
  ipcMain.handle(Channel.LIST_PROVIDERS, async () => ctx.providers.list())
  ipcMain.handle(Channel.SAVE_PROVIDER, async (_event, input: ProviderInput) => ctx.providers.save(input))
  ipcMain.handle(Channel.REMOVE_PROVIDER, async (_event, id: string) => ctx.providers.remove(id))
  ipcMain.handle(Channel.FETCH_PROVIDER_MODELS, async (_event, draft: { id?: string; baseURL: string; apiKey?: string }) =>
    ctx.providers.fetchAvailableModels(draft),
  )
  ipcMain.handle(
    Channel.SEND_MESSAGE,
    async (_event, providerId: string, modelId: string, directory: string, prompt: string, sessionId?: string) =>
      ctx.llm.chat(providerId, modelId, directory, prompt, sessionId),
  )
  ipcMain.handle(Channel.LIST_PROJECTS, async () => ctx.projects.list())
  ipcMain.handle(Channel.OPEN_PROJECT, async (_event, directory: string) => ctx.projects.open(directory))
  ipcMain.handle(Channel.SET_PROJECT_FAVORITE, async (_event, directory: string, favorite: boolean) =>
    ctx.projects.setFavorite(directory, favorite),
  )
  ipcMain.handle(Channel.REMOVE_PROJECT, async (_event, directory: string) => ctx.projects.remove(directory))
  ipcMain.handle(Channel.RENAME_PROJECT, async (_event, directory: string, name: string) => ctx.projects.rename(directory, name))
  // 켜자마자 띄운다 — 첫 메시지가 opencode 기동을 기다리지 않게. 실패하면 첫 전송이 사유를 받는다 (그때 다시 띄워 본다)
  void ctx.engine.connection().catch(() => {})
  // 앱 종료를 한 번 붙잡아 opencode 를 끈다 — GUI 앱에는 자식을 데려가 줄 터미널이 없어 흘려보내면 남는다
  // (closed-code app/quitGuard.ts). quit 은 이 핸들러로 되돌아오므로 exit 로 끝내고, 빗장으로 재진입을 막는다
  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    void ctx.engine.stop().finally(() => app.exit(0))
  })
  ipcMain.handle(Channel.PICK_PROJECT_FOLDER, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = { properties: ['openDirectory' as const] }
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || !picked.filePaths[0]) return undefined
    return ctx.projects.open(picked.filePaths[0])
  })
}
bootstrap.inject = ['providers', 'llm', 'projects', 'engine']
ctx.plugin(bootstrap)

// 실물 테스트는 창을 화면에 띄우지 않는다 — 사용자 화면·포커스를 가로채지 않게. 그려지기는 하고(paintWhenInitiallyHidden),
// 숨겨진 창의 타이머·애니메이션이 느려지지 않게(backgroundThrottling) 해서 playwright 조작은 그대로 된다. 제품은 이 변수를 안 쓴다
const hiddenForTests = process.env.LITECODE_TEST_HIDDEN === '1'
if (hiddenForTests) app.dock?.hide()

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: !hiddenForTests,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      backgroundThrottling: !hiddenForTests,
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
