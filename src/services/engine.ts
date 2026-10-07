import { Context, Service } from 'cordis'
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { mergePath } from './loginPath.ts'
import { findOpencodeBinary, notFoundMessage } from './opencodeBinary.ts'
import { startKeyProxy, type KeyProxy } from './keyProxy.ts'
import { keepTail, streamText } from './outputBuffer.ts'
import { engineConfig, engineMcpConfig, hiddenEnvNames, isGated, toolGate, withBrowserRules, type EngineGate, type EngineMcp, type EngineSkills } from './engineConfig.ts'
import { tr } from '../i18n.ts'
import { removeAppPluginDirs } from './enginePlugins.ts'
import './providers.ts'
import type {} from './features.ts' // ctx.features·'features/changed' 타입
import type {} from './settings.ts' // ctx.settings·'settings/changed' 타입

// 앱이 띄우는 opencode 서버 하나의 수명 (ctx.engine). ctx.llm 은 이 서비스에서 주소·인증을 받아 쓰고, 그 밖의 누구도
// opencode 를 모른다. 프로젝트마다 띄우지 않는다 — 세션마다 location.directory 로 폴더를 가른다 (01_probe Q1).
//
// 설정 전달은 실측(2026-09-30, opencode 1.18.18, _workspace/01_probe.md)을 따른다:
// - (이력 — 실측은 신규 세대 /api/session/* 로 했다. 채팅은 지금 레거시 경로다) 신규 세대가 읽는 설정은 `OPENCODE_CONFIG_DIR` 폴더(있으면 전역 폴더를 대신한다) + 세션 폴더의 opencode.json 뿐이다.
//   OPENCODE_CONFIG_CONTENT·OPENCODE_CONFIG 는 턴이 prompted 에서 멈춘다 → 앱 전용 폴더에 opencode.json 을 생성한다
// - **진짜 키는 opencode 프로세스에 두지 않는다** (파일에도 env 에도). opencode 는 자기 env 를 프로젝트 플러그인·bash 도구에 넘긴다
//   (03_qa 재현, --pure 로 못 막음). provider baseURL 은 메인 프로세스의 키 프록시(keyProxy.ts) 주소, apiKey 는 프록시 토큰이다
// - 레거시 GET /provider·/config/providers 가 설정의 키(이제 토큰)를 돌려준다 → 실행마다 난수 OPENCODE_SERVER_PASSWORD 를 건다
//   (Basic opencode:<pw>). **남는 한계:** 이 비밀번호는 opencode env 에 있어 플러그인·bash 가 읽는다 — 그걸로 얻는 건 토큰과
//   이 opencode 의 세션 조작이지 진짜 키가 아니다
// - 설정은 재시작해야 적용된다. 재시작·크래시 때 진행 중 턴은 끝 이벤트 없이 사라진다 → connection().closed 로 알린다
// - XDG_CONFIG_HOME 은 안 바꾼다 — opencode 가 띄우는 bash·git 이 물려받는다. 세션 저장소만 OPENCODE_DB 로 뗀다
//
// 부모가 kill -9 로 죽어도 opencode 는 산다 (closed-code pidStore 실측) → 띄운 PID 를 파일에 적고 다음 실행에서 거둔다.
// 끌 때는 우리가 띄운 자식만 끈다 — 사용자가 띄운 opencode 가 같은 기계에 있다.

// 규칙 표·opencode.json 생성은 engineConfig.ts (#183) — 바깥 import 경로를 지키려고 여기서 다시 내보낸다
export { ENGINE_AGENTS, engineConfig, hiddenEnvNames, isGated, MODE_AGENT, SUBAGENT_ASK, toolGate, withBrowserRules, type EngineMcp } from './engineConfig.ts'

declare module 'cordis' {
  interface Context {
    engine: EngineService
  }
}

/** ctx.llm 이 opencode 에 닿는 데 필요한 전부 */
export interface EngineConnection {
  url: string
  /** 모든 요청에 싣는다 (Basic 인증) */
  headers: Record<string, string>
  /** 이 서버가 끝나면(재시작·크래시·종료) abort 된다 — opencode 는 끊긴 턴의 끝 이벤트를 주지 않는다 */
  closed: AbortSignal
  /** opencode.json 에 그 provider 의 baseURL 로 적은 주소(키 프록시). 카탈로그의 api.url 이 이것과 다르면 폴더 설정이 덮은 것 */
  providerBaseURL(providerId: string): string
  /** 앱이 붙이는 MCP 서버의 opencode 설정 — 로컬 서버의 자식 env 에서 이 서버의 비밀(서버 비밀번호 등)을 빈 값으로 덮는다 (engineMcpConfig) */
  mcpConfig(def: EngineMcp): Record<string, unknown>
  /** 이 서버의 설정에 그 권한 이름의 도구 실행 전 게이트(ask 규칙)를 얹었나 (toolGate) — 얹지 않은 권한의 승인 요청은 모드나 사용자 설정이 원래 묻는 것이다 */
  gated(permission: string): boolean
}

