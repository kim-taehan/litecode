import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { ProviderRegistry, type ProviderInput } from '../src/services/providers.ts'
import { LlmService, type Attention, type AttentionAnswer } from '../src/services/llm.ts'
import type { TurnItem } from '../src/services/turnProgress.ts'
import { EngineService } from '../src/services/engine.ts'
import { bundledPaths } from '../src/services/opencodeBinary.ts'
import { ProjectsService } from '../src/services/projects.ts'
import { SessionsService, type Conversation } from '../src/services/sessions.ts'
import { TriggerRegistry, type TriggerScope } from '../src/services/triggers.ts'
import { TerminalsService } from '../src/services/terminals.ts'
import { ShellService } from '../src/services/shell.ts'
import { AtTrigger } from '../src/triggers/at.ts'
import { SlashTrigger } from '../src/triggers/slash.ts'
import { BangTrigger } from '../src/triggers/bang.ts'
import { TrajectoryService } from '../src/services/trajectory.ts'
import { existingFiles, projectFile } from '../src/services/fileMentions.ts'
import { previewFile, type FilePreview } from '../src/services/filePreview.ts'
import { SettingsService, type Settings } from '../src/services/settings.ts'
import { NotificationsService } from '../src/services/notifications.ts'
import { recordingHost, systemHost, type NotifyTestRecord, type WindowAccess } from './notificationHost.ts'
import { tr } from '../src/i18n.ts'
import { Channel } from '../shared/ipc.ts'
import { isWebUrl } from '../shared/webUrl.ts'
import { isMode, type Mode } from '../shared/modes.ts'
import { canSealKeys } from './keyStorage.ts'
import { OpenInService } from '../src/services/openIn.ts'
import { FeaturesService, type FeatureDefinition } from '../src/services/features.ts'
import { recordingOpenInHost, systemOpenInHost, type OpenInTestRecord } from './openInHost.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 앱은 하나만 (userData 마다 — 실물 테스트는 --user-data-dir 로 갈려 서로 막지 않는다). 두 번째 실행은 첫 실행의 창을 앞으로 부르고(second-instance)
// 바로 끝난다. 서비스를 올리기 **전에** 끝내야 한다 — ctx.engine 은 올라오자마자 PID 기록으로 "이전 실행의" opencode 를 거두는데,
// 두 번째 실행에겐 그것이 첫 실행의 살아 있는 opencode 다. 그래서 끝날 때까지 이 모듈의 나머지를 돌리지 않는다
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
  await new Promise<never>(() => {})
}
// Windows 토스트는 이 id 가 없으면 안 뜨거나 앱 이름이 틀린다 (electron-builder.yml appId 와 같게 — Windows 실행은 미검증)
if (process.platform === 'win32') app.setAppUserModelId('com.litecode.desktop')

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
  // 프로젝트 opencode 설정(opencode.json·.opencode/ 의 MCP·플러그인·에이전트 덮어쓰기·npm 설치)을 막는다 — 사용자 결정 (00_next_legacy 2).
  // 그 대가로 꺼지는 프로젝트 AGENTS.md/CLAUDE.md 는 ctx.llm 이 매 턴 system 으로 넣는다 (instructions.ts, 이슈 #13 L1)
  blockProjectConfig: true,
}))
mounted.push(ctx.plugin(LlmService))
mounted.push(ctx.plugin(ProjectsService, { file: path.join(userData, 'projects.json') }))
// 보관 개수는 실물 테스트만 낮춘다 (51번째 대화를 50개 만들지 않고 확인하려고). 제품은 이 변수를 안 쓴다
mounted.push(ctx.plugin(SessionsService, {
  file: path.join(userData, 'sessions.json'),
  limit: Number(process.env.LITECODE_TEST_SESSION_LIMIT) || undefined,
}))
// 입력창 트리거 — 등록소 하나에 플러그인 셋이 effect 로 등록한다. 하나를 내리면 그 문자는 평범한 글자가 된다.
// 등록소는 바탕이다(등록된 트리거가 없으면 모든 입력이 평범한 글). `@`·`/`·`!` 는 기능 묶음으로 ctx.features 가 올린다 (아래)
mounted.push(ctx.plugin(TriggerRegistry))

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
  /** 대화 id → 도는 턴의 중지 (STOP_TURN) */
  const stopping = new Map<string, AbortController>()
  handle(
    ctx,
    Channel.SEND_MESSAGE,
    async (_event, conversationId: string, providerId: string, modelId: string, directory: string, prompt: string, sessionId?: string, display?: string, mode?: Mode) => {
      // 보낸 본문과 보일 글이 다르면(`/` 명령) 엔진 메시지 id 를 정해 보일 글을 적어 둔다 — 다시 열어도 친 글이 보이게
      const messageId = display ? ctx.llm.newMessageId() : undefined
      if (messageId) await ctx.sessions.label(conversationId, messageId, display!)
      // 진행 줄은 모든 창에 흘린다 (화면이 대화 id 로 거른다) — 터미널 출력과 같은 방식
      const progress = (item: TurnItem) => {
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send(Channel.TURN_PROGRESS, conversationId, item)
      }
      // 승인·질문 카드도 같은 방식 — 대화 id 를 붙여 흘린다
      const attention = (requests: Attention[]) => {
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send(Channel.TURN_ATTENTION, conversationId, requests)
      }
      const stop = new AbortController() // 답변 중지 (STOP_TURN) — 첫 턴은 아직 엔진 세션이 없어 대화 id 로 쥔다
      stopping.set(conversationId, stop)
      return ctx.llm.chat(
        providerId,
        modelId,
        directory,
        prompt,
        sessionId,
        (created) => ctx.sessions.attach(conversationId, created),
        messageId,
        progress,
        isMode(mode) ? mode : undefined,
        attention,
        stop.signal,
      ).finally(() => stopping.get(conversationId) === stop && stopping.delete(conversationId))
    },
  )
  handle(ctx, Channel.STOP_TURN, async (_event, conversationId: string) => {
    const stop = stopping.get(conversationId)
    stop?.abort()
    return !!stop
  })
  handle(ctx, Channel.REPLY_ATTENTION, async (_event, sessionId: string, requestId: string, answer: AttentionAnswer) => ctx.llm.reply(sessionId, requestId, answer))
  handle(ctx, Channel.LIST_CONVERSATIONS, async () => ctx.sessions.list())
  handle(ctx, Channel.SAVE_CONVERSATION, async (_event, conversation: Conversation) => ctx.sessions.save(conversation))
  handle(ctx, Channel.REMOVE_CONVERSATION, async (_event, id: string) => ctx.sessions.remove(id))
  handle(ctx, Channel.LOAD_CONVERSATION, async (_event, id: string) => ctx.sessions.history(id))
  handle(ctx, Channel.QUERY_TRIGGER, async (_event, scope: TriggerScope, draft: string, caret: number) => ctx.triggers.query(scope, draft, caret))
  handle(ctx, Channel.PICK_TRIGGER, async (_event, scope: TriggerScope, char: string, id: string, action: 'pick' | 'drill') =>
    ctx.triggers.pick(scope, char, id, action),
  )
  handle(ctx, Channel.SUBMIT_TRIGGER, async (_event, scope: TriggerScope, draft: string) => ctx.triggers.submit(scope, draft))
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
  // 파일 언급 칩 — 프로젝트 안의 파일만. 누르면 OS 파일 관리자에서 그 파일을 가리킨다(열거나 실행하지 않는다 — 답은 모델이 쓴 글이다)
  handle(ctx, Channel.RESOLVE_FILES, async (_event, directory: string, tokens: string[]) => (Array.isArray(tokens) ? existingFiles(directory, tokens) : []))
  handle(ctx, Channel.REVEAL_FILE, async (_event, directory: string, token: string) => {
    const file = await projectFile(directory, token)
    if (file) shell.showItemInFolder(file)
    return !!file
  })
  // 파일 미리보기 패널 — 읽기만. 칩 판정에 더해 폴더가 등록된 프로젝트인지 본다(화면이 오염돼도 아무 폴더나 읽게 두지 않는다)
  handle(ctx, Channel.PREVIEW_FILE, async (_event, directory: string, token: string): Promise<FilePreview> => {
    const registered = (await ctx.projects.list()).some((project) => project.path === directory)
    return registered ? previewFile(directory, token) : { status: 'unavailable' }
  })
  handle(ctx, Channel.GET_SETTINGS, async () => ctx.settings.get())
  handle(ctx, Channel.SET_SETTINGS, async (_event, patch: Partial<Settings>) => ctx.settings.set(patch))
  // dsh 처럼 설정 정본 파일을 연다 (없으면 만든다). openPath 는 OS 연결 프로그램 — 실패하면 사유 문자열을 준다
  handle(ctx, Channel.OPEN_SETTINGS_FILE, async () => {
    const file = ctx.settings.ensureFile()
    if (!file || (await shell.openPath(file))) throw new Error(tr('settings.openFileError'))
  })
  handle(ctx, Channel.GET_APP_VERSION, async () => app.getVersion())
  // 테마는 nativeTheme 에만 넣는다 — 렌더러의 prefers-color-scheme 이 즉시 따라와 CSS 미디어 쿼리 하나로 셋이 다 된다 (01f 실측)
  ctx.on('settings/changed', (settings) => {
    nativeTheme.themeSource = settings.appearance
  })
  // 켜진 기능 — 화면은 이것을 보고 꺼진 기능의 버튼·탭·단축키를 그리지 않는다. 바뀌면 (묶음을 다 올리고 내린 뒤) 모든 창에
  handle(ctx, Channel.GET_FEATURES, async () => ctx.features.enabled())
  ctx.on('features/changed', (enabled) => broadcast(Channel.FEATURES_CHANGED, enabled))
}
// 바탕 연결 — 대화·엔진·설정·provider·프로젝트·대화 저장·트리거 등록소. 끌 수 없다. 기능마다의 연결은 아래 기능 묶음에 있어
// 기능 하나를 빼도(끄거나 서비스가 못 떠도) 이 연결은 그대로 뜬다
bootstrap.inject = ['providers', 'llm', 'projects', 'engine', 'sessions', 'triggers', 'settings', 'features']
mounted.push(ctx.plugin(bootstrap))

