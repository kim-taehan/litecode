import { Context, Service, type Fiber } from 'cordis'
import path from 'node:path'
import type {
  ExtensionCallError,
  ExtensionCallResult,
  ExtensionEntryResult,
  ExtensionFailedReason,
  ExtensionInstallResult,
  ExtensionLocaleResult,
  ExtensionManifest,
  ExtensionPermission,
  ExtensionPickResult,
  ExtensionProblem,
  ExtensionResult,
  ExtensionServerOptions,
  ExtensionStoreFailure,
  ExtensionSummary,
} from '../../shared/extensions.ts'
import { DEFAULT_LANGUAGE, isBuiltinLanguage } from '../../shared/i18n/index.ts'
import { setMainLocalePack } from '../i18n.ts'
import { changedFiles } from './extensions/changes.ts'
import { ExtensionData } from './extensions/data.ts'
import { EXTENSION_LIMITS } from './extensions/limits.ts'
import { isExtensionId } from './extensions/manifest.ts'
import { fetchForExtension, isAppAddress, parseFetchRequest, selfAddresses, type ExtensionFetch } from './extensions/network.ts'
import { isEntryPath } from './extensions/paths.ts'
import { projectRelativePaths } from './extensions/pick.ts'
import { DEFAULT_SERVER_OPTIONS, ExtensionServers, type ExtensionServersOptions } from './extensions/servers.ts'
import { ExtensionStore, readInsideFile } from './extensions/store.ts'
import { failureReason } from './features.ts'
import type { KeyCipher } from './providers.ts'
import './settings.ts'

// 설치한 확장 (ctx.extensions, 이슈 #482 — 설계 docs/superpowers/specs/2026-10-19-extension-install-design.md 5절). 바탕 서비스다(끌 수 없다).
// 부팅: (1) 보류 작업 적용 (2) installed/ 를 읽어 manifest 재검증 (3) 켜진 확장마다 올림. 생성자는 던지지 않는다(CLAUDE.md 함정 4) —
// 폴더 하나가 깨져도 그 확장만 failed 로 남고 앱은 뜬다. 삭제는 폴더 이름이 id 형식일 때만 된다 — 손으로 만든 다른 이름의 깨진 폴더는
// 목록에 failed 로 보이지만 앱에서 지울 수 없다(후속, QA 03_qa_ext_pr3 경고 3).
// 켜짐 값은 settings.extensions (기본 켜짐 — false 만 남긴다). 켜고 끄기는 곧바로 올리고 내린다. 설치·업데이트·삭제도 그 호출 안에서 곧바로
// 적용한다(이슈 #511 — 저장소의 보류를 쌓은 직후 applyPending. 부팅 때 적용은 비정상 종료 복구용으로 남는다).
// 패널 확장(#511): 진입 HTML 을 readEntry 로 화면에 넘길 뿐 메인에서 실행하지 않는다 — 화면이 격리된 iframe(sandbox="allow-scripts", CSP)에서 돌린다.
// 올리기는 주입된 mount(B 층 자리 — features 의 definitions 와 같은 패턴)로 한다. mount 가 없으면(A 층 단독) 아무것도 실행하지 않고 상태만 on.
// 부팅·설치·삭제·켜고 끄기는 한 줄(큐)로 선다 — features.ts 처럼, 끄자마자 켜도 앞의 올리기가 끝난 뒤 내린다.
// 대화상자는 host(pick), 파일 작업은 저장소(ExtensionStore — 2/4). 저장소 호출은 아래 `files` 한 곳에만 모았다(저장소의 공개 모양이 바뀌면 거기만 고친다).
// 언어 팩(#525, type 'locale'): 실행할 것이 없는 JSON 번들이다. readLocale 로 사전을 화면에 넘기고, 고른 언어(settings.language)가 팩 언어면
// 메인 문구(tr)에도 넣는다. 고른 팩이 지워지거나 꺼지거나 깨지면 언어를 기본(en)으로 되돌린다 — sync 끝의 followLanguage. 설치만으로는 언어를 바꾸지 않는다.
// 확장 ↔ 앱 통로(#536): 화면의 확장 탭이 iframe 에서 받은 요청을 call(id, method, params, project) 로 넘긴다 — 여기서 권한(manifest permissions)을 검사하고
// 처리한다. 확장이 남기는 값·허용한 주소는 data/<id>/ (extensions/data.ts), 지우면 같이 지운다. 허용 목록에 없는 주소는 요청하지 않고 consent-required —
// 화면이 동의 띠로 묻고 허용하면 allowOrigin 뒤에 다시 부른다(메인은 묻는 동안의 상태를 쥐지 않는다). 통로 일은 큰 줄에 서지 않는다(15초 요청이
// 설치·켜고 끄기를 막지 않게) — 자료 파일 쓰기만 자기 줄(dataQueue)에 서고, 삭제의 자료 지우기도 그 줄에 서서 쓰는 중인 값이 되살아나지 않는다.
// 내장 서버(#537, server 권한): manifest 의 server 선언대로 앱이 띄우고 내린다(extensions/servers.ts). 통로 메서드 server.status·start·stop·setOptions.
// 앱을 켤 때 — 켜진 서버 확장 중 설정 startWithApp 이거나 지난 실행의 서버가 남은 것(stopWithApp 끔·강제 종료)을 한 번 띄운다(남은 서버는 다시 잡는다).
// 끄거나 깨지거나 지우거나 업그레이드하면 내린다. 앱이 꺼질 때는 stopWithApp 인 서버에 정상 종료 신호를 보낸다(dispose).
// network.fetch 가 그 확장의 내장 서버 주소(http://127.0.0.1:<port>)로 가면 동의를 묻지 않고, 패널이 준 authorization 을 버리고 관리자 토큰을 붙인다.
// Electron 을 import 하지 않는다 — 단위 테스트가 임시 폴더 root 로 돈다.

