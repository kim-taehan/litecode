import fs from 'node:fs/promises'
import path from 'node:path'
import yauzl from 'yauzl'
import type { ExtensionInspection, ExtensionProblem } from '../../../shared/extensions.ts'
import { EXTENSION_LIMITS, type ExtensionLimits } from './limits.ts'
import { checkManifest, MANIFEST_FILE } from './manifest.ts'
import { isEntryPath, unsafePathReason } from './paths.ts'

// 확장 zip 검사 (이슈 #478, 설계 3절 "zip 안전 검사"·4절 "검사(pick)") — 풀지 않고 중앙 디렉터리의 항목 목록만 읽는다. 메모리로 읽는 내용은
// extension.json 하나뿐(상한 manifestBytes). 사유를 모두 모아 돌려준다. 크기는 헤더에 선언된 해제 크기 기준 — 실제 크기는 풀 때(2/4) 다시 본다.
//
// yauzl 은 decodeStrings:false 로 연다. 기본값(true)은 `..`·절대 경로·백슬래시 이름을 만나면 그 자리에서 오류를 내고 목록 읽기를 멈춰서
// 사유를 모을 수 없고, 백슬래시를 `/` 로 바꿔 읽는다. 이름은 직접 푼다: 플래그 0x800 이면 UTF-8, 아니면 latin1 — yauzl 은 CP437 로 풀지만
// 검사에 쓰는 글자(`/` `\` `.` `:` 널)는 둘 다 ASCII 그대로라 판정이 같다. Info-ZIP 유니코드 경로 필드(0x7075)는 풀 때 헤더 이름 대신
// 쓰이므로 그 이름도 검사한다(헤더엔 safe.txt, 필드엔 ../evil 인 우회).
//
// macOS Finder 로 만든 zip 에 딸려 오는 `__MACOSX/` 아래 항목과 `.DS_Store` 는 규칙 계산(항목 수·크기·중복·extension.json 자리)에서 뺀다 —
// 안 빼면 래퍼 폴더 zip 이 manifest-misplaced 로 거절된다(이슈 #480). 경로 안전 검사(위험한 이름·심볼릭 링크)는 그대로 건다. 풀 때도 건너뛴다.

export interface Item {
  name: string
  isDir: boolean
  entry: yauzl.Entry
}

export async function inspectZip(file: string, appVersion: string, limits: ExtensionLimits = EXTENSION_LIMITS): Promise<ExtensionInspection> {
  const files = { count: 0, totalBytes: 0 }
  const problems: ExtensionProblem[] = []

  const { size } = await fs.stat(file)
  if (size > limits.zipBytes) return { files, problems: [{ code: 'zip-too-large', params: { bytes: size, limit: limits.zipBytes } }] }

  let zip: yauzl.ZipFile | undefined
  try {
    zip = await openZip(file)
    if (zip.entryCount > limits.entries) {
      return { files, problems: [{ code: 'too-many-entries', params: { count: zip.entryCount, limit: limits.entries } }] }
    }
    const items = await listItems(zip)

    const seen = new Set<string>()
    for (const item of items) {
      for (const name of namesOf(item.entry, item.name)) {
        const reason = unsafePathReason(name)
        if (reason) problems.push({ code: 'unsafe-path', params: { path: name, reason } })
      }
      if (isSymlink(item.entry)) problems.push({ code: 'symlink', params: { path: item.name } })
      if (isFinderJunk(item.name)) continue
      // 대소문자를 안 가리는 디스크(macOS·윈도 기본)에선 A.js 와 a.js 가 같은 파일이다 — 하나가 다른 것을 덮는다
      const key = path.posix.normalize(item.name).replace(/\/$/, '').toLowerCase()
      if (seen.has(key)) problems.push({ code: 'duplicate-path', params: { path: item.name } })
      seen.add(key)

      const bytes = item.entry.uncompressedSize
      if (bytes > limits.fileBytes) problems.push({ code: 'file-too-large', params: { path: item.name, bytes, limit: limits.fileBytes } })
      files.totalBytes += bytes
      if (!item.isDir) files.count++
    }
    if (files.totalBytes > limits.totalBytes) problems.push({ code: 'total-too-large', params: { bytes: files.totalBytes, limit: limits.totalBytes } })

    const kept = items.filter((item) => !isFinderJunk(item.name))
    const located = locateManifest(kept)
    if ('problem' in located) {
      problems.push(located.problem)
      return { files, problems }
    }
    const { item: manifestItem, root } = located
    const manifestBytes = manifestItem.entry.uncompressedSize
    if (manifestBytes > limits.manifestBytes) {
      problems.push({ code: 'manifest-too-large', params: { bytes: manifestBytes, limit: limits.manifestBytes } })
      return { files, problems }
    }

    let value: unknown
    try {
      value = JSON.parse(await readEntry(zip, manifestItem.entry))
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      problems.push({ code: 'manifest-invalid', params: { message: error.message } })
      return { files, problems }
    }
    const checked = checkManifest(value, appVersion, limits)
    problems.push(...checked.problems)

    const entry = (value as { entry?: unknown } | null)?.entry
    if (typeof entry === 'string' && isEntryPath(entry)) {
      const target = root + entry
      if (!kept.some((item) => !item.isDir && item.name === target)) problems.push({ code: 'entry-missing', params: { entry } })
    }
    return { manifest: checked.manifest, files, problems }
  } catch (error) {
    return { files, problems: [...problems, { code: 'zip-unreadable', params: { message: error instanceof Error ? error.message : String(error) } }] }
  } finally {
    zip?.close()
  }
}

