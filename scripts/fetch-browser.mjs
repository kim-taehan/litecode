#!/usr/bin/env node
// 설치본에 실을 브라우저 기능의 MCP 서버(@playwright/mcp)와 그것이 읽는 playwright-core 를 받아 `build/vendor/browser/` 에 놓는다 (이슈 #147).
// electron-builder 가 이 자리를 `extraResources` 로 앱 안(`Resources/browser`)에 싣는다 (`electron-builder.yml`). 틀은 fetch-speech.mjs 와 같다.
//
// **망 밖(개발 머신·CI)에서만 돈다.** 폐쇄망 PC 에는 npm 이 없어 설치본에 실려 들어가야 한다 — 앱은 런타임에 내려받지 않는다.
// 받은 것은 레포에 넣지 않는다 (`.gitignore` 의 `build/vendor/`).
//
// 둘 다 순수 JS 다(네이티브 파일 0 — 실측 _workspace/01aj_playwright_mcp.md §1) → **타깃 구분 없는 한 벌**을 세 타깃에 그대로 싣는다.
// npm 레지스트리 tarball 을 여기 박아 둔 sha512(integrity)와 대조해 푼다. `cli.js` 는 `playwright-core/lib/{utilsBundle,coreBundle}` 만 읽으므로
// `playwright` 패키지는 받지 않고, playwright-core 에서 안 쓰는 `types/`·`bin/`·`lib/vite/` 는 뺀다 (18MB → 7.6MB).
// **브라우저는 받지 않는다** — PC 에 깔린 Chrome(Windows 는 없으면 Edge)을 쓴다. `cli.js install-browser` 는 부르지 않는다.
// **같은 버전·integrity 가 `src/services/browser/assets.ts` 의 BROWSER_PACKAGES 에도 있다** — 앱이 뜰 때 버전을 다시 본다. 한쪽만 바꾸면 단위 테스트가 잡는다.
// 버전을 올릴 때: 0.0.x + playwright alpha 라 도구 이름이 바뀐다. 권한 규칙이 이름에 걸려 있으니 `tools/list` 를 shared/browser.ts 의 목록과 다시 댄다.
// 놓는 자리:
//   build/vendor/browser/node_modules/@playwright/mcp/     (cli.js — 앱 실행 파일이 ELECTRON_RUN_AS_NODE=1 로 돌린다)
//   build/vendor/browser/node_modules/playwright-core/
//
//   node scripts/fetch-browser.mjs           받는다
//   node scripts/fetch-browser.mjs --check   받아 둔 것이 있는지만 (dist:* 앞에서)

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 동봉할 두 패키지 — 실측한 버전으로 고정한다. src/services/browser/assets.ts BROWSER_PACKAGES 와 같아야 한다 */
const PACKAGES = [
  { pkg: '@playwright/mcp', version: '0.0.83', integrity: 'sha512-oNcl+Ae2/IAjhfPeP46BfIkSakfmprY+aOtkv5MjrQ4lPav4/yNtPhL0iq8SlIM90oApWgBDUxaNKvktazUKOg==', needs: ['cli.js'], prune: [] },
  { pkg: 'playwright-core', version: '1.64.0-alpha-1790635538000', integrity: 'sha512-pNwaXirhXMRLaRQs4NQ18EpTdtDoFwyPH9FOaaDC7YXG4hpwE2xmwCic/1srbuExVQC7zT9LJSJpDBAru+Vo9A==', needs: ['lib/coreBundle.js', 'lib/utilsBundle.js'], prune: ['types', 'bin', 'lib/vite'] },
]

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const vendorDir = join(root, 'build', 'vendor', 'browser')
const packageDir = (pkg) => join(vendorDir, 'node_modules', pkg)

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

/** 받아 둔 패키지가 그 버전이고 있어야 할 파일이 있는가 */
function installed({ pkg, version, needs }) {
  try {
    return JSON.parse(readFileSync(join(packageDir(pkg), 'package.json'), 'utf8')).version === version && needs.every((file) => existsSync(join(packageDir(pkg), file)))
  } catch {
    return false
  }
}

/** npm tarball 을 받아 integrity 를 대조하고 `package/` 를 풀고 안 쓰는 폴더를 뺀다 */
async function fetchPackage(entry) {
  const { pkg, version, integrity, needs, prune } = entry
  if (installed(entry)) return console.log(`  · ${pkg}@${version} 이미 있음`)
  const url = `https://registry.npmjs.org/${pkg}/-/${pkg.split('/').at(-1)}-${version}.tgz`
  const res = await fetch(url)
  if (!res.ok) fail(`${url} 내려받기 실패 (HTTP ${res.status})`)
  const body = Buffer.from(await res.arrayBuffer())
  // 엔진이 사용자 권한으로 돌릴 코드다 — 기대값을 레지스트리에서 다시 읽지 않고 박아 둔 값과 댄다
  const digest = `sha512-${createHash('sha512').update(body).digest('base64')}`
  if (digest !== integrity) fail(`${pkg} 무결성 불일치\n  기대: ${integrity}\n  실제: ${digest}`)

  const dest = packageDir(pkg)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  const tmp = mkdtempSync(join(tmpdir(), 'litecode-fetch-'))
  try {
    const archive = join(tmp, 'pkg.tgz')
    writeFileSync(archive, body)
    execFileSync('tar', ['-xf', archive, '-C', dest, '--strip-components', '1'])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  for (const dir of prune) rmSync(join(dest, dir), { recursive: true, force: true })
  for (const file of needs) if (!existsSync(join(dest, file))) fail(`${pkg}: ${file} 이 tarball 에 없습니다`)
  console.log(`  · ${dest} (${(body.length / 1e6).toFixed(1)}MB tgz)`)
}

/** 받은 자리에서 서버 스크립트가 실제로 읽히는지 — 브라우저는 띄우지 않는다 (opencode 의 --version 확인과 같은 자리) */
function loadCheck() {
  const [mcp] = PACKAGES
  try {
    const out = execFileSync(process.execPath, [join(packageDir(mcp.pkg), 'cli.js'), '--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    if (!out.includes(mcp.version)) fail(`cli.js --version 이 ${mcp.version} 이 아닙니다: ${out.trim()}`)
  } catch (error) {
    fail(`cli.js 를 못 돌렸습니다\n${error.stderr?.toString() ?? error.message}`)
  }
  console.log('  · cli.js --version 확인')
}

/** `dist:*` 앞에서 도는 존재 검사 — 왜 실패했는지가 문장으로 나오게 */
function check() {
  const missing = PACKAGES.filter((entry) => !installed(entry)).map(({ pkg, version }) => `${pkg}@${version}`)
  if (missing.length > 0) {
    fail(
      `동봉할 브라우저 MCP 서버가 없습니다: ${missing.join(', ')}\n` +
        '  받으세요: node scripts/fetch-browser.mjs\n' +
        '  (폐쇄망 안에서는 못 받습니다 — 망 밖에서 빌드해 설치본을 반입하세요)',
    )
  }
  console.log('✓ 브라우저 MCP 서버 동봉 준비됨')
}

if (process.argv.includes('--check')) {
  check()
} else {
  console.log(PACKAGES.map(({ pkg, version }) => `${pkg} ${version}`).join(' · '))
  for (const entry of PACKAGES) await fetchPackage(entry)
  loadCheck()
  console.log('✓ 준비됨 — build/vendor/browser/')
}