declare module 'cordis' {
  interface Context {
    extensions: ExtensionsService
  }
  interface Events {
    /** 확장 목록(ExtensionSummary[])이 바뀌었다 — 설치·업그레이드·삭제·켜기/끄기·상태. 같은 값이면 다시 내지 않는다 */
    'extensions/changed'(extensions: ExtensionSummary[]): void
  }
}

/** mount 에 넘기는 확장 — 검증을 통과한 manifest 와 설치 폴더 */
export interface MountedExtension {
  manifest: ExtensionManifest
  dir: string
}

export interface ExtensionsOptions {
  /** 저장소 루트 — 앱은 `<userData>/extensions` */
  root: string
  /** manifest 의 litecode(최소 앱 버전) 검사 */
  appVersion: string
  /** zip 고르기 대화상자 — 취소면 undefined. owner 는 요청한 창(IPC event.sender) */
  pick?: (owner?: unknown) => Promise<string | undefined>
  /** 확장을 올리는 플러그인 — B 층의 주입 자리. 없으면 켜진 확장은 상태만 on */
  mount?: (extension: MountedExtension) => (ctx: Context) => void | Promise<void>
  /** secrets 를 봉하는 safeStorage (provider 키와 같은 것, 이슈 #536). 없거나 못 쓰면 secrets-unavailable */
  cipher?: KeyCipher
  /** network.fetch 가 쓰는 fetch — 확장마다 하나(쿠키·캐시를 확장끼리 섞지 않는다). 앱은 메인의 Chromium 네트워크(electron/extensionFetch.ts), 테스트가 주입한다. 기본 globalThis.fetch */
  fetch?: (id: string) => ExtensionFetch
  /** 앱 자신의 로컬 서버 포트 — network.fetch 가 동의와 상관없이 거절한다(address-reserved). 포트는 런타임에 정해지므로 부를 때마다 읽는다 */
  reservedPorts?: () => number[]
  /** project.pickPath 의 고르기 창 (이슈 #538) — 요청한 창(owner)에 붙이고 directory 에서 시작한다. 취소면 undefined. 없으면 io-failed */
  pickPaths?: (owner: unknown, request: { directory: string; multiple: boolean }) => Promise<string[] | undefined>
  /** project.changedFiles 가 띄우는 git 실행 파일 (기본: PATH 의 git — ctx.git 과 같다) */
  git?: string
  /** 내장 서버의 상태 주소·관리자 API 를 부르는 fetch (기본 globalThis.fetch) — 시험용 */
  serverFetch?: typeof globalThis.fetch
  /** 내장 서버 기한 — 시험용 */
  serverTiming?: ExtensionServersOptions['timing']
}

/** 통로 요청을 부른 프로젝트 — 다리가 등록된 프로젝트인지 확인한 것만 온다 */
export interface CallProject {
  directory: string
  name: string
}

/** 메서드 → 필요한 권한 (null: 권한 없이). 없는 메서드는 method-unknown */
const METHODS = new Map<string, ExtensionPermission | null>([
  ['storage.get', null],
  ['storage.set', null],
  ['storage.delete', null],
  ['secrets.get', 'secrets'],
  ['secrets.set', 'secrets'],
  ['secrets.delete', 'secrets'],
  ['network.fetch', 'network'],
  ['project.info', 'project'],
  ['project.readFile', 'project'],
  ['project.openFile', 'project'],
  ['project.pickPath', 'project'],
  ['project.changedFiles', 'project'],
  ['server.status', 'server'],
  ['server.start', 'server'],
  ['server.stop', 'server'],
  ['server.setOptions', 'server'],
])

type CallFailure = { ok: false; error: ExtensionCallError; origin?: string }
const fail = (error: ExtensionCallError): CallFailure => ({ ok: false, error })
const done = (result: unknown = null): ExtensionCallResult => ({ ok: true, result })

/** 한 확장의 파일 쪽 사실 — 설치 폴더(installed/<id>)에서 읽은 것 */
interface Entry {
  id: string
  manifest?: ExtensionManifest
  problems: ExtensionProblem[]
}

export class ExtensionsService extends Service {
  static readonly inject = ['settings']

  private readonly files: ReturnType<typeof storeAccess>
  private readonly data: ExtensionData
  /** 자료 파일(data/<id>) 쓰기·지우기의 줄 */
  private dataQueue: Promise<unknown> = Promise.resolve()
  /** 확장 id → 허용한 origin (목록에 싣는다) */
  private origins = new Map<string, string[]>()
  /** 고르기 창이 떠 있는 확장 (project.pickPath — 확장마다 하나) */
  private picking = new Set<string>()
  /** 확장마다 마지막 취소 시각과 막힘이 풀리는 시각 (project.pickPath — 되풀이해 띄우기 막기) */
  private pickCancels = new Map<string, { canceledAt: number; blockedUntil: number }>()
  private entries: Entry[] = []
  private queue: Promise<unknown> = Promise.resolve()
  private readonly booted: Promise<void>
  private fibers = new Map<string, Fiber>()
  /** 올리는 중인 확장 */
  private mounting = new Set<string>()
  /** mount 가 던진 사유 — 끄면 지운다 */
  private failures = new Map<string, string>()
  private published = ''
  private readonly servers: ExtensionServers
  /** 앱을 켤 때 같이 띄우기를 이번 실행에서 이미 본 확장 — 사용자가 내린 뒤 sync 가 다시 띄우지 않게 */
  private autoStarted = new Set<string>()

