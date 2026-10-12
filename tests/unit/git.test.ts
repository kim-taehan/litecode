import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context, Service } from 'cordis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GitService, parseBranchLine, parseNumstat, parseStatus, remoteFailure } from '../../src/services/git.ts'
import { GitTools } from '../../src/services/appMcp/tools/git.ts'
import type { AppMcpTool } from '../../src/services/appMcp/rpc.ts'
import { GIT_READ_TOOLS, GIT_WRITE_TOOLS, gitApprovalText, gitWebUrl } from '../../shared/git.ts'

// ctx.git (이슈 #290) — 임시 폴더의 진짜 git 저장소로 댄다. 원격은 로컬 bare 저장소. git 이 없는 기계면 건너뛴다.
// 사용자 git 설정이 끼지 않게 전역 설정을 임시 파일로 바꾼다 (이름·이메일·기본 브랜치 main)

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

let tmp: string
const saved: Record<string, string | undefined> = {}

beforeAll(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-git-')))
  const global = path.join(tmp, 'gitconfig')
  await fs.writeFile(global, '[user]\n\tname = Tester\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n')
  for (const [key, value] of Object.entries({ GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1' })) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
})

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

let serial = 0
async function folder(name: string): Promise<string> {
  const dir = path.join(tmp, `${name}-${++serial}`)
  await fs.mkdir(dir)
  return dir
}

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })

async function start(config?: { git?: string }): Promise<{ git: GitService; changed: string[] }> {
  const ctx = new Context()
  const changed: string[] = []
  ctx.on('git/changed', (directory) => void changed.push(directory))
  ctx.plugin(GitService, config)
  return new Promise((resolve) => ctx.inject(['git'], (ready) => resolve({ git: ready.git, changed })))
}

/** 첫 커밋(a.txt)이 있는 저장소 */
async function repo(): Promise<string> {
  const dir = await folder('repo')
  sh(dir, 'init', '-q')
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\ntwo\n')
  sh(dir, 'add', '.')
  sh(dir, 'commit', '-q', '-m', 'first')
  return dir
}

