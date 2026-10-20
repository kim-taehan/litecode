#!/usr/bin/env node
// SonarQube 확장(extensions/sonarqube)에 동봉할 내장 서버를 받아 `build/vendor/sonarqube/<타깃>/server/` 에 놓는다 (이슈 #537).
// 확장 zip 의 `server/` 가 이 폴더다 — manifest 의 `server` 선언이 이 자리를 가리킨다. zip 으로 묶는 것은 2단계.
//
// **망 밖(개발 머신·CI)에서만 돈다.** 폐쇄망 PC 의 앱은 내려받지 않는다 — 실행 중 바깥 요청 0.
// 받은 것은 레포에 넣지 않는다 (`.gitignore` 의 `build/vendor/`). 타깃당 풀어서 약 800MB 다.
// 근거 실측은 _workspace/01_probe_537.md (2026-10-20, macOS arm64).
//
// 세 가지를 받는다 — 버전과 sha256 을 여기 박아 둔다 (받는 쪽과 같은 곳에서 읽은 값으로 대조하면 바뀌어도 모른다):
// - SonarQube Community Build zip (binaries.sonarsource.com, 타깃 구분 없는 한 벌 950MB). `jres/`(281MB)는 지운다 — 스캐너에 JRE 를 내려 주는
//   용도라, 스캐너를 동봉 런타임 + sonar.scanner.skipJreProvisioning=true 로 돌리면 안 쓴다 (실측 §8: 지운 채로 기동·분석 성공)
// - Java 런타임: Temurin JDK 21 을 받아 jlink 로 줄인다. **JRE 로는 안 뜬다** — 검색 엔진(Elasticsearch)이 jdk.jdi·jdk.jlink·jdk.attach 모듈을
//   요구한다 (실측 §2: JRE 는 "Module jdk.jdi not found"). Temurin JRE 의 모듈 + 그 셋 = 85MB (JDK 그대로는 336MB).
//   다른 타깃은 이 판의 JDK 의 jlink 에 그 타깃 JDK 의 jmods 를 준다(같은 버전이어야 한다) — **mac-x64·win-x64 런타임은 미검증**
// - SonarScanner CLI (JRE 없는 한 벌 10MB) — 같은 런타임으로 돈다 (실측 §8)
//
//   node scripts/fetch-sonarqube.mjs                  이 판의 타깃
//   node scripts/fetch-sonarqube.mjs mac-x64 win-x64  지정한 타깃 · --all 전부
//   node scripts/fetch-sonarqube.mjs --check <타깃…>   받아 둔 것이 있는지만
//
// 놓는 자리 (타깃마다):
//   server/sonarqube/   SonarQube (lib/sonar-application-<버전>.jar 를 java -jar 로 띄운다)
//   server/runtime/     jlink 런타임 (bin/java)
//   server/scanner/     SonarScanner CLI

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

/** 실측한 버전으로 고정한다 — 올리면 01_probe_537 의 기동·관리자 API 를 다시 잰다. 선언(extensions/sonarqube/extension.json)의 jar 이름과 같아야 한다 */
const SONARQUBE = {
  version: '26.10.0.133078',
  url: 'https://binaries.sonarsource.com/Distribution/sonarqube/sonarqube-26.10.0.133078.zip',
  sha256: 'a23716457a73e44fff57c51d8999d97e59f4deee24cefb333918fe6c1ddb62c1',
}
const SCANNER = {
  version: '8.2.0.6438',
  url: 'https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/sonar-scanner-cli-8.2.0.6438.zip',
  sha256: '2f1f412ad4c36d23266371367e13214fea03add397fb789bbb3282fdc9fb1372',
}
const JDK_VERSION = '21.0.12.1+1'
const JDK_BASE = 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1'

