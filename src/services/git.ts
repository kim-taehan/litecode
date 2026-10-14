import { Context, Service } from 'cordis'
import { execProgram } from './exec.ts'
import type { GitAction, GitBranch, GitCommit, GitFailure, GitFile, GitFileKind, GitResult, GitStatus, GitView } from '../../shared/git.ts'

// Git (ctx.git, 이슈 #290 — 시안 _workspace/mock-git/Git.dc.html). 시스템 git 을 인자 배열로 띄운다(exec.ts execProgram — 셸 글 없음).
// 화면(Git 탭)과 AI 도구(appMcp/tools/git.ts)가 같은 메서드를 쓴다. 엔진·Electron 을 모른다 — 폴더는 부르는 쪽이 준다(IPC 는 등록된 프로젝트만).
//
// - 명령은 저장소 루트(rev-parse --show-toplevel)에서 돈다 — status 의 경로가 루트 기준이라 stage·diff 도 같은 기준으로 받는다.
//   하위 저장소(서브모듈)는 보지 않는다(시안 "범위")
// - 경로는 `--` 뒤에, `--literal-pathspecs` 로 (`:(top)` 같은 pathspec 마법이 안 먹는다). 브랜치 이름·원격 주소는 `-` 로 시작하면 거절
// - 모든 실행에 GIT_TERMINAL_PROMPT=0·GCM_INTERACTIVE=never — 인증 창·물음을 띄우지 않는다. 프로세스는 새 세션(exec.ts detached)이라 ssh 도
//   터미널에서 암호를 못 묻고 실패한다 → "터미널에서 한 번 로그인" 안내(reason auth). 키체인·ssh-agent 처럼 묻지 않는 인증은 그대로 쓴다
// - 읽기는 GIT_OPTIONAL_LOCKS=0·core.fsmonitor=false·--no-ext-diff·--no-textconv (commandChanges.ts 와 같은 이유 — AI 가 돌리는 git 과
//   index.lock 으로 부딪히지 않고, 저장소 설정의 외부 프로그램을 띄우지 않는다)
// - 강제 push·rebase·reset --hard 는 없다. 가져오기는 merge(--no-rebase)이고, 충돌이면 git 이 멈춘 그대로 두고 알린다(대신 풀지 않는다).
//   원격 실패(연결·인증)는 git 이 로컬을 건드리기 전이다
// - 바꾸는 메서드는 끝나면(실패해도) 'git/changed' — 화면이 다시 읽는다

declare module 'cordis' {
  interface Context {
    git: GitService
  }
  interface Events {
    /** 그 폴더의 저장소 상태가 바뀌었을 수 있다 (화면·AI 의 작업 뒤) */
    'git/changed'(directory: string): void
  }
}

export interface GitConfig {
  /** git 실행 파일 (기본: PATH 의 git) */
  git?: string
}

const LOCAL_TIMEOUT_MS = 20_000
const REMOTE_TIMEOUT_MS = 90_000
const MAX_OUTPUT = 4 * 1024 * 1024
/** 화면·모델에 줄 diff 의 상한 */
export const GIT_DIFF_MAX = 200 * 1024
const LOG_LIMIT = 50

const READ_FLAGS = ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', '-c', 'color.ui=false']
const ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_MERGE_AUTOEDIT: 'no', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', LANGUAGE: 'C' }

interface Run {
  code: number | null
  stdout: string
  stderr: string
  /** git 을 띄우지 못했다 (없다) */
  missing: boolean
  timeout: boolean
}

class GitError extends Error {
  constructor(
    readonly reason: GitFailure,
    message: string,
    readonly conflicts?: string[],
  ) {
    super(message)
  }
}