export interface EngineOptions {
  /** OPENCODE_CONFIG_DIR — 앱이 opencode.json 과 npm 설치 표식(package.json·package-lock.json·빈 node_modules)을 생성한다 */
  configDir: string
  /** OPENCODE_DB — 사용자 CLI opencode 의 세션 기록과 가른다 */
  db: string
  /** 띄운 PID 기록 — 앱이 곱게 못 끝났을 때 다음 실행이 거둔다 */
  pidFile: string
  /** 자식에 물려줄 환경 (기본 process.env) */
  env?: NodeJS.ProcessEnv
  /** 설치본에 실린 opencode·rg (opencodeBinary.ts bundledPaths). 개발 실행에는 없다 */
  bundled?: { opencode: string; rgDir: string }
  /** 프로젝트 opencode 설정을 막는다 (OPENCODE_DISABLE_PROJECT_CONFIG, engineEnv 참고). 기본 꺼짐 — L1(레거시 보내기 + AGENTS.md 주입)과 같이 켠다 */
  blockProjectConfig?: boolean
  /** 로그인 셸의 PATH 를 읽는 함수(loginPath.ts) — 앱 실행마다 한 번 읽어 자식 PATH 앞에 합친다 (#84). 테스트는 안 준다 */
  loginPath?: () => Promise<string | undefined>
}

interface RunningServer extends EngineConnection {
  pid: number
  stop(): Promise<void>
}

interface ServerRecord {
  pid: number
  /** spawn 에 넘긴 명령줄 그대로 (`<bin> serve --hostname 127.0.0.1 --port <p> --pure`) */
  command: string
  /** `ps -o lstart=` — 같은 PID 를 나중에 물려받은 프로세스와 가른다 */
  started?: string
  url: string
}

const PURGE_TIMEOUT_MS = 30_000
// 지운 대화 본문을 DB 파일에서 걷어낸다 (2026-10-01 실측, _workspace/01_probe.md). DELETE 뒤에도 본문은 WAL 에, 체크포인트 뒤에는
// main 의 빈 페이지에 남는다(secure_delete 기본값) — TRUNCATE 체크포인트 → VACUUM → 다시 TRUNCATE 해야 세 파일 모두 0 이 된다.
// sqlite 는 opencode 실행 파일을 BUN_BE_BUN=1 로 띄워 bun 의 bun:sqlite 로 연다 — Electron 33(Node 20)엔 node:sqlite 가 없고 의존성을
// 늘리지 않으려고. **문서화 안 된 bun 동작에 기댄다** (opencode 1.18.18 = bun 1.3.14 에서 확인). 버전이 바뀌어 안 먹으면 정리는 로그만
// 남기고 넘어가고, 실물 테스트(DB 파일에 표식 0건)가 깨진다. opencode 가 떠 있어도 됐다 — 다만 잠금을 opencode busy_timeout(5초) 넘게
// 쥐면 그동안의 opencode 쓰기가 실패하므로, 답을 기다리는 턴이 없을 때만 부른다(ctx.llm). busy_timeout 은 우리가 기다리는 쪽이다
const PURGE_SCRIPT = [
  'const { Database } = require("bun:sqlite")',
  'const db = new Database(process.env.LITECODE_PURGE_DB)',
  'db.run("PRAGMA busy_timeout=2000")',
  'const before = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get()',
  'db.run("VACUUM")',
  'const after = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get()',
  'db.close()',
  'console.log(JSON.stringify({ busy: before.busy || after.busy }))',
].join(';')

const READY_TIMEOUT_MS = 60_000 // 주소를 잡은 뒤에도 /doc 이 수십 초 무응답인 때가 있다 (live-test 스킬 기록)
const KILL_GRACE_MS = 5_000
const MAX_OUTPUT = 4_000
/** `--version` 기한 */
const VERSION_TIMEOUT_MS = 10_000

/** 이 프로세스가 띄워 아직 살아 있는 opencode 자식 — 앱 종료 기한이 지나면 서비스 상태와 무관하게 죽일 수 있게 쥔다 */
const liveChildren = new Set<ChildProcess>()

/** 살아 있는 opencode 자식을 바로 죽인다(SIGKILL). 앱 종료의 마지막 수단 — 서비스 정리(stop: SIGTERM → KILL_GRACE_MS → SIGKILL)가
 *  기한 안에 못 끝났을 때 메인이 부른다. GUI 앱에는 자식을 데려갈 터미널이 없어 남기면 유령이 된다 */
export function killEngineProcesses(): void {
  for (const child of liveChildren) {
    try {
      child.kill('SIGKILL')
    } catch {
      // 그 사이 끝났다
    }
  }
}

