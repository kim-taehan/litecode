import { Context, Service } from 'cordis'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSER_ASK_TOOLS,
  BROWSER_DENIED_TOOLS,
  BROWSER_MCP_NAME,
  BROWSER_QUIET_TOOLS,
  BROWSER_READ_TOOLS,
  browserApprovalDetail,
  browserToolKind,
} from '../../shared/browser.ts'
import { FEATURE_DEFAULT_OFF, FEATURE_GROUPS, FEATURE_REQUIRES, featureOn } from '../../shared/features.ts'
import { MODES, modePermission, type Mode } from '../../shared/modes.ts'
import { BrowserService, browserChannel } from '../../src/services/browser.ts'
import { BROWSER_PACKAGES, browserCli, bundledBrowserDir, checkBrowserAssets, devBrowserDir } from '../../src/services/browser/assets.ts'
import { browserPids, closeBrowsers } from '../../src/services/browser/cleanup.ts'
import { engineConfig, MODE_AGENT, SUBAGENT_ASK, toolGate, withBrowserRules, type EngineMcp } from '../../src/services/engine.ts'
import type { McpStatus } from '../../src/services/llm.ts'
import { McpService } from '../../src/services/mcp.ts'

// 브라우저 기능 (이슈 #147) — AI 가 Chrome 창을 조종한다. 동봉한 Playwright MCP(@playwright/mcp)를 내장 MCP 서버 `chrome` 으로 붙인다.
// 진짜 Chrome·opencode 는 띄우지 않는다 — 정의 모양·권한 규칙·자리 찾기·프로세스 고르기만 본다.

/** 실측 목록 (01aj §4, @playwright/mcp 0.0.83 기본 25개) — 버전을 올리면 tools/list 와 다시 댄다 */
const MEASURED = [
  'browser_close', 'browser_resize', 'browser_console_messages', 'browser_handle_dialog', 'browser_emulate_media', 'browser_evaluate', 'browser_file_upload',
  'browser_drop', 'browser_find', 'browser_fill_form', 'browser_press_key', 'browser_type', 'browser_navigate', 'browser_navigate_back', 'browser_network_requests',
  'browser_network_request', 'browser_run_code_unsafe', 'browser_take_screenshot', 'browser_snapshot', 'browser_click', 'browser_drag', 'browser_hover',
  'browser_select_option', 'browser_tabs', 'browser_wait_for',
]
const named = (tool: string): string => `${BROWSER_MCP_NAME}_${tool}`

describe('기능 browser', () => {
  it('고르는 기능 · 기본 꺼짐 · MCP 가 있어야 하고 · AI 도구 묶음에 있다', () => {
    expect(FEATURE_DEFAULT_OFF).toContain('browser')
    expect(featureOn(undefined, 'browser')).toBe(false)
    expect(featureOn({ browser: true }, 'browser')).toBe(true)
    expect(FEATURE_REQUIRES['browser']).toEqual(['mcp'])
    expect(FEATURE_GROUPS.find((group) => group.id === 'ai')!.features).toContain('browser')
  })
})

describe('도구 갈래 — 실측 목록 25개', () => {
  it('네 갈래가 실측 목록을 빠짐없이 한 번씩 담는다', () => {
    const all = [...BROWSER_READ_TOOLS, ...BROWSER_QUIET_TOOLS, ...BROWSER_ASK_TOOLS, ...BROWSER_DENIED_TOOLS]
    expect([...all].sort()).toEqual([...MEASURED].sort())
    expect(new Set(all).size).toBe(25)
  })

  it('임의 코드 실행·파일 올리기·놓기는 deny, 읽기는 read, 목록에 없는 chrome_* 는 ask, 다른 서버 도구는 브라우저 도구가 아니다', () => {
    expect(BROWSER_DENIED_TOOLS).toEqual(['browser_run_code_unsafe', 'browser_file_upload', 'browser_drop'])
    for (const tool of BROWSER_DENIED_TOOLS) expect(browserToolKind(named(tool))).toBe('deny')
    expect(browserToolKind('chrome_browser_snapshot')).toBe('read')
    expect(browserToolKind('chrome_browser_navigate')).toBe('ask')
    expect(browserToolKind('chrome_browser_brand_new')).toBe('ask')
    expect(browserToolKind('github_browser_snapshot')).toBeUndefined()
    expect(browserToolKind('chromeX_browser_snapshot')).toBeUndefined()
  })
})

