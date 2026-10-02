import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { ProviderRegistry, type ProviderInput } from '../src/services/providers.ts'
import { LlmService } from '../src/services/llm.ts'
import { EngineService } from '../src/services/engine.ts'
import { bundledPaths } from '../src/services/opencodeBinary.ts'
import { ProjectsService } from '../src/services/projects.ts'
import { SessionsService, type Conversation } from '../src/services/sessions.ts'
import { TriggerRegistry, type TriggerScope } from '../src/services/triggers.ts'
import { TerminalsService } from '../src/services/terminals.ts'
import { AtTrigger } from '../src/triggers/at.ts'
import { SlashTrigger } from '../src/triggers/slash.ts'
import { BangTrigger } from '../src/triggers/bang.ts'
import { TrajectoryService } from '../src/services/trajectory.ts'
import { SettingsService, type Settings } from '../src/services/settings.ts'
import { tr } from '../src/i18n.ts'
import { Channel } from '../shared/ipc.ts'
import { isWebUrl } from '../shared/webUrl.ts'
import { canSealKeys } from './keyStorage.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Cordis 컨텍스트는 메인 프로세스에 하나만 둔다 — 렌더러는 IPC 로만 닿는다.
const ctx = new Context()
// 올린 순서대로 쥔다 — 앱을 끌 때 거꾸로 내려 각 서비스가 걸어 둔 정리(effect)를 다 돌린다 (opencode·키 프록시 끄기 등)
const mounted: { dispose(): Promise<void> }[] = []
// userData 는 --user-data-dir 스위치를 따른다 (실물 테스트가 이걸로 격리한다).
const userData = app.getPath('userData')
// 설정 > 일반 — 맨 먼저 올린다: 언어(메인 오류 문구)·테마(첫 창 배경)가 다른 서비스·창보다 먼저 정해지게.
// 실물 테스트는 LITECODE_TEST_LANGUAGE=ko 로 첫 실행 언어를 한국어로 고정한다(셀렉터가 한국어). 제품은 이 변수를 안 쓴다
const settingsFiber = ctx.plugin(SettingsService, {
  file: path.join(userData, 'settings.json'),
  defaults: process.env.LITECODE_TEST_LANGUAGE === 'ko' ? { language: 'ko' } : undefined,
})
mounted.push(settingsFiber)
mounted.push(ctx.plugin(ProviderRegistry, {
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
}))
// opencode 는 앱이 직접 띄운다 (서버 하나). 사용자가 따로 띄운 opencode 에 붙는 길은 두지 않는다 — 폐쇄망에서는 사용자가
// `opencode serve` 를 칠 수 없고, 제품이 안 쓰는 분기는 낡는다 (closed-code 결정과 같다). 실물 테스트도 앱이 띄운 것을 쓴다.
mounted.push(ctx.plugin(EngineService, {
  configDir: path.join(userData, 'opencode'),
  db: path.join(userData, 'opencode.db'),
  pidFile: path.join(userData, 'opencode-server.json'),
  // 설치본에는 opencode·rg 가 실려 있다 (electron-builder.yml extraResources). 개발 실행의 resourcesPath 는 electron 배포물 자리라 넘기지 않는다
  bundled: app.isPackaged ? bundledPaths(process.resourcesPath) : undefined,
}))
mounted.push(ctx.plugin(LlmService))
mounted.push(ctx.plugin(ProjectsService, { file: path.join(userData, 'projects.json') }))
// 보관 개수는 실물 테스트만 낮춘다 (51번째 대화를 50개 만들지 않고 확인하려고). 제품은 이 변수를 안 쓴다
mounted.push(ctx.plugin(SessionsService, {
  file: path.join(userData, 'sessions.json'),
  limit: Number(process.env.LITECODE_TEST_SESSION_LIMIT) || undefined,
}))
// 입력창 트리거 — 등록소 하나에 플러그인 셋이 effect 로 등록한다. 하나를 내리면 그 문자는 평범한 글자가 된다
mounted.push(ctx.plugin(TriggerRegistry))
mounted.push(ctx.plugin(TerminalsService))
mounted.push(ctx.plugin(AtTrigger))
mounted.push(ctx.plugin(SlashTrigger))
mounted.push(ctx.plugin(BangTrigger))
mounted.push(ctx.plugin(TrajectoryService))

/** IPC 핸들러를 되돌릴 수 있게 건다 — 의존 서비스가 다시 올라와 bootstrap 이 다시 돌면, Cordis 가 먼저 이것을 풀어
 *  "이미 등록된 핸들러" 오류 없이 다시 건다 (Cordis 원칙: 모든 등록은 effect 로) */
