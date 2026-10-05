#!/usr/bin/env node
// 설치본에 실을 음성 입력 엔진(sherpa-onnx-node)과 모델(SenseVoiceSmall int8 · Silero VAD)을 받아 `build/vendor/speech/<타깃>/` 에 놓는다.
// electron-builder 가 이 자리를 `extraResources` 로 앱 안(`Resources/speech`)에 싣는다 (`electron-builder.yml`). 틀은 fetch-opencode.mjs 와 같다.
//
// **망 밖(개발 머신·CI)에서만 돈다.** 폐쇄망 PC 에는 npm·huggingface 가 없어 설치본에 실려 들어가야 한다.
// 받은 것은 레포에 넣지 않는다 (타깃당 풀어서 ~270MB, `.gitignore` 의 `build/vendor/`).
//
// 런타임: `sherpa-onnx-node` 는 JS 껍데기(61KB)고 네이티브(.node + onnxruntime)는 플랫폼별 패키지(`sherpa-onnx-darwin-arm64` 등)다 —
//   둘 다 npm 레지스트리 tarball 을 여기 박아 둔 sha512(integrity)와 대조해 통째로 푼다. N-API prebuilt 라 Electron 재빌드가 없다
//   (실측 _workspace/01ag_voice_input.md §2.1). 본체가 플랫폼 패키지를 `sherpa-onnx-<platform>-<arch>` 이름으로 찾으므로 폴더 이름을 바꾸지 않는다.
// 모델: huggingface 고정 리비전 URL 을 여기 박아 둔 크기·sha256 과 대조한다 (dsh `runtime/assets.json` 과 같은 값).
//   **같은 값이 `src/services/speech/assets.ts` 의 SPEECH_MODELS 에도 있다** — 앱이 뜰 때 다시 대조한다. 한쪽만 바꾸면 단위 테스트가 잡는다.
//   세 타깃이 같은 파일을 쓴다 — 다른 타깃에 받아 둔 것이 있으면 내려받지 않고 복사한다.
// 놓는 자리 (런타임에선 `createRequire(<speech>/package.json)('sherpa-onnx-node')` 로 읽는다):
//   build/vendor/speech/<타깃>/node_modules/sherpa-onnx-node/
//   build/vendor/speech/<타깃>/node_modules/sherpa-onnx-<platform>-<arch>/
//   build/vendor/speech/<타깃>/models/{model.int8.onnx, tokens.txt, silero_vad.onnx}
//
//   node scripts/fetch-speech.mjs                 이 판의 타깃
//   node scripts/fetch-speech.mjs mac-x64 win-x64 지정한 타깃 · --all 전부
//   node scripts/fetch-speech.mjs --check <타깃…>  받아 둔 것이 있는지만 (dist:* 앞에서)

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

/** 동봉할 엔진 — 실측한 버전으로 고정한다 (릴리스가 잦다). 올리려면 _workspace/probe-01ag/bench-sherpa.mjs 를 다시 돌린다 */
const SHERPA_VERSION = '1.13.8'
const SHERPA_NODE = { pkg: 'sherpa-onnx-node', integrity: 'sha512-MsDMBdhLFTZ1GwvcGSSQhnS7g/EA8OMH6IYysCVUOM7j8Icty9KRc0E6YT1A5fWBsZwRfKOeh88QC95aRvS8ag==' }

// 타깃 이름은 electron-builder 의 `${os}-${arch}` 다 (fetch-opencode.mjs 와 같은 이름). native 는 그 패키지에 있어야 하는 네이티브 모듈
const TARGETS = {
  'mac-arm64': {
    platform: 'darwin',
    arch: 'arm64',
    runtime: { pkg: 'sherpa-onnx-darwin-arm64', integrity: 'sha512-FPNgJMgnWVl/KhRTIhG3KL3A4Om63Rn4YKXc9/uHY7SzLcvqLJLc/h7UBWJwduXvv7K18t5NpxHR6XgXn4sjWw==' },
  },
  'mac-x64': {
    platform: 'darwin',
    arch: 'x64',
    runtime: { pkg: 'sherpa-onnx-darwin-x64', integrity: 'sha512-7BLRpjM6w4f9W46/nmkmq8lEKUayhebvcpslCVQ+6QN2uReYlZEMDZlSpXMjme+hUFrPfRz8P3UNq8ep/4d19g==' },
  },
  'win-x64': {
    platform: 'win32',
    arch: 'x64',
    runtime: { pkg: 'sherpa-onnx-win-x64', integrity: 'sha512-oZF1c9VPOKtMwn83Bboc5XSWL+76BRoyB3eUuVnCknBKxwSULZU2Foia9VHWzU+n4I12rPsP6z6H9Rp1hD9o8g==' },
  },
}
const NATIVE = 'sherpa-onnx.node'