describe('엔진 권한 규칙 (withBrowserRules)', () => {
  const proxy = { token: 't', baseURLFor: () => '' }
  type Config = { permission: Record<string, unknown>; agent: Record<string, { permission: Record<string, unknown> }> }
  const build = (matchers?: string[]): Config => {
    const gate = matchers && toolGate(matchers)
    return withBrowserRules(engineConfig([], proxy, { webTools: true, skills: { enabled: true, claude: false }, ...(gate && { gate }) }), gate?.mcp ?? false) as unknown as Config
  }
  /** 엔진처럼 — 전역 → 에이전트 순서로 깔고 마지막으로 맞는 규칙 (와일드카드는 `*`·`*_*`·`chrome_*`) */
  const rule = (config: Config, agent: string, permission: string): unknown => {
    const matches = (pattern: string): boolean =>
      pattern === permission || pattern === '*' || (pattern === '*_*' && permission.includes('_')) || (pattern.endsWith('_*') && pattern !== '*_*' && permission.startsWith(pattern.slice(0, -1)))
    const layers = [config.permission, config.agent[agent]?.permission ?? {}]
    return layers.flatMap((layer) => Object.entries(layer).filter(([pattern]) => matches(pattern))).at(-1)?.[1] ?? 'allow'
  }
  const table = (config: Config, agent: string): Record<string, unknown> => Object.fromEntries([...MEASURED, 'browser_brand_new'].map((tool) => [tool, rule(config, agent, named(tool))]))
  const config = build()

  it('모드별 스냅숏 — 계획·기본·매번 묻기·전체 권한', () => {
    expect(Object.fromEntries(MODES.map((mode) => [mode, table(config, MODE_AGENT[mode])]))).toMatchSnapshot()
  })

  it('임의 코드 실행·파일 올리기·놓기는 어느 에이전트에서도 deny', () => {
    for (const agent of [...MODES.map((mode) => MODE_AGENT[mode]), SUBAGENT_ASK, 'general', 'explore']) {
      for (const tool of BROWSER_DENIED_TOOLS) expect(rule(config, agent, named(tool)), `${agent} ${tool}`).toBe('deny')
    }
  })

  it('기본·전체 권한: 페이지를 바꾸거나 밖으로 내보낼 수 있는 것은 ask, 읽기는 allow — 전체 권한의 "*": allow 뒤에 온다', () => {
    for (const agent of [MODE_AGENT.build, MODE_AGENT.full]) {
      for (const tool of ['browser_navigate', 'browser_tabs', 'browser_evaluate', 'browser_type', 'browser_fill_form', 'browser_network_requests', 'browser_network_request']) expect(rule(config, agent, named(tool)), tool).toBe('ask')
      // 이미 열린 페이지 안의 조작은 묻지 않는다 (사용자 요청 2026-10-06)
      for (const tool of ['browser_click', 'browser_hover', 'browser_drag', 'browser_press_key', 'browser_select_option', 'browser_handle_dialog', 'browser_navigate_back']) expect(rule(config, agent, named(tool)), tool).toBe('allow')
      for (const tool of ['browser_snapshot', 'browser_take_screenshot', 'browser_console_messages']) expect(rule(config, agent, named(tool)), tool).toBe('allow')
    }
    const order = Object.keys(config.agent[MODE_AGENT.full]!.permission)
    expect(order.indexOf('chrome_*')).toBeGreaterThan(order.indexOf('*'))
  })

  it('모르는 chrome_* 도구는 ask 다 — allow 가 기본이 되지 않는다 (계획은 deny)', () => {
    expect(rule(config, MODE_AGENT.build, 'chrome_browser_brand_new')).toBe('ask')
    expect(rule(config, MODE_AGENT.full, 'chrome_browser_brand_new')).toBe('ask')
    expect(rule(config, MODE_AGENT.ask, 'chrome_browser_brand_new')).toBe('ask')
    expect(rule(config, MODE_AGENT.plan, 'chrome_browser_brand_new')).toBe('deny')
  })

  it('계획: 읽기만 — 나머지는 와일드카드 deny 그대로. 매번 묻기: 전부 ask', () => {
    for (const tool of BROWSER_READ_TOOLS) expect(rule(config, MODE_AGENT.plan, named(tool)), tool).toBe('allow')
    for (const tool of [...BROWSER_QUIET_TOOLS, ...BROWSER_ASK_TOOLS]) expect(rule(config, MODE_AGENT.plan, named(tool)), tool).toBe('deny')
    for (const tool of [...BROWSER_READ_TOOLS, ...BROWSER_QUIET_TOOLS, ...BROWSER_ASK_TOOLS]) expect(rule(config, MODE_AGENT.ask, named(tool)), tool).toBe('ask')
  })

  it('하위 작업은 못 쓴다 — 전역 deny, general-ask 는 자기 와일드카드 ask 뒤에 다시 deny', () => {
    expect(config.permission).toMatchObject({ 'chrome_*': 'deny' })
    for (const tool of MEASURED) {
      expect(rule(config, 'general', named(tool)), tool).toBe('deny')
      expect(rule(config, SUBAGENT_ASK, named(tool)), tool).toBe('deny')
    }
  })

  it('다른 규칙은 건드리지 않는다 — 브라우저 규칙을 빼면 engineConfig 그대로', () => {
    const plain = engineConfig([], proxy, { webTools: true, skills: { enabled: true, claude: false } }) as unknown as Config
    const strip = (permission: Record<string, unknown>) => Object.entries(permission).filter(([name]) => !name.startsWith('chrome_'))
    expect(strip(config.permission)).toEqual(Object.entries(plain.permission))
    for (const [name, def] of Object.entries(plain.agent)) expect(strip(config.agent[name]!.permission), name).toEqual(Object.entries(def.permission))
  })

  it('훅 게이트(MCP)가 걸리면 allow 였던 것도 ask 로 온다 — deny 는 그대로, 하위 에이전트(general)에서 되살아나지 않는다', () => {
    const gated = build([''])
    for (const agent of [MODE_AGENT.build, MODE_AGENT.full, MODE_AGENT.plan]) expect(rule(gated, agent, 'chrome_browser_snapshot'), agent).toBe('ask')
    expect(rule(gated, MODE_AGENT.plan, 'chrome_browser_navigate')).toBe('deny')
    for (const agent of [...MODES.map((mode) => MODE_AGENT[mode]), SUBAGENT_ASK, 'general', 'explore']) {
      for (const tool of BROWSER_DENIED_TOOLS) expect(rule(gated, agent, named(tool)), `${agent} ${tool}`).toBe('deny')
    }
    for (const tool of MEASURED) {
      expect(rule(gated, 'general', named(tool)), tool).toBe('deny')
      expect(rule(gated, SUBAGENT_ASK, named(tool)), tool).toBe('deny')
    }
  })

  it('모드 판정 표(shared/modes.ts)가 엔진 규칙과 같다 — 게이트를 통과한 요청을 묻지 않고 실행할지 가른다', () => {
    for (const mode of MODES as readonly Mode[]) {
      for (const tool of [...MEASURED, 'browser_brand_new']) {
        expect(modePermission(mode, named(tool)), `${mode} ${tool}`).toBe(rule(config, MODE_AGENT[mode], named(tool)))
        expect(modePermission(mode, named(tool), { child: true }), `${mode} child ${tool}`).toBe('deny')
      }
    }
  })
})