describe('순수 규칙', () => {
  it('브랜치 줄 — upstream·ahead/behind, 첫 커밋 전, 분리된 HEAD', () => {
    expect(parseBranchLine('## main...origin/main [ahead 1, behind 2]')).toEqual({ branch: 'main', upstream: 'origin/main', ahead: 1, behind: 2, hasCommits: true })
    expect(parseBranchLine('## feat')).toEqual({ branch: 'feat', upstream: undefined, ahead: 0, behind: 0, hasCommits: true })
    expect(parseBranchLine('## No commits yet on main')).toEqual({ branch: 'main', ahead: 0, behind: 0, hasCommits: false })
    expect(parseBranchLine('## HEAD (no branch)')).toEqual({ ahead: 0, behind: 0, hasCommits: true })
  })

  it('status -z — stage/변경/새 파일/충돌/이름 바꿈', () => {
    const text = ['## main', 'M  s.ts', ' M w.ts', 'MM both.ts', '?? new.ts', 'UU c.ts', 'R  to.ts', 'from.ts', ' D gone.ts', ''].join('\0')
    expect(parseStatus(text)).toEqual({
      branchLine: '## main',
      staged: [{ path: 's.ts', kind: 'M' }, { path: 'both.ts', kind: 'M' }, { path: 'to.ts', kind: 'R', from: 'from.ts' }],
      changed: [{ path: 'w.ts', kind: 'M' }, { path: 'both.ts', kind: 'M' }, { path: 'new.ts', kind: 'U' }, { path: 'gone.ts', kind: 'D' }],
      conflicts: [{ path: 'c.ts', kind: 'C' }],
    })
  })

  it('numstat -z — 이름 바꿈은 새 경로로, 바이너리는 뺀다', () => {
    const stats = parseNumstat(['3\t1\ta.ts', '-\t-\timg.png', '2\t0\t', 'old.ts', 'new.ts', ''].join('\0'))
    expect([...stats]).toEqual([
      ['a.ts', { added: 3, removed: 1 }],
      ['new.ts', { added: 2, removed: 0 }],
    ])
  })

  it('원격 실패 글 → 사유 (인증을 먼저)', () => {
    expect(remoteFailure("fatal: could not read Username for 'https://x': terminal prompts disabled")).toBe('auth')
    expect(remoteFailure('git@x: Permission denied (publickey).\nfatal: Could not read from remote repository.')).toBe('auth')
    expect(remoteFailure("fatal: unable to access 'https://x/': Could not resolve host: x")).toBe('network')
    expect(remoteFailure(' ! [rejected]        main -> main (fetch first)')).toBe('rejected')
    expect(remoteFailure('something else')).toBe('failed')
  })

  it('원격 주소 → https (원격 주소로 열기)', () => {
    expect(gitWebUrl('git@git.company.local:team/app.git')).toBe('https://git.company.local/team/app')
    expect(gitWebUrl('ssh://git@host:2222/team/app.git')).toBe('https://host/team/app')
    expect(gitWebUrl('https://user@host/team/app.git')).toBe('https://host/team/app')
    expect(gitWebUrl('/srv/repos/app.git')).toBeUndefined()
    expect(gitWebUrl(undefined)).toBeUndefined()
  })

  it('승인 카드 글 — 커밋 메시지·브랜치 이름·파일', () => {
    expect(gitApprovalText('git_commit', JSON.stringify({ message: 'fix: a' }))).toBe('fix: a')
    expect(gitApprovalText('git_switch', JSON.stringify({ name: 'dev' }))).toBe('dev')
    expect(gitApprovalText('git_stage', JSON.stringify({ paths: ['a', 'b'] }))).toBe('a\nb')
    expect(gitApprovalText('git_push', '{}')).toBeUndefined()
  })
})

