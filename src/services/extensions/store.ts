import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  ExtensionInspection,
  ExtensionManifest,
  ExtensionPendingOp,
  ExtensionProblem,
  ExtensionStoreFailure,
} from '../../../shared/extensions.ts'
import type { LocaleMessages } from '../../../shared/i18n/index.ts'
import { readJsonFileSync, writeJsonFileSync } from '../jsonFile.ts'
import { EXTENSION_LIMITS, limitsFor } from './limits.ts'
import { parseLocaleBundle } from './locale.ts'
import { checkManifest, isExtensionId, MANIFEST_FILE } from './manifest.ts'
import { isEntryPath } from './paths.ts'
import { unpackZip } from './unpack.ts'
import { inspectZip } from './zipInspect.ts'

// 확장 저장소 (이슈 #480, 설계 docs/superpowers/specs/2026-10-19-extension-install-design.md 4절 "풀기·교체는 보류로 쌓고 다음 부팅 때") —
// 파일 작업만 한다. 루트는 부르는 쪽이 준다(host 는 `<userData>/extensions`). 레이아웃:
//   installed/<id>/          풀린 확장
//   pending/ops.json         보류 작업 목록 (id 마다 하나 — 뒤 작업이 앞 작업을 바꾼다)
//   pending/install/<id>/    풀어 둔 새 버전
//   staging/<token>.zip      고른 zip 의 앱 안 복사본 — stage 는 이 복사본을 검사한다(확인 카드에 보인 것 = 설치되는 것)
//   staging/<token>.json     stage 때 본 { id, version } — install 이 다시 검사한 결과와 다르면 거절한다
//
// 실행 중인 확장 파일은 건드리지 않는다 — 교체는 applyPending 한 곳에서만. 교체는 모두 루트 안의 rename 이다
// (같은 볼륨 — 복사·이동이 아니라 원자적이고, Windows 에서도 폴더 rename 은 안의 파일이 열려 있지 않으면 된다).
// applyPending 은 부팅 때(확장이 올라오기 전) 부르고, 이슈 #511 부터는 서비스가 설치·삭제 직후에도 곧바로 부른다 — 패널 확장은 HTML 을
// 읽어 화면의 iframe 에서 돌릴 뿐 메인에서 실행되지 않아 열려 있는 확장 파일이 없다. 부팅 때 적용은 비정상 종료 복구용으로 남는다.
//
// 업그레이드 순서와 비정상 종료 복구:
//   1) installed/<id> → installed/.old-<id>-<시각>   2) pending/install/<id> → installed/<id>   3) .old 삭제
//   2) 가 실패하면 1) 을 되돌린다. 어느 지점에서 죽어도 다음 부팅의 복구가 맞춘다 — `.old-<id>-*` 가 있는데 installed/<id> 가 없으면
//   1)~2) 사이에서 죽은 것(가장 최근 .old 를 되돌린다), 있으면 2)~3) 사이(.old 를 지운다). ops.json 은 모든 작업이 끝난 뒤에 비우므로
//   죽은 부팅의 작업은 다음 부팅에 다시 적용된다. pending/install/<id> 가 이미 옮겨져 없는데 installed/<id> 가 그 op 의 버전이면 끝난 작업으로 본다.
// 삭제는 installed/<id> → installed/.del-<id>-<시각> 후 지운다. 이름이 .old 와 달라 복구가 되돌리지 않고 마저 지운다 — 지우다 실패한 반쪽 폴더가
// 다음 부팅에 "설치된 확장" 으로 되살아나지 않게 (이슈 #480 QA).
//
// 한 저장소의 stage·cancel·install·remove·applyPending 은 한 줄(직렬 큐)로 선다 — ops.json 읽기~쓰기 사이의 await 에 다른 호출이 끼어
// 서로의 op 를 덮거나, 부팅 청소가 막 풀어 둔 보류를 지우지 않게. 읽기 전용(listInstalled·pendingState)은 줄에 서지 않는다.
//
// 부팅 경로(applyPending·listInstalled·pendingState)는 던지지 않는다 (CLAUDE.md 함정 4). install·remove 는 실패를 구조화된 사유로 돌려준다