/** 모든 앱 창에 보낸다 */
function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, ...args)
}

// ── 기능 묶음 (이슈 #8) — 기능 서비스와 그 IPC 연결을 한 플러그인으로 올리고 내린다. 켜고 끄기는 ctx.features 가 settings 를 보고 한다

// `!명령` 카드 — 메인이 프로젝트 폴더에서 돌리고(ctx.shell), 끝나면 그 대화에 저장한다(ctx.sessions). 출력 조각은 모든 창에
function shellBridge(ctx: Context): void {
  handle(ctx, Channel.RUN_SHELL, async (_event, conversationId: string, runId: string, directory: string, command: string, position: number) => {
    const at = Date.now()
    const result = await ctx.shell.run(runId, directory, command)
    const card = { ...result, id: runId, at, position }
    await ctx.sessions.addShell(conversationId, card)
    return card
  })
  handle(ctx, Channel.STOP_SHELL, async (_event, runId: string) => ctx.shell.stop(runId))
  ctx.on('shell/data', (runId, chunk) => broadcast(Channel.SHELL_DATA, runId, chunk))
  handle(ctx, Channel.SHARE_SHELL, async (_event, conversationId: string, cardId: string, providerId: string, modelId: string) =>
    ctx.sessions.shareShell(conversationId, cardId, providerId, modelId),
  )
}
shellBridge.inject = ['shell', 'sessions']