  constructor(
    ctx: Context,
    private options: ExtensionsOptions,
  ) {
    super(ctx, 'extensions')
    this.files = storeAccess(options.root, options.appVersion)
    this.data = new ExtensionData(options.root)
    this.servers = new ExtensionServers({
      root: options.root,
      ...(options.cipher && { cipher: options.cipher }),
      ...(options.serverFetch && { fetch: options.serverFetch }),
      ...(options.serverTiming && { timing: options.serverTiming }),
      onChange: () => this.publish(),
    })
    // 앱 종료 — stopWithApp 인 서버에 정상 종료 신호 (기다리지 않는다, servers.release)
    ctx.effect(() => () => this.servers.release((id) => !this.serverOptions(id).stopWithApp))
    this.booted = this.enqueue(() => this.boot())
    // 올리기는 따로 세운다 — 목록(list)은 읽기까지만 기다리고, 오래 걸리는 mount 는 mounting 으로 보인다
    void this.enqueue(() => this.sync())
    // 설정 파일의 켜짐 값이 다른 길(설정 화면·손으로 고침)로 바뀌어도 따라간다 — 같으면 아무 일도 없다
    ctx.on('settings/changed', () => void this.enqueue(() => this.sync()))
  }

  /** 확장 목록 (id 순) — 부팅(보류 적용·읽기)이 끝난 뒤의 값 */
  async list(): Promise<ExtensionSummary[]> {
    await this.booted
    return this.summaries()
  }

  /** zip 고르기 → staging 복사·검사 → 미리보기. 대화상자는 줄 밖에서 연다(열려 있는 동안 켜고 끄기를 막지 않게) */
  async pick(owner?: unknown): Promise<ExtensionPickResult> {
    let file: string | undefined
    try {
      file = await this.options.pick?.(owner)
    } catch (error) {
      return ioFailed(error)
    }
    if (!file) return { ok: true }
    const picked = file
    return this.enqueue(async (): Promise<ExtensionPickResult> => {
      try {
        return { ok: true, preview: await this.files.stage(picked) }
      } catch (error) {
        return ioFailed(error)
      }
    })
  }

  /** 확인 카드의 [설치] — 보류 설치로 쌓고 곧바로 적용한다 (이슈 #511). 적용이 실패하면 apply-failed (이전 버전이 그대로) */
  install(token: string): Promise<ExtensionInstallResult> {
    return this.enqueue(async () => {
      const result = await this.files.install(token).catch(ioFailed)
      if (!result.ok) return result
      await this.servers.stop(result.id) // 업그레이드 — 옛 파일로 도는 서버를 먼저 내린다
      const failed = await this.applyNow(result.id)
      await this.refresh()
      return failed ?? result
    })
  }

  /** 확인 카드의 [취소] — staging 복사본을 지운다 */
  cancel(token: string): Promise<ExtensionResult> {
    return this.enqueue(async () => {
      try {
        await this.files.cancel(token)
        return { ok: true as const }
      } catch (error) {
        return ioFailed(error)
      }
    })
  }

  /** 삭제 — 곧바로 적용하고(이슈 #511) 켜짐 값도 지운다. 적용이 실패하면 apply-failed (확장이 그대로) */
  remove(id: string): Promise<ExtensionResult> {
    return this.enqueue(async () => {
      const result = await this.files.remove(id).catch(ioFailed)
      if (!result.ok) return result
      await this.servers.stop(id) // 자료 폴더(서버 데이터)를 지우기 전에
      const failed = await this.applyNow(id)
      await this.refresh()
      return failed ?? result
    })
  }

  /** 켜진 정상(on) 확장의 진입 HTML (이슈 #511) — 화면이 격리된 iframe 에서 돌린다. 메인은 실행하지 않는다. 던지지 않는다 */
  readEntry(id: string): Promise<ExtensionEntryResult> {
    return this.enqueue(async (): Promise<ExtensionEntryResult> => {
      if (!isExtensionId(id)) return { ok: false, failure: { code: 'id-invalid', params: { value: id } } }
      const entry = this.entries.find((item) => item.id === id)
      if (!entry) return { ok: false, failure: { code: 'not-installed', params: { id } } }
      if (!entry.manifest || this.state(entry, this.enabled(id)).state !== 'on') return { ok: false, failure: { code: 'not-on', params: { id } } }
      const read = await this.files.readEntry(id, entry.manifest.entry).catch(ioFailed)
      return read.ok ? { ok: true, html: read.html, version: entry.manifest.version } : read
    })
  }