const TOKEN = /^[0-9a-f]{32}$/
const OLD = /^\.old-([a-z0-9-]{3,40})-(\d+)$/
const DELETING = /^\.del-[a-z0-9-]{3,40}-\d+$/
const TEMP_MARK = '.tmp-'

export interface StageResult {
  /** 검사를 통과했을 때만 — install·cancel 에 넘긴다 */
  token?: string
  result: ExtensionInspection
  /** 같은 id 가 설치돼 있거나 보류 설치가 있으면 그 버전 (다음 부팅 뒤에 올라올 쪽 — 보류 설치가 먼저) */
  existing?: { version: string }
}

export type InstallResult = { ok: true; id: string; version: string } | { ok: false; failure: ExtensionStoreFailure }
export type RemoveResult = { ok: true } | { ok: false; failure: ExtensionStoreFailure }
export type ReadEntryResult = { ok: true; html: string } | { ok: false; failure: ExtensionStoreFailure }
export type ReadLocaleResult = { ok: true; messages: LocaleMessages } | { ok: false; failure: ExtensionStoreFailure }

export interface ApplyResult {
  applied: ExtensionPendingOp[]
  failed: { id: string; reason: string }[]
}

export interface InstalledExtension {
  /** 폴더 이름 */
  id: string
  /** extension.json 이 맞을 때만 */
  manifest?: ExtensionManifest
  /** 비면 정상 */
  problems: ExtensionProblem[]
}

export class ExtensionStore {
  private readonly root: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(root: string) {
    this.root = path.resolve(root)
  }

  private get installedDir() {
    return path.join(this.root, 'installed')
  }
  private get pendingInstallDir() {
    return path.join(this.root, 'pending', 'install')
  }
  private get stagingDir() {
    return path.join(this.root, 'staging')
  }
  private get opsFile() {
    return path.join(this.root, 'pending', 'ops.json')
  }
  private stagedZip(token: string) {
    return path.join(this.stagingDir, `${token}.zip`)
  }
  private stagedMeta(token: string) {
    return path.join(this.stagingDir, `${token}.json`)
  }

