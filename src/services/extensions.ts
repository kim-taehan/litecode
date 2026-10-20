import { Context, Service, type Fiber } from 'cordis'
import path from 'node:path'
import type {
  ExtensionEntryResult,
  ExtensionFailedReason,
  ExtensionInstallResult,
  ExtensionManifest,
  ExtensionPickResult,
  ExtensionProblem,
  ExtensionResult,
  ExtensionStoreFailure,
  ExtensionSummary,
} from '../../shared/extensions.ts'
import { isExtensionId } from './extensions/manifest.ts'
import { ExtensionStore } from './extensions/store.ts'
import { failureReason } from './features.ts'
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
}

/** 한 확장의 파일 쪽 사실 — 설치 폴더(installed/<id>)에서 읽은 것 */
interface Entry {
  id: string
  manifest?: ExtensionManifest
  problems: ExtensionProblem[]
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

  /** 확인 카드의 [설치] — 보류 설치로 쌓고 곧바로 적용한다 (이슈 #511). 적용이 실패하면 apply-failed (이전 버전이 그대로) */
  install(token: string): Promise<ExtensionInstallResult> {
    return this.enqueue(async () => {
      const result = await this.files.install(token).catch(ioFailed)
      if (!result.ok) return result
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
    await this.applyNow()
    await this.read()
  }

  /** 보류 작업을 적용하고 삭제된 id 의 켜짐 값을 지운다 (부팅·설치·삭제). id 를 주면 그 확장의 적용 실패를 apply-failed 로 돌려준다 */
  private async applyNow(id?: string): Promise<{ ok: false; failure: ExtensionStoreFailure } | undefined> {
    try {
      const { removed, failed } = await this.files.applyPending()
      for (const removedId of removed) this.forget(removedId)
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
      const { manifest } = entry
      return {
        id: entry.id,
        ...(manifest && { name: manifest.name, description: manifest.description, version: manifest.version }),
        ...(manifest?.details !== undefined && { details: manifest.details }),
        enabled,
        ...this.state(entry, enabled),
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
    /** 설치된 것 (id 순 — 저장소가 정렬한다). 보류는 설치·삭제 호출 안에서 곧바로 적용되므로 목록에 없다 (이슈 #511) */
    read: async (): Promise<Entry[]> =>
      (await store.listInstalled(appVersion)).map(({ id, manifest, problems }) => ({ id, ...(manifest && { manifest }), problems })),
    installedDir: (id: string) => path.join(path.resolve(root), 'installed', id),
  }
}
