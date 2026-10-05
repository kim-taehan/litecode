import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// 음성 입력 엔진·모델이 놓인 자리와 그 대조 — 받는 것은 scripts/fetch-speech.mjs, 설치본에 싣는 것은 electron-builder.yml `extraResources`.
//   <speech>/node_modules/sherpa-onnx-node/                (JS 껍데기)
//   <speech>/node_modules/sherpa-onnx-<platform>-<arch>/   (sherpa-onnx.node + onnxruntime — 폴더 하나로 닫혀 있다)
//   <speech>/models/{model.int8.onnx, tokens.txt, silero_vad.onnx}
// 워커는 `createRequire(<speech>/package.json)('sherpa-onnx-node')` 로 읽는다 (그 package.json 은 없어도 된다 — 실측 01ag §2.1).
// 사용자가 파일을 넣는 길은 없다 (리더 결정 2026-10-05) — 설치본에 실린 것만 쓰고, 개발 실행은 받아 둔 build/vendor 를 쓴다.

/** 모델 셋 — **scripts/fetch-speech.mjs 의 MODELS 와 같아야 한다** (받을 때 한 번, 앱이 뜰 때 한 번 대조한다. 단위 테스트가 두 곳을 댄다).
 *  SenseVoiceSmall int8 · 토큰은 `csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17` @ 2365baea, VAD 는 `csukuangfj/vad` @ fba88cd2 */
export const SPEECH_MODELS: readonly SpeechModelFile[] = [
  { file: 'model.int8.onnx', size: 239233841, sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' },
  { file: 'tokens.txt', size: 315894, sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc' },
  { file: 'silero_vad.onnx', size: 1807522, sha256: 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28' },
]

export interface SpeechModelFile {
  file: string
  size: number
  sha256: string
}

/** 엔진이 있는 판 — 이름은 electron-builder 의 `${os}-${arch}` (fetch-speech.mjs 의 타깃). 없는 판(linux·win-arm64 등)은 undefined */
export function speechTarget(platform: string, arch: string): string | undefined {
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : undefined
  const target = os && `${os}-${arch}`
  return target === 'mac-arm64' || target === 'mac-x64' || target === 'win-x64' ? target : undefined
}

/** 설치본에 실린 자리 (electron-builder.yml `extraResources` 의 `to` 와 같아야 한다) */
export function bundledSpeechDir(resourcesPath: string): string {
  return path.join(resourcesPath, 'speech')
}

/** 개발 실행의 자리 — `node scripts/fetch-speech.mjs` 가 받아 둔 것 */
export function devSpeechDir(repoRoot: string, platform: string = process.platform, arch: string = process.arch): string | undefined {
  const target = speechTarget(platform, arch)
  return target && path.join(repoRoot, 'build', 'vendor', 'speech', target)
}

/** 네이티브 패키지 이름 — sherpa-onnx-node 가 이 이름으로 찾는다 (win32 는 `win`) */
export function runtimePackage(platform: string, arch: string): string {
  return `sherpa-onnx-${platform === 'win32' ? 'win' : platform}-${arch}`
}

export type AssetCheck = { ok: true } | { ok: false; reason: 'missing' | 'mismatch'; file: string }

export interface AssetCheckOptions {
  platform?: string
  arch?: string
  /** 단위 테스트가 작은 파일로 바꾼다 */
  models?: readonly SpeechModelFile[]
}

/** 엔진·모델이 다 있고 모델이 받은 그대로인가. 런타임은 있는지만 본다(받을 때 tarball 을 통째로 댔다), 모델은 크기 → sha256.
 *  239MB 를 읽는다 — 서비스가 뜰 때 한 번만 돈다 (던지지 않는다: 못 읽으면 missing) */
export async function checkSpeechAssets(root: string, opts: AssetCheckOptions = {}): Promise<AssetCheck> {
  const native = runtimePackage(opts.platform ?? process.platform, opts.arch ?? process.arch)
  for (const file of [path.join('node_modules', 'sherpa-onnx-node', 'package.json'), path.join('node_modules', native, 'sherpa-onnx.node')]) {
    if (!(await size(path.join(root, file)))) return { ok: false, reason: 'missing', file }
  }
  for (const model of opts.models ?? SPEECH_MODELS) {
    const file = path.join('models', model.file)
    const bytes = await size(path.join(root, file))
    if (bytes === undefined) return { ok: false, reason: 'missing', file }
    if (bytes !== model.size) return { ok: false, reason: 'mismatch', file }
    const digest = await sha256(path.join(root, file)).catch(() => undefined)
    if (digest === undefined) return { ok: false, reason: 'missing', file }
    if (digest !== model.sha256) return { ok: false, reason: 'mismatch', file }
  }
  return { ok: true }
}

/** 파일 크기 — 없거나 파일이 아니면 undefined */
async function size(file: string): Promise<number | undefined> {
  const stat = await fs.promises.stat(file).catch(() => undefined)
  return stat?.isFile() ? stat.size : undefined
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}