// npm 설치 막기 (01w 4절, 사용자 결정 00_next_legacy 3). opencode 는 설정 폴더(앱 CONFIG_DIR·사용자 $XDG_CONFIG_HOME/opencode·
// ~/.opencode·프로젝트 .opencode) 중 쓰기 가능한 곳마다 @opencode-ai/plugin 을 백그라운드 npm 설치한다 — 끄는 플래그는 없다.
// node_modules/ 가 있고 package.json 의 의존성(+플러그인)이 package-lock.json packages[""] 에 다 있으면 건너뛴다(코드 Npm.install,
// 표식만으로 레지스트리 요청 0 — 1/1). 우리는 사용자 플러그인이 없어 본체는 필요 없다. 프로젝트 .opencode 는 blockProjectConfig 를 켜야 빠진다
const PLUGIN_PACKAGE = '@opencode-ai/plugin'
const PLUGIN_VERSION = '1.18.18' // 동봉 opencode 버전 (scripts/fetch-opencode.mjs)

/** 표식을 둘 폴더. create=false 면 이미 있을 때만 (opencode 도 없는 ~/.opencode 는 안 본다 — 01w "있다면") */
export function installMarkerDirs(configDir: string, env: NodeJS.ProcessEnv): { dir: string; create: boolean }[] {
  const home = env['HOME']?.trim() || os.homedir()
  const xdgConfig = env['XDG_CONFIG_HOME']?.trim() || path.join(home, '.config')
  return [
    { dir: configDir, create: true },
    // opencode 가 기동 때 스스로 만드는 전역 설정 폴더다 — 우리가 먼저 만들어도 같다
    { dir: path.join(xdgConfig, 'opencode'), create: true },
    { dir: path.join(home, '.opencode'), create: false },
  ]
}

/** 없는 표식만 만든다 — 있는 것은 내용이 달라도 안 덮고, 폴더의 다른 파일은 안 본다. 잠금 파일은 package.json 이 플러그인만
 *  가질 때만 둔다(다른 의존성이 있으면 사용자 것이라 맞지 않는 잠금을 지어내지 않는다 — 그 폴더는 설치가 시도된다) */
export function plantInstallMarkers(dir: string): void {
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
  const pkgFile = path.join(dir, 'package.json')
  writeIfMissing(pkgFile, { dependencies: { [PLUGIN_PACKAGE]: PLUGIN_VERSION } })
  let deps: Record<string, string>
  try {
    deps = (JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as { dependencies?: Record<string, string> }).dependencies ?? {}
  } catch {
    return // 망가진 package.json — 사용자 것이다
  }
  if (Object.keys(deps).some((name) => name !== PLUGIN_PACKAGE)) return
  writeIfMissing(path.join(dir, 'package-lock.json'), {
    lockfileVersion: 3,
    packages: { '': { dependencies: { [PLUGIN_PACKAGE]: deps[PLUGIN_PACKAGE] ?? PLUGIN_VERSION } } },
  })
}