describe('동봉 파일 자리', () => {
  let dir: string
  const plant = (root: string, versions: Record<string, string> = Object.fromEntries(BROWSER_PACKAGES.map(({ pkg, version }) => [pkg, version]))): void => {
    for (const [pkg, version] of Object.entries(versions)) {
      fs.mkdirSync(path.join(root, 'node_modules', pkg), { recursive: true })
      fs.writeFileSync(path.join(root, 'node_modules', pkg, 'package.json'), JSON.stringify({ version }))
    }
    fs.writeFileSync(browserCli(root), '')
  }
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litecode-browser-assets-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('설치본은 Resources/browser, 개발 실행은 build/vendor/browser — 타깃 구분이 없다', () => {
    expect(bundledBrowserDir('/app/Resources')).toBe(path.join('/app/Resources', 'browser'))
    expect(devBrowserDir('/repo')).toBe(path.join('/repo', 'build', 'vendor', 'browser'))
    expect(browserCli('/x')).toBe(path.join('/x', 'node_modules', '@playwright', 'mcp', 'cli.js'))
  })

  it('고정한 버전의 두 패키지와 cli.js 가 있으면 ok', () => {
    plant(dir)
    expect(checkBrowserAssets(dir)).toEqual({ ok: true })
  })

  it('폴더가 없거나 패키지가 빠졌으면 무엇이 없는지 (던지지 않는다)', () => {
    expect(checkBrowserAssets(path.join(dir, 'nope'))).toEqual({ ok: false, file: path.join('node_modules', '@playwright', 'mcp', 'package.json') })
    plant(dir, { '@playwright/mcp': BROWSER_PACKAGES[0]!.version })
    expect(checkBrowserAssets(dir)).toEqual({ ok: false, file: path.join('node_modules', 'playwright-core', 'package.json') })
  })

  it('버전이 다르면 받아들이지 않는다 — 권한 규칙이 도구 이름에 걸려 있다', () => {
    plant(dir, { '@playwright/mcp': '0.0.84', 'playwright-core': BROWSER_PACKAGES[1]!.version })
    expect(checkBrowserAssets(dir)).toEqual({ ok: false, file: path.join('node_modules', '@playwright', 'mcp', 'package.json') })
  })

  it('앱이 보는 버전·integrity 는 받기 스크립트(scripts/fetch-browser.mjs)의 값과 같다', () => {
    const script = fs.readFileSync(path.join(import.meta.dirname, '../../scripts/fetch-browser.mjs'), 'utf8')
    expect(BROWSER_PACKAGES.map(({ pkg, version }) => `${pkg}@${version}`)).toEqual(['@playwright/mcp@0.0.83', 'playwright-core@1.64.0-alpha-1790635538000'])
    for (const { pkg, version, integrity } of BROWSER_PACKAGES) {
      expect(integrity, pkg).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/)
      expect(script, pkg).toContain(`pkg: '${pkg}', version: '${version}', integrity: '${integrity}'`)
    }
  })

  it('설치본에 싣는 자리(electron-builder.yml)와 dist 스크립트의 --check 가 있다', () => {
    const root = path.join(import.meta.dirname, '../..')
    expect(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')).toMatch(/from: build\/vendor\/browser\n\s+to: browser\n/)
    const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts as Record<string, string>
    for (const name of ['dist:mac', 'dist:win']) expect(scripts[name], name).toContain('node scripts/fetch-browser.mjs --check')
  })
})