const SENSEVOICE = 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07'
/** 모델 셋 — src/services/speech/assets.ts SPEECH_MODELS 와 같아야 한다 */
const MODELS = [
  { file: 'model.int8.onnx', size: 239233841, sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51', url: `${SENSEVOICE}/model.int8.onnx` },
  { file: 'tokens.txt', size: 315894, sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc', url: `${SENSEVOICE}/tokens.txt` },
  {
    file: 'silero_vad.onnx',
    size: 1807522,
    sha256: 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28',
    url: 'https://huggingface.co/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/silero_vad.onnx',
  },
]

// Node 는 주소마다 250ms 안에 연결이 안 되면 다음 주소로 넘어간다 — 모델 CDN(해외)은 연결에 0.4초쯤 걸려 주소를 다 돌고 ETIMEDOUT 으로 끝났다
// (실측 2026-10-05, 같은 때 curl 은 됐다). 주소마다 5초를 준다
setDefaultAutoSelectFamilyAttemptTimeout(5000)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const speechRoot = join(root, 'build', 'vendor', 'speech')
const vendorDir = (target) => join(speechRoot, target)
const packageDir = (target, pkg) => join(vendorDir(target), 'node_modules', pkg)
const modelFile = (target, file) => join(vendorDir(target), 'models', file)

function hostTarget() {
  const found = Object.entries(TARGETS).find(([, t]) => t.platform === process.platform && t.arch === process.arch)
  if (found === undefined) fail(`이 판(${process.platform}-${process.arch})용 타깃이 없습니다`)
  return found[0]
}

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

/** 받아 둔 패키지가 그 버전인가 */
function installed(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version === SHERPA_VERSION
  } catch {
    return false
  }
}

/** npm tarball 을 받아 integrity 를 대조하고 `package/` 를 dest 에 통째로 푼다 */
async function fetchPackage({ pkg, integrity }, dest, needs) {
  if (installed(dest) && needs.every((file) => existsSync(join(dest, file)))) return console.log(`  · ${pkg}@${SHERPA_VERSION} 이미 있음`)
  const url = `https://registry.npmjs.org/${pkg}/-/${pkg}-${SHERPA_VERSION}.tgz`
  const res = await fetch(url)
  if (!res.ok) fail(`${url} 내려받기 실패 (HTTP ${res.status})`)
  const body = Buffer.from(await res.arrayBuffer())
  // 반입물에 들어갈 네이티브 코드다 — 여기서 안 재면 잰 자리가 없다. 기대값을 레지스트리에서 다시 읽지 않고 박아 둔 값과 댄다
  const digest = `sha512-${createHash('sha512').update(body).digest('base64')}`
  if (digest !== integrity) fail(`${pkg} 무결성 불일치\n  기대: ${integrity}\n  실제: ${digest}`)

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
  for (const file of needs) if (!existsSync(join(dest, file))) fail(`${pkg}: ${file} 이 tarball 에 없습니다`)
  console.log(`  · ${dest} (${(body.length / 1e6).toFixed(1)}MB tgz)`)
}

function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/** 크기와 sha256 이 둘 다 맞는가 (크기가 틀리면 해시를 재지 않는다) */
async function verified(file, model) {
  return existsSync(file) && statSync(file).size === model.size && (await sha256Of(file)) === model.sha256
}

async function fetchModel(target, model) {
  const dest = modelFile(target, model.file)
  if (await verified(dest, model)) return console.log(`  · ${model.file} 이미 있음 (sha256 일치)`)
  mkdirSync(dirname(dest), { recursive: true })
  // 다른 타깃에 받아 둔 같은 파일 — 239MB 를 타깃마다 다시 받지 않는다
  for (const other of Object.keys(TARGETS)) {
    const have = modelFile(other, model.file)
    if (other !== target && (await verified(have, model))) {
      copyFileSync(have, dest)
      return console.log(`  · ${model.file} ← ${other} 에서 복사`)
    }
  }
  const res = await fetch(model.url)
  if (!res.ok || !res.body) fail(`${model.url} 내려받기 실패 (HTTP ${res.status})`)
  const part = `${dest}.part`
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part))
  const size = statSync(part).size
  const digest = await sha256Of(part)
  if (size !== model.size || digest !== model.sha256) {
    rmSync(part, { force: true })
    fail(`${model.file} 체크섬 불일치\n  기대: ${model.sha256} (${model.size}바이트)\n  실제: ${digest} (${size}바이트)`)
  }
  renameSync(part, dest)
  console.log(`  · ${dest} (${(size / 1e6).toFixed(1)}MB, sha256 일치)`)
}