  /** 앞선 호출이 끝난 뒤에 돈다 (앞 호출의 실패와 상관없이) */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => {})
    return run
  }

  /** zip 을 staging 에 복사하고 그 복사본을 검사한다. 통과하면 token 을 주고, 사유가 있으면 복사본을 지운다 */
  stage(zipPath: string, appVersion: string): Promise<StageResult> {
    return this.serial(() => this.stageNow(zipPath, appVersion))
  }

  /** 복사본과 기록을 지운다 */
  cancel(token: string): Promise<void> {
    return this.serial(async () => {
      if (TOKEN.test(token)) await this.removeStaged(token)
    })
  }

  /** staging 복사본을 다시 검사하고 pending/install/<id> 에 풀어 op 를 기록한다. 성공·실패와 상관없이 staging 복사본은 지운다(token 은 한 번 쓴다) */
  install(token: string, appVersion: string): Promise<InstallResult> {
    return this.serial(async () => {
      if (!TOKEN.test(token)) return failure('token-unknown', {})
      try {
        return await this.installStaged(token, appVersion)
      } finally {
        await this.removeStaged(token)
      }
    })
  }

  /** 설치된 것은 remove op 를 기록하고(같은 id 의 보류 설치는 버린다), 보류 설치만 있으면 그 보류를 취소한다 */
  remove(id: string): Promise<RemoveResult> {
    return this.serial(() => this.removeNow(id))
  }

  /** 부팅 때 확장이 올라오기 전에 한 번 — 비정상 종료 복구 → id 별 마지막 op 적용 → ops 비우기 → 남은 임시물 청소. 던지지 않는다 */
  applyPending(): Promise<ApplyResult> {
    return this.serial(() => this.applyPendingNow())
  }

  private async stageNow(zipPath: string, appVersion: string): Promise<StageResult> {
    const token = randomBytes(16).toString('hex')
    const copy = this.stagedZip(token)
    let result: ExtensionInspection
    try {
      await fs.mkdir(this.stagingDir, { recursive: true })
      await fs.copyFile(zipPath, copy)
      result = await inspectZip(copy, appVersion)
      if (result.problems.length > 0 || !result.manifest) {
        await fs.rm(copy, { force: true })
        return { result }
      }
      writeJsonFileSync(this.stagedMeta(token), { id: result.manifest.id, version: result.manifest.version })
    } catch (error) {
      await this.removeStaged(token)
      throw error
    }
    const version = this.pendingInstallVersion(result.manifest.id) ?? (await installedVersion(path.join(this.installedDir, result.manifest.id)))
    return version === undefined ? { token, result } : { token, result, existing: { version } }
  }

  private async removeStaged(token: string): Promise<void> {
    for (const file of [this.stagedZip(token), this.stagedMeta(token)]) {
      await fs.rm(file, { force: true }).catch((error: unknown) => console.warn(`[extensions] staging 을 지우지 못했다: ${messageOf(error)}`))
    }
  }

  /** stage 때 본 { id, version } — 없거나 모양이 틀리면 undefined */
  private readStagedMeta(token: string): { id: string; version: string } | undefined {
    try {
      const value = readJsonFileSync(this.stagedMeta(token), 'object') as Record<string, unknown> | undefined
      return value && isExtensionId(value.id) && typeof value.version === 'string' ? { id: value.id, version: value.version } : undefined
    } catch {
      return undefined
    }
  }

  private async installStaged(token: string, appVersion: string): Promise<InstallResult> {
    const staged = this.stagedZip(token)
    const expected = this.readStagedMeta(token)
    if (!expected || !(await exists(staged))) return failure('token-unknown', {})
    const inspection = await inspectZip(staged, appVersion).catch((error: unknown) => error as Error)
    if (inspection instanceof Error) return failure('unpack-failed', { message: inspection.message })
    if (inspection.problems.length > 0 || !inspection.manifest) return failure('rejected', { problems: inspection.problems })
    const { id, version } = inspection.manifest
    if (id !== expected.id || version !== expected.version) {
      return failure('staged-mismatch', { expected: `${expected.id}@${expected.version}`, actual: `${id}@${version}` })
    }

    const temp = path.join(this.pendingInstallDir, `${id}${TEMP_MARK}${token}`)
    try {
      // server 권한 확장은 상한이 크고(이슈 #537) 동봉한 런타임을 실행해야 해서 실행 비트를 살린다
      await unpackZip(staged, temp, limitsFor(EXTENSION_LIMITS, inspection.manifest.permissions), { executable: inspection.manifest.server !== undefined })
    } catch (error) {
      await fs.rm(temp, { recursive: true, force: true })
      return failure('unpack-failed', { message: messageOf(error) })
    }
    const problem = await verifyUnpacked(temp, id, appVersion)
    if (problem) {
      await fs.rm(temp, { recursive: true, force: true })
      return failure('verify-failed', { message: problem })
    }

    let ops: ExtensionPendingOp[]
    try {
      ops = this.readOps()
    } catch (error) {
      await fs.rm(temp, { recursive: true, force: true })
      return failure('io-failed', { message: messageOf(error) })
    }
    const target = path.join(this.pendingInstallDir, id)
    try {
      await fs.rm(target, { recursive: true, force: true })
      await fs.rename(temp, target)
      this.writeOps([...ops.filter((op) => op.id !== id), { op: 'install', id, version }])
    } catch (error) {
      await fs.rm(temp, { recursive: true, force: true })
      await fs.rm(target, { recursive: true, force: true })
      return failure('io-failed', { message: messageOf(error) })
    }
    return { ok: true, id, version }
  }

  private async removeNow(id: string): Promise<RemoveResult> {
    if (!isExtensionId(id)) return failure('id-invalid', { value: id })
    try {
      const ops = this.readOps()
      const others = ops.filter((op) => op.id !== id)
      const installed = await isDirectory(path.join(this.installedDir, id))
      const pendingInstall = finalOps(ops).get(id)?.op === 'install'
      if (!installed && !pendingInstall) return failure('not-installed', { id })
      await fs.rm(path.join(this.pendingInstallDir, id), { recursive: true, force: true })
      this.writeOps(installed ? [...others, { op: 'remove', id }] : others)
      return { ok: true }
    } catch (error) {
      return failure('io-failed', { message: messageOf(error) })
    }
  }

  private async applyPendingNow(): Promise<ApplyResult> {
    const result: ApplyResult = { applied: [], failed: [] }
    await this.recoverOld()

    let ops: ExtensionPendingOp[]
    try {
      ops = this.readOps()
    } catch (error) {
      // 내용이 깨진 것은 readJsonFileSync 가 옮기고 빈 목록을 준다 — 여기는 읽기 자체가 안 되는 경우(EACCES 등). 보류 폴더도 그대로 둔다
      console.warn(`[extensions] 보류 작업 목록을 읽지 못했다 (${messageOf(error)}) — 이번 부팅엔 적용하지 않는다`)
      await removeChildren(this.stagingDir)
      return result
    }

    for (const op of finalOps(ops).values()) {
      const reason = op.op === 'install' ? await this.applyInstall(op) : await this.applyRemove(op.id)
      if (reason === undefined) result.applied.push(op)
      else result.failed.push({ id: op.id, reason })
    }
    if (ops.length > 0) {
      try {
        this.writeOps([])
      } catch (error) {
        console.warn(`[extensions] 보류 작업 목록을 비우지 못했다 (${messageOf(error)})`)
      }
    }
    // op 를 다 썼으니 pending/install 에 남은 것(실패한 보류·.tmp-*)은 다시 쓰이지 않는다
    await removeChildren(this.pendingInstallDir)
    await removeChildren(this.stagingDir)
    for (const failed of result.failed) console.warn(`[extensions] ${failed.id} 보류 작업 실패: ${failed.reason}`)
    return result
  }

  /** installed/* — 점으로 시작하는 폴더(.old-* 포함)는 뺀다. 폴더 하나가 깨져도 그 항목만 problems. 던지지 않는다 */
  async listInstalled(appVersion: string): Promise<InstalledExtension[]> {
    let names: string[]
    try {
      names = (await fs.readdir(this.installedDir, { withFileTypes: true }))
        .filter((dirent) => dirent.isDirectory() && !dirent.name.startsWith('.'))
        .map((dirent) => dirent.name)
        .sort()
    } catch {
      return []
    }
    return Promise.all(names.map((name) => readInstalled(path.join(this.installedDir, name), name, appVersion)))
  }

  /** 설치된 확장의 진입 HTML (이슈 #511) — 화면이 격리된 iframe 에 싣는다(메인은 실행하지 않는다). 설치 때 검증했어도 그 뒤 디스크가 바뀔 수 있어
   *  읽을 때마다 다시 본다: id 형식 · entry 경로 규칙(isEntryPath) · .html/.htm · 실제 경로(realpath)가 설치 폴더 안 · 일반 파일(lstat) · 크기 상한.
   *  읽기 전용이라 줄에 서지 않는다(부르는 서비스가 자기 줄에서 부른다). 던지지 않는다 */
  async readEntry(id: string, entry: string): Promise<ReadEntryResult> {
    if (!isExtensionId(id)) return failure('id-invalid', { value: id })
    if (!isEntryPath(entry)) return failure('entry-unsafe', { entry })
    if (!/\.html?$/i.test(entry)) return failure('entry-not-html', { entry })
    const read = await readInsideFile(path.join(this.installedDir, id), entry, EXTENSION_LIMITS.entryBytes)
    return read.ok ? { ok: true, html: read.bytes.toString('utf8') } : read
  }

  /** 설치된 언어 팩의 번들 (이슈 #525) — readEntry 와 같은 안전한 읽기(경로·심볼릭 링크·일반 파일·크기 localeBytes) 뒤 parseLocaleBundle 로 거른다.
   *  읽기 전용이라 줄에 서지 않는다. 던지지 않는다 */
  async readLocale(id: string, entry: string): Promise<ReadLocaleResult> {
    if (!isExtensionId(id)) return failure('id-invalid', { value: id })
    if (!isEntryPath(entry)) return failure('entry-unsafe', { entry })
    return readLocaleFile(path.join(this.installedDir, id), entry)
  }

  /** 다음 부팅에 적용될 보류 작업 — id 별 마지막 op. 던지지 않는다 */
  pendingState(): Record<string, 'install' | 'remove'> {
    try {
      return Object.fromEntries([...finalOps(this.readOps())].map(([id, op]) => [id, op.op]))
    } catch {
      return {}
    }
  }

  // --- 부팅 적용 ---

  /** `.del-*` 는 마저 지운다. `.old-<id>-<시각>` — installed/<id> 가 없으면 가장 최근 것을 되돌리고, 나머지는 지운다 */
  private async recoverOld(): Promise<void> {
    let names: string[]
    try {
      names = await fs.readdir(this.installedDir)
    } catch {
      return
    }
    for (const name of names.filter((name) => DELETING.test(name))) {
      await fs.rm(path.join(this.installedDir, name), { recursive: true, force: true }).catch((error: unknown) => {
        console.warn(`[extensions] ${name} 을 지우지 못했다: ${messageOf(error)}`)
      })
    }
    const olds = names
      .map((name) => ({ name, match: OLD.exec(name) }))
      .filter((item) => item.match !== null)
      .map(({ name, match }) => ({ name, id: match![1]!, time: Number(match![2]) }))
      .sort((a, b) => b.time - a.time)
    for (const old of olds) {
      const from = path.join(this.installedDir, old.name)
      const current = path.join(this.installedDir, old.id)
      try {
        if (await exists(current)) await fs.rm(from, { recursive: true, force: true })
        else await fs.rename(from, current)
      } catch (error) {
        console.warn(`[extensions] ${old.name} 복구 실패: ${messageOf(error)}`)
      }
    }
  }

  /** 실패 사유 또는 undefined(성공). 실패하면 installed/<id> 는 이전 그대로다 */
  private async applyInstall(op: Extract<ExtensionPendingOp, { op: 'install' }>): Promise<string | undefined> {
    const source = path.join(this.pendingInstallDir, op.id)
    const current = path.join(this.installedDir, op.id)
    if (!(await isDirectory(source))) {
      // 앞선 부팅이 2) 까지 하고 죽었다 — 이미 이 버전이 올라가 있다
      if ((await installedVersion(current)) === op.version) return undefined
      return 'pending folder missing'
    }
    const old = path.join(this.installedDir, `.old-${op.id}-${Date.now()}`)
    let moved = false
    try {
      await fs.mkdir(this.installedDir, { recursive: true })
      if (await exists(current)) {
        await fs.rename(current, old)
        moved = true
      }
      await fs.rename(source, current)
    } catch (error) {
      if (moved) {
        // 되돌리기마저 실패하면 .old 가 남는다 — 다음 부팅의 recoverOld 가 되돌린다
        await fs.rename(old, current).catch((rollback: unknown) => console.warn(`[extensions] ${op.id} 롤백 실패: ${messageOf(rollback)}`))
      }
      return messageOf(error)
    }
    if (moved) await fs.rm(old, { recursive: true, force: true }).catch(() => {}) // 남으면 다음 부팅이 지운다
    return undefined
  }

  private async applyRemove(id: string): Promise<string | undefined> {
    const current = path.join(this.installedDir, id)
    if (!(await exists(current))) return undefined
    const deleting = path.join(this.installedDir, `.del-${id}-${Date.now()}`)
    try {
      await fs.rename(current, deleting)
    } catch (error) {
      return messageOf(error)
    }
    // installed/<id> 는 이미 없다(목록·올리기에서 빠진다) — 지우다 남은 것은 다음 부팅의 recoverOld 가 마저 지운다
    await fs.rm(deleting, { recursive: true, force: true }).catch((error: unknown) => {
      console.warn(`[extensions] ${id} 폴더를 다 지우지 못했다 (다음 부팅에 다시 지운다): ${messageOf(error)}`)
    })
    return undefined
  }

  // --- ops.json ---

  /** 내용이 깨졌으면 옆으로 옮기고 빈 목록, 모양이 틀린 줄은 버린다. 읽기 자체가 안 되면 던진다 */
  private readOps(): ExtensionPendingOp[] {
    const value = readJsonFileSync(this.opsFile, 'array') as unknown[] | undefined
    return (value ?? []).filter(isPendingOp)
  }

  private writeOps(ops: ExtensionPendingOp[]): void {
    writeJsonFileSync(this.opsFile, ops)
  }

  private pendingInstallVersion(id: string): string | undefined {
    try {
      const op = finalOps(this.readOps()).get(id)
      return op?.op === 'install' ? op.version : undefined
    } catch {
      return undefined
    }
  }
}