describe('브라우저 고르기', () => {
  it('mac 은 chrome. Windows 는 Chrome 이 표준 자리에 없을 때만 Edge', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)' }
    expect(browserChannel('darwin', {}, () => false)).toBe('chrome')
    expect(browserChannel('win32', env, () => false)).toBe('msedge')
    const seen: string[] = []
    expect(browserChannel('win32', env, (file) => (seen.push(file), file.startsWith('C:\\Program Files\\')))).toBe('chrome')
    expect(seen[0]).toBe('C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe')
  })
})

describe('남은 Chrome 정리 — 우리 프로필로 뜬 것만', () => {
  const profile = '/Users/u/Library/Application Support/litecode/browser/profile'
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const helper = '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper'
  const ps = [
    `  101 ${chrome}`, // 사용자의 평소 Chrome
    `  102 ${chrome} --user-data-dir=/Users/u/other --remote-debugging-pipe`,
    `  103 ${chrome} --user-data-dir=${profile}2 --remote-debugging-pipe`, // 이름이 우리 것으로 시작할 뿐이다
    `  104 ${chrome} --user-data-dir=${profile}/sub`,
    `  150 /Applications/litecode.app/Contents/MacOS/litecode /x/cli.js --browser chrome --user-data-dir ${profile} --output-dir /x/out`, // MCP 서버 — 엔진이 끊는다
    `  200 ${chrome} --disable-sync --user-data-dir=${profile} --remote-debugging-pipe about:blank`,
    `  201 ${helper} --type=renderer --user-data-dir=${profile} --lang=ko`, // 본체가 끝나면 같이 끝난다
    `  202 ${chrome} --user-data-dir=${profile}`,
    `  300 /usr/bin/grep --user-data-dir=${profile}x`,
    '',
  ].join('\n')

  it('명령줄에 우리 프로필 경로가 그대로 있는 브라우저 본체만 고른다 (경로에 공백이 있어도)', () => {
    expect(browserPids(ps, profile)).toEqual([200, 202])
  })

  it('프로필 경로가 비었거나 상대 경로면 아무것도 고르지 않는다', () => {
    expect(browserPids(ps, '')).toEqual([])
    expect(browserPids(ps, 'profile')).toEqual([])
  })

  it('고른 PID 에만 SIGTERM 을 보낸다 — 자기 자신은 빼고, 목록을 못 읽으면 아무것도 안 한다', async () => {
    const killed: number[] = []
    await closeBrowsers(profile, { platform: 'darwin', list: async () => ps, kill: (pid) => void killed.push(pid), self: 202 })
    expect(killed).toEqual([200])
    killed.length = 0
    await closeBrowsers(profile, { platform: 'darwin', list: async () => Promise.reject(new Error('ps 없음')), kill: (pid) => void killed.push(pid) })
    expect(killed).toEqual([])
  })

  it('Windows 에서는 정리하지 않는다 (명령줄 대조를 실측하지 않았다)', async () => {
    const list = vi.fn(async () => ps)
    await closeBrowsers(profile, { platform: 'win32', list, kill: () => {} })
    expect(list).not.toHaveBeenCalled()
  })
})