/** extension.json 의 자리 — 최상위 한 곳, 또는 zip 전체가 폴더 하나로 감싸여 있을 때 그 폴더 바로 안 한 곳. root 는 entry 앞에 붙일 접두어 */
export function locateManifest(items: readonly Item[]): { item: Item; root: string } | { problem: ExtensionProblem } {
  const candidates = items.filter((item) => !item.isDir && (item.name === MANIFEST_FILE || /^[^/]+\/extension\.json$/.test(item.name)))
  if (candidates.length === 0) return { problem: { code: 'manifest-missing', params: {} } }
  if (candidates.length > 1) return { problem: { code: 'manifest-ambiguous', params: { paths: candidates.map((item) => item.name).join(', ') } } }
  const only = candidates[0]!
  if (only.name === MANIFEST_FILE) return { item: only, root: '' }
  const root = only.name.slice(0, -MANIFEST_FILE.length)
  if (items.every((item) => item.name.startsWith(root))) return { item: only, root }
  return { problem: { code: 'manifest-misplaced', params: { path: only.name } } }
}

/** Finder 가 붙이는 부산물 — 최상위 `__MACOSX/` 아래 전부와 어느 깊이든 `.DS_Store` 파일 */
export function isFinderJunk(name: string): boolean {
  return name.startsWith('__MACOSX/') || name.split('/').pop() === '.DS_Store'
}

export function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, decodeStrings: false, autoClose: false }, (error, zip) => (error ? reject(error) : resolve(zip)))
  })
}

export function listItems(zip: yauzl.ZipFile): Promise<Item[]> {
  return new Promise((resolve, reject) => {
    const items: Item[] = []
    zip.on('entry', (entry: yauzl.Entry) => {
      const name = unicodeName(entry) ?? decodeName(entry)
      items.push({ name, isDir: name.endsWith('/'), entry })
      zip.readEntry()
    })
    zip.once('end', () => resolve(items))
    zip.once('error', reject)
    zip.readEntry()
  })
}

function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<string> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(error)
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      stream.once('error', reject)
    })
  })
}

/** decodeStrings:false 라 fileName 은 Buffer 다 (@types/yauzl 은 string 으로 적는다) */
function decodeName(entry: yauzl.Entry): string {
  const raw = entry.fileName as unknown as Buffer
  return raw.toString(entry.generalPurposeBitFlag & 0x800 ? 'utf8' : 'latin1')
}

/** Info-ZIP Unicode Path Extra Field (0x7075, 버전 1) 의 이름 — 1바이트 버전 + 4바이트 CRC 뒤가 UTF-8 이름 */
function unicodeName(entry: yauzl.Entry): string | undefined {
  const field = entry.extraFields.find((extra) => extra.id === 0x7075 && extra.data.length >= 6 && extra.data.readUInt8(0) === 1)
  return field?.data.subarray(5).toString('utf8')
}

/** 검사할 이름들 — 헤더 이름과, 있으면 유니코드 경로 필드의 이름 (풀 때 어느 쪽이 쓰일지는 CRC 대조에 달려 있어 둘 다 본다) */
export function namesOf(entry: yauzl.Entry, name: string): string[] {
  const header = decodeName(entry)
  return header === name ? [name] : [header, name]
}

/** external attributes 위 16비트의 유닉스 파일 종류가 심볼릭 링크 — 만든 OS 바이트와 상관없이 본다 (더 엄격한 쪽) */
export function isSymlink(entry: yauzl.Entry): boolean {
  return ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000
}