  /** 켜진 정상(on) 언어 팩의 사전 (이슈 #525) — 같은 언어의 팩이 여럿이면 id 순 첫 팩. 던지지 않는다 */
  readLocale(language: string): Promise<ExtensionLocaleResult> {
    return this.enqueue(async (): Promise<ExtensionLocaleResult> => {
      const entry = this.localeEntry(language)
      if (!entry?.manifest) return { ok: false, failure: { code: 'locale-unavailable', params: { language } } }
      const read = await this.files.readLocale(entry.id, entry.manifest.entry).catch(ioFailed)
      return read.ok ? { ok: true, messages: read.messages, version: entry.manifest.version } : read
    })
  }

  /** 켜기/끄기 — settings.extensions 에 저장(기본 켜짐이라 false 만 남긴다)하고 곧바로 올리거나 내린다 */
  setEnabled(id: string, on: boolean): Promise<ExtensionResult> {
    return this.enqueue(async (): Promise<ExtensionResult> => {
      if (!this.entries.some((entry) => entry.id === id)) return { ok: false, failure: { code: 'not-installed', params: { id } } }
      try {
        const { [id]: _previous, ...others } = this.ctx.settings.get().extensions ?? {}
        if (this.enabled(id) !== on) this.ctx.settings.set({ extensions: on ? others : { ...others, [id]: false } })
      } catch (error) {
        return ioFailed(error)
      }
      await this.sync()
      return { ok: true }
    })
  }

  /** 확장 ↔ 앱 통로 (이슈 #536) — id 는 화면이 iframe 출처로 정한 것. 켜진 정상 확장만, 메서드마다 manifest 권한을 본다. 던지지 않는다.
   *  owner 는 요청한 창(IPC event.sender) — 고르기 창을 거기 붙인다 (#538) */
  async call(id: string, method: string, params: unknown, project?: CallProject, owner?: unknown): Promise<ExtensionCallResult> {
    await this.booted
    const manifest = this.onManifest(id)
    if (!manifest) return fail('not-on')
    const permission = METHODS.get(method)
    if (permission === undefined) return fail('method-unknown')
    if (permission !== null && !manifest.permissions?.includes(permission)) return fail('permission-missing')
    try {
      switch (method) {
        case 'storage.get':
        case 'storage.set':
        case 'storage.delete':
          return await this.storage(id, method, params)
        case 'secrets.get':
        case 'secrets.set':
        case 'secrets.delete':
          return await this.secrets(id, method, params)
        case 'network.fetch':
          return await this.fetch(id, params)
        case 'project.pickPath':
          return await this.pickPath(id, params, project, owner)
        case 'project.changedFiles':
          return await this.changedFiles(project)
        case 'server.status':
        case 'server.start':
        case 'server.stop':
        case 'server.setOptions':
          return await this.server(id, manifest, method, params)
        default:
          return await this.project(method, params, project)
      }
    } catch (error) {
      console.warn(`[extensions] ${id} ${method} 실패`, error)
      return fail('io-failed')
    }
  }

  /** 동의 띠의 [허용] — 그 확장의 허용 목록에 origin 을 넣는다. network 권한이 있는 켜진 확장만 */
  async allowOrigin(id: string, origin: string): Promise<ExtensionCallResult> {
    await this.booted
    const manifest = this.onManifest(id)
    if (!manifest) return fail('not-on')
    if (!manifest.permissions?.includes('network')) return fail('permission-missing')
    if (!isOrigin(origin)) return fail('url-invalid')
    if (this.reserved(new URL(origin))) return fail('address-reserved')
    return this.withData(async () => {
      if (!this.onManifest(id)) return fail('not-on')
      const list = this.origins.get(id) ?? []
      if (!list.includes(origin)) await this.saveOrigins(id, [...list, origin])
      return done()
    })
  }

  /** 카드 상세의 [거두기] — 꺼진 확장도 거둘 수 있다 */
  async revokeOrigin(id: string, origin: string): Promise<ExtensionResult> {
    await this.booted
    if (!this.entries.some((entry) => entry.id === id)) return { ok: false, failure: { code: 'not-installed', params: { id } } }
    return this.withData(async (): Promise<ExtensionResult> => {
      try {
        const list = this.origins.get(id) ?? []
        if (list.includes(origin)) await this.saveOrigins(id, list.filter((item) => item !== origin))
        return { ok: true }
      } catch (error) {
        return ioFailed(error)
      }
    })
  }

  /** 밀린 일이 다 끝날 때까지 (테스트용) */
  async idle(): Promise<void> {
    await this.booted
    await this.queue
  }

  // --- 줄 ---

  /** 일을 줄 끝에 세운다. 일은 던지지 않게 짠다 — 던져도 줄은 이어진다 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    this.queue = run.catch((error: unknown) => console.error('[extensions] 처리 실패', error))
    return run
  }

  /** 자료 파일 일을 자기 줄 끝에 세운다 */
  private withData<T>(task: () => Promise<T>): Promise<T> {
    const run = this.dataQueue.then(task)
    this.dataQueue = run.catch(() => {})
    return run
  }

  private async boot(): Promise<void> {
    await this.applyNow()
    await this.read()
  }

  /** 보류 작업을 적용하고 삭제된 id 의 켜짐 값을 지운다 (부팅·설치·삭제). id 를 주면 그 확장의 적용 실패를 apply-failed 로 돌려준다 */
  private async applyNow(id?: string): Promise<{ ok: false; failure: ExtensionStoreFailure } | undefined> {
    try {
      const { removed, failed } = await this.files.applyPending()
      for (const removedId of removed) {
        this.forget(removedId)
        await this.dropData(removedId)
      }
      const reason = failed.find((item) => item.id === id)?.reason
      return reason === undefined ? undefined : { ok: false, failure: { code: 'apply-failed', params: { message: reason } } }
    } catch (error) {
      console.warn('[extensions] 보류 작업 적용 실패', error)
      return id === undefined ? undefined : { ok: false, failure: { code: 'apply-failed', params: { message: error instanceof Error ? error.message : String(error) } } }
    }
  }