// 터미널 칸 — 출력은 메인이 먼저 안다. 모든 창에 흘려보낸다 (화면이 폴더로 거른다). ctx.on 은 묶음이 내려가면 같이 풀린다
function terminalsBridge(ctx: Context): void {
  handle(ctx, Channel.OPEN_TERMINAL, async (_event, directory: string) => ctx.terminals.attach(directory))
  handle(ctx, Channel.WRITE_TERMINAL, async (_event, directory: string, data: string) => ctx.terminals.write(directory, data))
  handle(ctx, Channel.RESIZE_TERMINAL, async (_event, directory: string, rows: number, cols: number) => ctx.terminals.resize(directory, rows, cols))
  ctx.on('terminal/data', (directory, chunk, end) => broadcast(Channel.TERMINAL_DATA, directory, chunk, end))
  ctx.on('terminal/exit', (directory) => broadcast(Channel.TERMINAL_EXIT, directory))
}
terminalsBridge.inject = ['terminals']

function trajectoryBridge(ctx: Context): void {
  handle(ctx, Channel.LOAD_TRAJECTORY, async (_event, directory: string, sessionId: string) => ctx.trajectory.read(directory, sessionId))
}
trajectoryBridge.inject = ['trajectory']

// 알림 IPC — ctx.notifications 를 빼면 이 줄들만 사라지고 나머지 앱은 그대로다
function notificationsBridge(ctx: Context): void {
  handle(ctx, Channel.GET_NOTIFICATIONS, async () => ctx.notifications.snapshot())
  handle(ctx, Channel.VIEW_CONVERSATION, async (_event, conversationId?: string) => ctx.notifications.view(conversationId))
  handle(ctx, Channel.TAKE_PENDING_OPEN, async () => ctx.notifications.takePendingOpen())
  ctx.on('notifications/changed', (state) => broadcast(Channel.NOTIFICATIONS_CHANGED, state))
  ctx.on('notifications/toast', (toast) => broadcast(Channel.NOTIFICATION_TOAST, toast))
  ctx.on('notifications/open', () => broadcast(Channel.NOTIFICATION_OPEN))
  // 창이 앞으로 오면 보고 있던 대화를 읽음으로 (뒤에 있는 동안 끝난 것)
  ctx.effect(() => {
    const onFocus = () => ctx.notifications.focused()
    app.on('browser-window-focus', onFocus)
    return () => void app.off('browser-window-focus', onFocus)
  })
}
notificationsBridge.inject = ['notifications']

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