function handle(ctx: Context, channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
  ctx.effect(() => {
    ipcMain.handle(channel, listener)
    return () => ipcMain.removeHandler(channel)
  })
}

// 서비스는 비동기로 마운트된다 — ctx.providers 를 바로 쓰지 않고, inject 로
// 선언한 플러그인 안에서만 접근한다 (Cordis 원칙: 순서는 inject 로 표현한다).
function bootstrap(ctx: Context): void {
  handle(ctx, Channel.LIST_PROVIDERS, async () => ctx.providers.list())
  handle(ctx, Channel.SAVE_PROVIDER, async (_event, input: ProviderInput) => ctx.providers.save(input))
  handle(ctx, Channel.REMOVE_PROVIDER, async (_event, id: string) => ctx.providers.remove(id))
  handle(ctx, Channel.FETCH_PROVIDER_MODELS, async (_event, draft: { id?: string; baseURL: string; apiKey?: string }) =>
    ctx.providers.fetchAvailableModels(draft),
  )
  handle(
    ctx,
    Channel.SEND_MESSAGE,
    async (_event, conversationId: string, providerId: string, modelId: string, directory: string, prompt: string, sessionId?: string, display?: string) => {
      // 보낸 본문과 보일 글이 다르면(`/` 명령) 엔진 메시지 id 를 정해 보일 글을 적어 둔다 — 다시 열어도 친 글이 보이게
      const messageId = display ? ctx.llm.newMessageId() : undefined
      if (messageId) await ctx.sessions.label(conversationId, messageId, display!)
      return ctx.llm.chat(providerId, modelId, directory, prompt, sessionId, (created) => ctx.sessions.attach(conversationId, created), messageId)
    },
  )
  handle(ctx, Channel.LIST_CONVERSATIONS, async () => ctx.sessions.list())
  handle(ctx, Channel.SAVE_CONVERSATION, async (_event, conversation: Conversation) => ctx.sessions.save(conversation))
  handle(ctx, Channel.REMOVE_CONVERSATION, async (_event, id: string) => ctx.sessions.remove(id))
  handle(ctx, Channel.LOAD_CONVERSATION, async (_event, id: string) => ctx.sessions.history(id))
  handle(ctx, Channel.QUERY_TRIGGER, async (_event, scope: TriggerScope, draft: string, caret: number) => ctx.triggers.query(scope, draft, caret))
  handle(ctx, Channel.PICK_TRIGGER, async (_event, scope: TriggerScope, char: string, id: string, action: 'pick' | 'drill') =>
    ctx.triggers.pick(scope, char, id, action),
  )
  handle(ctx, Channel.SUBMIT_TRIGGER, async (_event, scope: TriggerScope, draft: string) => ctx.triggers.submit(scope, draft))
  handle(ctx, Channel.OPEN_TERMINAL, async (_event, directory: string) => ctx.terminals.attach(directory))
  handle(ctx, Channel.WRITE_TERMINAL, async (_event, directory: string, data: string) => ctx.terminals.write(directory, data))
  handle(ctx, Channel.RESIZE_TERMINAL, async (_event, directory: string, rows: number, cols: number) => ctx.terminals.resize(directory, rows, cols))
  // 터미널 출력은 메인이 먼저 안다 — 모든 창에 흘려보낸다 (화면이 폴더로 거른다). ctx.on 은 bootstrap 이 내려가면 같이 풀린다
  ctx.on('terminal/data', (directory, chunk, end) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(Channel.TERMINAL_DATA, directory, chunk, end)
  })
  ctx.on('terminal/exit', (directory) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(Channel.TERMINAL_EXIT, directory)
  })
  handle(ctx, Channel.LIST_PROJECTS, async () => ctx.projects.list())
  handle(ctx, Channel.OPEN_PROJECT, async (_event, directory: string) => ctx.projects.open(directory))
  handle(ctx, Channel.SET_PROJECT_FAVORITE, async (_event, directory: string, favorite: boolean) =>
    ctx.projects.setFavorite(directory, favorite),
  )
  handle(ctx, Channel.REMOVE_PROJECT, async (_event, directory: string) => ctx.projects.remove(directory))
  handle(ctx, Channel.RENAME_PROJECT, async (_event, directory: string, name: string) => ctx.projects.rename(directory, name))
  // 켜자마자 띄운다 — 첫 메시지가 opencode 기동을 기다리지 않게. 실패하면 첫 전송이 사유를 받는다 (그때 다시 띄워 본다)
  void ctx.engine.connection().catch(() => {})
  handle(ctx, Channel.PICK_PROJECT_FOLDER, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = { properties: ['openDirectory' as const] }
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || !picked.filePaths[0]) return undefined
    return ctx.projects.open(picked.filePaths[0])
  })
  // 답의 링크 — 렌더러가 걸러도 여기서 다시 거른다 (답은 모델이 쓴 글이라 file:·javascript: 등이 올 수 있다)
  handle(ctx, Channel.OPEN_EXTERNAL, async (_event, url: string) => {
    if (typeof url !== 'string' || !isWebUrl(url)) return false
    await shell.openExternal(url)
    return true
  })
  handle(ctx, Channel.LOAD_TRAJECTORY, async (_event, directory: string, sessionId: string) => ctx.trajectory.read(directory, sessionId))
  handle(ctx, Channel.GET_SETTINGS, async () => ctx.settings.get())
  handle(ctx, Channel.SET_SETTINGS, async (_event, patch: Partial<Settings>) => ctx.settings.set(patch))
  // dsh 처럼 설정 정본 파일을 연다 (없으면 만든다). openPath 는 OS 연결 프로그램 — 실패하면 사유 문자열을 준다
  handle(ctx, Channel.OPEN_SETTINGS_FILE, async () => {
    const file = ctx.settings.ensureFile()
    if (!file || (await shell.openPath(file))) throw new Error(tr('settings.openFileError'))
  })
  // 테마는 nativeTheme 에만 넣는다 — 렌더러의 prefers-color-scheme 이 즉시 따라와 CSS 미디어 쿼리 하나로 셋이 다 된다 (01f 실측)
  ctx.on('settings/changed', (settings) => {
    nativeTheme.themeSource = settings.appearance
  })
}
bootstrap.inject = ['providers', 'llm', 'projects', 'engine', 'sessions', 'triggers', 'terminals', 'trajectory', 'settings']
mounted.push(ctx.plugin(bootstrap))

