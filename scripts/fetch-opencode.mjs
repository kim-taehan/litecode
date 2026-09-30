#!/usr/bin/env node
// 설치본에 실을 opencode·ripgrep 실행 파일을 받아 `build/vendor/{opencode,rg}/<타깃>/` 에 놓는다.
// electron-builder 가 이 자리를 `extraResources` 로 앱 안에 싣는다 (`electron-builder.yml`). closed-code/desktop 의 같은 스크립트를 옮겼다.
//
// **망 밖(개발 머신·CI)에서만 돈다.** 폐쇄망 PC 에는 npm·github 가 없어 실행 파일이 설치본에 실려 들어가야 한다.
// 받은 것은 레포에 넣지 않는다 (타깃당 140~180MB, `.gitignore` 의 `build/vendor/`).
//
// opencode: `opencode-ai` 는 런처뿐이고 실물은 플랫폼별 패키지(`opencode-darwin-arm64` 등)다 — 그것을 직접 받는다.
//   tarball 은 `package/bin/opencode[.exe]` 하나. 레지스트리의 sha512(integrity)와 대조한다.
// ripgrep: opencode 의 grep·glob 도구가 rg 를 PATH 에서 못 찾으면 github 에서 받으려 한다 — 폐쇄망에서 실패하거나
//   무응답 망이면 도구마다 ~300초 멈춘다 (_workspace/01b_offline.md). 앱이 이 rg 폴더를 opencode 자식 PATH 맨 앞에 둔다.
//   버전은 opencode 1.18.18 이 받으려던 15.1.0. sha256 은 릴리스의 `.sha256` 을 여기 박아 둔다 — 받는 쪽과 같은 곳에서 읽은
//   값으로 대조하면 릴리스가 바뀌어도 모른다.
//
//   node scripts/fetch-opencode.mjs                 이 판의 타깃
//   node scripts/fetch-opencode.mjs mac-x64 win-x64 지정한 타깃 · --all 전부
//   node scripts/fetch-opencode.mjs --check <타깃…>  받아 둔 것이 있는지만 (dist:* 앞에서)

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 동봉할 opencode — 설정 전달(CONFIG_DIR·env)을 실측한 버전으로 고정한다. 올리려면 01 실측부터 다시 잰다 (latest 를 따라가지 않는다) */
const OPENCODE_VERSION = '1.18.18'
const RG_VERSION = '15.1.0'