/** ctx.llm 의 mcp* 흉내 */
class FakeLlm extends Service {
  status = new Map<string, Record<string, McpStatus>>()
  added: Record<string, EngineMcp> = {}
  calls: string[] = []
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
  async mcpStatus(directory: string) {
    return { ...(this.status.get(directory) ?? {}) }
  }
  async mcpAdd(directory: string, name: string, def: EngineMcp) {
    this.calls.push(`add ${name}`)
    this.added[name] = def
    this.status.set(directory, { ...(this.status.get(directory) ?? {}), [name]: { status: 'connected' } })
    return this.status.get(directory)!
  }
  async mcpDisconnect(directory: string, name: string) {
    this.calls.push(`disconnect ${name}`)
    this.status.set(directory, { ...(this.status.get(directory) ?? {}), [name]: { status: 'disabled' } })
  }
  async mcpConnect() {}
}

describe('ctx.browser', () => {
  let tmp: string
  let project: string
  let root: string
  let closed: string[]

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'litecode-browser-unit-')))
    project = path.join(tmp, 'proj')
    root = path.join(tmp, 'vendor')
    fs.mkdirSync(project)
    closed = []
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  const plant = (): void => {
    for (const { pkg, version } of BROWSER_PACKAGES) {
      fs.mkdirSync(path.join(root, 'node_modules', pkg), { recursive: true })
      fs.writeFileSync(path.join(root, 'node_modules', pkg, 'package.json'), JSON.stringify({ version }))
    }
    fs.writeFileSync(browserCli(root), '')
  }

  async function start() {
    const ctx = new Context()
    ctx.plugin(FakeLlm)
    ctx.plugin(McpService, { env: { HOME: path.join(tmp, 'home'), XDG_CONFIG_HOME: path.join(tmp, 'xdg') }, fallbackCwd: tmp })
    const fiber = ctx.plugin(BrowserService, {
      runner: '/Applications/litecode.app/Contents/MacOS/litecode',
      root,
      dataDir: path.join(tmp, 'user data', 'browser'),
      channel: 'chrome',
      close: async (profile: string) => void closed.push(profile),
    })
    const ready = await new Promise<Context>((resolve) => ctx.inject(['llm', 'mcp', 'browser'], resolve))
    return { ctx, fiber, llm: ready.llm as unknown as FakeLlm, mcp: ready.mcp, browser: ready.browser }
  }

  it('올라오면 chrome 이 내장 MCP 로 붙는다 — 앱 실행 파일을 node 로, 창이 보이게, 전용 프로필·출력 폴더로', async () => {
    plant()
    const { llm, mcp, browser } = await start()
    expect(browser.status()).toEqual({ ready: true })
    await mcp.prepare(project)
    expect(llm.calls).toEqual(['add chrome'])
    const dataDir = path.join(tmp, 'user data', 'browser')
    expect(llm.added['chrome']).toEqual({
      type: 'local',
      command: [
        '/Applications/litecode.app/Contents/MacOS/litecode',
        browserCli(root),
        '--browser',
        'chrome',
        '--user-data-dir',
        path.join(dataDir, 'profile'),
        '--output-dir',
        path.join(dataDir, 'output'),
        '--snapshot-mode',
        'none',
      ],
      environment: { ELECTRON_RUN_AS_NODE: '1' },
    })
    const command = (llm.added['chrome'] as { command: string[] }).command
    for (const never of ['--headless', '--isolated', '--extension', '--cdp-endpoint', '--caps', '--allow-unrestricted-file-access']) expect(command).not.toContain(never)
    expect((await mcp.list(project)).find((entry) => entry.name === 'chrome')).toMatchObject({ source: 'builtin', status: 'connected' })
  })

  it('뜰 때 지난 실행이 남긴 우리 프로필의 Chrome 을 거둔다', async () => {
    plant()
    await start()
    expect(closed).toEqual([path.join(tmp, 'user data', 'browser', 'profile')])
  })

  it('내려가면 chrome 이 빠지고(다음 붙이기가 끊는다) 우리 프로필의 Chrome 을 닫는다', async () => {
    plant()
    const { fiber, llm, mcp } = await start()
    await mcp.prepare(project)
    closed = []
    await fiber.dispose()
    expect(closed).toEqual([path.join(tmp, 'user data', 'browser', 'profile')])
    await mcp.prepare(project)
    expect(llm.calls).toEqual(['add chrome', 'disconnect chrome'])
    expect((await mcp.list(project)).some((entry) => entry.source === 'builtin')).toBe(false)
  })

  it('동봉 파일이 없으면 붙이지 않고 읽을 수 있는 오류를 남긴다 — 내려받지 않는다', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { llm, mcp, browser } = await start()
      const status = browser.status()
      expect(status.ready).toBe(false)
      expect(status.ready === false && status.error).toMatch(/동봉 파일이 없습니다/)
      await mcp.prepare(project)
      expect(llm.calls).toEqual([])
      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })

  it('이름 `chrome` 은 예약 — 브라우저 기능이 꺼져 있어도 사용자·폴더 서버는 그 이름으로 못 붙는다', async () => {
    const ctx = new Context()
    ctx.plugin(FakeLlm)
    ctx.plugin(McpService, { env: { HOME: path.join(tmp, 'home'), XDG_CONFIG_HOME: path.join(tmp, 'xdg') }, fallbackCwd: tmp })
    const ready = await new Promise<Context>((resolve) => ctx.inject(['llm', 'mcp'], resolve))
    const llm = ready.llm as unknown as FakeLlm
    const local = (name: string) => ({ name, type: 'local' as const, command: ['/bin/cat'], vars: [] })
    expect(() => ready.mcp.save(local('chrome'))).toThrow(/앱이 쓰는 이름/)
    expect(() => ready.mcp.save({ ...local('chrome'), scope: 'project' }, project)).toThrow(/앱이 쓰는 이름/)
    expect(() => ready.mcp.save(local('litecode'))).toThrow(/앱이 쓰는 이름/)
    fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { chrome: { command: '/bin/false' }, wiki: { command: '/bin/cat' } } }))
    const listed = await ready.mcp.list(project)
    expect(listed.find((entry) => entry.name === 'chrome')).toMatchObject({ source: 'project', shadowed: true })
    expect(llm.calls).toEqual(['add wiki'])
  })
})