// 앱 종료를 한 번 붙잡아 서비스를 거꾸로 내린다 — 내리는 동안 각 서비스의 effect 가 돈다(ctx.engine: opencode·키 프록시 끄기).
// GUI 앱에는 자식을 데려가 줄 터미널이 없어 흘려보내면 opencode 가 남는다 (closed-code app/quitGuard.ts). Cordis 의 dispose 는
// 비동기 정리가 끝날 때까지 기다린다(실측). quit 은 이 핸들러로 되돌아오므로 exit 로 끝내고, 빗장으로 재진입을 막는다
let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  void (async () => {
    for (const fiber of mounted.reverse()) await fiber.dispose().catch((error: unknown) => console.error('[quit] 서비스 정리 실패', error))
  })().finally(() => app.exit(0))
})

// 실물 테스트는 창을 화면에 띄우지 않는다 — 사용자 화면·포커스를 가로채지 않게. 그려지기는 하고(paintWhenInitiallyHidden),
// 숨겨진 창의 타이머·애니메이션이 느려지지 않게(backgroundThrottling) 해서 playwright 조작은 그대로 된다. 제품은 이 변수를 안 쓴다
const hiddenForTests = process.env.LITECODE_TEST_HIDDEN === '1'
if (hiddenForTests) app.dock?.hide()

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    // 첫 그림 전 깜빡임 막기 — 테마 바탕(--bg)과 같은 색. themeSource 는 창보다 먼저 넣었다
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#151517' : '#ffffff',
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

  // 앱 창은 앱 화면에서 벗어나지 않는다 — 링크가 새 창(Shift·가운데 클릭)이나 다른 주소로 이동하는 길을 막는다.
  // 답의 링크는 OPEN_EXTERNAL 로 OS 브라우저에서 연다. 같은 출처 이동(개발 서버 새로고침)은 그대로 둔다
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== new URL(win.webContents.getURL()).origin) event.preventDefault()
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
    // __dirname 은 dist-electron/electron — vite 는 <root>/dist/renderer 에 쓴다 (설치본에선 app.asar 안의 같은 자리)
    void win.loadFile(path.join(__dirname, '../../dist/renderer/index.html'))
  }
}

void app.whenReady().then(async () => {
  await settingsFiber // 설정 서비스가 올라온 뒤 — 테마를 창보다 먼저 정한다
  nativeTheme.themeSource = ctx.settings.get().appearance
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
