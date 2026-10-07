import type { Context } from 'cordis'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import './chat.ts'
import './llm.ts'
import { insideOf, realDirectory } from './projectPath.ts'
import { countLines } from './toolDiffs.ts'
import type { FileDiff } from '../../shared/contract.ts'

// 명령으로 바뀐 파일 (이슈 #213) — "고친 파일" 카드는 도구 diff(edit·write·apply_patch)만 봐서 sed·포매터·코드 생성기·`!명령` 으로 바뀐 파일이
// 빠졌다. 턴 시작('chat/before-send')과 끝('chat/after-turn') **두 번만** 프로젝트 폴더의 git 상태를 떠서 그 차이를 턴 끝 진행 줄 하나
// (kind 'changes')로 싣는다. 도구 diff 와 합치는 것(겹치면 도구 쪽)은 화면(renderer/changedFiles.ts)이 한다. 엔진의 스텝마다 도는 snapshot 은
// 비용 때문에 꺼 두었다(01ad) — 그 대신이다. dsh 의 "턴 앞뒤 작업 트리 비교" 아이디어만 가져왔다(코드는 새로 썼다).
//
// - 엔진을 거치지 않는다: git 을 메인이 직접 띄운다. 셸을 거치지 않는 execFile — fileIndex.ts(rg)와 같은 모양이다. exec.ts(execShell)는
//   로그인 셸로 띄워(`$SHELL -lc`) 뜨는 데만 수백 ms 이고 인자를 셸 글로 이어야 해서 턴 시작마다 부르기에 맞지 않는다
// - 폴더는 ctx.llm 의 engineFolder 문(folderProblem — 없는 폴더·엔진 플러그인 파일이 있는 폴더, 이슈 #101)을 지나고 realDirectory 한 것만
// - git 저장소가 아니면(위로 올라가며 .git 이 없으면) git 을 아예 띄우지 않는다. git 이 없거나·실패하거나·시간을 넘기면 조용히 건너뛴다
//   (줄이 없다 — 카드는 원래대로 "도구로 고친 파일만" 이라고 말한다)
// - 무엇을 "바뀜" 으로 보나: `git status --porcelain -z --untracked-files=all` 에 든 파일(더러운 것 + untracked, .gitignore 된 것은 git 이
//   안 보므로 `.env` 같은 비밀 파일은 자연히 빠진다)마다 시작 때 내용 해시를 쥔다. 끝에 다시 떠서
//   · 시작 때 목록에 없던 파일(= 그때 HEAD 와 같았다) → `git diff HEAD -- 파일` 이 비어 있지 않으면 이 턴의 변경. untracked 면 새 파일
//   · 시작 때 목록에 있던 파일(턴 전부터 더러웠다) → 해시가 달라졌을 때만. patch 는 시작 때 쥔 내용과 지금 내용의 diff(`--no-index`)라
//     턴 전의 변경은 섞이지 않는다
// - git 은 읽기만 한다: GIT_OPTIONAL_LOCKS=0(status 가 index 를 새로 쓰지 않는다 — 같은 때 AI 가 돌리는 git 과 index.lock 으로 부딪히지 않게),
//   core.fsmonitor=false(저장소 설정의 fsmonitor 명령을 띄우지 않는다), diff 는 --no-ext-diff·--no-textconv(설정된 외부 프로그램을 안 띄운다).
//   **남은 것**: 저장소 설정에 clean filter(.gitattributes + filter.<이름>.clean)가 있으면 status·diff 가 그 명령을 띄울 수 있다 — 끌 방법이
//   이름마다라 막지 않았다 (그 설정은 클론으로 오지 않고 그 기계에서 누군가 써야 생긴다)
//
// 상한 (큰 저장소에서 턴 시작이 눈에 띄게 늦어지지 않게):
// - status 한 번 STATUS_TIMEOUT_MS·출력 STATUS_MAX_BYTES — 넘으면 그 턴은 건너뛴다(시작) / 줄 없음(끝)
// - 시작 때 목록이 MAX_ENTRIES 를 넘으면(턴 전부터 더러운 파일이 너무 많다 — 해시를 다 뜰 수 없다) 비교를 포기하고 끝에 빈 목록 + truncated
// - 해시는 HASH_MAX_BYTES 이하 파일만·합 HASH_BUDGET_BYTES 까지(넘으면 크기+mtime 으로 가른다), 내용은 KEEP_MAX_BYTES 이하만·합 KEEP_BUDGET_BYTES
//   까지 쥔다(못 쥔 파일이 바뀌면 이전 내용을 모른다 — unknownBefore)
// - 끝에서 실을 파일은 MAX_FILES 개·END_BUDGET_MS 까지 — 넘으면 truncated(카드가 "변경이 너무 많아 일부만 보입니다")
// 같은 프로젝트에서 두 대화가 동시에 돌면 서로의 변경이 섞인다(폴더 하나를 보므로 가를 수 없다). 다시 연 대화에는 없다(엔진 기록이 아니다)