  /** 파일 쪽 사실을 다시 읽는다 */
  private async read(): Promise<void> {
    try {
      this.entries = await this.files.read()
    } catch (error) {
      console.warn('[extensions] 목록을 읽지 못했다', error)
    }
    const origins = new Map<string, string[]>()
    for (const { id } of this.entries) {
      const list = await this.data.read(id, 'origins').catch(() => undefined)
      if (Array.isArray(list)) origins.set(id, list.filter(isOrigin))
    }
    this.origins = origins
  }

  /** 다시 읽고 올리기·내리기를 맞춘다 */
  private async refresh(): Promise<void> {
    await this.read()
    await this.sync()
  }

  /** 켜진(그리고 깨지지 않은) 확장은 올리고, 아닌 것은 내린다. mount 가 없으면 상태만 맞춘다 */
  private async sync(): Promise<void> {
    const mount = this.options.mount
    for (const id of new Set([...this.fibers.keys(), ...this.entries.map((entry) => entry.id), ...this.failures.keys()])) {
      const entry = this.entries.find((item) => item.id === id)
      const wanted = !!mount && !!entry?.manifest && entry.problems.length === 0 && this.enabled(id)
      const fiber = this.fibers.get(id)
      if (wanted && !fiber && !this.failures.has(id)) {
        await this.mountOne(mount, { manifest: entry.manifest!, dir: this.files.installedDir(id) })
      } else if (!wanted) {
        this.failures.delete(id)
        if (fiber) {
          this.fibers.delete(id)
          await fiber.dispose().catch((error: unknown) => console.error(`[extensions] ${id} 내리기 실패`, error))
        }
      }
    }
    await this.syncServers()
    await this.followLanguage()
    this.publish()
  }

  /** 고른 언어가 팩 언어면 그 팩의 사전을 메인 문구에 넣고, 그런 팩이 없거나(지움·꺼짐·깨짐) 읽지 못하면 기본 언어로 되돌린다 (이슈 #525).
   *  publish 보다 먼저 한다 — 화면은 extensions:changed 를 받으면 설정을 다시 읽는다. 언어를 되돌리면 settings/changed 로 sync 가 한 번 더 돈다(내장 언어라 여기서 멈춘다) */
  private async followLanguage(): Promise<void> {
    const language = this.ctx.settings.get().language
    if (isBuiltinLanguage(language)) {
      setMainLocalePack(undefined)
      return
    }
    const entry = this.localeEntry(language)
    const read = entry?.manifest ? await this.files.readLocale(entry.id, entry.manifest.entry).catch(ioFailed) : undefined
    if (read?.ok) {
      setMainLocalePack({ language, messages: read.messages })
      return
    }
    setMainLocalePack(undefined)
    console.warn(`[extensions] 언어 ${language} 의 팩을 쓸 수 없어 기본 언어로 돌아간다${read ? ` (${read.failure.code})` : ''}`)
    try {
      this.ctx.settings.set({ language: DEFAULT_LANGUAGE })
    } catch (error) {
      console.warn('[extensions] 언어를 되돌리지 못했다', error)
    }
  }

  /** 그 언어의 켜진 정상(on) 언어 팩 — id 순 첫 팩 */
  private localeEntry(language: string): Entry | undefined {
    return this.entries.find(
      (entry) => entry.manifest?.type === 'locale' && entry.manifest.locale?.language === language && this.state(entry, this.enabled(entry.id)).state === 'on',
    )
  }

  private async mountOne(mount: NonNullable<ExtensionsOptions['mount']>, extension: MountedExtension): Promise<void> {
    const id = extension.manifest.id
    this.mounting.add(id)
    this.publish()
    try {
      const fiber = this.ctx.plugin(mount(extension))
      this.fibers.set(id, fiber)
      await fiber
    } catch (error) {
      console.error(`[extensions] ${id} 올리기 실패`, error)
      this.failures.set(id, failureReason(error))
    } finally {
      this.mounting.delete(id)
    }
  }

  // --- 통로 (이슈 #536) ---

  /** 켜진 정상(on) 확장의 manifest — 아니면 undefined */
  private onManifest(id: string): ExtensionManifest | undefined {
    const entry = this.entries.find((item) => item.id === id)
    return entry?.manifest && this.state(entry, this.enabled(id)).state === 'on' ? entry.manifest : undefined
  }

  private async storage(id: string, method: string, params: unknown): Promise<ExtensionCallResult> {
    const key = keyOf(params)
    if (key === undefined) return fail('params-invalid')
    // 자기 키만 읽는다 — 'constructor' 같은 상속 키는 함수가 나와 IPC 복제가 깨진다 (QA #536)
    if (method === 'storage.get') return done(ownValue(await this.values(id, 'storage'), key) ?? null)
    const value = (params as { value?: unknown }).value
    if (method === 'storage.set' && value === undefined) return fail('params-invalid')
    return this.withData(async () => {
      if (!this.onManifest(id)) return fail('not-on')
      const { [key]: _old, ...others } = await this.values(id, 'storage')
      const next = method === 'storage.set' ? { ...others, [key]: value } : others
      if (JSON.stringify(next).length > EXTENSION_LIMITS.storageBytes) return fail('storage-full')
      await this.data.write(id, 'storage', next)
      return done()
    })
  }