function isPendingOp(value: unknown): value is ExtensionPendingOp {
  if (typeof value !== 'object' || value === null) return false
  const op = value as Record<string, unknown>
  if (!isExtensionId(op.id)) return false
  return op.op === 'remove' || (op.op === 'install' && typeof op.version === 'string')
}

/** id 별 마지막 op */
function finalOps(ops: readonly ExtensionPendingOp[]): Map<string, ExtensionPendingOp> {
  const map = new Map<string, ExtensionPendingOp>()
  for (const op of ops) {
    map.delete(op.id)
    map.set(op.id, op)
  }
  return map
}

/** 풀고 난 폴더를 다시 본다 — 심볼릭 링크·특수 파일 없음, 실제 경로가 폴더 안, extension.json 이 맞고 id 가 같다, entry 가 일반 파일 */
async function verifyUnpacked(dir: string, id: string, appVersion: string): Promise<string | undefined> {
  try {
    const real = await fs.realpath(dir)
    const walk = async (folder: string): Promise<string | undefined> => {
      for (const name of await fs.readdir(folder)) {
        const file = path.join(folder, name)
        const stat = await fs.lstat(file)
        if (stat.isSymbolicLink()) return `symlink ${name}`
        if (!stat.isDirectory() && !stat.isFile()) return `not a regular file ${name}`
        if (!(await fs.realpath(file)).startsWith(real + path.sep)) return `outside ${name}`
        if (stat.isDirectory()) {
          const problem = await walk(file)
          if (problem) return problem
        }
      }
      return undefined
    }
    const problem = await walk(dir)
    if (problem) return problem
    const checked = await readInstalled(dir, id, appVersion)
    if (checked.problems.length > 0) return checked.problems.map((p) => p.code).join(', ')
    return undefined
  } catch (error) {
    return messageOf(error)
  }
}