// 타깃 이름은 electron-builder 의 `${os}-${arch}` 다 (`process.platform` 이 아니다). 이름이 어긋나면 extraResources 가 빈 자리를 가리킨다.
const TARGETS = {
  'mac-arm64': {
    platform: 'darwin',
    arch: 'arm64',
    opencode: { pkg: 'opencode-darwin-arm64', bin: 'opencode' },
    rg: { asset: 'ripgrep-15.1.0-aarch64-apple-darwin.tar.gz', sha256: '378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715', bin: 'rg' },
  },
  'mac-x64': {
    platform: 'darwin',
    arch: 'x64',
    opencode: { pkg: 'opencode-darwin-x64', bin: 'opencode' },
    rg: { asset: 'ripgrep-15.1.0-x86_64-apple-darwin.tar.gz', sha256: '64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882', bin: 'rg' },
  },
  'win-x64': {
    platform: 'win32',
    arch: 'x64',
    opencode: { pkg: 'opencode-windows-x64', bin: 'opencode.exe' },
    rg: { asset: 'ripgrep-15.1.0-x86_64-pc-windows-msvc.zip', sha256: '124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a', bin: 'rg.exe' },
  },
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const vendorDir = (tool, target) => join(root, 'build', 'vendor', tool, target)

function hostTarget() {
  const found = Object.entries(TARGETS).find(([, t]) => t.platform === process.platform && t.arch === process.arch)
  if (found === undefined) fail(`이 판(${process.platform}-${process.arch})용 타깃이 없습니다`)
  return found[0]
}

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

async function get(url) {
  const res = await fetch(url)
  if (!res.ok) fail(`${url} 내려받기 실패 (HTTP ${res.status})`)
  return Buffer.from(await res.arrayBuffer())
}

/** body 를 임시 파일로 두고 그 안의 member 하나를 dest 에 푼다 (strip 마디를 걷어내고). bsdtar 는 zip 도 푼다 */
function extract(body, name, member, strip, dest) {
  mkdirSync(dest, { recursive: true })
  const tmp = mkdtempSync(join(tmpdir(), 'litecode-fetch-'))
  try {
    const archive = join(tmp, name)
    writeFileSync(archive, body)
    execFileSync('tar', ['-xf', archive, '-C', dest, '--strip-components', String(strip), member])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** 이 판에서 돌 수 있을 때만 --version 을 잰다 */
function runnable(target) {
  const t = TARGETS[target]
  return t.platform === process.platform && t.arch === process.arch
}

async function fetchOpencode(target) {
  const { pkg, bin } = TARGETS[target].opencode
  const meta = await fetch(`https://registry.npmjs.org/${pkg}/${OPENCODE_VERSION}`)
  if (!meta.ok) fail(`${pkg}@${OPENCODE_VERSION} 메타데이터를 못 받았습니다 (HTTP ${meta.status})`)
  const { dist } = await meta.json()
  const body = await get(dist.tarball)
  // 반입물에 들어갈 실행 파일이다 — 여기서 안 재면 잰 자리가 없다 (폐쇄망 안에서는 다시 받아 볼 수도 없다)
  const digest = `sha512-${createHash('sha512').update(body).digest('base64')}`
  if (digest !== dist.integrity) fail(`${pkg} 무결성 불일치\n  기대: ${dist.integrity}\n  실제: ${digest}`)

  const dest = vendorDir('opencode', target)
  extract(body, 'pkg.tgz', `package/bin/${bin}`, 2, dest)
  const file = join(dest, bin)
  chmodSync(file, 0o755) // 실행 비트가 빠지면 증상이 "opencode 를 못 찾는다" 로 나온다 (opencodeBinary.ts 는 X_OK 로 본다)
  console.log(`  · ${file} (${(statSync(file).size / 1e6).toFixed(0)}MB)`)
  if (!runnable(target)) return console.log('  · --version 확인 건너뜀 (이 판에서 못 돈다)')
  const printed = execFileSync(file, ['--version'], { encoding: 'utf8' }).trim()
  if (printed !== OPENCODE_VERSION) fail(`${target}: opencode --version 이 ${printed} 입니다 (기대 ${OPENCODE_VERSION})`)
  console.log(`  · opencode --version ${printed}`)
}

async function fetchRipgrep(target) {
  const { asset, sha256, bin } = TARGETS[target].rg
  const body = await get(`https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${asset}`)
  const digest = createHash('sha256').update(body).digest('hex')
  if (digest !== sha256) fail(`${asset} 체크섬 불일치\n  기대: ${sha256}\n  실제: ${digest}`)

  const folder = asset.replace(/\.(tar\.gz|zip)$/, '')
  const dest = vendorDir('rg', target)
  extract(body, asset, `${folder}/${bin}`, 1, dest)
  const file = join(dest, bin)
  chmodSync(file, 0o755)
  console.log(`  · ${file} (${(statSync(file).size / 1e6).toFixed(1)}MB)`)
  if (!runnable(target)) return
  const printed = execFileSync(file, ['--version'], { encoding: 'utf8' }).split('\n')[0]
  if (!printed.startsWith(`ripgrep ${RG_VERSION}`)) fail(`${target}: rg --version 이 "${printed}" 입니다 (기대 ${RG_VERSION})`)
  console.log(`  · ${printed}`)
}

/** `dist:*` 앞에서 도는 존재 검사 — 왜 실패했는지가 문장으로 나오게 */
function check(targets) {
  const missing = targets.filter(
    (target) =>
      !existsSync(join(vendorDir('opencode', target), TARGETS[target].opencode.bin)) ||
      !existsSync(join(vendorDir('rg', target), TARGETS[target].rg.bin)),
  )
  if (missing.length > 0) {
    fail(
      `동봉할 opencode·rg 실행 파일이 없습니다: ${missing.join(', ')}\n` +
        `  받으세요: node scripts/fetch-opencode.mjs ${missing.join(' ')}\n` +
        '  (폐쇄망 안에서는 못 받습니다 — 망 밖에서 빌드해 설치본을 반입하세요)',
    )
  }
  console.log(`✓ 동봉 준비됨: ${targets.join(', ')}`)
}

const args = process.argv.slice(2)
const named = args.filter((a) => !a.startsWith('--'))
const targets = args.includes('--all') ? Object.keys(TARGETS) : named.length > 0 ? named : [hostTarget()]
for (const target of targets) {
  if (TARGETS[target] === undefined) fail(`모르는 타깃: ${target} (있는 것: ${Object.keys(TARGETS).join(', ')})`)
}

if (args.includes('--check')) {
  check(targets)
} else {
  for (const target of targets) {
    console.log(`${target}: opencode ${OPENCODE_VERSION} · ripgrep ${RG_VERSION}`)
    await fetchOpencode(target)
    await fetchRipgrep(target)
  }
  console.log(`✓ ${targets.length}개 준비됨 — build/vendor/`)
}
