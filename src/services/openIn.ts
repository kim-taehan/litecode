import { Context, Service } from 'cordis'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { tr } from '../i18n.ts'

// "다른 앱에서 열기" — 지금 대화의 프로젝트 폴더를 설치된 앱(편집기·Git GUI·터미널)에서 연다 (사용자 결정 2026-10-02, _workspace/01m_open_in.md).
// 첫 버전은 mac 만. 앱 목록은 정해 둔 허용 목록이고(dsh open-in-app 의 mac 항목과 같은 범위), 그중 /Applications·~/Applications 에
// 실제로 있는 것만 보인다. OS 앱 전체를 나열하지 않는 이유: 그 앱이 폴더를 받는지 OS 가 알려 주지 않는다.
// 보안: 화면은 {앱 id, 폴더} 만 보낸다. 번들 경로·인자는 이 표에서 오고, 폴더는 ctx.projects 에 등록된 realpath 와 정확히 같아야 한다 —
// 화면이 오염돼도 사용자가 연 폴더를 허용 목록 앱으로 여는 것 말고는 못 한다. 실행은 셸을 거치지 않는다(host 가 execFile).
// Electron 을 모른다: 아이콘·실행은 host(electron/openInHost.ts)가 한다 — 실물 테스트는 실행을 기록기로 바꾼다(사용자 화면에 앱을 띄우지 않게).

declare module 'cordis' {
  interface Context {
    openIn: OpenInService
  }
}

/** 메뉴 순서 = 파일 관리자 → 편집기·IDE → Git GUI → 터미널. bundles 는 흔한 설치 이름 — 첫 번째로 있는 것 하나 */
const CATALOG: readonly { id: string; name: string; bundles?: readonly string[]; fixed?: 'finder' | 'terminal' }[] = [
  { id: 'finder', name: 'Finder', fixed: 'finder' },
  { id: 'cursor', name: 'Cursor', bundles: ['Cursor.app'] },
  { id: 'vscode', name: 'VS Code', bundles: ['Visual Studio Code.app'] },
  { id: 'vscodeinsiders', name: 'VS Code Insiders', bundles: ['Visual Studio Code - Insiders.app'] },
  { id: 'windsurf', name: 'Windsurf', bundles: ['Windsurf.app'] },
  { id: 'zed', name: 'Zed', bundles: ['Zed.app', 'Zed Preview.app'] },
  { id: 'sublimetext', name: 'Sublime Text', bundles: ['Sublime Text.app'] },
  { id: 'xcode', name: 'Xcode', bundles: ['Xcode.app'] },
  { id: 'androidstudio', name: 'Android Studio', bundles: ['Android Studio.app'] },
  { id: 'intellij', name: 'IntelliJ IDEA', bundles: ['IntelliJ IDEA.app', 'IntelliJ IDEA Ultimate.app', 'IntelliJ IDEA CE.app'] },
  { id: 'pycharm', name: 'PyCharm', bundles: ['PyCharm.app', 'PyCharm Professional.app', 'PyCharm CE.app', 'PyCharm Community.app'] },
  { id: 'webstorm', name: 'WebStorm', bundles: ['WebStorm.app'] },
  { id: 'phpstorm', name: 'PhpStorm', bundles: ['PhpStorm.app'] },
  { id: 'goland', name: 'GoLand', bundles: ['GoLand.app'] },
  { id: 'rider', name: 'Rider', bundles: ['Rider.app', 'JetBrains Rider.app'] },
  { id: 'rustrover', name: 'RustRover', bundles: ['RustRover.app'] },
  { id: 'fork', name: 'Fork', bundles: ['Fork.app'] },
  { id: 'sourcetree', name: 'Sourcetree', bundles: ['Sourcetree.app'] },
  { id: 'github', name: 'GitHub Desktop', bundles: ['GitHub Desktop.app'] },
  { id: 'tower', name: 'Tower', bundles: ['Tower.app'] },
  { id: 'gitkraken', name: 'GitKraken', bundles: ['GitKraken.app'] },
  { id: 'smartgit', name: 'SmartGit', bundles: ['SmartGit.app'] },
  { id: 'sublimemerge', name: 'Sublime Merge', bundles: ['Sublime Merge.app'] },
  { id: 'ghostty', name: 'Ghostty', bundles: ['Ghostty.app'] },
  { id: 'warp', name: 'Warp', bundles: ['Warp.app'] },
  { id: 'iterm', name: 'iTerm2', bundles: ['iTerm.app'] },
  { id: 'kitty', name: 'kitty', bundles: ['kitty.app'] },
  { id: 'terminal', name: 'Terminal', fixed: 'terminal' },
]