describe.skipIf(!hasGit)('GitService — 진짜 git', () => {
  it('git 이 없으면 missing, 저장소가 아니면 not-repo → init 하면 첫 커밋 전 저장소', async () => {
    const { git: none } = await start({ git: path.join(tmp, 'no-such-git') })
    expect(await none.view(tmp)).toEqual({ state: 'missing' })

    const { git, changed } = await start()
    const dir = await folder('plain')
    expect(await git.view(dir)).toEqual({ state: 'not-repo' })
    expect(await git.init(dir)).toEqual({ ok: true })
    expect(changed).toContain(dir)
    expect(await git.view(dir)).toMatchObject({ state: 'ok', branch: 'main', hasCommits: false, staged: [], changed: [], conflicts: [], merging: false })
    expect(await git.log(dir)).toEqual([])
  })

  it('status — 고친 파일(줄 수)·새 파일, stage/unstage, 첫 커밋 전에도 unstage', async () => {
    const { git } = await start()
    const dir = await repo()
    await fs.writeFile(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n')
    await fs.writeFile(path.join(dir, 'b 한글.txt'), 'new\n')
    let view = await git.view(dir)
    expect(view).toMatchObject({ state: 'ok', branch: 'main', staged: [], changed: [{ path: 'a.txt', kind: 'M', added: 2, removed: 1 }, { path: 'b 한글.txt', kind: 'U' }] })

    expect(await git.stage(dir, ['a.txt', 'b 한글.txt'])).toEqual({ ok: true })
    view = await git.view(dir)
    expect(view).toMatchObject({ staged: [{ path: 'a.txt', kind: 'M', added: 2, removed: 1 }, { path: 'b 한글.txt', kind: 'A', added: 1, removed: 0 }], changed: [] })
    expect(await git.unstage(dir, ['b 한글.txt'])).toEqual({ ok: true })
    expect(await git.view(dir)).toMatchObject({ staged: [{ path: 'a.txt' }], changed: [{ path: 'b 한글.txt', kind: 'U' }] })

    const fresh = await folder('fresh')
    sh(fresh, 'init', '-q')
    await fs.writeFile(path.join(fresh, 'x'), 'x\n')
    await git.stage(fresh, ['x'])
    expect(await git.view(fresh)).toMatchObject({ staged: [{ path: 'x', kind: 'A' }] })
    expect(await git.unstage(fresh, ['x'])).toEqual({ ok: true })
    expect(await git.view(fresh)).toMatchObject({ staged: [], changed: [{ path: 'x', kind: 'U' }] })
  })

  it('diff — 작업 트리·stage 쪽·새 파일', async () => {
    const { git } = await start()
    const dir = await repo()
    await fs.writeFile(path.join(dir, 'a.txt'), 'one\nTWO\n')
    await fs.writeFile(path.join(dir, 'n.txt'), 'hello\n')
    expect(await git.diff(dir, 'a.txt')).toContain('+TWO')
    expect(await git.diff(dir, 'a.txt', true)).toBe('')
    expect(await git.diff(dir, 'n.txt')).toContain('+hello')
    await git.stage(dir, ['a.txt'])
    expect(await git.diff(dir, 'a.txt', true)).toContain('-two')
  })

  it('commit — stage 없으면 nothing, 있으면 짧은 해시·파일 수, 기록에 (올리지 않음). -a 가 아니다', async () => {
    const { git, changed } = await start()
    const dir = await repo()
    await fs.writeFile(path.join(dir, 'a.txt'), 'changed\n')
    await fs.writeFile(path.join(dir, 'c.txt'), 'c\n')
    expect(await git.commit(dir, 'msg')).toMatchObject({ ok: false, reason: 'nothing' })
    await git.stage(dir, ['c.txt'])
    expect(await git.commit(dir, '   ')).toMatchObject({ ok: false, reason: 'invalid' })
    const done = await git.commit(dir, '한글 메시지\n\n본문')
    expect(done).toMatchObject({ ok: true, files: 1 })
    expect(changed.filter((entry) => entry === dir).length).toBeGreaterThanOrEqual(3)
    const log = await git.log(dir)
    expect(log.map((commit) => commit.subject)).toEqual(['한글 메시지', 'first'])
    expect(log[0]).toMatchObject({ short: done.ok ? done.short : '', author: 'Tester', pushed: false })
    expect(await git.view(dir)).toMatchObject({ staged: [], changed: [{ path: 'a.txt', kind: 'M' }] })
  })

  it('브랜치 — 만들기(변경이 따라온다)·전환·목록(합쳐지지 않은 수)·삭제, 잘못된 이름은 거절', async () => {
    const { git } = await start()
    const dir = await repo()
    expect(await git.createBranch(dir, '-x')).toMatchObject({ ok: false, reason: 'invalid' })
    expect(await git.createBranch(dir, 'bad..name')).toMatchObject({ ok: false, reason: 'invalid' })
    await fs.writeFile(path.join(dir, 'a.txt'), 'dirty\n')
    expect(await git.createBranch(dir, 'feat')).toEqual({ ok: true, branch: 'feat' })
    expect(await git.view(dir)).toMatchObject({ branch: 'feat', changed: [{ path: 'a.txt' }] })
    await git.stage(dir, ['a.txt'])
    await git.commit(dir, 'on feat')
    expect(await git.switchBranch(dir, 'main')).toEqual({ ok: true, branch: 'main' })
    expect(await git.switchBranch(dir, 'nope')).toMatchObject({ ok: false, reason: 'invalid' })
    const branches = await git.branches(dir)
    expect(branches.map((branch) => [branch.name, branch.current, branch.unmerged])).toEqual([
      ['main', true, 0],
      ['feat', false, 1],
    ])
    expect(await git.deleteBranch(dir, 'main')).toMatchObject({ ok: false }) // 지금 브랜치
    expect(await git.deleteBranch(dir, 'feat')).toEqual({ ok: true })
    expect((await git.branches(dir)).map((branch) => branch.name)).toEqual(['main'])
  })

  it('전환 — 지금 변경이 덮이면 멈추고 아무것도 안 바뀐다(overwrite)', async () => {
    const { git } = await start()
    const dir = await repo()
    sh(dir, 'checkout', '-q', '-b', 'other')
    await fs.writeFile(path.join(dir, 'a.txt'), 'other\n')
    sh(dir, 'commit', '-qam', 'other')
    sh(dir, 'checkout', '-q', 'main')
    await fs.writeFile(path.join(dir, 'a.txt'), 'local edit\n')
    expect(await git.switchBranch(dir, 'other')).toMatchObject({ ok: false, reason: 'overwrite' })
    expect(await git.view(dir)).toMatchObject({ branch: 'main', changed: [{ path: 'a.txt' }] })
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('local edit\n')
  })

  it('되돌리기 — 고친 파일은 stage 된 내용으로, 새 파일은 지운다', async () => {
    const { git } = await start()
    const dir = await repo()
    await fs.writeFile(path.join(dir, 'a.txt'), 'gone edit\n')
    await fs.writeFile(path.join(dir, 'tmp.txt'), 'x\n')
    expect(await git.discard(dir, ['a.txt', 'tmp.txt'])).toEqual({ ok: true })
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('one\ntwo\n')
    await expect(fs.access(path.join(dir, 'tmp.txt'))).rejects.toThrow()
    expect(await git.view(dir)).toMatchObject({ staged: [], changed: [] })
  })

  it('커밋 실행 취소 — soft (변경은 stage 에 남는다), 첫 커밋도', async () => {
    const { git } = await start()
    const dir = await repo()
    await fs.writeFile(path.join(dir, 'a.txt'), 'second\n')
    await git.stage(dir, ['a.txt'])
    await git.commit(dir, 'second')
    expect(await git.undoCommit(dir)).toMatchObject({ ok: true })
    expect(await git.view(dir)).toMatchObject({ hasCommits: true, staged: [{ path: 'a.txt', kind: 'M' }] })
    expect((await git.log(dir)).map((commit) => commit.subject)).toEqual(['first'])
    expect(await git.undoCommit(dir)).toMatchObject({ ok: true })
    expect(await git.view(dir)).toMatchObject({ hasCommits: false, staged: [{ path: 'a.txt', kind: 'A' }] })
    expect(await git.undoCommit(dir)).toMatchObject({ ok: false, reason: 'nothing' })
  })

  it('원격 — 없으면 no-remote, 추가 → push(upstream 생김, 올린 커밋은 취소 못 함) → 다른 클론의 커밋을 pull', async () => {
    const { git } = await start()
    const dir = await repo()
    expect(await git.push(dir)).toMatchObject({ ok: false, reason: 'no-remote' })
    expect(await git.pull(dir)).toMatchObject({ ok: false, reason: 'no-remote' })
    const bare = path.join(await folder('remote'), 'r.git')
    sh(tmp, 'init', '-q', '--bare', bare)
    expect(await git.addRemote(dir, '--upload-pack=x')).toMatchObject({ ok: false, reason: 'invalid' })
    expect(await git.addRemote(dir, bare)).toEqual({ ok: true })
    expect(await git.view(dir)).toMatchObject({ remote: bare })
    expect(await git.push(dir)).toEqual({ ok: true, branch: 'main' })
    expect(await git.view(dir)).toMatchObject({ upstream: 'origin/main', ahead: 0 })
    expect((await git.log(dir))[0]).toMatchObject({ pushed: true })
    expect(await git.undoCommit(dir)).toMatchObject({ ok: false, reason: 'pushed' })

    const clone = path.join(await folder('clone'), 'c')
    sh(tmp, 'clone', '-q', bare, clone)
    await fs.writeFile(path.join(clone, 'from-clone.txt'), 'hi\n')
    sh(clone, 'add', '.')
    sh(clone, 'commit', '-qm', 'from clone')
    sh(clone, 'push', '-q')
    expect(await git.pull(dir)).toEqual({ ok: true })
    expect(await fs.readFile(path.join(dir, 'from-clone.txt'), 'utf8')).toBe('hi\n')
  })

  it('pull 충돌 — 멈춘 채 conflict + 파일 목록, merging. 가져오기 취소로 되돌린다', async () => {
    const { git } = await start()
    const dir = await repo()
    const bare = path.join(await folder('remote'), 'r.git')
    sh(tmp, 'init', '-q', '--bare', bare)
    await git.addRemote(dir, bare)
    await git.push(dir)
    const clone = path.join(await folder('clone'), 'c')
    sh(tmp, 'clone', '-q', bare, clone)
    await fs.writeFile(path.join(clone, 'a.txt'), 'theirs\n')
    sh(clone, 'commit', '-qam', 'theirs')
    sh(clone, 'push', '-q')

    await fs.writeFile(path.join(dir, 'a.txt'), 'mine\n')
    await git.stage(dir, ['a.txt'])
    await git.commit(dir, 'mine')
    expect(await git.push(dir)).toMatchObject({ ok: false, reason: 'rejected' })
    const pulled = await git.pull(dir)
    expect(pulled).toMatchObject({ ok: false, reason: 'conflict', conflicts: ['a.txt'] })
    expect(await git.view(dir)).toMatchObject({ merging: true, conflicts: [{ path: 'a.txt', kind: 'C' }] })
    expect(await git.abortMerge(dir)).toEqual({ ok: true })
    expect(await git.view(dir)).toMatchObject({ merging: false, conflicts: [] })
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('mine\n')
  })

  it('AI 도구 — 이름은 권한 표와 같고(읽기 넷·쓰기 여섯), 읽기는 JSON, 쓰기 실패는 사유를 던진다', async () => {
    const ctx = new Context()
    const tools = new Map<string, AppMcpTool>()
    class FakeAppMcp extends Service {
      constructor(inner: Context) {
        super(inner, 'appMcp')
      }
      register(tool: AppMcpTool): () => void {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      }
    }
    ctx.plugin(FakeAppMcp)
    ctx.plugin(GitService)
    ctx.plugin(GitTools)
    for (let wait = 0; tools.size < 10 && wait < 100; wait++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect([...tools.keys()].sort()).toEqual([...GIT_READ_TOOLS, ...GIT_WRITE_TOOLS].sort())
    const dir = await repo()
    const call = { directory: dir }
    expect(JSON.parse(await tools.get('git_status')!.run({}, call))).toMatchObject({ state: 'ok', branch: 'main' })
    await expect(tools.get('git_commit')!.run({ message: 'x' }, call)).rejects.toThrow(/nothing/)
    await fs.writeFile(path.join(dir, 'z.txt'), 'z\n')
    expect(await tools.get('git_stage')!.run({ paths: ['.'] }, call)).toBe('Staged: ..')
    expect(await tools.get('git_commit')!.run({ message: 'by ai' }, call)).toMatch(/^Committed \w+ \(1 files\)\.$/)
    expect(JSON.parse(await tools.get('git_log')!.run({ limit: 1 }, call))).toMatchObject([{ subject: 'by ai', pushed: false }])
    await expect(tools.get('git_status')!.run({}, { directory: await folder('plain') })).rejects.toThrow(/not a git repository/)
    ctx.registry.delete(GitTools)
  })

  it('원격에 닿지 못하면 로컬은 그대로 — network', async () => {
    const { git } = await start()
    const dir = await repo()
    await git.addRemote(dir, path.join(tmp, 'missing-remote.git'))
    expect(await git.push(dir)).toMatchObject({ ok: false, reason: 'network' })
    expect(await git.pull(dir)).toMatchObject({ ok: false, reason: 'network' })
    expect(await git.view(dir)).toMatchObject({ branch: 'main', staged: [], changed: [] })
  })
})