  private async secrets(id: string, method: string, params: unknown): Promise<ExtensionCallResult> {
    const key = keyOf(params)
    if (key === undefined) return fail('params-invalid')
    const value = (params as { value?: unknown }).value
    if (method === 'secrets.set' && typeof value !== 'string') return fail('params-invalid')
    const cipher = this.options.cipher
    if (!cipher?.available()) return fail('secrets-unavailable')
    if (method === 'secrets.get') {
      const sealed = ownValue(await this.values(id, 'secrets'), key)
      return done(typeof sealed === 'string' ? cipher.decrypt(Buffer.from(sealed, 'base64')) : null)
    }
    return this.withData(async () => {
      if (!this.onManifest(id)) return fail('not-on')
      const { [key]: _old, ...others } = await this.values(id, 'secrets')
      const next = method === 'secrets.set' ? { ...others, [key]: cipher.encrypt(value as string).toString('base64') } : others
      if (JSON.stringify(next).length > EXTENSION_LIMITS.secretsBytes) return fail('storage-full')
      await this.data.write(id, 'secrets', next)
      return done()
    })
  }

  private async fetch(id: string, params: unknown): Promise<ExtensionCallResult> {
    const parsed = parseFetchRequest(params)
    if (!parsed.ok) return parsed
    const origin = parsed.request.url.origin
    // 리다이렉트는 같은 origin 만 따라가므로 처음 주소만 보면 된다
    if (this.reserved(parsed.request.url)) return fail('address-reserved')
    const server = this.onManifest(id)?.server
    if (server && origin === `http://127.0.0.1:${server.port}`) {
      // 자기 내장 서버 (이슈 #537) — 앱이 띄운 127.0.0.1 서버라 묻지 않는다. 인증은 앱이 붙인다: 패널이 준 authorization 은 버리고 관리자 토큰을
      const headers = Object.fromEntries(Object.entries(parsed.request.headers).filter(([name]) => name.toLowerCase() !== 'authorization'))
      const token = this.servers.token(id)
      parsed.request.headers = token === undefined ? headers : { ...headers, authorization: `Bearer ${token}` }
    } else if (!this.origins.get(id)?.includes(origin)) return { ok: false, error: 'consent-required', origin }
    return fetchForExtension(parsed.request, {
      fetch: this.options.fetch?.(id) ?? globalThis.fetch,
      timeoutMs: EXTENSION_LIMITS.fetchTimeoutMs,
      maxBytes: EXTENSION_LIMITS.fetchBytes,
      maxRedirects: EXTENSION_LIMITS.fetchRedirects,
    })
  }

  private reserved(url: URL): boolean {
    return isAppAddress(url, this.options.reservedPorts?.() ?? [], selfAddresses())
  }