const STATUS_TIMEOUT_MS = 1_500
const STATUS_MAX_BYTES = 1024 * 1024
const DIFF_TIMEOUT_MS = 3_000
const DIFF_MAX_BYTES = 1024 * 1024
const END_BUDGET_MS = 8_000
const MAX_ENTRIES = 1_000
const MAX_FILES = 50
const HASH_MAX_BYTES = 1024 * 1024
const HASH_BUDGET_BYTES = 32 * 1024 * 1024
const KEEP_MAX_BYTES = 256 * 1024
const KEEP_BUDGET_BYTES = 8 * 1024 * 1024

export interface SnapshotOptions {
  /** git 실행 파일 (기본: PATH 의 git) */
  git?: string
  /** 시작 때 목록 상한 */
  maxEntries?: number
  /** 끝에 실을 파일 수 상한 */
  maxFiles?: number
}

/** 파일 하나의 시작 때 모습 — id 는 missing·other(파일 아님)·link:대상·sha1:해시·stat:크기:mtime. content 는 쥘 수 있었을 때만 */
interface Entry {
  id: string
  content?: Buffer
}

export interface Snapshot {
  /** 세션 폴더 (realpath) */
  workdir: string
  /** 저장소 맨 위 — status 의 경로가 이 기준이다 */
  top: string
  git: string
  maxFiles: number
  /** 시작 때 status 에 든 파일(세션 폴더 기준 상대 경로) → 모습. undefined: 상한을 넘어 비교를 포기했다 */
  entries: Map<string, Entry> | undefined
}

export interface CommandChanges {
  diffs: FileDiff[]
  truncated: boolean
}

/** 턴 시작 스냅숏. git 저장소가 아니거나 git 을 못 띄웠거나 시간을 넘기면 undefined (던지지 않는다) */
export async function takeSnapshot(workdir: string, options: SnapshotOptions = {}): Promise<Snapshot | undefined> {
  const top = await repoTop(workdir)
  if (!top) return undefined
  const base = { workdir, top, git: options.git ?? 'git', maxFiles: options.maxFiles ?? MAX_FILES }
  const listed = await status(base)
  if (!listed) return undefined
  if (listed.size > (options.maxEntries ?? MAX_ENTRIES)) return { ...base, entries: undefined }
  const budget = newBudget()
  const entries = new Map<string, Entry>()
  for (const rel of listed.keys()) entries.set(rel, await identify(path.join(workdir, rel), budget))
  return { ...base, entries }
}

/** 시작 스냅숏 이후 바뀐 파일 — 끝의 status 를 못 뜨면 undefined (던지지 않는다) */
export async function changesSince(start: Snapshot): Promise<CommandChanges | undefined> {
  if (!start.entries) return { diffs: [], truncated: true }
  const listed = await status(start)
  if (!listed) return undefined
  const deadline = Date.now() + END_BUDGET_MS
  const budget = newBudget()
  const diffs: FileDiff[] = []
  const scratch = new Scratch()
  try {
    for (const rel of new Set([...listed.keys(), ...start.entries.keys()])) {
      if (Date.now() > deadline) return { diffs, truncated: true }
      const before = start.entries.get(rel)
      const diff = before ? await changedSinceStart(start, rel, before, budget, scratch) : await changedFromHead(start, rel, listed.get(rel) === true, scratch)
      if (!diff) continue
      if (diffs.length >= start.maxFiles) return { diffs, truncated: true } // 하나 더 바뀐 것이 있다
      diffs.push(diff)
    }
    return { diffs, truncated: false }
  } finally {
    await scratch.remove()
  }
}