/** 폴더의 extension.json 을 검증 — id 는 폴더 이름(expectedId)과 같아야 하고, entry 는 일반 파일이어야 한다 */
async function readInstalled(dir: string, expectedId: string, appVersion: string): Promise<InstalledExtension> {
  let text: string
  try {
    text = await fs.readFile(path.join(dir, MANIFEST_FILE), 'utf8')
  } catch {
    return { id: expectedId, problems: [{ code: 'manifest-missing', params: {} }] }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { id: expectedId, problems: [{ code: 'manifest-invalid', params: { message: messageOf(error) } }] }
  }
  const { manifest, problems } = checkManifest(value, appVersion)
  if (!manifest) return { id: expectedId, problems }
  if (manifest.id !== expectedId) return { id: expectedId, problems: [{ code: 'id-mismatch', params: { folder: expectedId, id: manifest.id } }] }
  const entry = await fs.lstat(path.join(dir, manifest.entry)).catch(() => undefined)
  if (!entry?.isFile()) return { id: expectedId, problems: [{ code: 'entry-missing', params: { entry: manifest.entry } }] }
  if (manifest.type === 'locale') {
    // 언어 팩은 번들도 다시 본다 (이슈 #525) — 깨진 번들의 팩은 failed 로 남아 언어 선택지에 나오지 않는다
    const read = await readLocaleFile(dir, manifest.entry)
    if (!read.ok) return { id: expectedId, problems: [localeProblem(read.failure)] }
  }
  return { id: expectedId, manifest, problems: [] }
}

