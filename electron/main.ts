import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, screen, session, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { ProviderRegistry, type KeyCipher, type ProviderInput } from '../src/services/providers.ts'
import { LlmService, type AttentionAnswer } from '../src/services/llm.ts'
import { ChatService } from '../src/services/chat.ts'
import { attachDropped, attachPasted, pickAttachments } from '../src/services/attachments.ts'
import { PastedImages } from '../src/services/pastedImages.ts'
import type { AttachmentKind } from '../shared/contract.ts'
import type { ChatModel, QueuedSend } from '../shared/chat.ts'
import { EngineService, killEngineProcesses } from '../src/services/engine.ts'
import { readLoginPath } from '../src/services/loginPath.ts'
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
import { previewFile, readHtmlAssets, type FilePreview, type HtmlAsset } from '../src/services/filePreview.ts'
import { listDirectory, type DirectoryListing } from '../src/services/fileTree.ts'
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
import { SkillsService, type SkillScope } from '../src/services/skills.ts'
import { recordingOpenInHost, systemOpenInHost, type OpenInTestRecord } from './openInHost.ts'
import { McpService, type McpServerInput } from '../src/services/mcp.ts'
import { AppMcpService } from '../src/services/appMcp.ts'
import { OpenFileTool } from '../src/services/appMcp/tools/openFile.ts'
import { OpenTerminalTool } from '../src/services/appMcp/tools/openTerminal.ts'
import { RemoteService } from '../src/services/remote.ts'
import { RemoteHttp } from '../src/services/remote/http.ts'
import { SessionTools } from '../src/services/appMcp/tools/sessions.ts'
import { attentionTarget } from '../shared/delegation.ts'
import { captureConsole, createLogFile } from '../src/services/logFile.ts'
import { readJsonFileSync, writeJsonFileSync } from '../src/services/jsonFile.ts'
import { allowPermission, missingServices, reloadGuard, withDeadline } from './resilience.ts'
import { restorableBounds } from './windowBounds.ts'

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