/** 원격 명령의 실패 글 → 사유. 인증을 먼저 본다 (ssh 의 거절은 "Could not read from remote repository" 와 같이 온다) */
export function remoteFailure(stderr: string): GitFailure {
  if (/Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied \(|Host key verification failed|HTTP 40[13]|returned error: 40[13]|access denied/i.test(stderr)) return 'auth'
  if (/\[rejected\]|non-fast-forward|fetch first/i.test(stderr)) return 'rejected'
  if (/Could not resolve host|Connection refused|timed out|Network is unreachable|unable to access|Could not read from remote|does not appear to be a git repository|Connection reset|No route to host/i.test(stderr)) return 'network'
  return 'failed'
}

const firstLines = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join('\n')

/** `## main...origin/main [ahead 1, behind 2]` · `## No commits yet on main` · `## HEAD (no branch)` */
export function parseBranchLine(line: string): { branch?: string; upstream?: string; ahead: number; behind: number; hasCommits: boolean } {
  const head = line.replace(/^## /, '')
  const unborn = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(head)
  if (unborn) return { branch: unborn[1], ahead: 0, behind: 0, hasCommits: false }
  if (head.startsWith('HEAD (no branch)')) return { ahead: 0, behind: 0, hasCommits: true }
  const match = /^(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(head)!
  const track = match[3] ?? ''
  return {
    branch: match[1],
    upstream: match[2],
    ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
    hasCommits: true,
  }
}

const CONFLICT = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])
const kindOf = (letter: string): GitFileKind => (letter === 'D' ? 'D' : letter === 'A' || letter === 'C' ? 'A' : letter === 'R' ? 'R' : 'M')

/** `git status --porcelain=v1 -z --branch` 의 글 → 브랜치 줄 + 세 묶음 */
export function parseStatus(text: string): { branchLine: string; staged: GitFile[]; changed: GitFile[]; conflicts: GitFile[] } {
  const parts = text.split('\0')
  const staged: GitFile[] = []
  const changed: GitFile[] = []
  const conflicts: GitFile[] = []
  let branchLine = ''
  for (let index = 0; index < parts.length; index++) {
    const entry = parts[index]!
    if (!entry) continue
    if (entry.startsWith('## ')) {
      branchLine = entry
      continue
    }
    const xy = entry.slice(0, 2)
    const path = entry.slice(3)
    const x = xy[0]!
    const y = xy[1]!
    const from = x === 'R' || x === 'C' ? parts[++index] : undefined
    if (xy === '!!') continue
    if (xy === '??') {
      changed.push({ path, kind: 'U' })
      continue
    }
    if (CONFLICT.has(xy)) {
      conflicts.push({ path, kind: 'C' })
      continue
    }
    if (x !== ' ') staged.push({ path, kind: kindOf(x), ...(x === 'R' && from !== undefined && { from }) })
    if (y !== ' ') changed.push({ path, kind: kindOf(y) })
  }
  return { branchLine, staged, changed, conflicts }
}

/** `git diff --numstat -z` → 경로별 줄 수 (바이너리는 없다) */
export function parseNumstat(text: string): Map<string, { added: number; removed: number }> {
  const stats = new Map<string, { added: number; removed: number }>()
  const parts = text.split('\0')
  for (let index = 0; index < parts.length; index++) {
    const entry = parts[index]!
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(entry)
    if (!match) continue
    let path = match[3]!
    if (path === '') {
      index++ // 옛 경로
      path = parts[++index] ?? ''
    }
    if (match[1] !== '-') stats.set(path, { added: Number(match[1]), removed: Number(match[2]) })
  }
  return stats
}

const withStats = (files: GitFile[], stats: Map<string, { added: number; removed: number }>): GitFile[] => files.map((file) => ({ ...file, ...stats.get(file.path) }))

export class GitService extends Service {
  private readonly binary: string

  constructor(ctx: Context, config: GitConfig = {}) {
    super(ctx, 'git')
    this.binary = config.git ?? 'git'
  }

  private run(cwd: string, args: readonly string[], opts: { timeoutMs?: number; stdin?: string } = {}): Promise<Run> {
    let stdout = ''
    let stderr = ''
    const handle = execProgram({
      file: this.binary,
      args,
      cwd,
      timeoutMs: opts.timeoutMs ?? LOCAL_TIMEOUT_MS,
      env: ENV,
      stdin: opts.stdin,
      onOutput(stream, text) {
        if (stream === 'stdout') {
          if (stdout.length < MAX_OUTPUT) stdout += text
        } else if (stderr.length < MAX_OUTPUT) stderr += text
      },
    })
    return handle.done.then((end) => ({
      code: end.exitCode,
      stdout,
      stderr,
      missing: end.status === 'error' && /ENOENT|EACCES/.test(end.error ?? ''),
      timeout: end.status === 'timeout',
    }))
  }

  /** 저장소 루트 — git 이 없거나 저장소가 아니면 GitError */
  private async root(directory: string): Promise<string> {
    const found = await this.run(directory, ['rev-parse', '--show-toplevel'])
    if (found.missing) throw new GitError('missing', 'git not found')
    if (found.code !== 0) throw new GitError('not-repo', firstLines(found.stderr))
    return found.stdout.trim()
  }

  /** 루트에서 돌리고 실패면 던진다 */
  private async must(root: string, args: readonly string[], opts?: { timeoutMs?: number; stdin?: string }): Promise<string> {
    const result = await this.run(root, args, opts)
    if (result.missing) throw new GitError('missing', 'git not found')
    if (result.code !== 0) throw new GitError('failed', firstLines(result.stderr || result.stdout) || 'git failed')
    return result.stdout
  }

  private async exists(root: string, ref: string): Promise<boolean> {
    return (await this.run(root, ['rev-parse', '-q', '--verify', ref])).code === 0
  }

  /** 바꾸는 작업을 감싼다 — 실패를 GitResult 로, 끝나면 git/changed */
  private async act<T extends object>(directory: string, work: (root: string) => Promise<T>): Promise<GitResult<T>> {
    try {
      const root = await this.root(directory)
      return { ok: true, ...(await work(root)) }
    } catch (error) {
      if (error instanceof GitError) return { ok: false, reason: error.reason, message: error.message, ...(error.conflicts && { conflicts: error.conflicts }) }
      return { ok: false, reason: 'failed', message: (error as Error).message }
    } finally {
      this.ctx.emit('git/changed', directory)
    }
  }

  async view(directory: string): Promise<GitView> {
    let root: string
    try {
      root = await this.root(directory)
    } catch (error) {
      if (error instanceof GitError && (error.reason === 'missing' || error.reason === 'not-repo')) return { state: error.reason }
      throw error
    }
    const [status, unstaged, staged, remote, merging] = await Promise.all([
      this.must(root, [...READ_FLAGS, 'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all']),
      this.run(root, [...READ_FLAGS, 'diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv']),
      this.run(root, [...READ_FLAGS, 'diff', '--cached', '--numstat', '-z', '--no-ext-diff', '--no-textconv']),
      this.run(root, ['remote', 'get-url', 'origin']),
      this.exists(root, 'MERGE_HEAD'),
    ])
    const parsed = parseStatus(status)
    const branch = parseBranchLine(parsed.branchLine)
    const result: GitStatus = {
      state: 'ok',
      ...branch,
      ...(remote.code === 0 && remote.stdout.trim() && { remote: remote.stdout.trim() }),
      merging,
      staged: withStats(parsed.staged, parseNumstat(staged.stdout)),
      changed: withStats(parsed.changed, parseNumstat(unstaged.stdout)),
      conflicts: parsed.conflicts,
    }
    if (result.upstream === undefined) delete result.upstream
    if (result.branch === undefined) delete result.branch
    return result
  }

  /** 파일 하나(또는 path 없이 전체)의 unified diff. staged 면 stage 된 쪽, 아니면 작업 트리 쪽(새 파일은 통째로 추가). 상한에서 자른다 */
  async diff(directory: string, path?: string, staged = false): Promise<string> {
    const root = await this.root(directory)
    const base = ['--literal-pathspecs', ...READ_FLAGS, 'diff', '--no-ext-diff', '--no-textconv', ...(staged ? ['--cached'] : [])]
    let text = (await this.run(root, path ? [...base, '--', path] : base)).stdout
    if (!text && path && !staged) {
      // 새 파일(untracked) — 빈 것과 비교한다 (차이가 있으면 종료 코드 1)
      const untracked = await this.run(root, ['--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '--', path])
      if (untracked.stdout.trim()) text = (await this.run(root, [...READ_FLAGS, 'diff', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', path])).stdout
    }
    return text.length > GIT_DIFF_MAX ? text.slice(0, GIT_DIFF_MAX) : text
  }

  async log(directory: string, limit = LOG_LIMIT): Promise<GitCommit[]> {
    const root = await this.root(directory)
    if (!(await this.exists(root, 'HEAD'))) return []
    const [out, unpushed] = await Promise.all([
      this.must(root, [...READ_FLAGS, 'log', `-n${limit}`, '--format=%H%x1f%h%x1f%s%x1f%an%x1f%at%x1e']),
      this.run(root, ['rev-list', `-n${limit}`, 'HEAD', '--not', '--remotes']),
    ])
    const local = new Set(unpushed.stdout.split('\n').filter(Boolean))
    return out
      .split('\x1e')
      .map((record) => record.trim())
      .filter(Boolean)
      .map((record) => {
        const [hash = '', short = '', subject = '', author = '', time = '0'] = record.split('\x1f')
        return { hash, short, subject, author, time: Number(time) * 1000, pushed: !local.has(hash) }
      })
  }

  async branches(directory: string): Promise<GitBranch[]> {
    const root = await this.root(directory)
    const out = await this.must(root, ['for-each-ref', '--format=%(refname:short)%1f%(HEAD)%1f%(committerdate:unix)%1f%(upstream:short)%1f%(upstream:track)', 'refs/heads'])
    const rows = out.split('\n').filter(Boolean)
    const hasHead = await this.exists(root, 'HEAD')
    const branches = await Promise.all(
      rows.map(async (row): Promise<GitBranch> => {
        const [name = '', head = '', time = '0', upstream = '', track = ''] = row.split('\x1f')
        const current = head === '*'
        const unmerged = !current && hasHead ? Number((await this.run(root, ['rev-list', '--count', `HEAD..refs/heads/${name}`])).stdout.trim() || 0) : 0
        return {
          name,
          current,
          time: Number(time) * 1000,
          ...(upstream && { upstream }),
          ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
          behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
          unmerged,
        }
      }),
    )
    return branches.sort((a, b) => Number(b.current) - Number(a.current) || b.time - a.time)
  }

  stage(directory: string, paths: readonly string[]): Promise<GitResult> {
    return this.act(directory, async (root) => {
      if (paths.length === 0) return {}
      await this.must(root, ['--literal-pathspecs', 'add', '-A', '--', ...paths])
      return {}
    })
  }

  unstage(directory: string, paths: readonly string[]): Promise<GitResult> {
    return this.act(directory, async (root) => {
      if (paths.length === 0) return {}
      if (await this.exists(root, 'HEAD')) await this.must(root, ['--literal-pathspecs', 'reset', '-q', 'HEAD', '--', ...paths])
      else await this.must(root, ['--literal-pathspecs', 'rm', '--cached', '-r', '-q', '--', ...paths]) // 첫 커밋 전
      return {}
    })
  }

  /** stage 된 것을 커밋한다 (-a 없음) — 짧은 해시와 파일 수 */
  commit(directory: string, message: string): Promise<GitResult<{ short: string; files: number }>> {
    return this.act(directory, async (root) => {
      if (!message.trim()) throw new GitError('invalid', 'empty message')
      const staged = parseStatus(await this.must(root, [...READ_FLAGS, 'status', '--porcelain=v1', '-z'])).staged.length
      if (staged === 0) throw new GitError('nothing', 'nothing staged')
      const result = await this.run(root, ['commit', '-q', '-F', '-'], { stdin: message })
      if (result.code !== 0) {
        const text = firstLines(result.stderr || result.stdout)
        throw new GitError(/tell me who you are|empty ident|user\.email|user\.name/i.test(result.stderr) ? 'identity' : 'failed', text)
      }
      return { short: (await this.must(root, ['rev-parse', '--short', 'HEAD'])).trim(), files: staged }
    })
  }

  private async checkBranchName(root: string, name: string): Promise<void> {
    if (!name || name.startsWith('-') || (await this.run(root, ['check-ref-format', '--branch', name])).code !== 0) throw new GitError('invalid', name)
  }

  /** 새 브랜치를 만들고 옮겨 간다 (변경은 그대로 따라온다) */
  createBranch(directory: string, name: string): Promise<GitResult<{ branch: string }>> {
    return this.act(directory, async (root) => {
      await this.checkBranchName(root, name)
      await this.must(root, ['checkout', '-q', '-b', name])
      return { branch: name }
    })
  }

  /** 있는 로컬 브랜치로 옮긴다 — 변경이 덮이면 git 이 멈추고 아무것도 바꾸지 않는다(overwrite) */
  switchBranch(directory: string, name: string): Promise<GitResult<{ branch: string }>> {
    return this.act(directory, async (root) => {
      await this.checkBranchName(root, name)
      if (!(await this.exists(root, `refs/heads/${name}`))) throw new GitError('invalid', name)
      await this.checkout(root, ['checkout', '-q', name, '--'])
      return { branch: name }
    })
  }

  /** checkout — 변경이 덮이면 git 이 멈추고 아무것도 바꾸지 않는다(overwrite) */
  private async checkout(root: string, args: readonly string[]): Promise<void> {
    const result = await this.run(root, args)
    if (result.code !== 0) throw new GitError(/would be overwritten|commit your changes or stash/i.test(result.stderr) ? 'overwrite' : 'failed', firstLines(result.stderr))
  }

  /** 원격 브랜치 이름 (`origin/x`, 이름 순) — 원격의 HEAD(가리키는 ref)는 뺀다 (브랜치 팝업 #386) */
  async remoteBranches(directory: string): Promise<string[]> {
    const root = await this.root(directory)
    const out = await this.must(root, ['for-each-ref', '--format=%(refname)%1f%(symref)', 'refs/remotes'])
    return out
      .split('\n')
      .filter(Boolean)
      .map((row) => row.split('\x1f'))
      .filter(([ref = '', symref]) => !symref && !ref.endsWith('/HEAD'))
      .map(([ref = '']) => ref.slice('refs/remotes/'.length))
  }

  /** 원격 브랜치(`origin/x`)로 — 같은 이름의 로컬 브랜치가 있으면 그것으로, 없으면 추적 브랜치를 만들어 옮긴다 (#386) */
  switchRemote(directory: string, name: string): Promise<GitResult<{ branch: string }>> {
    return this.act(directory, async (root) => {
      const slash = name.indexOf('/')
      if (slash <= 0 || name.startsWith('-') || !(await this.exists(root, `refs/remotes/${name}`))) throw new GitError('invalid', name)
      const local = name.slice(slash + 1)
      await this.checkBranchName(root, local)
      if (await this.exists(root, `refs/heads/${local}`)) await this.checkout(root, ['checkout', '-q', local, '--'])
      else await this.checkout(root, ['checkout', '-q', '--track', '-b', local, `refs/remotes/${name}`, '--'])
      return { branch: local }
    })
  }

  /** 태그·커밋으로 — 분리된 HEAD (#386). 커밋을 못 찾으면 invalid */
  switchRevision(directory: string, revision: string): Promise<GitResult<{ short: string }>> {
    return this.act(directory, async (root) => {
      const rev = revision.trim()
      if (!rev || rev.startsWith('-')) throw new GitError('invalid', rev)
      const found = await this.run(root, ['rev-parse', '-q', '--verify', `${rev}^{commit}`])
      if (found.code !== 0) throw new GitError('invalid', rev)
      const hash = found.stdout.trim()
      await this.checkout(root, ['checkout', '-q', '--detach', hash, '--'])
      return { short: (await this.must(root, ['rev-parse', '--short', hash])).trim() }
    })
  }

  /** 로컬 브랜치 지우기 (합쳐지지 않아도 — 화면이 경고 카드로 먼저 묻는다). 지금 브랜치는 못 지운다 */
  deleteBranch(directory: string, name: string): Promise<GitResult> {
    return this.act(directory, async (root) => {
      await this.checkBranchName(root, name)
      await this.must(root, ['branch', '-D', name])
      return {}
    })
  }

  /** 작업 트리의 변경을 버린다 — stage 된 것은 남는다(index 로 되돌린다). 새 파일(untracked)은 지운다 */
  discard(directory: string, paths: readonly string[]): Promise<GitResult> {
    return this.act(directory, async (root) => {
      if (paths.length === 0) return {}
      const untracked = new Set(
        (await this.must(root, ['--literal-pathspecs', 'ls-files', '-z', '--others', '--exclude-standard', '--', ...paths])).split('\0').filter(Boolean),
      )
      const tracked = paths.filter((path) => !untracked.has(path))
      if (untracked.size > 0) await this.must(root, ['--literal-pathspecs', 'clean', '-f', '-q', '--', ...untracked])
      if (tracked.length > 0) await this.must(root, ['--literal-pathspecs', 'checkout', '-q', '--', ...tracked])
      return {}
    })
  }

  /** 마지막 커밋 실행 취소 — 아직 올리지 않았을 때만, soft (변경은 stage 에 남는다) */
  undoCommit(directory: string): Promise<GitResult<{ short: string }>> {
    return this.act(directory, async (root) => {
      if (!(await this.exists(root, 'HEAD'))) throw new GitError('nothing', 'no commits')
      const pushed = await this.run(root, ['branch', '-r', '--contains', 'HEAD'])
      if (pushed.stdout.trim()) throw new GitError('pushed', pushed.stdout.trim())
      const short = (await this.must(root, ['rev-parse', '--short', 'HEAD'])).trim()
      if (await this.exists(root, 'HEAD~1')) await this.must(root, ['reset', '-q', '--soft', 'HEAD~1'])
      else await this.must(root, ['update-ref', '-d', 'HEAD']) // 첫 커밋 — 브랜치를 커밋 전으로 (index 는 그대로)
      return { short }
    })
  }

  private async remoteRun(root: string, args: readonly string[]): Promise<Run> {
    const result = await this.run(root, args, { timeoutMs: REMOTE_TIMEOUT_MS })
    if (result.missing) throw new GitError('missing', 'git not found')
    if (result.timeout) throw new GitError('network', 'timed out')
    return result
  }

  /** 올리기 — 강제 없음. upstream 이 없으면 origin 의 같은 이름으로 만들고 잇는다 */
  push(directory: string): Promise<GitResult<{ branch: string }>> {
    return this.act(directory, async (root) => {
      const view = await this.view(directory)
      if (view.state !== 'ok') throw new GitError(view.state, view.state)
      if (!view.remote) throw new GitError('no-remote', 'origin')
      if (!view.branch || !view.hasCommits) throw new GitError('nothing', 'no branch')
      const result = await this.remoteRun(root, view.upstream ? ['push'] : ['push', '-u', 'origin', view.branch])
      if (result.code !== 0) throw new GitError(remoteFailure(result.stderr), firstLines(result.stderr))
      return { branch: view.branch }
    })
  }

  /** 가져오기 — merge(--no-rebase). 충돌이면 git 이 멈춘 그대로 두고 conflict (충돌 파일 목록). 대신 풀지 않는다 */
  pull(directory: string): Promise<GitResult> {
    return this.act(directory, async (root) => {
      const view = await this.view(directory)
      if (view.state !== 'ok') throw new GitError(view.state, view.state)
      if (!view.remote) throw new GitError('no-remote', 'origin')
      if (!view.branch) throw new GitError('nothing', 'no branch')
      const result = await this.remoteRun(root, ['pull', '--no-rebase', '--no-edit', ...(view.upstream ? [] : ['origin', view.branch])])
      if (result.code === 0) return {}
      const after = await this.view(directory)
      if (after.state === 'ok' && after.conflicts.length > 0)
        throw new GitError(
          'conflict',
          firstLines(result.stdout + '\n' + result.stderr),
          after.conflicts.map((file) => file.path),
        )
      if (/would be overwritten/i.test(result.stderr)) throw new GitError('overwrite', firstLines(result.stderr))
      throw new GitError(remoteFailure(result.stderr), firstLines(result.stderr))
    })
  }

  /** 충돌로 멈춘 가져오기를 취소한다 (merge --abort — 가져오기 전으로) */
  abortMerge(directory: string): Promise<GitResult> {
    return this.act(directory, async (root) => {
      await this.must(root, ['merge', '--abort'])
      return {}
    })
  }

  /** 이 폴더를 저장소로 (저장소가 아닐 때 부른다 — 루트를 찾지 않는다) */
  async init(directory: string): Promise<GitResult> {
    try {
      const result = await this.run(directory, ['init', '-q'])
      if (result.missing) return { ok: false, reason: 'missing', message: 'git not found' }
      if (result.code !== 0) return { ok: false, reason: 'failed', message: firstLines(result.stderr) }
      return { ok: true }
    } finally {
      this.ctx.emit('git/changed', directory)
    }
  }

  /** 화면의 작업 하나 (git:run) — 모르는 kind 는 invalid */
  perform(directory: string, action: GitAction): Promise<GitResult<object>> {
    const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [])
    const name = 'name' in action ? String(action.name) : ''
    switch (action.kind) {
      case 'stage':
        return this.stage(directory, strings(action.paths))
      case 'unstage':
        return this.unstage(directory, strings(action.paths))
      case 'discard':
        return this.discard(directory, strings(action.paths))
      case 'commit':
        return this.commit(directory, String(action.message))
      case 'createBranch':
        return this.createBranch(directory, name)
      case 'switchBranch':
        return this.switchBranch(directory, name)
      case 'switchRemote':
        return this.switchRemote(directory, name)
      case 'switchRevision':
        return this.switchRevision(directory, name)
      case 'deleteBranch':
        return this.deleteBranch(directory, name)
      case 'addRemote':
        return this.addRemote(directory, String(action.url))
      case 'undoCommit':
        return this.undoCommit(directory)
      case 'push':
        return this.push(directory)
      case 'pull':
        return this.pull(directory)
      case 'abortMerge':
        return this.abortMerge(directory)
      case 'init':
        return this.init(directory)
      default:
        return Promise.resolve({ ok: false, reason: 'invalid', message: 'unknown action' })
    }
  }

  /** origin 추가 */
  addRemote(directory: string, url: string): Promise<GitResult> {
    return this.act(directory, async (root) => {
      const trimmed = url.trim()
      if (!trimmed || trimmed.startsWith('-') || /\s/.test(trimmed)) throw new GitError('invalid', trimmed)
      await this.must(root, ['remote', 'add', 'origin', trimmed])
      return {}
    })
  }
}