export interface DetectOptions {
  /** 앱을 찾을 폴더 — 기본 /Applications, ~/Applications */
  roots?: string[]
  /** OS 고정 앱의 번들 경로 */
  fixed?: { finder: string; terminal: string }
}

export interface DetectedApp {
  id: string
  name: string
  /** .app 절대 경로 — 아이콘과 `open -a` 에 쓴다 */
  bundle: string
}

/** 화면에 주는 것 — 번들 경로는 주지 않는다 */
export interface OpenInApp {
  id: string
  name: string
  /** data:image/png, 못 구하면 null (화면은 ↗) */
  icon: string | null
}

/** host 가 할 일 — open-a: `open` 에 이 인자 그대로(셸 없음), os-open: OS 기본 열기(Finder) */
export type Launch = { kind: 'open-a'; args: string[] } | { kind: 'os-open'; path: string }

export interface OpenInHost {
  icon(bundle: string): Promise<string | null>
  /** 실패면 throw */
  launch(what: Launch): Promise<void>
}

export interface OpenInOptions extends DetectOptions {
  host: OpenInHost
  /** 기본 process.platform — 단위 테스트가 mac 밖을 흉내 낸다 */
  platform?: NodeJS.Platform
}

const DEFAULT_FIXED ={ finder: '/System/Library/CoreServices/Finder.app', terminal: '/System/Applications/Utilities/Terminal.app' }

/** 허용 목록 중 지금 있는 것 (목록 순서). 디스크 조회만 — 앱을 실행하지 않는다 */
export function detectApps(options: DetectOptions = {}): DetectedApp[] {
  const roots = options.roots ?? ['/Applications', path.join(os.homedir(), 'Applications')]
  const fixed = options.fixed ?? DEFAULT_FIXED
  const found: DetectedApp[] = []
  for (const entry of CATALOG) {
    const candidates = entry.fixed ? [fixed[entry.fixed]] : entry.bundles!.flatMap((name) => roots.map((root) => path.join(root, name)))
    const bundle = candidates.find((candidate) => fs.existsSync(candidate))
    if (bundle) found.push({ id: entry.id, name: entry.name, bundle })
  }
  return found
}

export class OpenInService extends Service {
  static readonly inject = ['projects']

  /** 첫 apps() 때 한 번 찾는다 — 새로 깐 앱은 재시작 뒤에, 실행이 실패하면 다음에 다시 찾는다 */
  private detected?: Promise<(DetectedApp & { icon: string | null })[]>

  constructor(
    ctx: Context,
    private opts: OpenInOptions,
  ) {
    super(ctx, 'openIn')
  }

  async apps(): Promise<OpenInApp[]> {
    return (await this.load()).map(({ id, name, icon }) => ({ id, name, icon }))
  }

  /** 등록된 프로젝트 폴더를 탐지된 앱으로 연다. 그 밖은 실행기를 부르지 않고 거절한다 */
  async open(appId: string, directory: string): Promise<void> {
    const target = (await this.load()).find((entry) => entry.id === appId)
    if (typeof appId !== 'string' || !target) throw new Error(tr('openIn.unknownApp'))
    // 등록된 realpath 와 정확히 같아야 한다 — 상대 경로·`..`·옵션처럼 보이는 값은 여기서 걸린다
    const registered = typeof directory === 'string' && (await this.ctx.projects.list()).some((project) => project.path === directory)
    if (!registered || !path.isAbsolute(directory)) throw new Error(tr('openIn.notProject'))
    if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) throw new Error(tr('error.notFolder', { dir: directory }))
    const what: Launch = target.id === 'finder' ? { kind: 'os-open', path: directory } : { kind: 'open-a', args: ['-a', target.bundle, directory] }
    try {
      await this.opts.host.launch(what)
    } catch (error) {
      this.detected = undefined // 지운 앱이면 다음 목록에서 빠진다
      throw new Error(tr('openIn.failed', { app: target.name, message: error instanceof Error ? error.message : String(error) }))
    }
  }

  private load(): Promise<(DetectedApp & { icon: string | null })[]> {
    if ((this.opts.platform ?? process.platform) !== 'darwin') return Promise.resolve([])
    this.detected ??= Promise.all(
      detectApps(this.opts).map(async (entry) => ({ ...entry, icon: await this.opts.host.icon(entry.bundle).catch(() => null) })),
    )
    return this.detected
  }
}