describe('승인 카드에 보일 인자', () => {
  const detail = (tool: string, args: unknown) => browserApprovalDetail(tool, JSON.stringify(args))

  it('navigate 는 열 주소 전체, 뒤로 가기는 제목만', () => {
    const long = `http://wiki.corp/${'a'.repeat(400)}?token=1`
    expect(detail('browser_navigate', { url: 'http://wiki.corp/page' })).toEqual({ action: 'navigate', text: 'http://wiki.corp/page' })
    expect(detail('browser_navigate', { url: long })!.text).toBe(long)
    expect(detail('browser_navigate_back', {})).toEqual({ action: 'back' })
  })

  it('type 은 넣을 글과 넣는 칸, fill_form 은 칸마다 한 줄', () => {
    expect(detail('browser_type', { element: '검색창', target: 'e3', text: '비밀 메모' })).toEqual({ action: 'type', target: '검색창', text: '비밀 메모' })
    expect(
      detail('browser_fill_form', {
        fields: [
          { name: '아이디', type: 'textbox', target: 'e1', value: 'kim' },
          { name: '비밀번호', type: 'textbox', target: 'e2', value: 'hunter2' },
        ],
      }),
    ).toEqual({ action: 'fill', text: '아이디: kim\n비밀번호: hunter2' })
  })

  it('click·hover 는 대상 설명, drag 는 어디서 어디로, select_option 은 대상과 고를 값', () => {
    expect(detail('browser_click', { element: '저장 버튼', target: 'e7' })).toEqual({ action: 'click', text: '저장 버튼' })
    expect(detail('browser_hover', { element: '메뉴', target: 'e2' })).toEqual({ action: 'hover', text: '메뉴' })
    expect(detail('browser_drag', { startElement: '카드', startTarget: 'e1', endElement: '완료 칸', endTarget: 'e9' })).toEqual({ action: 'drag', text: '카드 → 완료 칸' })
    expect(detail('browser_select_option', { element: '언어', target: 'e4', values: ['한국어', 'English'] })).toEqual({ action: 'select', target: '언어', text: '한국어, English' })
  })

  it('evaluate 는 실행할 스크립트(여러 줄 그대로), press_key 는 키', () => {
    const script = '() => {\n  return document.title\n}'
    expect(detail('browser_evaluate', { function: script })).toEqual({ action: 'evaluate', text: script, code: true })
    expect(detail('browser_press_key', { key: 'Enter' })).toEqual({ action: 'key', text: 'Enter' })
  })

  it('tabs 는 동작과 주소', () => {
    expect(detail('browser_tabs', { action: 'new', url: 'http://a.corp/' })).toEqual({ action: 'tabs', text: 'new\nhttp://a.corp/' })
    expect(detail('browser_tabs', { action: 'select', index: 2 })).toEqual({ action: 'tabs', text: 'select 2' })
  })

  it('네트워크 읽기는 제목(무엇을 읽는지는 화면 문구) + 준 인자', () => {
    expect(detail('browser_network_requests', {})).toEqual({ action: 'network' })
    expect(detail('browser_network_request', { index: 3 })).toEqual({ action: 'network', text: JSON.stringify({ index: 3 }, null, 2) })
  })

  it('모르는 browser_* 도구는 인자를 그대로 JSON 으로 — 숨기지 않는다', () => {
    const args = { where: 'http://x.corp/', deep: { a: 1 } }
    expect(detail('browser_teleport', args)).toEqual({ text: JSON.stringify(args, null, 2) })
    expect(detail('browser_handle_dialog', { accept: true, promptText: '네' })).toEqual({ text: JSON.stringify({ accept: true, promptText: '네' }, null, 2) })
    expect(detail('browser_snapshot', {})).toEqual({})
  })

  it('아는 도구인데 기대한 인자가 없으면 인자 전체를 보인다', () => {
    expect(detail('browser_navigate', { url: 42 })).toEqual({ action: 'navigate', text: JSON.stringify({ url: 42 }, null, 2) })
    expect(detail('browser_click', { target: 'e7' })).toEqual({ action: 'click', text: JSON.stringify({ target: 'e7' }, null, 2) })
  })

  it('인자가 없거나 브라우저 도구가 아니면 없다, JSON 이 아니면 받은 글 그대로', () => {
    expect(browserApprovalDetail('browser_navigate', undefined)).toBeUndefined()
    expect(browserApprovalDetail('query', JSON.stringify({ url: 'http://a.corp/' }))).toBeUndefined()
    expect(browserApprovalDetail('browser_navigate', '{oops')).toEqual({ text: '{oops' })
  })
})