/** 폴더 안의 파일을 읽는다 — 실제 경로(realpath)가 폴더 안, 일반 파일(lstat), 크기 상한(확인과 읽기 사이에 커졌을 때도). 던지지 않는다 */
export async function readInsideFile(dir: string, entry: string, limit: number): Promise<{ ok: true; bytes: Buffer } | { ok: false; failure: ExtensionStoreFailure }> {
  const file = path.join(dir, entry)
  try {
    const [realDir, realFile, stat] = await Promise.all([fs.realpath(dir), fs.realpath(file), fs.lstat(file)])
    if (!realFile.startsWith(realDir + path.sep) || !stat.isFile()) return failure('entry-unsafe', { entry })
    if (stat.size > limit) return failure('entry-too-large', { bytes: stat.size, limit })
    const bytes = await fs.readFile(realFile)
    // 확인과 읽기 사이에 커졌을 수 있다
    if (bytes.length > limit) return failure('entry-too-large', { bytes: bytes.length, limit })
    return { ok: true, bytes }
  } catch (error) {
    return failure('entry-unreadable', { message: messageOf(error) })
  }
}

async function readLocaleFile(dir: string, entry: string): Promise<ReadLocaleResult> {
  const read = await readInsideFile(dir, entry, EXTENSION_LIMITS.localeBytes)
  if (!read.ok) return read
  const parsed = parseLocaleBundle(read.bytes.toString('utf8'))
  return 'error' in parsed ? failure('locale-unreadable', { message: parsed.error }) : { ok: true, messages: parsed.messages }
}

