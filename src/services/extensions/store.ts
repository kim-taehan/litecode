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
import { readJsonFileSync, writeJsonFileSync } from '../jsonFile.ts'
import { checkManifest, isExtensionId, MANIFEST_FILE } from './manifest.ts'
import { unpackZip } from './unpack.ts'
import { inspectZip } from './zipInspect.ts'

// 확장 저장소 (이슈 #480, 설계 docs/superpowers/specs/2026-10-19-extension-install-design.md 4절 "풀기·교체는 보류로 쌓고 다음 부팅 때") —
// 파일 작업만 한다. 루트는 부르는 쪽이 준다(host 는 `<userData>/extensions`). 레이아웃:
//   installed/<id>/          풀린 확장
//   pending/ops.json         보류 작업 목록 (id 마다 하나 — 뒤 작업이 앞 작업을 바꾼다)
//   pending/install/<id>/    풀어 둔 새 버전
//   staging/<token>.zip      고른 zip 의 앱 안 복사본
//
// 실행 중인 확장 파일은 건드리지 않는다 — 교체는 applyPending(부팅 때, 확장이 올라오기 전) 한 곳에서만. 교체는 모두 루트 안의 rename 이다
// (같은 볼륨 — 복사·이동이 아니라 원자적이고, Windows 에서도 폴더 rename 은 안의 파일이 열려 있지 않으면 된다. 부팅 전이라 열려 있지 않다).
//
// 업그레이드 순서와 비정상 종료 복구:
//   1) installed/<id> → installed/.old-<id>-<시각>   2) pending/install/<id> → installed/<id>   3) .old 삭제
//   2) 가 실패하면 1) 을 되돌린다. 어느 지점에서 죽어도 다음 부팅의 복구가 맞춘다 — `.old-<id>-*` 가 있는데 installed/<id> 가 없으면
//   1)~2) 사이에서 죽은 것(가장 최근 .old 를 되돌린다), 있으면 2)~3) 사이(.old 를 지운다). ops.json 은 모든 작업이 끝난 뒤에 비우므로
//   죽은 부팅의 작업은 다음 부팅에 다시 적용된다. pending/install/<id> 가 이미 옮겨져 없는데 installed/<id> 가 그 op 의 버전이면 끝난 작업으로 본다.
//
// 부팅 경로(applyPending·listInstalled·pendingState)는 던지지 않는다 (CLAUDE.md 함정 4). install·remove 는 실패를 구조화된 사유로 돌려준다

const TOKEN = /^[0-9a-f]{32}$/
const OLD = /^\.old-([a-z0-9-]{3,40})-(\d+)$/
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

  /** 검사하고, 통과하면 zip 을 staging 에 복사해 token 을 준다. 사유가 있으면 아무것도 만들지 않는다 */
  async stage(zipPath: string, appVersion: string): Promise<StageResult> {
    const result = await inspectZip(zipPath, appVersion)
    if (result.problems.length > 0 || !result.manifest) return { result }
    const token = randomBytes(16).toString('hex')
    await fs.mkdir(this.stagingDir, { recursive: true })
    await fs.copyFile(zipPath, this.stagedZip(token))
    const version = this.pendingInstallVersion(result.manifest.id) ?? (await installedVersion(path.join(this.installedDir, result.manifest.id)))
    return version === undefined ? { token, result } : { token, result, existing: { version } }
  }

  async cancel(token: string): Promise<void> {
    if (TOKEN.test(token)) await fs.rm(this.stagedZip(token), { force: true })
  }

  /** staging 복사본을 다시 검사하고 pending/install/<id> 에 풀어 op 를 기록한다. 실패해도 staging 은 남긴다(cancel·다음 부팅이 지운다) */
  async install(token: string, appVersion: string): Promise<InstallResult> {
    const staged = this.stagedZip(token)
    if (!TOKEN.test(token) || !(await exists(staged))) return failure('token-unknown', {})
    const inspection = await inspectZip(staged, appVersion).catch((error: unknown) => error as Error)
    if (inspection instanceof Error) return failure('unpack-failed', { message: inspection.message })
    if (inspection.problems.length > 0 || !inspection.manifest) return failure('rejected', { problems: inspection.problems })
    const { id, version } = inspection.manifest

    const temp = path.join(this.pendingInstallDir, `${id}${TEMP_MARK}${token}`)
    try {
      await unpackZip(staged, temp)
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
    await fs.rm(staged, { force: true })
    return { ok: true, id, version }
  }

  /** 설치된 것은 remove op 를 기록하고(같은 id 의 보류 설치는 버린다), 보류 설치만 있으면 그 보류를 취소한다 */
  async remove(id: string): Promise<RemoveResult> {
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

  /** 부팅 때 확장이 올라오기 전에 한 번 — 비정상 종료 복구 → id 별 마지막 op 적용 → ops 비우기 → 남은 임시물 청소. 던지지 않는다 */
  async applyPending(): Promise<ApplyResult> {
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

  /** 다음 부팅에 적용될 보류 작업 — id 별 마지막 op. 던지지 않는다 */
  pendingState(): Record<string, 'install' | 'remove'> {
    try {
      return Object.fromEntries([...finalOps(this.readOps())].map(([id, op]) => [id, op.op]))
    } catch {
      return {}
    }
  }

  // --- 부팅 적용 ---

  /** `.old-<id>-<시각>` — installed/<id> 가 없으면 가장 최근 것을 되돌리고, 나머지는 지운다 */
  private async recoverOld(): Promise<void> {
    let olds: { name: string; id: string; time: number }[]
    try {
      olds = (await fs.readdir(this.installedDir))
        .map((name) => ({ name, match: OLD.exec(name) }))
        .filter((item) => item.match !== null)
        .map(({ name, match }) => ({ name, id: match![1]!, time: Number(match![2]) }))
        .sort((a, b) => b.time - a.time)
    } catch {
      return
    }
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
    const old = path.join(this.installedDir, `.old-${id}-${Date.now()}`)
    try {
      await fs.rename(current, old)
    } catch (error) {
      return messageOf(error)
    }
    // 지우다 실패하면 .old 가 남고 installed/<id> 는 없다 — 다음 부팅의 recoverOld 가 되돌리므로 실패로 보고한다
    return fs.rm(old, { recursive: true, force: true }).then(() => undefined, (error: unknown) => messageOf(error))
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
  return { id: expectedId, manifest, problems: [] }
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