/** 턴 전부터 status 에 있던 파일 — 모습이 그대로면 undefined. patch 는 시작 때 쥔 내용 → 지금 */
async function changedSinceStart(start: Snapshot, rel: string, before: Entry, budget: Budget, scratch: Scratch): Promise<FileDiff | undefined> {
  const file = path.join(start.workdir, rel)
  const after = await identify(file, budget)
  if (after.id === before.id || after.id === 'other' || before.id === 'other') return undefined
  const existed = before.id !== 'missing'
  const exists = after.id !== 'missing'
  const status: FileDiff['status'] = !existed ? 'added' : !exists ? 'deleted' : 'modified'
  if (existed && !before.content) return { path: rel, status, added: 0, removed: 0, patch: '', unknownBefore: true }
  const patch = await noIndexPatch(start, await scratch.file(before.content ?? Buffer.alloc(0)), exists ? file : await scratch.file(Buffer.alloc(0)))
  if (patch === null && existed === exists) return undefined // 모습은 달랐지만(크기+mtime 으로 갈랐다) 내용은 같다 (빈 파일을 만들거나 지운 것은 바뀐 것)
  return diffOf(rel, status, patch ?? '')
}

/** 턴 시작 때 HEAD 와 같았던 파일 — untracked 면 새 파일, 아니면 HEAD 와의 diff. 비어 있으면(인덱스만 바뀜) undefined */
async function changedFromHead(start: Snapshot, rel: string, untracked: boolean, scratch: Scratch): Promise<FileDiff | undefined> {
  const file = path.join(start.workdir, rel)
  if (untracked) {
    if ((await identify(file, { hash: 0, keep: 0 })).id === 'other') return undefined
    const patch = await noIndexPatch(start, await scratch.file(Buffer.alloc(0)), file)
    return diffOf(rel, 'added', patch ?? '') // null: 빈 새 파일
  }
  const out = await runGit(start.git, start.workdir, ['diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--', rel], DIFF_TIMEOUT_MS, DIFF_MAX_BYTES)
  if (!out) return diffOf(rel, (await identify(file, { hash: 0, keep: 0 })).id === 'missing' ? 'deleted' : 'modified', '') // 너무 크거나 시간을 넘겼다
  if (out.code !== 0 || !out.stdout) return undefined
  const status: FileDiff['status'] = /^new file mode/m.test(out.stdout) ? 'added' : /^deleted file mode/m.test(out.stdout) ? 'deleted' : 'modified'
  return diffOf(rel, status, hunks(out.stdout))
}

function diffOf(rel: string, status: FileDiff['status'], patch: string): FileDiff {
  return { path: rel, status, ...countLines(patch), patch }
}

/** 두 파일의 diff 의 hunk 부분 — 같으면 null, git 을 못 썼으면(너무 큼·시간 초과) undefined. 바이너리는 hunk 가 없어 '' 다 */
async function noIndexPatch(start: Snapshot, from: string, to: string): Promise<string | null | undefined> {
  const out = await runGit(start.git, start.workdir, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--', from, to], DIFF_TIMEOUT_MS, DIFF_MAX_BYTES)
  if (!out || out.code > 1) return undefined
  return out.code === 0 ? null : hunks(out.stdout)
}

/** 첫 `@@` 부터 — 머리(diff --git·index·---·+++)는 임시 파일 이름이라 뗀다. 화면(diffRows)도 @@ 앞은 건너뛴다 */
function hunks(text: string): string {
  const at = text.search(/^@@/m)
  return at < 0 ? '' : text.slice(at)
}

/** 세션 폴더(또는 그 위)에서 `.git` 이 있는 폴더 — 없으면 git 저장소가 아니다 (git 을 띄우지 않고 가른다) */
async function repoTop(workdir: string): Promise<string | undefined> {
  for (let at = workdir; ; at = path.dirname(at)) {
    try {
      await fs.lstat(path.join(at, '.git'))
      return at
    } catch {
      if (path.dirname(at) === at) return undefined
    }
  }
}

/** 세션 폴더 안의 status — 상대 경로 → untracked 인가. 못 뜨면 undefined */
async function status(snapshot: Pick<Snapshot, 'workdir' | 'top' | 'git'>): Promise<Map<string, boolean> | undefined> {
  const out = await runGit(
    snapshot.git,
    snapshot.workdir,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=all', '--', '.'],
    STATUS_TIMEOUT_MS,
    STATUS_MAX_BYTES,
  )
  if (!out || out.code !== 0) return undefined
  const listed = new Map<string, boolean>()
  const fields = out.stdout.split('\0')
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!
    if (field.length < 4) continue
    const code = field.slice(0, 2)
    if (code[0] === 'R' || code[0] === 'C') index++ // 옮긴 것은 원래 이름이 다음 칸에 온다 (--no-renames 라 안 오지만)
    const rel = insideOf(snapshot.workdir, path.join(snapshot.top, field.slice(3)))
    if (rel) listed.set(rel, code === '??' || listed.get(rel) === true)
  }
  return listed
}