/** 번들 읽기 실패 → 설치 폴더 재검증의 사유 */
function localeProblem(failed: ExtensionStoreFailure): ExtensionProblem {
  switch (failed.code) {
    case 'entry-too-large':
      return { code: 'locale-too-large', params: failed.params }
    case 'locale-unreadable':
    case 'entry-unreadable':
      return { code: 'locale-unreadable', params: failed.params }
    default:
      return { code: 'locale-unreadable', params: { message: failed.code } }
  }
}

/** 폴더의 extension.json 의 version — 못 읽으면 undefined */
async function installedVersion(dir: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(dir, MANIFEST_FILE), 'utf8')) as { version?: unknown }
    return typeof value.version === 'string' ? value.version : undefined
  } catch {
    return undefined
  }
}

async function removeChildren(dir: string): Promise<void> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  for (const name of names) {
    await fs.rm(path.join(dir, name), { recursive: true, force: true }).catch((error: unknown) => {
      console.warn(`[extensions] 임시물 ${name} 을 지우지 못했다: ${messageOf(error)}`)
    })
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.lstat(file).then(() => true, () => false)
}

async function isDirectory(file: string): Promise<boolean> {
  return fs.lstat(file).then((stat) => stat.isDirectory(), () => false)
}

function failure<C extends ExtensionStoreFailure['code']>(code: C, params: Extract<ExtensionStoreFailure, { code: C }>['params']): { ok: false; failure: ExtensionStoreFailure } {
  return { ok: false, failure: { code, params } as ExtensionStoreFailure }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