  /** project.* — info 는 이름만(경로는 주지 않는다: 확장에 필요 없고 홈 폴더·사용자 이름이 드러난다). 파일 경로는 프로젝트 기준 상대 경로만 */
  private async project(method: string, params: unknown, project: CallProject | undefined): Promise<ExtensionCallResult> {
    if (!project) return fail('no-project')
    if (method === 'project.info') return done({ name: project.name })
    const { path: relPath, line } = (typeof params === 'object' && params !== null ? params : {}) as { path?: unknown; line?: unknown }
    if (typeof relPath !== 'string' || relPath === '') return fail('params-invalid')
    if (!isEntryPath(relPath)) return fail('path-unsafe')
    if (method === 'project.openFile') {
      // 여는 것은 화면이 오른쪽 패널의 파일 미리보기로 한다 — 그 길이 등록된 프로젝트 안만 읽는다
      if (line !== undefined && !(Number.isInteger(line) && (line as number) >= 1)) return fail('params-invalid')
      return done({ path: relPath, ...(line !== undefined && { line }) })
    }
    const read = await readInsideFile(project.directory, relPath, EXTENSION_LIMITS.projectFileBytes)
    if (!read.ok) return fail(read.failure.code === 'entry-unsafe' ? 'path-unsafe' : read.failure.code === 'entry-too-large' ? 'file-too-large' : 'file-unreadable')
    try {
      return done(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes))
    } catch {
      return fail('not-text')
    }
  }

  /** project.pickPath (이슈 #538) — 파일·폴더 고르기 창. 결과는 프로젝트 기준 상대 경로(밖은 빼고 outside 개수), 취소면 canceled.
   *  같은 확장이 창을 띄운 동안 또 부르면 busy (창이 겹쳐 쌓이지 않게) */
  private async pickPath(id: string, params: unknown, project: CallProject | undefined, owner: unknown): Promise<ExtensionCallResult> {
    const multiple = typeof params === 'object' && params !== null ? (params as { multiple?: unknown }).multiple : undefined
    if (multiple !== undefined && typeof multiple !== 'boolean') return fail('params-invalid')
    if (!project) return fail('no-project')
    if (!this.options.pickPaths) return fail('io-failed')
    if (this.picking.has(id)) return fail('busy')
    if (Date.now() < (this.pickCancels.get(id)?.blockedUntil ?? 0)) return fail('pick-blocked')
    this.picking.add(id)
    try {
      const chosen = await this.options.pickPaths(owner, { directory: project.directory, multiple: multiple ?? false })
      if (!chosen) {
        this.noteCancel(id)
        return done({ paths: [], canceled: true })
      }
      this.pickCancels.delete(id)
      return done(await projectRelativePaths(project.directory, chosen))
    } finally {
      this.picking.delete(id)
    }
  }

  /** 취소 하나를 적는다 — 앞 취소에서 pickCancelWindowMs 안이면 pickBlockMs 동안 막는다 (QA 03_qa_538) */
  private noteCancel(id: string): void {
    const now = Date.now()
    const previous = this.pickCancels.get(id)
    const repeated = previous !== undefined && now - previous.canceledAt <= EXTENSION_LIMITS.pickCancelWindowMs
    this.pickCancels.set(id, { canceledAt: now, blockedUntil: repeated ? now + EXTENSION_LIMITS.pickBlockMs : 0 })
  }

  /** project.changedFiles (이슈 #538) — 기준 브랜치 대비 내 변경. git 기능(ctx.git)이 꺼져 있어도 돈다 (extensions/changes.ts) */
  private async changedFiles(project: CallProject | undefined): Promise<ExtensionCallResult> {
    if (!project) return fail('no-project')
    const changed = await changedFiles(this.options.git ?? 'git', project.directory)
    return changed.ok ? done({ base: changed.base, files: changed.files }) : changed
  }

  // --- 내장 서버 (이슈 #537) ---

  /** server.* — status: 상태 · start: 띄우기 시작(기다리지 않는다 — 1분 남짓, 패널이 status 로 본다) · stop: 내림이 끝날 때까지 · setOptions: 앱 쪽 설정 */
  private async server(id: string, manifest: ExtensionManifest, method: string, params: unknown): Promise<ExtensionCallResult> {
    const server = manifest.server
    if (!server) return fail('permission-missing') // manifest 검사가 server 권한과 선언을 같이만 통과시킨다 — 여기 오지 않는다
    if (method === 'server.start') this.servers.start(id, server, this.files.installedDir(id))
    else if (method === 'server.stop') await this.servers.stop(id)
    else if (method === 'server.setOptions') {
      const patch = serverOptionsPatch(params)
      if (!patch) return fail('params-invalid')
      const { [id]: previous, ...others } = this.ctx.settings.get().extensionServers ?? {}
      this.ctx.settings.set({ extensionServers: { ...others, [id]: { ...previous, ...patch } } })
    }
    return done(this.servers.status(id, server, this.serverOptions(id)))
  }

  private serverOptions(id: string): ExtensionServerOptions {
    const stored = this.ctx.settings.get().extensionServers
    return { ...DEFAULT_SERVER_OPTIONS, ...(stored && Object.hasOwn(stored, id) ? stored[id] : {}) }
  }

  /** 켜진 정상 서버 확장이 아니면 내리고(지난 실행이 남긴 것도 거둔다), 이번 실행에서 처음 보는 것이면:
   *  startWithApp 이면 띄운다(남은 서버는 다시 잡는다) · 지난 서버가 살아 남았고 stopWithApp 을 껐으면 다시 잡는다 · 그 밖에는 남은 것을 거둔다.
   *  기록이 남았다는 것만으로 새로 띄우지 않는다 — 정상 종료는 앱이 먼저 꺼져 기록이 남는다 (QA 03_qa_537 차단) */
  private async syncServers(): Promise<void> {
    for (const entry of this.entries) {
      const server = entry.manifest?.server
      if (!server) continue
      const dir = this.files.installedDir(entry.id)
      if (this.state(entry, this.enabled(entry.id)).state !== 'on') {
        await this.servers.stop(entry.id)
        await this.servers.reap(entry.id, dir)
        continue
      }
      if (this.autoStarted.has(entry.id)) continue
      this.autoStarted.add(entry.id)
      const options = this.serverOptions(entry.id)
      if (options.startWithApp || (!options.stopWithApp && this.servers.leftoverAlive(entry.id, dir))) this.servers.start(entry.id, server, dir)
      else await this.servers.reap(entry.id, dir)
    }
  }

  /** storage·secrets 파일의 값 — 없거나 모양이 틀리면 빈 객체 */
  private async values(id: string, kind: 'storage' | 'secrets'): Promise<Record<string, unknown>> {
    const value = await this.data.read(id, kind)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  }

  private async saveOrigins(id: string, list: string[]): Promise<void> {
    await this.data.write(id, 'origins', list)
    this.origins.set(id, list)
    this.publish()
  }

  /** 지워진 확장의 자료(storage·secrets·허용 목록)를 지운다 — 쓰는 중인 값이 있으면 그 뒤에 */
  private async dropData(id: string): Promise<void> {
    await this.withData(async () => {
      this.origins.delete(id)
      await this.data.remove(id).catch((error: unknown) => console.warn(`[extensions] ${id} 의 자료를 지우지 못했다`, error))
    })
  }

  // --- 목록 ---

  /** 자기 키만 읽는다 — id `constructor` 는 id 규칙을 통과하는데, 일반 객체에서 읽으면 상속된 Object 함수가 나온다 (QA 03_qa_ext_pr3) */
  private enabled(id: string): boolean {
    const switches = this.ctx.settings.get().extensions
    return switches && Object.hasOwn(switches, id) ? switches[id]! : true
  }

  private summaries(): ExtensionSummary[] {
    return this.entries.map((entry) => {
      const enabled = this.enabled(entry.id)
      const { manifest } = entry
      return {
        id: entry.id,
        ...(manifest && { name: manifest.name, description: manifest.description, version: manifest.version }),
        ...(manifest?.details !== undefined && { details: manifest.details }),
        ...(manifest?.type === 'locale' && manifest.locale && { type: 'locale' as const, locale: { language: manifest.locale.language, label: manifest.locale.label } }),
        enabled,
        ...this.state(entry, enabled),
        ...(this.origins.get(entry.id)?.length && { origins: this.origins.get(entry.id) }),
        ...(manifest?.server && { server: this.servers.status(entry.id, manifest.server, this.serverOptions(entry.id)) }),
      }
    })
  }

  private state(entry: Entry, enabled: boolean): Pick<ExtensionSummary, 'state' | 'reason'> {
    if (entry.problems.length > 0) return failed({ code: 'invalid', params: { problems: entry.problems } })
    if (!enabled) return { state: 'off' }
    const failure = this.failures.get(entry.id)
    if (failure !== undefined) return failed({ code: 'mount-failed', params: { message: failure } })
    return { state: this.mounting.has(entry.id) ? 'mounting' : 'on' }
  }

  private publish(): void {
    const list = this.summaries()
    const key = JSON.stringify(list)
    if (key === this.published) return
    this.published = key
    // cordis emit 은 리스너 예외를 여기로 던진다 — 알림(창으로 보내기) 실패가 줄의 일과 요청 결과로 번지지 않게 로그만 (console 은 로그 파일이 비밀을 가린다)
    try {
      this.ctx.emit('extensions/changed', list)
    } catch (error) {
      console.error('[extensions] 바뀜 알림 실패', error)
    }
  }

  /** 지워진 확장의 켜짐 값을 지운다 — 못 지워도(설정 파일을 못 읽는 등) 남는 것은 쓰이지 않는 값 하나다 */
  private forget(id: string): void {
    const switches = this.ctx.settings.get().extensions
    if (!switches || !Object.hasOwn(switches, id)) return
    const { [id]: _removed, ...others } = switches
    try {
      this.ctx.settings.set({ extensions: others })
    } catch (error) {
      console.warn(`[extensions] ${id} 의 켜짐 값을 지우지 못했다`, error)
    }
  }
}