/** Temurin 21 JRE 의 모듈(`java --list-modules`) + 검색 엔진이 요구하는 셋 */
const MODULES = [
  'java.base,java.compiler,java.datatransfer,java.desktop,java.instrument,java.logging,java.management,java.management.rmi,java.naming,java.net.http',
  'java.prefs,java.rmi,java.scripting,java.se,java.security.jgss,java.security.sasl,java.smartcardio,java.sql,java.sql.rowset,java.transaction.xa',
  'java.xml,java.xml.crypto,jdk.accessibility,jdk.charsets,jdk.crypto.cryptoki,jdk.crypto.ec,jdk.dynalink,jdk.httpserver,jdk.incubator.vector',
  'jdk.internal.vm.ci,jdk.internal.vm.compiler,jdk.internal.vm.compiler.management,jdk.jdwp.agent,jdk.jfr,jdk.jsobject,jdk.localedata,jdk.management',
  'jdk.management.agent,jdk.management.jfr,jdk.naming.dns,jdk.naming.rmi,jdk.net,jdk.nio.mapmode,jdk.sctp,jdk.security.auth,jdk.security.jgss',
  'jdk.unsupported,jdk.xml.dom,jdk.zipfs',
  'jdk.jdi,jdk.jlink,jdk.attach',
].join(',')