/** 이 판에서 돌 수 있을 때만 — 받은 자리에서 네이티브 모듈이 실제로 읽히는지 (opencode 의 --version 확인과 같은 자리) */
function loadCheck(target) {
  const t = TARGETS[target]
  if (t.platform !== process.platform || t.arch !== process.arch) return console.log('  · 로드 확인 건너뜀 (이 판에서 못 돈다)')
  const script = `const s = require('node:module').createRequire(process.argv[1])('sherpa-onnx-node'); if (typeof s.OfflineRecognizer !== 'function' || typeof s.Vad !== 'function') process.exit(2)`
  try {
    execFileSync(process.execPath, ['-e', script, join(vendorDir(target), 'package.json')], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (error) {
    fail(`${target}: sherpa-onnx-node 를 못 읽었습니다\n${error.stderr?.toString() ?? error.message}`)
  }
  console.log('  · 네이티브 모듈 로드 확인')
}

/** 타깃에 있어야 하는 파일 전부 — 모델은 크기까지 본다 (sha256 은 받을 때와 앱이 뜰 때 잰다) */
function missingFiles(target) {
  const { runtime } = TARGETS[target]
  return [
    ...(installed(packageDir(target, SHERPA_NODE.pkg)) ? [] : [`node_modules/${SHERPA_NODE.pkg}`]),
    ...(installed(packageDir(target, runtime.pkg)) && existsSync(join(packageDir(target, runtime.pkg), NATIVE)) ? [] : [`node_modules/${runtime.pkg}`]),
    ...MODELS.filter((model) => !existsSync(modelFile(target, model.file)) || statSync(modelFile(target, model.file)).size !== model.size).map((model) => `models/${model.file}`),
  ]
}

/** `dist:*` 앞에서 도는 존재 검사 — 왜 실패했는지가 문장으로 나오게 */
function check(targets) {
  const missing = targets.filter((target) => missingFiles(target).length > 0)
  if (missing.length > 0) {
    fail(
      `동봉할 음성 입력 엔진·모델이 없습니다: ${missing.map((target) => `${target} (${missingFiles(target).join(', ')})`).join(' · ')}\n` +
        `  받으세요: node scripts/fetch-speech.mjs ${missing.join(' ')}\n` +
        '  (폐쇄망 안에서는 못 받습니다 — 망 밖에서 빌드해 설치본을 반입하세요)',
    )
  }
  console.log(`✓ 음성 입력 동봉 준비됨: ${targets.join(', ')}`)
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
    console.log(`${target}: sherpa-onnx-node ${SHERPA_VERSION} · SenseVoiceSmall int8 · Silero VAD`)
    await fetchPackage(SHERPA_NODE, packageDir(target, SHERPA_NODE.pkg), ['package.json'])
    await fetchPackage(TARGETS[target].runtime, packageDir(target, TARGETS[target].runtime.pkg), [NATIVE])
    for (const model of MODELS) await fetchModel(target, model)
    loadCheck(target)
  }
  console.log(`✓ ${targets.length}개 준비됨 — build/vendor/speech/`)
}