/** server.setOptions 의 params — startWithApp·stopWithApp 중 하나 이상, boolean 만 */
function serverOptionsPatch(params: unknown): Partial<ExtensionServerOptions> | undefined {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return undefined
  const entries = Object.entries(params)
  if (entries.length === 0 || !entries.every(([key, value]) => (key === 'startWithApp' || key === 'stopWithApp') && typeof value === 'boolean')) return undefined
  return Object.fromEntries(entries) as Partial<ExtensionServerOptions>
}

/** storage·secrets 의 키 — 비지 않은 글 */
function keyOf(params: unknown): string | undefined {
  const key = typeof params === 'object' && params !== null ? (params as { key?: unknown }).key : undefined
  return typeof key === 'string' && key !== '' ? key : undefined
}

/** 허용 목록에 넣을 수 있는 origin — http/https 의 `scheme://host[:port]` 그대로(경로·끝 / 없음) */
function isOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value
  } catch {
    return false
  }
}

function failed(reason: ExtensionFailedReason): Pick<ExtensionSummary, 'state' | 'reason'> {
  return { state: 'failed', reason }
}

function ioFailed(error: unknown): { ok: false; failure: ExtensionStoreFailure } {
  return { ok: false, failure: { code: 'io-failed', params: { message: error instanceof Error ? error.message : String(error) } } }
}

/** 저장소(2/4, 보안 점검 중 — 공개 함수 이름·반환 모양이 바뀔 수 있다)와 닿는 곳은 여기 하나다. 서비스는 이 모양만 안다 */
function storeAccess(root: string, appVersion: string) {
  const store = new ExtensionStore(root)
  return {
    stage: async (zip: string) => {
      const { token, result, existing } = await store.stage(zip, appVersion)
      return { ...result, ...(token && { token }), ...(existing && { existing }) }
    },
    install: (token: string): Promise<ExtensionInstallResult> => store.install(token, appVersion),
    cancel: (token: string) => store.cancel(token),
    remove: (id: string): Promise<ExtensionResult> => store.remove(id),
    /** 보류 적용 — 삭제가 적용된 id 와 적용하지 못한 작업(저장소가 로그로도 남긴다) */
    applyPending: async () => {
      const { applied, failed } = await store.applyPending()
      return { removed: applied.flatMap((op) => (op.op === 'remove' ? [op.id] : [])), failed }
    },
    readEntry: (id: string, entry: string) => store.readEntry(id, entry),
    readLocale: (id: string, entry: string) => store.readLocale(id, entry),
    /** 설치된 것 (id 순 — 저장소가 정렬한다). 보류는 설치·삭제 호출 안에서 곧바로 적용되므로 목록에 없다 (이슈 #511) */
    read: async (): Promise<Entry[]> =>
      (await store.listInstalled(appVersion)).map(({ id, manifest, problems }) => ({ id, ...(manifest && { manifest }), problems })),
    installedDir: (id: string) => path.join(path.resolve(root), 'installed', id),
  }
}

function ownValue(values: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(values, key) ? values[key] : undefined
}