interface Budget {
  hash: number
  keep: number
}

const newBudget = (): Budget => ({ hash: HASH_BUDGET_BYTES, keep: KEEP_BUDGET_BYTES })

/** 파일의 지금 모습 — 작으면 내용 해시(그리고 쥘 수 있으면 내용), 크면 크기+mtime */
async function identify(file: string, budget: Budget): Promise<Entry> {
  try {
    const stat = await fs.lstat(file)
    if (stat.isSymbolicLink()) return { id: `link:${await fs.readlink(file)}` }
    if (!stat.isFile()) return { id: 'other' }
    if (stat.size > HASH_MAX_BYTES || stat.size > budget.hash) return { id: `stat:${stat.size}:${stat.mtimeMs}` }
    const data = await fs.readFile(file)
    budget.hash -= data.length
    const entry: Entry = { id: `sha1:${createHash('sha1').update(data).digest('hex')}` }
    if (data.length <= KEEP_MAX_BYTES && data.length <= budget.keep) {
      budget.keep -= data.length
      entry.content = data
    }
    return entry
  } catch {
    return { id: 'missing' }
  }
}

/** `--no-index` 에 넘길 임시 파일들 — 처음 쓸 때 폴더를 만들고, 끝에 그 폴더만 지운다 */
class Scratch {
  private dir: string | undefined
  private count = 0

  async file(content: Buffer): Promise<string> {
    this.dir ??= await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-changes-'))
    const file = path.join(this.dir, String(++this.count))
    await fs.writeFile(file, content)
    return file
  }

  async remove(): Promise<void> {
    if (this.dir) await fs.rm(this.dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** git 한 번 — 셸 없이. 끝난 코드와 출력, 못 띄웠거나·시간을 넘겼거나·출력이 상한을 넘으면 undefined */
function runGit(git: string, cwd: string, args: string[], timeoutMs: number, maxBytes: number): Promise<{ code: number; stdout: string } | undefined> {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
  return new Promise((resolve) => {
    try {
      execFile(
        git,
        ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', '--literal-pathspecs', ...args],
        { cwd, env, timeout: timeoutMs, maxBuffer: maxBytes, encoding: 'utf8', windowsHide: true },
        (error, stdout) => {
          if (!error) return resolve({ code: 0, stdout })
          const code = (error as { code?: unknown }).code
          resolve(typeof code === 'number' && !error.killed ? { code, stdout } : undefined)
        },
      )
    } catch {
      resolve(undefined)
    }
  })
}

/** 'chat/before-send' 에 뜨고 'chat/after-turn' 에 비교해 그 턴의 진행 줄(ctx.chat.note)로 싣는다 — 대화마다 시작 스냅숏 하나 */
export function commandChanges(ctx: Context): void {
  const starts = new Map<string, Promise<Snapshot | undefined>>()
  let seq = 0
  ctx.on('chat/before-send', async (send) => {
    if (send.blocked !== undefined) return // 앞의 훅이 막았다 — 보내지 않는다
    const start = snapshotOf(ctx, send.project)
    starts.set(send.cid, start)
    await start // 엔진에 닿기 전에 떠야 AI 의 첫 변경이 시작 쪽에 섞이지 않는다
  })
  ctx.on('chat/after-turn', async (turn) => {
    const start = await starts.get(turn.cid)
    starts.delete(turn.cid)
    if (!start) return
    const found = await changesSince(start).catch(() => undefined)
    if (!found) return
    try {
      ctx.chat.note(turn.cid, { kind: 'changes', id: `changes_${++seq}`, diffs: found.diffs, ...(found.truncated && { truncated: true as const }) })
    } catch {
      // 기다리는 사이 내려갔다 (앱 종료)
    }
  })
}
commandChanges.inject = ['chat', 'llm']

/** engineFolder 문을 지난 폴더에서만 뜬다 */
async function snapshotOf(ctx: Context, project: string): Promise<Snapshot | undefined> {
  try {
    if (await ctx.llm.folderProblem(project)) return undefined
    const workdir = await realDirectory(project)
    return workdir ? await takeSnapshot(workdir) : undefined
  } catch {
    return undefined
  }
}