// 로그 파일 (참고 레포 검토 02x) — 설치본엔 터미널이 없어 console.error/warn 이 어디에도 안 남았다. 서비스보다 먼저 건다:
// 지금부터의 console.error·warn 은 userData/logs/main.log 에도 남는다 (1MB × 3개로 돈다, 비밀은 가린다 — logFile.ts).
const mainLog = createLogFile(path.join(userData, 'logs'))
captureConsole(mainLog)
// 메인의 잡히지 않은 오류 — 기록하고 계속 돈다. (리스너를 걸면 Electron 기본 오류 대화상자는 더 안 뜬다 — 스택을 사용자에게 보이는 대신 파일에 남긴다)
process.on('uncaughtException', (error) => console.error('[fatal] uncaughtException', error))
process.on('unhandledRejection', (reason) => console.error('[fatal] unhandledRejection', reason))
// 렌더러·보조 프로세스(GPU·유틸리티)가 죽었다. 앱 창의 렌더러면 화면을 다시 불러온다 — 턴·대기열은 메인(ctx.chat)이 쥐고 있어
// 새 화면이 CHAT_SNAPSHOT 으로 이어 그린다. 죽고 불러오기가 되풀이되면(1분에 3번) 멈추고 기록만 한다
const RENDERER_RELOADS = { max: 3, withinMs: 60_000 }
const rendererReloads = reloadGuard(RENDERER_RELOADS)
app.on('render-process-gone', (_event, contents, details) => {
  console.error('[fatal] render-process-gone', details.reason, details.exitCode)
  if (details.reason === 'clean-exit' || contents !== mainWindow?.webContents) return
  if (rendererReloads.allow()) contents.reload()
  else console.error(`[fatal] 렌더러가 ${RENDERER_RELOADS.withinMs / 1000}초 안에 ${RENDERER_RELOADS.max}번 넘게 죽었다 — 다시 불러오기를 멈춘다`)
})
app.on('child-process-gone', (_event, details) => console.error('[fatal] child-process-gone', details.type, details.reason, details.exitCode, details.name ?? ''))
// 설정 > 일반 — 맨 먼저 올린다: 언어(메인 오류 문구)·테마(첫 창 배경)가 다른 서비스·창보다 먼저 정해지게.
// 실물 테스트는 LITECODE_TEST_LANGUAGE=ko 로 첫 실행 언어를 한국어로 고정한다(셀렉터가 한국어). 제품은 이 변수를 안 쓴다
const settingsFiber = ctx.plugin(SettingsService, {
  file: path.join(userData, 'settings.json'),
  defaults: process.env.LITECODE_TEST_LANGUAGE === 'ko' ? { language: 'ko' } : undefined,
})
mounted.push(settingsFiber)
/** provider 키·MCP 비밀을 봉하는 safeStorage (키 없는 Linux basic_text 는 못 쓴다 — keyStorage.ts) */
const keyCipher: KeyCipher = {
  available: () =>
    canSealKeys(
      process.platform,
      safeStorage.isEncryptionAvailable(),
      process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : undefined,
    ),
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (sealed) => safeStorage.decryptString(sealed),
}
mounted.push(ctx.plugin(ProviderRegistry, {
  file: path.join(userData, 'providers.json'),
  keysFile: path.join(userData, 'provider-keys.json'),
  // safeStorage 는 app ready 뒤에만 쓸 수 있다 — 키 저장은 설정 화면에서만 일어나므로 그때는 늘 ready 다.
  // macOS 는 Keychain, 쓸 수 없는 환경(키링 없는 Linux 의 basic_text 포함 — keyStorage.ts)이면 서비스가 키 저장을 거부한다.
  cipher: keyCipher,
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
  loginPath: () => readLoginPath(),
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
  handle(ctx, Channel.LIST_CONVERSATIONS, async () => ctx.sessions.list())
  handle(ctx, Channel.SAVE_CONVERSATION, async (_event, conversation: Conversation) => ctx.sessions.save(conversation))
  // 고른 모델·모드·시각만 — 제목·통계·엔진 세션은 ctx.chat 이 적는다 (화면이 통째로 덮지 않게)
  handle(ctx, Channel.PATCH_CONVERSATION, async (_event, id: string, patch: { model?: ChatModel; mode?: Mode; updatedAt?: number }) => {
    await ctx.sessions.patch(String(id), () => ({
      ...(typeof patch?.model?.providerId === 'string' && typeof patch.model.modelId === 'string' && { model: { providerId: patch.model.providerId, modelId: patch.model.modelId } }),
      ...(isMode(patch?.mode) && { mode: patch.mode }),
      ...(typeof patch?.updatedAt === 'number' && { updatedAt: patch.updatedAt }),
    }))
  })
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
  // 오른쪽 패널(이슈 #29) — HTML 미리보기 리소스와 Files 탭 목록도 등록된 프로젝트 안만
  handle(ctx, Channel.PREVIEW_ASSETS, async (_event, directory: string, token: string, references: string[]): Promise<HtmlAsset[]> => {
    const registered = (await ctx.projects.list()).some((project) => project.path === directory)
    return registered ? readHtmlAssets(directory, token, references) : []
  })
  handle(ctx, Channel.LIST_DIRECTORY, async (_event, directory: string, relative: string): Promise<DirectoryListing> => {
    const registered = (await ctx.projects.list()).some((project) => project.path === directory)
    return registered ? listDirectory(directory, relative) : { status: 'unavailable' }
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

// 대화 (ctx.chat, 이슈 #52) — 보내기·대기열·중지·답은 메인이 쥐고, 화면은 이벤트로 그린다. 이벤트는 모든 창에 흘린다 (화면이 대화 id 로 거른다).
// 창이 없어도(macOS 에서 닫음) 턴은 돌고, 새 창은 CHAT_SNAPSHOT 으로 이어 그린다
function chatBridge(ctx: Context): void {
  // `+` 메뉴의 파일 추가·이미지 추가 (이슈 #44) — 이미지는 png·jpeg 만 (01y: 그 밖은 실측하지 않았다. 판정은 확장자가 아니라 매직 바이트)
  handle(ctx, Channel.PICK_ATTACHMENTS, async (event, kind: AttachmentKind, directory: string, held: number) => {
    const image = kind === 'image'
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      properties: ['openFile' as const, 'multiSelections' as const],
      ...(image ? { filters: [{ name: tr('attach.imageFilter'), extensions: ['png', 'jpg', 'jpeg'] }] } : typeof directory === 'string' && { defaultPath: directory }),
    }
    const chosen = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (chosen.canceled) return { picked: [], rejected: [] }
    const result = await pickAttachments(image ? 'image' : 'file', chosen.filePaths, Number(held) || 0)
    ctx.chat.allowAttachments(result.picked.map((item) => item.path))
    return result
  })
  // 붙여넣기·끌어다 놓기 (이슈 #80). 본문은 preload 가 File 객체에서 만든 것이다 — paths: 사용자가 실제로 놓거나 붙여넣은 파일의 경로
  // (webUtils.getPathForFile), blobs: 경로 없는 이미지의 바이트(스크린숏). 종류·상한·사유는 고르기와 같은 검사로 메인이 정하고,
  // 칩이 된 경로만 보낼 수 있게 적어 둔다. 경로 없는 이미지는 userData/pasted-images 의 임시 파일이 된다 (pastedImages.ts — 지우는 때 포함)
  const pasted = new PastedImages(path.join(userData, 'pasted-images'))
  const cleared = pasted.reset().catch((error: unknown) => console.error('[attachments] 붙여넣은 이미지 폴더 비우기 실패', (error as Error).message))
  ctx.effect(() => () => pasted.reset().catch(() => {}))
  ctx.on('chat/attachments-read', (paths) => void pasted.discard(paths))
  ctx.on('sessions/removed', (ids) => void pasted.discardOf(ids))
  handle(ctx, Channel.ATTACH_DROPPED, async (_event, conversationId: string, input: { paths?: unknown; blobs?: unknown } | undefined, held: Partial<Record<AttachmentKind, number>> | undefined, model: ChatModel | undefined) => {
    await cleared
    const paths = Array.isArray(input?.paths) ? input.paths.filter((file): file is string => typeof file === 'string' && path.isAbsolute(file)) : []
    const blobs = (Array.isArray(input?.blobs) ? (input.blobs as { name?: unknown; data?: unknown }[]) : []).map((blob) => ({
      name: String(blob?.name ?? ''),
      ...(blob?.data instanceof Uint8Array && { data: blob.data }),
    }))
    const imageInput = typeof model === 'object' && ctx.chat.acceptsImages(model)
    const count = { file: Number(held?.file) || 0, image: Number(held?.image) || 0 }
    const dropped = await attachDropped(paths, count, imageInput)
    for (const item of dropped.picked) count[item.kind]++
    const fromBytes = await attachPasted(pasted, String(conversationId), blobs, count, imageInput)
    const picked = [...dropped.picked, ...fromBytes.picked]
    ctx.chat.allowAttachments(picked.map((item) => item.path))
    return { picked, rejected: [...new Set([...dropped.rejected, ...fromBytes.rejected])] }
  })
  handle(ctx, Channel.DISCARD_ATTACHMENTS, async (_event, paths: unknown) => pasted.discard(Array.isArray(paths) ? paths.filter((file): file is string => typeof file === 'string') : []))
  handle(ctx, Channel.SEND_MESSAGE, async (_event, conversationId: string, input: QueuedSend) => ctx.chat.send(String(conversationId), { ...input, origin: 'user' }))
  // 이름 바꾸기 — 제목은 ctx.chat 이 적는다 (빈 이름·모르는 대화면 undefined)
  handle(ctx, Channel.RENAME_CONVERSATION, async (_event, id: string, name: string) => ctx.chat.rename(String(id), String(name)))
  // 고정·해제 (이슈 #79) — 이름 바꾸기와 같은 길 (모르는 대화면 undefined)
  handle(ctx, Channel.PIN_CONVERSATION, async (_event, id: string, pinned: boolean) => ctx.chat.pin(String(id), pinned === true))
  handle(ctx, Channel.TAKE_QUEUE, async (_event, conversationId: string) => ctx.chat.takeQueue(String(conversationId)))
  handle(ctx, Channel.DROP_QUEUED, async (_event, conversationId: string, index: number) => ctx.chat.dropQueued(String(conversationId), Number(index)))
  handle(ctx, Channel.CHAT_SNAPSHOT, async () => ctx.chat.snapshot())
  handle(ctx, Channel.STOP_TURN, async (_event, conversationId: string) => ctx.chat.stop(String(conversationId)))
  handle(ctx, Channel.STOP_SUBTASK, async (_event, subtaskId: string) => ctx.chat.stopSubtask(String(subtaskId)))
  // target: 지시 보내기 승인 카드에서 고른 받을 대화 (이슈 #67) — 모양만 거른다. 그 대화로 보낼 수 있는지는 도구가 실행할 때 다시 본다
  handle(ctx, Channel.REPLY_ATTENTION, async (_event, sessionId: string, requestId: string, answer: AttentionAnswer, target?: unknown) => ctx.chat.reply(sessionId, requestId, answer, attentionTarget(target)))
  ctx.on('chat/turn-started', (data) => broadcast(Channel.TURN_STARTED, data))
  ctx.on('chat/turn-progress', ({ cid, item }) => broadcast(Channel.TURN_PROGRESS, cid, item))
  ctx.on('chat/turn-attention', ({ cid, requests }) => broadcast(Channel.TURN_ATTENTION, cid, requests))
  ctx.on('chat/turn-ended', (data) => broadcast(Channel.TURN_ENDED, data))
  ctx.on('chat/queue-changed', (data) => broadcast(Channel.QUEUE_CHANGED, data))
  ctx.on('chat/conversations-changed', (data) => broadcast(Channel.CONVERSATIONS_CHANGED, data))
}
chatBridge.inject = ['chat']
mounted.push(ctx.plugin(ChatService))
mounted.push(ctx.plugin(chatBridge))

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
// 정리에는 전체 기한을 둔다 (참고 레포 검토 02x D) — 서비스 하나의 dispose 가 안 끝나도 앱은 꺼져야 한다. 엔진의 stop 은
// SIGTERM → 5초(KILL_GRACE_MS) → SIGKILL 이라 기한은 그보다 길다. 기한이 지났든 아니든 끝내기 직전에 살아 있는 opencode 자식을
// 죽인다(다 내려갔으면 아무 일도 없다) — 앱만 꺼지고 opencode 가 남는 길을 없앤다
const QUIT_DEADLINE_MS = 8_000
let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  const disposing = (async () => {
    for (const fiber of mounted.reverse()) await fiber.dispose().catch((error: unknown) => console.error('[quit] 서비스 정리 실패', error))
  })()
  void withDeadline(disposing, QUIT_DEADLINE_MS).then((outcome) => {
    if (outcome === 'timeout') console.error(`[quit] 서비스 정리가 ${QUIT_DEADLINE_MS / 1000}초 안에 끝나지 않았다 — 남은 opencode 를 죽이고 끝낸다`)
    killEngineProcesses()
    app.exit(0)
  })
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

// 스킬 (이슈 #7) — 입력창 `+` 메뉴의 스킬 팝업 목록(#43). `/` 후보·본문 붙이기는 SlashTrigger 가 ctx.skills 를 쓴다
function skillsBridge(ctx: Context): void {
  handle(ctx, Channel.LIST_SKILLS, async (_event, directory: string) => ctx.skills.list(directory))
  // "폴더 열기" — 등록된 프로젝트일 때만 (화면이 오염돼도 아무 폴더에나 .opencode/skills 를 만들지 않는다). 경로는 메인이 정한다
  handle(ctx, Channel.OPEN_SKILLS_FOLDER, async (_event, scope: SkillScope, directory: string) => {
    const registered = (await ctx.projects.list()).some((project) => project.path === directory)
    const folder = registered ? await ctx.skills.folder(scope === 'project' ? 'project' : 'all', directory) : undefined
    if (!folder || (await shell.openPath(folder))) throw new Error(tr('skills.openFolderError'))
  })
}
skillsBridge.inject = ['skills', 'projects']

// MCP (이슈 #28) — 입력창 `+` 메뉴의 MCP 팝업(#43)의 IPC. directory 는 지금 프로젝트 — 프로젝트 전용 서버·프로젝트별 켜기 값의 열쇠다
function mcpBridge(ctx: Context): void {
  handle(ctx, Channel.LIST_MCP, async (_event, directory?: string) => ctx.mcp.list(directory))
  handle(ctx, Channel.SAVE_MCP, async (_event, input: McpServerInput, directory?: string) => ctx.mcp.save(input, directory))
  handle(ctx, Channel.REMOVE_MCP, async (_event, name: string, directory?: string) => ctx.mcp.remove(name, directory))
  handle(ctx, Channel.SET_MCP_ENABLED, async (_event, name: string, enabled: boolean, directory: string) => ctx.mcp.setEnabled(name, enabled, String(directory)))
  handle(ctx, Channel.TEST_MCP, async (_event, input: McpServerInput, directory?: string) => ctx.mcp.test(input, directory))
}
mcpBridge.inject = ['mcp']

// 앱 MCP 서버 (이슈 #51) — AI 의 open_file·open_terminal 을 화면에 잇는다. 화면 도구는 사용자가 보고 있는 프로젝트에만 닿는다:
// 화면이 지금 프로젝트를 알리고(APP_MCP_VIEW), 도구의 요청은 모든 창에 흘린다(화면이 프로젝트로 거른다). 창이 다 닫히면 보고 있는 것이 없다
function appMcpBridge(ctx: Context): void {
  handle(ctx, Channel.APP_MCP_VIEW, async (_event, directory?: string) => ctx.appMcp.view(typeof directory === 'string' ? directory : undefined))
  ctx.on('appMcp/open-file', (directory, file, line) => broadcast(Channel.APP_MCP_OPEN_FILE, directory, file, line))
  ctx.on('appMcp/open-terminal', (directory) => broadcast(Channel.APP_MCP_OPEN_TERMINAL, directory))
  ctx.effect(() => {
    const onAllClosed = () => ctx.appMcp.view(undefined)
    app.on('window-all-closed', onAllClosed)
    return () => void app.off('window-all-closed', onAllClosed)
  })
}
appMcpBridge.inject = ['appMcp']

// 모바일 연결 (이슈 #56) — 설정 > 모바일과 짝짓기 [허용] 확인의 IPC. 상태가 바뀌면(요청이 왔다·기기가 붙었다) 모든 창에
function remoteBridge(ctx: Context): void {
  handle(ctx, Channel.REMOTE_STATUS, async () => ctx.remote.status())
  handle(ctx, Channel.REMOTE_SET_ENABLED, async (_event, enabled: boolean) => ctx.remote.setEnabled(enabled === true))
  handle(ctx, Channel.REMOTE_START_PAIRING, async () => ctx.remote.startPairing())
  handle(ctx, Channel.REMOTE_CANCEL_PAIRING, async () => ctx.remote.cancelPairing())
  handle(ctx, Channel.REMOTE_ANSWER_PAIR, async (_event, requestId: string, allow: boolean) => ctx.remote.answerPair(String(requestId), allow === true))
  handle(ctx, Channel.REMOTE_REVOKE, async (_event, deviceId: string) => ctx.remote.revoke(String(deviceId)))
  ctx.on('remote/changed', (status) => broadcast(Channel.REMOTE_CHANGED, status))
}
remoteBridge.inject = ['remote']

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
      ctx.plugin(OpenTerminalTool) // 앱 MCP 의 open_terminal — 터미널 칸을 끄면 도구도 목록에서 빠진다
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
  {
    // 끄면 엔진도 skill 도구를 뺀다 — ctx.engine 이 features/changed 를 듣고 재시작한다
    id: 'skills',
    plugin: (ctx) => {
      ctx.plugin(SkillsService, { appDir: path.join(userData, 'opencode', 'skills') }) // 앱 설정 폴더(ctx.engine 의 configDir)의 skills
      ctx.plugin(skillsBridge)
    },
  },
  // 웹 도구(web)는 묶음이 없다 — ctx.engine 이 features/changed 를 듣고 opencode.json 을 다시 써 재시작한다 (이슈 #14)
  {
    id: 'mcp',
    plugin: (ctx) => {
      // 비밀(env·헤더 값)은 provider 키와 같은 safeStorage — 렌더러엔 설정 여부만
      ctx.plugin(McpService, {
        file: path.join(userData, 'mcp.json'),
        secretsFile: path.join(userData, 'mcp-secrets.json'),
        projectsFile: path.join(userData, 'mcp-projects.json'),
        cipher: keyCipher,
        fallbackCwd: userData,
      })
      ctx.plugin(mcpBridge)
      // 앱 자신의 MCP 서버(127.0.0.1, 실행마다 토큰) — ctx.mcp 가 사용자 서버와 같은 길로 매 턴 붙인다. 끄는 스위치는 없다
      ctx.plugin(AppMcpService)
      ctx.plugin(OpenFileTool)
      ctx.plugin(SessionTools) // 앱 MCP 의 세션 도구 넷 — 다른 대화 보기·지시 보내기 (이슈 #55)
      ctx.plugin(appMcpBridge)
    },
  },
  {
    // 모바일 연결 — 기본 꺼짐. 켜도 설정 > 모바일의 스위치를 켜기 전에는 포트를 열지 않는다. 끄면 서버·IPC·설정 메뉴가 함께 내려간다
    id: 'remote',
    plugin: (ctx) => {
      ctx.plugin(RemoteService, { file: path.join(userData, 'remote-devices.json'), appVersion: app.getVersion() })
      // 운반은 ctx.remote 밑의 플러그인이다 (이슈 #68) — 지금은 HTTP(127.0.0.1:47600) 하나. 블루투스 운반이 이 옆에 올라온다
      ctx.plugin(RemoteHttp)
      ctx.plugin(remoteBridge)
    },
  },
]
// 종료 때 바탕보다 먼저 내려간다(거꾸로 내리므로) — 터미널·셸·알림이 엔진보다 먼저 정리된다
mounted.push(ctx.plugin(FeaturesService, features))

/** Windows·Linux 창 버튼 덮개(titleBarOverlay) — 대화 머리(52px)와 같은 높이, 테마 바탕(--bg)·보조 글자(--text-secondary) 색 */
function titleBarOverlay(): Electron.TitleBarOverlayOptions {
  const dark = nativeTheme.shouldUseDarkColors
  return { height: 52, color: dark ? '#151517' : '#ffffff', symbolColor: dark ? '#cfd3d6' : '#61666b' }
}

/** 화면에 전체 화면 여부를 알린다 — macOS 는 전체 화면에서 창 버튼이 사라지므로 화면이 그 자리 여백을 거둔다 (preload 가 html[data-fullscreen]) */
function sendFullScreen(win: BrowserWindow): void {
  if (!win.isDestroyed()) win.webContents.send(Channel.WINDOW_FULLSCREEN, win.isFullScreen())
}

/** 창 크기·위치 기억 — 닫을 때 적고 다음 창이 되돌린다. 저장한 자리가 지금 화면 밖이면 기본 크기로 가운데 (windowBounds.ts) */
const windowFile = path.join(userData, 'window.json')

function createWindow(): BrowserWindow {
  const saved = restorableBounds(readJsonFileSync(windowFile, 'object'), screen.getAllDisplays().map((display) => display.workArea))
  const win = new BrowserWindow({
    ...(saved ?? { width: 1280, height: 800 }),
    // 제목 표시줄 없이 화면이 창 맨 위까지 (이슈 #25). macOS 는 창 버튼을 사이드바 맨 위 줄(52px) 안 왼쪽에 — dsh 데스크톱과 같은
    // {16, 18}(버튼 세로 가운데 = 25, 사이드바 맨 위 줄·사이드바 숨김 때 본문 왼쪽 위 버튼과 같은 줄). Windows·Linux 는 창 버튼을
    // 오른쪽 위 덮개로 그린다(실행 미검증). 창 끌기는 화면 CSS(-webkit-app-region)가 정한다
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 18 } }
      : { titleBarStyle: 'hidden' as const, titleBarOverlay: titleBarOverlay() }),
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
  // 화면 안 iframe(오른쪽 패널의 HTML 미리보기, 이슈 #29)은 처음 실린 srcdoc 밖으로 못 나간다 — 링크·location 변경·meta refresh 로
  // 외부 주소를 여는 것도 네트워크 요청이라 CSP(connect-src 등)로는 못 막는다. 같은 문서 안 #조각 이동만 둔다
  win.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame && !/^about:(srcdoc|blank)(#|$)/.test(event.url)) event.preventDefault()
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
  win.on('enter-full-screen', () => sendFullScreen(win))
  win.on('leave-full-screen', () => sendFullScreen(win))
  win.webContents.on('did-finish-load', () => sendFullScreen(win)) // 새로고침하면 화면 표시가 지워지므로 다시
  // 덮개 색은 테마를 따라간다 (Windows·Linux)
  const recolor = () => {
    if (!win.isDestroyed()) win.setTitleBarOverlay(titleBarOverlay())
  }
  if (process.platform !== 'darwin') nativeTheme.on('updated', recolor)

  win.on('close', () => {
    try {
      writeJsonFileSync(windowFile, win.getNormalBounds()) // 최대화·전체 화면이면 그 전의 크기
    } catch (error) {
      console.warn('[window] 창 자리를 못 적었다', (error as Error).message)
    }
  })

  mainWindow = win
  win.on('closed', () => {
    nativeTheme.off('updated', recolor)
    if (mainWindow === win) mainWindow = undefined
  })
  return win
}

// 부팅 진단 (참고 레포 검토 02x A) — 바탕 서비스 하나라도 안 뜨면 그것을 inject 한 bootstrap·chatBridge 가 말없이 기다리기만 하고
// 창은 IPC 핸들러 없이 뜬다. 기한 뒤에도 안 뜬 서비스의 이름을 로그에 남기고 사용자에게 한 줄로 알린다
const BOOT_DEADLINE_MS = 15_000
function checkBoot(): void {
  const missing = missingServices([...bootstrap.inject, ...chatBridge.inject], (name) => ctx.get(name))
  if (!missing.length) return
  console.error(`[boot] ${BOOT_DEADLINE_MS / 1000}초 안에 안 뜬 서비스: ${missing.join(', ')}`)
  if (hiddenForTests) return // 실물 테스트는 대화상자를 띄우지 않는다 — 기록만
  const message = tr('error.bootStalled', { seconds: BOOT_DEADLINE_MS / 1000, names: missing.join(', '), log: mainLog.path })
  if (mainWindow) void dialog.showMessageBox(mainWindow, { type: 'error', message })
  else dialog.showErrorBox(app.getName(), message)
}

void app.whenReady().then(async () => {
  // 화면(웹 내용)의 권한 요청은 기본 거부 (참고 레포 검토 02x D) — 답·미리보기 iframe 의 글은 모델·프로젝트 파일에서 온다.
  // 앱 화면이 쓰는 것은 "복사" 의 클립보드 쓰기뿐이다 (resilience.ts allowPermission)
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => callback(allowPermission(permission, details.isMainFrame)))
  session.defaultSession.setPermissionCheckHandler((_contents, permission, _origin, details) => allowPermission(permission, details.isMainFrame))
  setTimeout(checkBoot, BOOT_DEADLINE_MS).unref()
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