// 타깃 이름은 electron-builder 의 `${os}-${arch}` (fetch-opencode.mjs 와 같다). home 은 JDK 압축의 맨 위 폴더 아래 JAVA_HOME 자리
const TARGETS = {
  'mac-arm64': {
    platform: 'darwin',
    arch: 'arm64',
    jdk: { asset: 'OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.12.1_1.tar.gz', sha256: '3623232f33a9c3baadf304480b2535f9a3cba8a58d42ecbb438ba267315d9998', home: 'Contents/Home' },
    java: 'java',
  },
  'mac-x64': {
    platform: 'darwin',
    arch: 'x64',
    jdk: { asset: 'OpenJDK21U-jdk_x64_mac_hotspot_21.0.12.1_1.tar.gz', sha256: '44db0f08196daf19a47f90d13388b0c943b67663cb537f998fe29e836fa842ce', home: 'Contents/Home' },
    java: 'java',
  },
  'win-x64': {
    platform: 'win32',
    arch: 'x64',
    jdk: { asset: 'OpenJDK21U-jdk_x64_windows_hotspot_21.0.12.1_1.zip', sha256: 'f9d6e191ab098c0d416e7d588a24420a8621cd2f4720dab2459b8b7b2d2d8b4e', home: '' },
    java: 'java.exe',
  },
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const vendor = join(root, 'build', 'vendor', 'sonarqube')
/** 받은 압축 — 타깃마다 다시 받지 않게 둔다 (SonarQube 만 950MB) */
const downloads = join(vendor, 'downloads')
const serverDir = (target) => join(vendor, target, 'server')

function hostTarget() {
  const found = Object.entries(TARGETS).find(([, t]) => t.platform === process.platform && t.arch === process.arch)
  if (found === undefined) fail(`이 판(${process.platform}-${process.arch})용 타깃이 없습니다`)
  return found[0]
}

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

const sha256Of = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** 받아서 sha256 을 대조한다. 이미 받아 둔 것이 맞으면 다시 받지 않는다. 크기 때문에 메모리에 담지 않고 파일로 흘린다 */
async function download(url, name, sha256) {
  const file = join(downloads, name)
  if (existsSync(file) && sha256Of(file) === sha256) return file
  mkdirSync(downloads, { recursive: true })
  const res = await fetch(url)
  if (!res.ok || res.body === null) fail(`${url} 내려받기 실패 (HTTP ${res.status})`)
  const partial = `${file}.partial`
  await pipeline(Readable.fromWeb(res.body), createWriteStream(partial))
  const digest = sha256Of(partial)
  if (digest !== sha256) {
    rmSync(partial, { force: true })
    fail(`${name} 체크섬 불일치\n  기대: ${sha256}\n  실제: ${digest}`)
  }
  renameSync(partial, file)
  console.log(`  · 받음 ${name}`)
  return file
}

/** 압축을 dest 에 맨 위 폴더 하나를 벗겨 푼다. bsdtar 는 zip 도 푼다 */
function extract(archive, dest) {
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  execFileSync('tar', ['-xf', archive, '-C', dest, '--strip-components', '1'])
}

const runnable = (target) => TARGETS[target].platform === process.platform && TARGETS[target].arch === process.arch

async function fetchJdk(target) {
  const { asset, sha256, home } = TARGETS[target].jdk
  const dest = join(vendor, 'jdk', target)
  if (!existsSync(join(dest, home, 'release'))) extract(await download(`${JDK_BASE}/${asset}`, asset, sha256), dest)
  return join(dest, home)
}

async function stage(target, hostJdk) {
  const dir = serverDir(target)
  console.log(`${target}: SonarQube ${SONARQUBE.version} · JDK ${JDK_VERSION} (jlink) · SonarScanner ${SCANNER.version}`)

  const sonarqube = join(dir, 'sonarqube')
  extract(await download(SONARQUBE.url, `sonarqube-${SONARQUBE.version}.zip`, SONARQUBE.sha256), sonarqube)
  rmSync(join(sonarqube, 'jres'), { recursive: true, force: true })

  const targetJdk = await fetchJdk(target)
  const runtime = join(dir, 'runtime')
  rmSync(runtime, { recursive: true, force: true })
  execFileSync(join(hostJdk, 'bin', 'jlink'), [
    '--module-path', join(targetJdk, 'jmods'),
    '--add-modules', MODULES,
    '--strip-debug', '--no-man-pages', '--no-header-files', '--compress=zip-6',
    '--output', runtime,
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
  // jlink 는 legal/<모듈>/ 의 라이선스 글을 java.base 쪽으로 가는 심볼릭 링크로 만든다(166개) — 확장 zip 풀기는 링크를 거절한다(unpack.ts)
  for (const name of readdirSync(runtime, { recursive: true })) {
    const file = join(runtime, name)
    if (!lstatSync(file).isSymbolicLink()) continue
    const real = realpathSync(file)
    rmSync(file)
    copyFileSync(real, file)
  }

  extract(await download(SCANNER.url, `sonar-scanner-cli-${SCANNER.version}.zip`, SCANNER.sha256), join(dir, 'scanner'))

  if (!runnable(target)) return console.log('  · java -version 확인 건너뜀 (이 판에서 못 돈다)')
  const java = join(runtime, 'bin', TARGETS[target].java)
  const modules = execFileSync(java, ['--list-modules'], { encoding: 'utf8' })
  if (!modules.includes(`java.base@${JDK_VERSION.split('+')[0]}`) || !modules.includes('jdk.jdi@')) fail(`${target}: 런타임 모듈이 기대와 다릅니다\n${modules}`)
  console.log(`  · ${java} (java.base@${JDK_VERSION.split('+')[0]} · jdk.jdi 포함)`)
}

/** 받아 둔 것이 있는지만 — 왜 실패했는지가 문장으로 나오게 */
function check(targets) {
  const missing = targets.filter((target) => {
    const dir = serverDir(target)
    return (
      !existsSync(join(dir, 'sonarqube', 'lib', `sonar-application-${SONARQUBE.version}.jar`)) ||
      !existsSync(join(dir, 'runtime', 'bin', TARGETS[target].java)) ||
      !existsSync(join(dir, 'scanner', 'lib', `sonar-scanner-cli-${SCANNER.version}.jar`))
    )
  })
  if (missing.length > 0) {
    fail(
      `동봉할 SonarQube 서버가 없습니다: ${missing.join(', ')}\n` +
        `  받으세요: node scripts/fetch-sonarqube.mjs ${missing.join(' ')}\n` +
        '  (폐쇄망 안에서는 못 받습니다 — 망 밖에서 받아 확장 zip 을 반입하세요)',
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
  // jlink 는 이 판에서 돌아야 한다 — 이 판의 JDK 를 먼저 받는다
  const hostJdk = await fetchJdk(hostTarget())
  for (const target of targets) await stage(target, hostJdk)
  console.log(`✓ ${targets.length}개 준비됨 — build/vendor/sonarqube/<타깃>/server/`)
}
