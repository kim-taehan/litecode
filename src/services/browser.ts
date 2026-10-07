import { Context, Service } from 'cordis'
import fs from 'node:fs'
import path from 'node:path'
import { BROWSER_MCP_NAME } from '../../shared/browser.ts'
import { tr } from '../i18n.ts'
import { browserCli, checkBrowserAssets } from './browser/assets.ts'
import { closeBrowsers } from './browser/cleanup.ts'
import type { EngineMcp } from './engineConfig.ts'
import './mcp.ts'

// 브라우저 (ctx.browser, 기능 `browser` · 기본 꺼짐, 이슈 #147 — 사용자 결정 2026-10-06 "Playwright MCP 로", "별도 코디스 기능", "브라우저 창 보이게").
// 실측·설계 _workspace/01aj_playwright_mcp.md. AI 가 Chrome 창을 열어 페이지를 읽고 누른다. 이 서비스가 하는 일은 셋뿐이다:
// - 동봉한 Playwright MCP(browser/assets.ts)를 내장 MCP 서버 `chrome` 으로 올린다 (ctx.mcp.registerBuiltin — 매 턴 그 폴더 엔진에 붙는다, 엔진 재시작 없음).
//   서버 프로세스는 엔진이 띄운다: **앱 실행 파일을 node 로**(`ELECTRON_RUN_AS_NODE=1`) — 폐쇄망 PC 에 node 가 없어도 된다. Chrome 은 첫 도구 호출 때 뜬다
// - 내려갈 때(기능 끄기·앱 종료)와 뜰 때 우리 프로필로 뜬 Chrome 을 닫는다 (browser/cleanup.ts)
// - 동봉 파일이 없으면 올리지 않고 사유를 쥔다 (내려받지 않는다)
// 도구 권한(늘 deny·ask·allow)은 엔진 설정에 있다 (engineConfig.ts withBrowserRules, 도구 갈래는 shared/browser.ts). Electron 을 모른다 — 실행 파일·자리는 받는다.
//
// 인자 (01aj §1·§5):
// - `--browser chrome` — PC 에 깔린 Chrome. Windows 에서 Chrome 이 표준 자리에 없으면 `msedge`. 없는 브라우저는 서버가 도구 호출에 "not found at …" 로
//   답할 뿐 내려받지 않는다 (서버 연결 자체는 된다 — MCP 목록에는 "연결됨" 으로 보인다)
// - **헤드리스 인자를 주지 않는다** — 창이 보여야 AI 가 무엇을 하는지 드러나고 사용자가 그 창에서 직접 로그인할 수 있다
// - `--user-data-dir <userData>/browser/profile` — 전용 프로필. 평소 Chrome 프로필과 완전히 따로이고, 로그인이 앱을 껐다 켜도 남는다
//   (`--isolated` 는 매번 빈 프로필이라 쓰지 않는다). ⚠️ 프로필 하나는 한 번에 Chrome 하나만 쓴다 — 엔진은 폴더마다 MCP 서버를 따로 띄우므로
//   두 프로젝트가 동시에 브라우저를 쓰면 뒤쪽이 "Browser is already in use" 로 실패한다 (코드 확인, 미실측)
// - `--output-dir <userData>/browser/output` — 안 주면 프로젝트 폴더에 `.playwright-mcp/` 가 생긴다. 스크린샷이 여기 쌓인다 (지우는 것은 아직 없다)
// - `--snapshot-mode none` — 기본값은 동작마다 스냅숏을 **파일**로 쓰고 링크만 준다. none 이면 모델이 `browser_snapshot` 을 불러 본문으로 받는다
// - 주지 않는 것: `--extension`·`--cdp-endpoint`(평소 Chrome·떠 있는 브라우저에 붙기), `--caps`(좌표 클릭·녹화·PDF), `--allow-unrestricted-file-access`

export interface BrowserOptions {
  /** node 처럼 돌 실행 파일 — 앱 자신 (`process.execPath`. 개발 실행에서도 Electron 바이너리다) */
  runner: string
  /** 동봉 폴더 (browser/assets.ts 의 자리) */
  root: string
  /** 프로필·출력 폴더를 둘 자리 (`<userData>/browser`) */
  dataDir: string
  /** 쓸 브라우저 — 단위 테스트가 바꾼다 (기본 browserChannel) */
  channel?: string
  /** 그 프로필로 뜬 브라우저 닫기 — 단위 테스트가 바꾼다 */
  close?: (profileDir: string) => Promise<void>
}

export type BrowserStatus = { ready: true } | { ready: false; error: string }

declare module 'cordis' {
  interface Context {
    browser: BrowserService
  }
}

/** Chrome 의 표준 설치 자리 (Windows — Playwright 가 보는 자리와 같다, 01aj §6) */
const WINDOWS_CHROME = ['LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)']

/** 쓸 브라우저 — Chrome. Windows 에서 Chrome 이 표준 자리에 없을 때만 Edge (늘 깔려 있다) */
export function browserChannel(platform: string, env: NodeJS.ProcessEnv, exists: (file: string) => boolean): 'chrome' | 'msedge' {
  if (platform !== 'win32') return 'chrome'
  const found = WINDOWS_CHROME.some((name) => env[name] !== undefined && exists(path.win32.join(env[name]!, 'Google', 'Chrome', 'Application', 'chrome.exe')))
  return found ? 'chrome' : 'msedge'
}

export class BrowserService extends Service {
  static readonly inject = ['mcp']

  private state: BrowserStatus = { ready: true }

  constructor(ctx: Context, opts: BrowserOptions) {
    super(ctx, 'browser')
    const profile = path.join(opts.dataDir, 'profile')
    const close = opts.close ?? closeBrowsers
    const assets = checkBrowserAssets(opts.root)
    if (!assets.ok) {
      const error = tr('browser.error.missing', { file: assets.file })
      this.state = { ready: false, error }
      console.error('[browser]', error)
      return
    }

    const channel = opts.channel ?? browserChannel(process.platform, process.env, fs.existsSync)
    const definition: EngineMcp = {
      type: 'local',
      command: [opts.runner, browserCli(opts.root), '--browser', channel, '--user-data-dir', profile, '--output-dir', path.join(opts.dataDir, 'output'), '--snapshot-mode', 'none'],
      environment: { ELECTRON_RUN_AS_NODE: '1' },
    }
    void close(profile) // 지난 실행이 남긴 것 (MCP 서버가 강제 종료됐을 때) — 남아 있으면 프로필이 잠겨 새 브라우저가 못 뜬다
    ctx.effect(() => {
      const off = ctx.mcp.registerBuiltin(BROWSER_MCP_NAME, () => definition)
      // 엔진의 MCP 서버는 그 폴더의 다음 붙이기(다음 턴·MCP 목록 읽기)나 엔진 종료 때 끊긴다 — 창은 지금 닫는다
      return () => {
        off()
        return close(profile)
      }
    })
  }

  /** 쓸 수 있나 — 동봉 파일이 없으면 사유 */
  status(): BrowserStatus {
    return this.state
  }
}
