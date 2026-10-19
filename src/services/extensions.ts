import { Context, Service, type Fiber } from 'cordis'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  ExtensionFailedReason,
  ExtensionInstallResult,
  ExtensionManifest,
  ExtensionPickResult,
  ExtensionProblem,
  ExtensionResult,
  ExtensionStoreFailure,
  ExtensionSummary,
} from '../../shared/extensions.ts'
import { checkManifest, MANIFEST_FILE } from './extensions/manifest.ts'
import { ExtensionStore } from './extensions/store.ts'
import { failureReason } from './features.ts'
import './settings.ts'

// 설치한 확장 (ctx.extensions, 이슈 #482 — 설계 docs/superpowers/specs/2026-10-19-extension-install-design.md 5절). 바탕 서비스다(끌 수 없다).
// 부팅: (1) 보류 작업 적용 (2) installed/ 를 읽어 manifest 재검증 (3) 켜진 확장마다 올림. 생성자는 던지지 않는다(CLAUDE.md 함정 4) —
// 폴더 하나가 깨져도 그 확장만 failed 로 남고 앱은 뜬다. 삭제는 폴더 이름이 id 형식일 때만 된다 — 손으로 만든 다른 이름의 깨진 폴더는
// 목록에 failed 로 보이지만 앱에서 지울 수 없다(후속, QA 03_qa_ext_pr3 경고 3).
// 켜짐 값은 settings.extensions (기본 켜짐 — false 만 남긴다). 켜고 끄기는 곧바로 올리고 내린다(설치·업데이트·삭제만 재시작).
// 올리기는 주입된 mount(B 층 자리 — features 의 definitions 와 같은 패턴)로 한다. mount 가 없으면(A 층 단독) 아무것도 실행하지 않고 상태만 on.
// 부팅·설치·삭제·켜고 끄기는 한 줄(큐)로 선다 — features.ts 처럼, 끄자마자 켜도 앞의 올리기가 끝난 뒤 내린다.
// 대화상자는 host(pick), 파일 작업은 저장소(ExtensionStore — 2/4). 저장소 호출은 아래 `files` 한 곳에만 모았다(저장소의 공개 모양이 바뀌면 거기만 고친다).
// Electron 을 import 하지 않는다 — 단위 테스트가 임시 폴더 root 로 돈다.

declare module 'cordis' {
  interface Context {
    extensions: ExtensionsService
  }
  interface Events {
    /** 확장 목록(ExtensionSummary[])이 바뀌었다 — 설치·삭제 예약·켜기/끄기·상태. 같은 값이면 다시 내지 않는다 */
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
}

/** 한 확장의 파일 쪽 사실 — 설치 폴더(installed)와 보류 설치 폴더 중 읽은 것 */
interface Entry {
  id: string
  installed: boolean
  manifest?: ExtensionManifest
  problems: ExtensionProblem[]
  pending?: 'install' | 'remove'
}

export class ExtensionsService extends Service {
  static readonly inject = ['settings']

  private readonly files: ReturnType<typeof storeAccess>
  private entries: Entry[] = []
  private queue: Promise<unknown> = Promise.resolve()
  private readonly booted: Promise<void>
  private fibers = new Map<string, Fiber>()
  /** 올리는 중인 확장 */
  private mounting = new Set<string>()
  /** mount 가 던진 사유 — 끄면 지운다 */
  private failures = new Map<string, string>()
  private published = ''