/** 앱 창은 하나 — 알림 클릭·dock·두 번째 실행이 이 창을 앞으로 부른다. macOS 에서 창을 닫으면 없다(앱은 산다) */
let mainWindow: BrowserWindow | undefined
const windows: WindowAccess = {
  current: () => mainWindow,
  reveal() {
    const win = mainWindow ?? createWindow()
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  },
}
// 실물 테스트는 OS 알림·배지·창 앞으로 부르기 대신 기록하고, 앞/뒤 판정을 주입한다 — 사용자 화면에 알림을 띄우지 않는다.
// 테스트는 app.evaluate 로 globalThis.__litecodeNotifyTest 의 record 를 읽고, emit 으로 ctx.llm 의 이벤트를 흉내 낸다. 제품은 이 길이 없다
const notifyTest: NotifyTestRecord | undefined = hiddenForTests ? { foreground: false, shown: [], badge: [], reveals: 0 } : undefined
const notifyHost = notifyTest ? recordingHost(notifyTest) : systemHost(windows)
if (notifyTest) Object.assign(globalThis, { __litecodeNotifyTest: { record: notifyTest, emit: (name: string, ...args: unknown[]) => (ctx.emit as (...all: unknown[]) => void)(name, ...args) } })
app.on('second-instance', () => notifyHost.reveal())

// 다른 앱에서 열기 (대화 머리 분할 버튼) — 실물 테스트는 실행을 기록만 한다(globalThis.__litecodeOpenInTest). 제품은 이 길이 없다
const openInTest: OpenInTestRecord | undefined = hiddenForTests ? { launches: [] } : undefined
if (openInTest) Object.assign(globalThis, { __litecodeOpenInTest: openInTest })
const openInHost = openInTest ? recordingOpenInHost(openInTest) : systemOpenInHost
function openInBridge(ctx: Context): void {
  handle(ctx, Channel.OPEN_IN_APPS, async () => ctx.openIn.apps())
  handle(ctx, Channel.OPEN_IN, async (_event, appId: string, directory: string) => ctx.openIn.open(appId, directory))
  handle(ctx, Channel.OPEN_FILE_IN, async (_event, appId: string, directory: string, token: string) => ctx.openIn.openFile(appId, directory, token))
}
openInBridge.inject = ['openIn']

/** 기능 묶음 — ctx.features 가 settings 의 켜기 값을 보고 올리고 내린다 (재시작 없이). 순서는 shared/features.ts 의 FEATURES 와 같게 */
const features: FeatureDefinition[] = [
  { id: 'at', plugin: AtTrigger },
  { id: 'slash', plugin: SlashTrigger },
  { id: 'bang', plugin: BangTrigger }, // `!명령`(shell) 이 꺼지면 같이 꺼진다 (FEATURE_REQUIRES)
  {
    id: 'shell',
    plugin: (ctx) => {
      ctx.plugin(ShellService)
      ctx.plugin(shellBridge)
    },
  },
  {
    id: 'terminal',
    plugin: (ctx) => {
      ctx.plugin(TerminalsService)
      ctx.plugin(terminalsBridge)
    },
  },
  {
    id: 'trajectory',
    plugin: (ctx) => {
      ctx.plugin(TrajectoryService)
      ctx.plugin(trajectoryBridge)
    },
  },
  {
    id: 'notifications',
    plugin: (ctx) => {
      ctx.plugin(NotificationsService, notifyHost)
      ctx.plugin(notificationsBridge)
    },
  },
  {
    id: 'openIn',
    plugin: (ctx) => {
      ctx.plugin(OpenInService, { host: openInHost })
      ctx.plugin(openInBridge)
    },
  },
  // 웹 도구(web)는 묶음이 없다 — ctx.engine 이 features/changed 를 듣고 opencode.json 을 다시 써 재시작한다 (이슈 #14)
]
// 종료 때 바탕보다 먼저 내려간다(거꾸로 내리므로) — 터미널·셸·알림이 엔진보다 먼저 정리된다
mounted.push(ctx.plugin(FeaturesService, features))

function createWindow(): BrowserWindow {
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
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = undefined
  })
  return win
}

void app.whenReady().then(async () => {
  await settingsFiber // 설정 서비스가 올라온 뒤 — 테마를 창보다 먼저 정한다
  nativeTheme.themeSource = ctx.settings.get().appearance
  createWindow()
})

// macOS: 창을 닫아도 앱은 산다 — dock 을 누르면 새 창 (알림 클릭과 같은 창 함수)
app.on('activate', () => {
  if (app.isReady() && !mainWindow) createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