function writeIfMissing(file: string, value: unknown): void {
  try {
    fs.writeFileSync(file, JSON.stringify(value), { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/** 기동 전에 표식을 둔다. 못 쓰는 폴더는 넘어간다 — opencode 도 쓰기 불가 폴더엔 설치하지 않는다 */
function prepareInstallMarkers(configDir: string, env: NodeJS.ProcessEnv): void {
  for (const { dir, create } of installMarkerDirs(configDir, env)) {
    try {
      if (create) fs.mkdirSync(dir, { recursive: true })
      else if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue
      plantInstallMarkers(dir)
    } catch (error) {
      console.warn('[engine] 설치 표식을 못 뒀다', dir, (error as Error).message)
    }
  }
}

/** 자식에 물려주지 않는 env 이름 — 앱이 정한 OPENCODE_* 는 engineEnv 가 다시 넣는다 (01x 2-8 "망·외부 켜기"·"설정 주입") */
const INHERITED_ENGINE_ENV = /^(OPENCODE_|OTEL_|EXA_API_KEY$|PARALLEL_API_KEY$)/i
/** 사용자 셸의 비밀 — opencode 의 bash 도구가 `env` 로 그대로 본다 (이슈 #178, 02x B 4-9, 사용자 결정 "처리해 줘"). 이름 패턴으로 뺀다.
 *  AUTH 는 AUTHOR 를 뺀다 — GIT_AUTHOR_NAME·EMAIL 은 비밀이 아니고 모델의 git 커밋에 쓰인다. 한계는 docs/status.md engine 줄 */
const SECRET_ENGINE_ENV = /^(AWS_|AZURE_|GITHUB_|GITLAB_|GOOGLE_APPLICATION_CREDENTIALS$|NPM_TOKEN$|SSH_AUTH_SOCK$)|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|PRIVATE_KEY|AUTH(?!OR)/i

/** opencode 자식에 물려주지 않는 env 이름인가 (대소문자 무시) */
export function withheldEngineEnv(name: string): boolean {
  return INHERITED_ENGINE_ENV.test(name) || SECRET_ENGINE_ENV.test(name)
}

const LOOPBACK_NO_PROXY = ['127.0.0.1', 'localhost']

/** opencode 자식 프로세스 env — 진짜 키는 없다 (키 프록시) */
export function engineEnv(
  base: NodeJS.ProcessEnv,
  opts: { configDir: string; db: string; password: string; rgDir?: string; blockProjectConfig?: boolean },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    // 물려받은 opencode 설정 env 는 버린다 (01x 7, 이슈 #19) — OPENCODE_EXPERIMENTAL 하나로 레거시에 exa 검색·lsp 도구가 생기고, OTEL_* 는
    // trace 를 내보내고, OPENCODE_CONFIG_CONTENT 등은 앱 설정을 흔든다. 개발 셸에만 OPENCODE_DISABLE_* 가 있어 개발·테스트와 Finder 실행본이
    // 달랐다 — 앱이 아래에 정한 것만 남긴다. OPENCODE_SERVER_USERNAME 도 여기서 빠진다(Basic 사용자명은 기본값 opencode 로 고정)
    ...Object.fromEntries(Object.entries(base).filter(([name]) => !withheldEngineEnv(name))),
    OPENCODE_CONFIG_DIR: opts.configDir,
    OPENCODE_DB: opts.db,
    OPENCODE_SERVER_PASSWORD: opts.password,
    // models.opencode.ai 카탈로그 받기를 끈다 — 폐쇄망에서 나가는 시도 6번이 사라지고 카탈로그·턴은 그대로 된다 (01b_offline 실측 2/2)
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    // 아래 셋은 생성한 opencode.json 의 share·autoupdate·lsp 와 겹친다 — 설정이 덮이거나 무시돼도 꺼지게 (01x 2-8). LSP_DOWNLOAD 는
    // typescript 서버를 못 막는다(코드에 검사 없음) — 그래서 lsp:false 가 본체다
    OPENCODE_DISABLE_SHARE: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    // Claude Code 자료를 묻지 않고 싣지 않는다 (사용자 결정 2026-10-02: "Claude Code 스킬 함께 쓰기" 기본 꺼짐, 켜는 스위치는 #7).
    // 레거시는 ~/.claude/CLAUDE.md·~/.claude/skills·~/.agents/skills 와 프로젝트 CLAUDE.md·.claude/skills 를 싣는다 — 두 플래그로 다섯 다 빠진다.
    // 신규 세대는 원래 다섯 다 안 싣는다(프로젝트 AGENTS.md 만) — 그래서 지금 동작은 그대로다 (#19 실측 2026-10-02, 1.18.18 각 1)
    OPENCODE_DISABLE_CLAUDE_CODE: '1', // CLAUDE.md(전역·프로젝트) + .claude/skills
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', // .claude·.agents 스킬 탐색 전부 (설정의 skills.paths 는 그대로 읽힌다 — 코드상)
  }
  if (opts.blockProjectConfig) {
    // **레거시가** 프로젝트 opencode.json·.opencode/ 를 안 읽는다 (신규 세대 런타임은 이 플래그를 안 본다 — 프로젝트 설정을 읽고 그 플러그인 파일을
    // 실행한다. 먹는 스위치가 없어 ctx.llm 이 그런 폴더를 걸러 낸다: enginePlugins.ts, 01ah #101). 레거시는 그 안의 MCP 를 묻지 않고 띄우고 .opencode 에 npm 설치를 한다 (01w 3-1,
    // 사용자 결정 00_next_legacy 2). 대가로 프로젝트 AGENTS.md/CLAUDE.md 도 안 읽힌다 — 신규 세대 경로에서도 그렇다(trajectory.live 의
    // AGENTS.md 줄이 깨진다, 2026-10-02). 그래서 ctx.llm 이 AGENTS.md 를 prompt system 으로 넣는 L1 과 같이 켠다
    env['OPENCODE_DISABLE_PROJECT_CONFIG'] = '1'
  }
  // 프록시 변수(HTTP_PROXY·http_proxy)가 있으면 opencode 는 앱의 키 프록시·내장 MCP 서버(127.0.0.1)로 가는 요청도 그 프록시로 보낸다
  // (실측 2026-10-05, 1.18.18 — NO_PROXY·no_proxy 어느 쪽이든 루프백이 있으면 직접 간다, #75). 있던 값 뒤에 루프백을 덧붙인다.
  // Windows 는 이름의 대소문자가 다를 수 있다 — 있던 키를 지우고 둘로 다시 넣는다
  const noProxyKeys = Object.keys(env).filter((name) => name.toUpperCase() === 'NO_PROXY')
  const noProxy = noProxyKeys.flatMap((name) => (env[name] ?? '').split(',')).map((host) => host.trim())
  for (const name of noProxyKeys) delete env[name]
  env['NO_PROXY'] = env['no_proxy'] = [...new Set([...noProxy, ...LOOPBACK_NO_PROXY])].filter(Boolean).join(',')
  if (opts.rgDir) {
    // grep·glob 도구는 rg 를 PATH 에서 찾고, 없으면 github 에서 받으려 한다 — 폐쇄망에선 실패하거나 ~300초 멈춘다 (01b_offline 실측).
    // 동봉 rg 를 맨 앞에 둔다. Windows 는 이름이 Path 일 수 있다 — 있는 키에 붙여야 PATH 가 둘이 되지 않는다
    const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
    env[key] = [opts.rgDir, ...(env[key] ? [env[key]] : [])].join(path.delimiter)
  }
  return env
}

export class EngineService extends Service {
  static readonly inject = ['providers']

  private current?: Promise<RunningServer>
  /** 이전 서버가 다 꺼져야 다음 서버를 띄운다 — 같은 DB·설정 폴더를 두 프로세스가 쥐지 않게 */
  private stopping: Promise<void> = Promise.resolve()
  private disposed = false
  /** 엔진과 수명을 같이 한다 (토큰은 앱 실행마다 바뀐다) */
  private proxy?: Promise<KeyProxy>
  /** DB 정리는 한 번에 하나만 */
  private purging: Promise<void> = Promise.resolve()
  /** 떠 있는(띄우는 중인) 서버의 opencode.json 에 넣은 웹 도구 켜짐(설정 > 기능 web, 기본 꺼짐)·스킬 설정·게이트 (JSON — 바뀌었는지만 본다).
   *  **띄우는 중인 서버가 아직 설정을 읽기 전이면 없다** — 그 사이에 바뀐 값은 그 기동이 읽으므로 다시 띄울 일이 아니다. 지난 서버의 값과 비교하면
   *  앱 시작 때 뜨는 중에 도착한 게이트(ctx.hooks)가 "달라졌다" 로 보여 엔진이 두 번 떴다 (이슈 #126) */
  private launched?: string
  /** 도구 실행 전 판정을 받을 도구의 매처 (setGate) — 다음 기동이 읽는다 */
  private gateMatchers: readonly string[] = []
  /** 지금(또는 마지막으로 띄운) 서버 출력의 끝 — 문제 신고 묶음(ctx.report)이 싣는다 */
  private lastOutput?: { text(): string }
  /** 엔진 버전 — 한 번만 묻는다 */
  private versionRead?: Promise<string | undefined>

  constructor(
    ctx: Context,
    private opts: EngineOptions,
  ) {
    super(ctx, 'engine')
    reapStale(opts.pidFile)
    // 재시작이 실패해도 다음 대화가 다시 띄워 본다 — 다만 조용히 묻히지 않게 사유는 남긴다(키는 안 싣는다: 오류는 프로세스·포트 사유뿐)
    ctx.on('providers/changed', () => void this.restart().catch((error: unknown) => console.error('[engine] 설정 변경 후 재시작 실패', (error as Error).message)))
    // 웹 도구 켜기/끄기 (이슈 #14) — 설정은 재시작해야 먹는다. 떠 있는 서버와 값이 다르면 다시 띄운다(진행 중 턴은 중단됨).
    // 안 떠 있으면 다음 기동이 읽는다(launch). features 는 inject 하지 않는다 — 기능 레지스트리 없이 띄운 엔진(서비스 실물 테스트)은 꺼짐으로 돈다
    ctx.on('features/changed', () => {
      // 훅 기능(이슈 #102)을 끄면 도구 실행 전 게이트도 걷는다 — 판정할 쪽이 없는데 묻기만 하게 두지 않는다
      if (!this.outdated()) return
      void this.restart().catch((error: unknown) => console.error('[engine] 웹 도구·스킬·훅 변경 후 재시작 실패', (error as Error).message))
    })
    // 스킬 (이슈 #7) — 설정 > 기능의 스킬(위 features/changed)과 "Claude Code 스킬 함께 쓰기"(settings) 도 같은 길로 다시 띄운다
    ctx.on('settings/changed', () => {
      if (!this.outdated()) return
      void this.restart().catch((error: unknown) => console.error('[engine] 스킬 설정 변경 후 재시작 실패', (error as Error).message))
    })
    ctx.effect(() => () => this.stop())
  }

  /** 지금 설정의 스킬 — 기능 레지스트리·설정 없이 띄운 엔진(서비스 실물 테스트)은 켬·Claude 꺼짐 */
  private skills(): EngineSkills {
    return { enabled: this.ctx.get('features')?.isEnabled('skills') ?? true, claude: this.ctx.get('settings')?.get().claudeSkills ?? false }
  }

  /** 앱 CONFIG_DIR — ctx.llm 이 엔진이 실행할 플러그인 파일을 찾을 때 이 폴더도 본다 (enginePlugins.ts, #101) */
  get configDir(): string {
    return this.opts.configDir
  }

  /** 도구 실행 전 판정을 받을 도구를 정한다 (이슈 #102 — toolGate). 매처는 도구 이름의 `|` 나열·정규식, 빈 글자는 전부. 떠 있는 서버의 게이트와
   *  **실제로 달라졌을 때만** 다시 띄운다(진행 중 턴은 끊긴다 — 부르는 쪽 ctx.llm 이 도는 턴이 없을 때 부른다). 안 떠 있으면 다음 기동이 읽는다 */
  setGate(matchers: readonly string[]): void {
    this.gateMatchers = [...matchers]
    if (!this.outdated()) return
    void this.restart().catch((error: unknown) => console.error('[engine] 도구 실행 전 게이트 변경 후 재시작 실패', (error as Error).message))
  }

  /** 지금 걸 게이트 — 훅 기능이 꺼져 있으면 없다 (기능 레지스트리 없이 띄운 엔진은 받은 매처 그대로) */
  private gate(): EngineGate {
    return toolGate(this.ctx.get('features')?.isEnabled('hooks') === false ? [] : this.gateMatchers)
  }

  /** 지금 설정으로 띄우면 opencode.json 에 들어갈 웹 도구·스킬·게이트 */
  private wanted(): { webTools: boolean; skills: EngineSkills; gate: EngineGate } {
    return { webTools: this.ctx.get('features')?.isEnabled('web') ?? false, skills: this.skills(), gate: this.gate() }
  }

  /** 떠 있는(띄우는 중인) 서버가 읽은 설정이 지금 설정과 다른가 — 다시 띄워야 한다. 안 떠 있거나 아직 읽기 전이면 아니다 (다음·그 기동이 읽는다) */
  private outdated(): boolean {
    return !!this.current && this.launched !== undefined && JSON.stringify(this.wanted()) !== this.launched
  }

  /** 엔진 버전 — `<bin> --version` 의 첫 줄 (실측 2026-10-07, 1.18.18: `1.18.18` 한 줄). 서버와 같은 격리 env 로 돌린다. 못 읽으면 undefined.
   *  문제 신고 묶음(ctx.report)이 싣는다 */
  version(): Promise<string | undefined> {
    this.versionRead ??= (async () => {
      const base = await this.baseEnv()
      const bin = findOpencodeBinary(base, undefined, this.opts.bundled?.opencode).path
      if (!bin) return undefined
      const env = engineEnv(base, { configDir: this.opts.configDir, db: this.opts.db, password: '', rgDir: this.opts.bundled?.rgDir, blockProjectConfig: this.opts.blockProjectConfig })
      return new Promise<string | undefined>((resolve) =>
        execFile(bin, ['--version'], { env, timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (error, out) => resolve(error ? undefined : out.trim().split('\n')[0] || undefined)),
      )
    })()
    return this.versionRead
  }

  /** 지금(또는 마지막으로 띄운) 서버의 stdout·stderr 끝 (MAX_OUTPUT 자) — 띄운 적이 없으면 빈 글. **가리지 않은 원문이다** — 싣는 쪽(ctx.report)이 가린다 */
  outputTail(): string {
    return this.lastOutput?.text() ?? ''
  }

  /** 떠 있나(띄우는 중 포함) — 묻기만 하고 띄우지 않는다. 엔진과 같이 사라지는 것(붙인 MCP)을 치우려고 죽은 엔진을 다시 띄우지 않게 (#126) */
  get up(): boolean {
    return !!this.current
  }

  /** 떠 있는 서버의 연결. 없거나 죽었으면 띄운다 (동시에 불러도 한 번만) */
  connection(): Promise<EngineConnection> {
    if (this.disposed) return Promise.reject(new Error(tr('error.appQuitting')))
    if (!this.current) {
      this.launched = undefined
      // 물러난 기동(restart 로 밀려난 것)이 뒤늦게 읽은 값은 적지 않는다 — 지금 띄우는 서버의 값이 아니다
      const launching: Promise<RunningServer> = this.stopping.then(() =>
        this.launch(
          () => this.forget(launching),
          (read) => void (this.current === launching && (this.launched = read)),
        ),
      )
      launching.catch(() => this.forget(launching))
      this.current = launching
    }
    return this.current
  }

  /** 설정을 다시 써서 띄운다. 진행 중 턴은 끊긴다 (connection().closed) */
  restart(): Promise<EngineConnection> {
    this.retire()
    return this.connection()
  }

  /** 끄고 다시 띄우지 않는다 — 앱 종료 */
  async stop(): Promise<void> {
    this.disposed = true
    this.retire()
    await this.stopping
    await (await this.proxy?.catch(() => undefined))?.close()
  }

  /** 지운 대화 본문을 DB 파일에서 걷어낸다 (위 PURGE_SCRIPT). 실패·busy 면 로그만 남기고 다음 기회로 — 대화 기능을 막지 않는다.
   *  띄우기 직전에도 스스로 부른다(크래시로 놓친 정리까지). 떠 있을 때는 답을 기다리는 턴이 없을 때만 부를 것 (ctx.llm.purgeDeleted) */
  purgeDeleted(): Promise<void> {
    const base = this.opts.env ?? process.env
    const bin = findOpencodeBinary(base, undefined, this.opts.bundled?.opencode).path
    if (!bin) return Promise.resolve()
    this.purging = this.purging.then(() => purgeDb(bin, this.opts.db, base))
    return this.purging
  }

  private retire(): void {
    const old = this.current
    this.current = undefined
    const previous = this.stopping
    this.stopping = (async () => {
      await previous
      const server = await old?.catch(() => undefined)
      await server?.stop()
    })()
  }

  private forget(server: Promise<RunningServer>): void {
    if (this.current === server) this.current = undefined
  }

  private loginPath?: Promise<string | undefined>

  /** 자식 env 의 바탕 — Finder 로 띄운 앱의 짧은 PATH 에 로그인 셸의 PATH 를 합친다 (#84). 한 번만 읽고, 못 읽으면 물려받은 PATH 그대로 */
  private async baseEnv(): Promise<NodeJS.ProcessEnv> {
    const base = this.opts.env ?? process.env
    if (!this.opts.loginPath) return base
    const login = await (this.loginPath ??= this.opts.loginPath().catch(() => undefined))
    if (!login) return base
    const key = Object.keys(base).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
    return { ...base, [key]: mergePath(login, base[key]) }
  }

  private async launch(onExit: () => void, onRead: (config: string) => void): Promise<RunningServer> {
    const base = await this.baseEnv()
    const lookup = findOpencodeBinary(base, undefined, this.opts.bundled?.opencode)
    if (!lookup.path) throw new Error(notFoundMessage(lookup))
    const bin = lookup.path

    // 저장된 설정을 요청마다 본다 — 키는 이 메인 프로세스에서만 풀린다
    this.proxy ??= startKeyProxy((id) => {
      const provider = this.ctx.providers.get(id)
      return provider && { baseURL: provider.baseURL, apiKey: this.ctx.providers.apiKey(id) }
    })
    const proxy = await this.proxy
    await this.purgeDeleted() // 다른 연결이 없을 때 — 지난 실행이 정리 전에 끝났어도 여기서 걷힌다
    const password = randomBytes(24).toString('base64url')
    const port = await freePort()
    const env = engineEnv(base, {
      configDir: this.opts.configDir,
      db: this.opts.db,
      password,
      rgDir: this.opts.bundled?.rgDir,
      blockProjectConfig: this.opts.blockProjectConfig,
    })

    fs.mkdirSync(this.opts.configDir, { recursive: true })
    removeAppPluginDirs(this.opts.configDir) // 여기 놓인 파일은 모든 프로젝트에서 엔진 안에 실린다 (#101, enginePlugins.ts)
    const wanted = this.wanted()
    const { gate } = wanted
    onRead(JSON.stringify(wanted)) // 읽자마자 적는다 (사이에 await 없음) — 이 뒤에 바뀐 값은 다시 띄워야 먹는다
    const config = withBrowserRules(engineConfig(this.ctx.providers.all(), proxy, { childEnv: env, ...wanted }), gate.mcp)
    fs.writeFileSync(path.join(this.opts.configDir, 'opencode.json'), JSON.stringify(config, null, 2))
    prepareInstallMarkers(this.opts.configDir, env)

    const args = ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--pure']
    const child = spawn(bin, args, {
      cwd: path.dirname(this.opts.configDir),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    liveChildren.add(child)
    // 끝 MAX_OUTPUT 자를 쥔다 — 기동 실패 사유는 출력의 끝에 있다 (앞만 쥐면 시작 로그에 밀려 잘린다, 참고 레포 검토 02x D).
    // 읽는 곳은 아래 기동 실패 문구와 문제 신고 묶음(outputTail)이다. 조각 경계의 한글이 깨지지 않게 스트림마다 디코더
    const output = keepTail(MAX_OUTPUT)
    this.lastOutput = output
    for (const stream of [child.stdout, child.stderr]) {
      const decoded = streamText()
      stream?.on('data', (part: Buffer) => output.push(decoded.push(part)))
    }
    const closer = new AbortController()
    const exited = new Promise<void>((resolve) =>
      child.once('exit', (code, signal) => {
        liveChildren.delete(child)
        closer.abort(new Error(tr('error.opencodeExited', { code: String(code), signal: String(signal) })))
        forgetRecord(this.opts.pidFile, child.pid)
        onExit()
        resolve()
      }),
    )
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', (error) => {
        liveChildren.delete(child) // 못 띄웠다 — exit 은 오지 않는다
        reject(new Error(tr('error.opencodeSpawn', { bin, message: error.message })))
      })
    })

    const url = `http://127.0.0.1:${port}`
    writeRecord(this.opts.pidFile, { pid: child.pid!, command: [bin, ...args].join(' '), started: observe(child.pid!).started, url })
    const stop = async (): Promise<void> => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
      await exited
      clearTimeout(timer)
    }

    const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` }
    try {
      await waitUntilReady(url, headers, closer.signal)
    } catch (error) {
      await stop()
      throw new Error(`${(error as Error).message}\n${output.text().trim()}`.trimEnd())
    }
    const hidden = hiddenEnvNames(env)
    return { url, headers, closed: closer.signal, providerBaseURL: (id) => proxy.baseURLFor(id), mcpConfig: (def) => engineMcpConfig(def, hidden), gated: (permission) => isGated(gate, permission), pid: child.pid!, stop }
  }
}

async function purgeDb(bin: string, db: string, base: NodeJS.ProcessEnv): Promise<void> {
  if (!fs.existsSync(db)) return // 열면 빈 DB 를 만든다
  try {
    const stdout = await new Promise<string>((resolve, reject) =>
      execFile(bin, ['-e', PURGE_SCRIPT], { env: { ...base, BUN_BE_BUN: '1', LITECODE_PURGE_DB: db }, timeout: PURGE_TIMEOUT_MS, windowsHide: true }, (error, out) =>
        error ? reject(error) : resolve(out),
      ),
    )
    if ((JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as { busy?: number }).busy) console.warn('[engine] DB 정리: 잠겨 있어 일부 못 했다 — 다음 기회에')
  } catch (error) {
    console.error('[engine] DB 정리 실패 — 다음 기회에', (error as Error).message)
  }
}

async function waitUntilReady(url: string, headers: Record<string, string>, closed: AbortSignal): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let last = ''
  while (Date.now() < deadline) {
    if (closed.aborted) throw new Error(tr('error.opencodeExitedEarly', { message: (closed.reason as Error).message }))
    try {
      const res = await fetch(`${url}/doc`, { headers, signal: AbortSignal.timeout(2_000) })
      if (res.ok) return
      last = `HTTP ${res.status}`
    } catch (error) {
      last = String((error as Error).cause ?? error) // 아직 안 떴다
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(tr('error.opencodeNotReady', { seconds: READY_TIMEOUT_MS / 1000, last }))
}

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as net.AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}

// PID 기록 — 한 서버라 기록도 하나다. 동기로 쓴다: 띄운 직후 앱이 죽어도 PID 는 파일에 있어야 한다.
function writeRecord(file: string, record: ServerRecord): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(record))
  } catch {
    // 못 적어도 앱은 떠야 한다 — 대가는 "강제 종료 뒤 유령이 남을 수 있다" 뿐
  }
}

function forgetRecord(file: string, pid: number | undefined): void {
  try {
    if ((JSON.parse(fs.readFileSync(file, 'utf8')) as ServerRecord).pid === pid) fs.rmSync(file)
  } catch {
    // 없거나 망가졌다
  }
}

/** 기록한 그 프로세스가 아직 그대로인가 — PID 는 재사용된다. 명령줄 **전체**(포트·--pure 까지)와 시작 시각이 둘 다 같을 때만 참.
 *  같은 실행 파일로 사용자가 띄운 `opencode serve --hostname 127.0.0.1` 과 가르려면 bin+serve 로는 모자라다 (03_qa 경고).
 *  argv[0] 은 spawn 에 넘긴 문자열 그대로라 기록한 명령줄과 글자까지 같다 (closed-code pidStore 실측) */
export function isOurServer(record: Pick<ServerRecord, 'command' | 'started'>, observed: { command?: string; started?: string }): boolean {
  return !!record.started && observed.command === record.command && observed.started === record.started
}

function observe(pid: number): { command?: string; started?: string } {
  if (process.platform === 'win32') return {} // ps 가 없다 — 확인 못 한 PID 는 안 죽인다
  const ps = (field: string): string | undefined => {
    try {
      return execFileSync('ps', ['-p', String(pid), '-o', `${field}=`], { encoding: 'utf8' }).trim() || undefined
    } catch {
      return undefined // 없는 PID
    }
  }
  return { command: ps('command'), started: ps('lstart') }
}

/** 지난 실행이 남긴 서버를 거둔다. 기록은 무조건 지운다 — 더는 우리 것을 가리키지 않는다 */
function reapStale(file: string): void {
  let record: ServerRecord
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8')) as ServerRecord
  } catch {
    return
  }
  if (typeof record?.pid === 'number' && typeof record.command === 'string' && isOurServer(record, observe(record.pid))) {
    try {
      process.kill(record.pid, 'SIGTERM')
    } catch {
      // 그 사이 끝났다
    }
  }
  fs.rmSync(file, { force: true })
}