  constructor(
    ctx: Context,
    private options: ExtensionsOptions,
  ) {
    super(ctx, 'extensions')
    this.files = storeAccess(options.root, options.appVersion)
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

  /** 확인 카드의 [설치] — 보류 설치로 쌓는다 (다음 부팅에 적용) */
  install(token: string): Promise<ExtensionInstallResult> {
    return this.enqueue(async () => {
      const result = await this.files.install(token).catch(ioFailed)
      if (result.ok) await this.refresh()
      return result
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

  /** 삭제 예약 (다음 부팅에 적용). 보류 설치만 있던 확장은 보류가 취소돼 곧바로 목록에서 빠진다 — 그때는 켜짐 값도 지금 지운다 */
  remove(id: string): Promise<ExtensionResult> {
    return this.enqueue(async () => {
      const wasInstalled = this.entries.find((entry) => entry.id === id)?.installed
      const result = await this.files.remove(id).catch(ioFailed)
      if (!result.ok) return result
      if (!wasInstalled) this.forget(id)
      await this.refresh()
      return result
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

  private async boot(): Promise<void> {
    try {
      const { removed } = await this.files.applyPending()
      for (const id of removed) this.forget(id)
    } catch (error) {
      console.warn('[extensions] 보류 작업 적용 실패', error)
    }
    await this.read()
  }

  /** 파일 쪽 사실을 다시 읽는다 */
  private async read(): Promise<void> {
    try {
      this.entries = await this.files.read()
    } catch (error) {
      console.warn('[extensions] 목록을 읽지 못했다', error)
    }
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
      const wanted = !!mount && !!entry?.installed && !!entry.manifest && entry.problems.length === 0 && this.enabled(id)
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
    this.publish()
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

  // --- 목록 ---

  /** 자기 키만 읽는다 — id `constructor` 는 id 규칙을 통과하는데, 일반 객체에서 읽으면 상속된 Object 함수가 나온다 (QA 03_qa_ext_pr3) */
  private enabled(id: string): boolean {
    const switches = this.ctx.settings.get().extensions
    return switches && Object.hasOwn(switches, id) ? switches[id]! : true
  }

  private summaries(): ExtensionSummary[] {
    return this.entries.map((entry) => {
      const enabled = this.enabled(entry.id)
      const { manifest, pending } = entry
      return {
        id: entry.id,
        ...(manifest && { name: manifest.name, description: manifest.description, version: manifest.version }),
        enabled,
        ...this.state(entry, enabled),
        ...(pending && { pending }),
      }
    })
  }

  private state(entry: Entry, enabled: boolean): Pick<ExtensionSummary, 'state' | 'reason'> {
    if (entry.installed && entry.problems.length > 0) return failed({ code: 'invalid', params: { problems: entry.problems } })
    if (!entry.installed || !enabled) return { state: 'off' }
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
    /** 보류 적용 — 삭제가 적용된 id 를 돌려준다. 실패한 보류는 로그로만 (저장소가 남긴다) */
    applyPending: async () => {
      const { applied } = await store.applyPending()
      return { removed: applied.flatMap((op) => (op.op === 'remove' ? [op.id] : [])) }
    },
    /** 설치된 것 + 보류 설치만 있는 것 (id 순) */
    read: async (): Promise<Entry[]> => {
      const pending = store.pendingState()
      const installed = await store.listInstalled(appVersion)
      const entries: Entry[] = installed.map(({ id, manifest, problems }) => ({ id, installed: true, ...(manifest && { manifest }), problems, ...(Object.hasOwn(pending, id) && { pending: pending[id] }) }))
      for (const [id, op] of Object.entries(pending)) {
        if (op !== 'install' || installed.some((item) => item.id === id)) continue
        entries.push({ id, installed: false, ...(await pendingManifest(root, id, appVersion)), problems: [], pending: 'install' })
      }
      return entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    },
    installedDir: (id: string) => path.join(path.resolve(root), 'installed', id),
  }
}

/** 보류 설치 폴더의 extension.json — 저장소가 읽는 함수를 내놓지 않아 자리(pending/install/<id>)를 여기서 안다. 못 읽으면 manifest 없이 */
async function pendingManifest(root: string, id: string, appVersion: string): Promise<{ manifest?: ExtensionManifest }> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(path.join(path.resolve(root), 'pending', 'install', id, MANIFEST_FILE), 'utf8'))
    const { manifest } = checkManifest(value, appVersion)
    return manifest ? { manifest } : {}
  } catch {
    return {}
  }
}
