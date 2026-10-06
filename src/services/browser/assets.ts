import fs from 'node:fs'
import path from 'node:path'

// 브라우저 기능의 동봉 파일 — Playwright MCP 서버와 그것이 읽는 playwright-core (둘 다 순수 JS, 네이티브 파일 0 → 타깃 구분 없는 한 벌, 7.6MB).
// 받는 것은 scripts/fetch-browser.mjs, 설치본에 싣는 것은 electron-builder.yml `extraResources`. 실측 _workspace/01aj_playwright_mcp.md §1·§5.
//   <browser>/node_modules/@playwright/mcp/cli.js        (앱 실행 파일을 node 로 돌려 stdio MCP 서버로 띄운다)
//   <browser>/node_modules/playwright-core/lib/**        (cli.js 가 require 한다 — `playwright` 패키지는 필요 없다)
// **런타임에 내려받지 않는다** (폐쇄망) — 없으면 기능이 "동봉 파일 없음" 으로 실패한다. 브라우저도 내려받지 않고 PC 에 깔린 Chrome 을 쓴다.

/** 동봉하는 두 패키지 — **scripts/fetch-browser.mjs 의 PACKAGES 와 같아야 한다** (단위 테스트가 두 곳을 댄다).
 *  0.0.x + playwright alpha 라 버전마다 도구 이름이 바뀐다 — 권한 규칙(shared/browser.ts)이 이름에 걸려 있으므로 올릴 때 `tools/list` 를 다시 대조한다 */
export const BROWSER_PACKAGES: readonly { pkg: string; version: string; integrity: string }[] = [
  { pkg: '@playwright/mcp', version: '0.0.83', integrity: 'sha512-oNcl+Ae2/IAjhfPeP46BfIkSakfmprY+aOtkv5MjrQ4lPav4/yNtPhL0iq8SlIM90oApWgBDUxaNKvktazUKOg==' },
  { pkg: 'playwright-core', version: '1.64.0-alpha-1790635538000', integrity: 'sha512-pNwaXirhXMRLaRQs4NQ18EpTdtDoFwyPH9FOaaDC7YXG4hpwE2xmwCic/1srbuExVQC7zT9LJSJpDBAru+Vo9A==' },
]

/** 설치본에 실린 자리 (electron-builder.yml `extraResources` 의 `to` 와 같아야 한다) */
export function bundledBrowserDir(resourcesPath: string): string {
  return path.join(resourcesPath, 'browser')
}

/** 개발 실행의 자리 — `node scripts/fetch-browser.mjs` 가 받아 둔 것 */
export function devBrowserDir(repoRoot: string): string {
  return path.join(repoRoot, 'build', 'vendor', 'browser')
}

/** MCP 서버의 실행 스크립트 */
export function browserCli(root: string): string {
  return path.join(root, 'node_modules', '@playwright', 'mcp', 'cli.js')
}

export type BrowserAssetCheck = { ok: true } | { ok: false; file: string }

/** 두 패키지가 고정한 버전으로 있고 cli.js 가 있는가 — 내용은 받을 때 tarball 을 통째로 댔다. 던지지 않는다 */
export function checkBrowserAssets(root: string): BrowserAssetCheck {
  for (const { pkg, version } of BROWSER_PACKAGES) {
    const file = path.join('node_modules', pkg, 'package.json')
    try {
      if ((JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')) as { version?: unknown }).version !== version) return { ok: false, file }
    } catch {
      return { ok: false, file }
    }
  }
  return fs.existsSync(browserCli(root)) ? { ok: true } : { ok: false, file: path.relative(root, browserCli(root)) }
}
