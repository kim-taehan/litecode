import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context, Service } from 'cordis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GitService, parseBranchLine, parseNumstat, parseRefs, parseStashList, parseStatus, remoteFailure } from '../../src/services/git.ts'
import { GitTools } from '../../src/services/appMcp/tools/git.ts'
import type { AppMcpTool } from '../../src/services/appMcp/rpc.ts'
import { GIT_READ_TOOLS, GIT_WRITE_TOOLS, gitApprovalText, gitWebUrl, ignoreLine } from '../../shared/git.ts'

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

/** 직선 커밋 N 개 — git commit 루프 대신 fast-import 로 한 프로세스(메시지만 바뀐다). 첫 커밋의 부모는 지금 끝(분기가
 *  이미 있는 데서), 그 뒤는 스트림 안의 앞 커밋이 자동 부모가 된다 — 수천 개도 즉시 */
function lineCommits(dir: string, count: number): void {
  const from = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  let script = ''
  for (let i = 1; i <= count; i++) {
    const msg = `line ${i}\n`
    script += `commit refs/heads/main\nauthor Tester <t@example.com> 1760000000 +0000\ncommitter Tester <t@example.com> 1760000000 +0000\ndata ${msg.length}\n${msg}${i === 1 ? `from ${from}\n` : ''}\n`
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: dir, encoding: 'utf8', input: script })
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

  it('decorate → 레프 (#400) — HEAD(브랜치 위·분리) · 브랜치 · 원격 · 태그', () => {
    const remotes = new Set(['origin'])
    expect(parseRefs('HEAD -> dev, origin/dev, origin/HEAD, tag: v1', remotes)).toEqual([
      { kind: 'head', name: 'dev' },
      { kind: 'remote', name: 'origin/dev' },
      { kind: 'remote', name: 'origin/HEAD' },
      { kind: 'tag', name: 'v1' },
    ])
    expect(parseRefs('HEAD', remotes)).toEqual([{ kind: 'head', name: '' }]) // 분리된 HEAD
    expect(parseRefs('dev', remotes)).toEqual([{ kind: 'branch', name: 'dev' }])
    expect(parseRefs('feat/foo', remotes)).toEqual([{ kind: 'branch', name: 'feat/foo' }]) // / 있어도 원격이 아니면 로컬
    expect(parseRefs('origin/feat/foo', remotes)).toEqual([{ kind: 'remote', name: 'origin/feat/foo' }])
    expect(parseRefs('', remotes)).toEqual([])
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

  it('여기서 새 브랜치 (#399) — 시작점 브랜치 끝에서 만들고 옮긴다, 없는·잘못된 시작점은 invalid, 덮이면 overwrite', async () => {
    const { git, changed } = await start()
    const dir = await repo()
    sh(dir, 'checkout', '-q', '-b', 'other')
    await fs.writeFile(path.join(dir, 'a.txt'), 'other\n')
    sh(dir, 'commit', '-qam', 'on other')
    const otherTip = sh(dir, 'rev-parse', 'other').trim()
    sh(dir, 'checkout', '-q', 'main')

    expect(await git.createBranch(dir, 'from-other', 'other')).toEqual({ ok: true, branch: 'from-other' })
    expect(await git.view(dir)).toMatchObject({ branch: 'from-other', changed: [] })
    expect(sh(dir, 'rev-parse', 'HEAD').trim()).toBe(otherTip)
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('other\n')
    expect(changed).toContain(dir)
    // GitAction 으로도 (화면의 git:run)
    expect(await git.perform(dir, { kind: 'createBranch', name: 'from-main', from: 'main' })).toEqual({ ok: true, branch: 'from-main' })
    expect(sh(dir, 'rev-parse', 'HEAD').trim()).toBe(sh(dir, 'rev-parse', 'main').trim())

    expect(await git.createBranch(dir, 'x1', 'nope')).toMatchObject({ ok: false, reason: 'invalid' })
    expect(await git.createBranch(dir, 'x2', '-x')).toMatchObject({ ok: false, reason: 'invalid' })
    expect(await git.createBranch(dir, 'x3', 'bad..name')).toMatchObject({ ok: false, reason: 'invalid' })
    expect((await git.branches(dir)).map((branch) => branch.name).sort()).toEqual(['from-main', 'from-other', 'main', 'other'])

    // 지금 변경이 시작점 내용에 덮이면 멈추고 아무것도 안 바뀐다
    await fs.writeFile(path.join(dir, 'a.txt'), 'local edit\n')
    expect(await git.createBranch(dir, 'x4', 'other')).toMatchObject({ ok: false, reason: 'overwrite' })
    expect(await git.view(dir)).toMatchObject({ branch: 'from-main', changed: [{ path: 'a.txt' }] })
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('local edit\n')
    expect((await git.branches(dir)).map((branch) => branch.name)).not.toContain('x4')
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

  it('태그·커밋으로 전환 (#386) — 분리된 HEAD(브랜치 없음), 없는 이름은 invalid, 덮이면 overwrite', async () => {
    const { git } = await start()
    const dir = await repo()
    const first = sh(dir, 'rev-parse', 'HEAD').trim()
    sh(dir, 'tag', 'v1')
    await fs.writeFile(path.join(dir, 'a.txt'), 'second\n')
    sh(dir, 'commit', '-qam', 'second')
    expect(await git.perform(dir, { kind: 'switchRevision', name: 'v1' })).toEqual({ ok: true, short: first.slice(0, 7) })
    const detached = await git.view(dir)
    expect(detached).toMatchObject({ state: 'ok', hasCommits: true, staged: [], changed: [] })
    expect(detached).not.toHaveProperty('branch')
    expect(await git.switchBranch(dir, 'main')).toEqual({ ok: true, branch: 'main' })
    expect(await git.switchRevision(dir, first.slice(0, 7))).toMatchObject({ ok: true })
    expect(sh(dir, 'rev-parse', 'HEAD').trim()).toBe(first)
    await git.switchBranch(dir, 'main')
    for (const bad of ['nope', '-x', '', 'HEAD~9']) expect(await git.switchRevision(dir, bad)).toMatchObject({ ok: false, reason: 'invalid' })
    await fs.writeFile(path.join(dir, 'a.txt'), 'local edit\n')
    expect(await git.switchRevision(dir, 'v1')).toMatchObject({ ok: false, reason: 'overwrite' })
    expect(await git.view(dir)).toMatchObject({ branch: 'main', changed: [{ path: 'a.txt' }] })
  })

  it('원격 브랜치 (#386) — 목록(origin/HEAD 제외), 누르면 같은 이름 추적 브랜치를 만들어 전환, 있으면 그 로컬로', async () => {
    const { git } = await start()
    const dir = await repo()
    expect(await git.remoteBranches(dir)).toEqual([])
    const bare = path.join(await folder('remote'), 'r.git')
    sh(tmp, 'init', '-q', '--bare', bare)
    await git.addRemote(dir, bare)
    await git.push(dir)
    const clone = path.join(await folder('clone'), 'c')
    sh(tmp, 'clone', '-q', bare, clone)
    sh(clone, 'checkout', '-q', '-b', 'feat_remote')
    await fs.writeFile(path.join(clone, 'r.txt'), 'remote\n')
    sh(clone, 'add', '.')
    sh(clone, 'commit', '-qm', 'remote work')
    sh(clone, 'push', '-q', 'origin', 'feat_remote')
    // 클론은 origin/HEAD 를 가진다 — 목록에서 뺀다
    expect(await git.remoteBranches(clone)).toEqual(['origin/feat_remote', 'origin/main'])
    sh(dir, 'fetch', '-q', 'origin')
    expect(await git.remoteBranches(dir)).toEqual(['origin/feat_remote', 'origin/main'])

    expect(await git.perform(dir, { kind: 'switchRemote', name: 'origin/feat_remote' })).toEqual({ ok: true, branch: 'feat_remote' })
    expect(await git.view(dir)).toMatchObject({ branch: 'feat_remote', upstream: 'origin/feat_remote', ahead: 0, behind: 0 })
    expect(await fs.readFile(path.join(dir, 'r.txt'), 'utf8')).toBe('remote\n')
    // 이미 있는 로컬 브랜치면 그것으로 옮긴다 (원격으로 덮지 않는다)
    expect(await git.switchRemote(dir, 'origin/main')).toEqual({ ok: true, branch: 'main' })
    expect(await git.view(dir)).toMatchObject({ branch: 'main' })
    for (const bad of ['origin/nope', 'nope', '-x/y', '']) expect(await git.switchRemote(dir, bad)).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('마지막 커밋 고치기 (#387) — stage 된 것을 합치고 메시지를 바꾼다, stage 가 없으면 메시지만. 커밋 수는 그대로', async () => {
    const { git, changed } = await start()
    const dir = await repo()
    await fs.writeFile(path.join(dir, 'a.txt'), 'second\n')
    sh(dir, 'commit', '-qam', 'second')
    expect(await git.lastCommit(dir)).toEqual({ message: 'second', pushed: false })

    await fs.writeFile(path.join(dir, 'b.txt'), 'b\n')
    await git.stage(dir, ['b.txt'])
    const before = changed.length
    const amended = await git.perform(dir, { kind: 'amend', message: '두 번째\n\n본문' })
    expect(amended).toMatchObject({ ok: true, files: 1 })
    expect(changed.length).toBeGreaterThan(before)
    expect((await git.log(dir)).map((commit) => commit.subject)).toEqual(['두 번째', 'first'])
    expect(sh(dir, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual(['a.txt', 'b.txt'])
    expect(await git.view(dir)).toMatchObject({ staged: [], changed: [] })
    expect(await git.lastCommit(dir)).toEqual({ message: '두 번째\n\n본문', pushed: false })

    // stage 된 것이 없으면 메시지만
    const onlyMessage = await git.amend(dir, 'second again')
    expect(onlyMessage).toMatchObject({ ok: true, files: 0 })
    expect((await git.log(dir)).map((commit) => commit.subject)).toEqual(['second again', 'first'])
    expect(sh(dir, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('마지막 커밋 고치기 (#387) — 빈 메시지 invalid, 첫 커밋 전 nothing, 병합 중 conflict, 이미 올린 커밋 pushed (아무것도 안 바뀐다)', async () => {
    const { git } = await start()
    const fresh = await folder('fresh')
    sh(fresh, 'init', '-q')
    expect(await git.lastCommit(fresh)).toBeUndefined()
    expect(await git.amend(fresh, 'x')).toMatchObject({ ok: false, reason: 'nothing' })

    const dir = await repo()
    expect(await git.amend(dir, '   ')).toMatchObject({ ok: false, reason: 'invalid' })

    const bare = path.join(await folder('remote'), 'r.git')
    sh(tmp, 'init', '-q', '--bare', bare)
    await git.addRemote(dir, bare)
    await git.push(dir)
    expect(await git.lastCommit(dir)).toEqual({ message: 'first', pushed: true })
    const head = sh(dir, 'rev-parse', 'HEAD').trim()
    expect(await git.amend(dir, 'rewrite')).toMatchObject({ ok: false, reason: 'pushed' })
    expect(sh(dir, 'rev-parse', 'HEAD').trim()).toBe(head)

    // 병합이 충돌로 멈춘 동안
    const clone = path.join(await folder('clone'), 'c')
    sh(tmp, 'clone', '-q', bare, clone)
    await fs.writeFile(path.join(clone, 'a.txt'), 'theirs\n')
    sh(clone, 'commit', '-qam', 'theirs')
    sh(clone, 'push', '-q')
    await fs.writeFile(path.join(dir, 'a.txt'), 'mine\n')
    sh(dir, 'commit', '-qam', 'mine')
    expect(await git.pull(dir)).toMatchObject({ ok: false, reason: 'conflict' })
    expect(await git.amend(dir, 'mine 2')).toMatchObject({ ok: false, reason: 'conflict' })
    expect(await git.view(dir)).toMatchObject({ merging: true })
  })

  it('커밋하고 올리기 (#387) — 커밋 뒤 push 로 원격에 닿는다, 거절(rejected)이면 커밋은 로컬에 남는다', async () => {
    const { git } = await start()
    const dir = await repo()
    const bare = path.join(await folder('remote'), 'r.git')
    sh(tmp, 'init', '-q', '--bare', bare)
    await git.addRemote(dir, bare)
    await fs.writeFile(path.join(dir, 'a.txt'), 'second\n')
    await git.stage(dir, ['a.txt'])
    expect(await git.perform(dir, { kind: 'commit', message: 'second' })).toMatchObject({ ok: true })
    expect(await git.perform(dir, { kind: 'push' })).toEqual({ ok: true, branch: 'main' })
    expect(sh(bare, 'log', '-1', '--format=%s', 'main').trim()).toBe('second')

    const clone = path.join(await folder('clone'), 'c')
    sh(tmp, 'clone', '-q', bare, clone)
    await fs.writeFile(path.join(clone, 'c.txt'), 'c\n')
    sh(clone, 'add', '.')
    sh(clone, 'commit', '-qm', 'from clone')
    sh(clone, 'push', '-q')
    await fs.writeFile(path.join(dir, 'd.txt'), 'd\n')
    await git.stage(dir, ['d.txt'])
    expect(await git.commit(dir, 'third')).toMatchObject({ ok: true })
    expect(await git.push(dir)).toMatchObject({ ok: false, reason: 'rejected' })
    expect((await git.log(dir))[0]).toMatchObject({ subject: 'third', pushed: false })
    expect(await git.lastCommit(dir)).toEqual({ message: 'third', pushed: false })
  })
})

describe.skipIf(!hasGit)('GitService — 기록 페이징 logPage (#400 #403)', () => {
  it('parents·refs — 분기 후 머지 · 태그 · special characters, 머지 첫 부모가 main 끝', async () => {
    const { git } = await start()
    const dir = await repo() // 첫 커밋('first', main)
    sh(dir, 'checkout', '-q', '-b', 'side')
    await fs.writeFile(path.join(dir, 'b.txt'), 'b\n')
    sh(dir, 'add', '.')
    sh(dir, 'commit', '-qm', 'on side')
    sh(dir, 'checkout', '-q', 'main')
    await fs.writeFile(path.join(dir, 'c.txt'), 'c\n')
    sh(dir, 'add', '.')
    sh(dir, 'commit', '-qm', 'on main ! (100%)')
    sh(dir, 'merge', '-q', '--no-ff', 'side', '-m', 'merge side')
    sh(dir, 'tag', 'v1')

    const page = await git.logPage(dir, { limit: 10 })
    expect(page.hasMore).toBe(false)
    // --topo-order 는 부모 순서를 보장하지 않으므로(첫·두 번째 부모 줄의 상대 순서) — 집합으로 보고, 각 줄은 제목으로 찾는다
    expect(new Set(page.commits.map((m) => m.subject))).toEqual(new Set(['merge side', 'on main ! (100%)', 'on side', 'first']))
    const [merge] = page.commits
    const onMain = page.commits.find((m) => m.subject === 'on main ! (100%)')!
    const onSide = page.commits.find((m) => m.subject === 'on side')!
    const first = page.commits.find((m) => m.subject === 'first')!
    expect(merge.parents.length).toBe(2)
    expect(merge.parents[0]).toBe(onMain.hash) // 첫 부모 = main 의 끝
    expect(merge.parents[1]).toBe(onSide.hash)
    expect(onMain.parents).toEqual([first.hash])
    expect(onSide.parents).toEqual([first.hash])
    expect(first.parents).toEqual([])
    expect(merge.refs).toEqual([
      { kind: 'head', name: 'main' },
      { kind: 'tag', name: 'v1' },
    ])
    expect(onMain.refs).toEqual([])
    expect(merge.short.length).toBeGreaterThanOrEqual(7)
  })

  it('push 판정 — bare 원격: 올린 것은 true, 그 뒤 로컬 커밋은 false. refs 의 원격도 보인다', async () => {
    const { git } = await start()
    const dir = await repo()
    const bare = path.join(await folder('remote'), 'r.git')
    sh(tmp, 'init', '-q', '--bare', bare)
    sh(dir, 'remote', 'add', 'origin', bare)
    sh(dir, 'push', '-q', '-u', 'origin', 'main')
    await fs.writeFile(path.join(dir, 'a.txt'), 'local\n')
    sh(dir, 'add', '.')
    sh(dir, 'commit', '-qm', 'local only')
    const page = await git.logPage(dir, { limit: 10 })
    expect(page.commits.map((m) => m.pushed)).toEqual([false, true])
    const [local, pushed] = page.commits
    expect(local.refs).toEqual([{ kind: 'head', name: 'main' }])
    expect(pushed.refs).toEqual([{ kind: 'remote', name: 'origin/main' }])
  })

  it('페이징 — hasMore 로 이어 읽으면 전체와 일치하고, 페이지 경계에서 부모가 이어진다', async () => {
    const { git } = await start()
    const dir = await repo()
    lineCommits(dir, 300)
    const pages = await Promise.all([git.logPage(dir, { skip: 0, limit: 200 }), git.logPage(dir, { skip: 200, limit: 200 })])
    expect(pages[0].hasMore).toBe(true)
    expect(pages[1].hasMore).toBe(false)
    expect(pages[0].commits.map((m) => m.subject)).toEqual(Array.from({ length: 200 }, (_, i) => `line ${300 - i}`))
    expect(pages[1].commits.map((m) => m.subject)).toEqual([...Array.from({ length: 100 }, (_, i) => `line ${100 - i}`), 'first'])
    // 페이지 경계 — 첫 페이지 마지막 커밋의 부모가 두 페이지 첫 커밋 (부모가 밖으로 가도 해시로 이어진다)
    expect(pages[0].commits[199].parents[0]).toBe(pages[1].commits[0].hash)
    const total = [...pages[0].commits, ...pages[1].commits]
    expect(total).toHaveLength(301)
    expect(new Set(total.map((m) => m.hash)).size).toBe(301)
  })

  it('큰 저장소 — 1500 개 커밋, 깊은 skip 도 페이지가 맞고 속도 상한 안', async () => {
    const { git } = await start()
    const dir = await repo()
    lineCommits(dir, 1500)
    const started = Date.now()
    const all: { hash: string }[] = []
    for (let skip = 0; ; skip += 200) {
      const page = await git.logPage(dir, { skip, limit: 200 })
      all.push(...page.commits)
      if (!page.hasMore) break
    }
    expect(Date.now() - started).toBeLessThan(20_000) // 8 페이지 읽기 — 속도 붕괴를 잡는 느슨한 상한
    expect(all).toHaveLength(1501)
    expect(new Set(all.map((m) => m.hash)).size).toBe(1501)

    const deep = await git.logPage(dir, { skip: 1400, limit: 100 })
    expect(deep.commits).toHaveLength(100)
    expect(deep.hasMore).toBe(true) // 'first' 가 아직 한 개 남음
    expect(deep.commits[0].subject).toBe('line 100')
    expect(deep.commits[99].subject).toBe('line 1')
    expect((await git.logPage(dir, { skip: 1401, limit: 100 })).commits.map((m) => m.subject)).toEqual([...Array.from({ length: 99 }, (_, i) => `line ${99 - i}`), 'first'])
  })

  it('첫 커밋 전 — 빈 페이지', async () => {
    const { git } = await start()
    const dir = await folder('empty')
    sh(dir, 'init', '-q')
    expect(await git.logPage(dir)).toEqual({ commits: [], hasMore: false })
  })
})

describe.skipIf(!hasGit)('GitService — 기록 필터 logPage (#409)', () => {
  /** 저자·날짜·파일로 커밋 — --since 는 커밋 날짜를 본다 */
  async function authored(dir: string, msg: string, author: string, date: string, file: string, content: string): Promise<void> {
    await fs.writeFile(path.join(dir, file), content)
    sh(dir, 'add', file)
    execFileSync('git', ['-c', `user.name=${author}`, '-c', 'user.email=t@example.com', 'commit', '-q', '-m', msg], {
      cwd: dir,
      stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    })
  }

  async function fixture(): Promise<string> {
    const dir = await repo() // 'first' (a.txt, 저자 Tester)
    await authored(dir, 'Alpha change', 'Alpha', '2026-10-10T10:00:00 +0900', 'b.txt', 'b\n')
    await authored(dir, 'beta change', 'Beta', '2026-10-11T10:00:00 +0900', 'c.txt', 'c\n')
    await authored(dir, 'GAMMA tweak', 'Gamma', '2026-10-12T10:00:00 +0900', 'd.txt', 'd\n')
    sh(dir, 'checkout', '-q', '-b', 'feat')
    await authored(dir, 'feat work', 'Alpha', '2026-10-13T10:00:00 +0900', 'e.txt', 'e\n')
    sh(dir, 'checkout', '-q', 'main')
    return dir
  }

  const subjects = (page: Awaited<ReturnType<GitService['logPage']>>) => page.commits.map((m) => m.subject)

  it('검색 — 고정 문자열(기본), `Cc` 끄면 대소문자 무시, `.*` 은 패턴', async () => {
    const { git } = await start()
    const dir = await fixture()
    expect(subjects(await git.logPage(dir, { text: 'Alpha' }))).toEqual(['Alpha change'])
    expect(subjects(await git.logPage(dir, { text: 'ALPHA' }))).toEqual([]) // 기본 = 대소문자 구분
    expect(subjects(await git.logPage(dir, { text: 'alpha', caseSensitive: false }))).toEqual(['Alpha change'])
    expect(subjects(await git.logPage(dir, { text: '^GAMMA' }))).toEqual([]) // 고정이라 ^ 가 글자
    expect(subjects(await git.logPage(dir, { text: '^gamma', regex: true, caseSensitive: false }))).toEqual(['GAMMA tweak'])
  })

  it('해시 같은 검색 — rev-parse 로 해석해 그 커밋의 역사를 (짧은 해시도)', async () => {
    const { git } = await start()
    const dir = await fixture()
    const all = await git.logPage(dir)
    const gamma = all.commits.find((m) => m.subject === 'GAMMA tweak')!
    const page = await git.logPage(dir, { text: gamma.short })
    expect(page.commits[0].hash).toBe(gamma.hash)
    expect(subjects(page)).toEqual(['GAMMA tweak', 'beta change', 'Alpha change', 'first'])
    // 해석 안 되는 16진 4자 이상은 그냥 검색으로(검색 결과가 없으면 아무것도)
    expect(subjects(await git.logPage(dir, { text: 'ffabcd0' }))).toEqual([])
  })

  // fixture: main = first → Alpha change → beta change → GAMMA tweak, feat = GAMMA 에서 갈라져 feat work (5개)
  it('브랜치 — 그 브랜치의 역사만, all 은 전부, 원격 브랜치도', async () => {
    const { git } = await start()
    const dir = await fixture()
    const bare = path.join(await folder('remote'), 'r.git')
    sh(tmp, 'init', '-q', '--bare', bare)
    sh(dir, 'remote', 'add', 'origin', bare)
    sh(dir, 'push', '-q', 'origin', 'main')
    expect(new Set(subjects(await git.logPage(dir, { branch: 'feat' })))).toEqual(new Set(['feat work', 'GAMMA tweak', 'beta change', 'Alpha change', 'first']))
    expect(subjects(await git.logPage(dir, { branch: 'main' }))).toEqual(['GAMMA tweak', 'beta change', 'Alpha change', 'first'])
    expect(new Set(subjects(await git.logPage(dir, { branch: 'all' })))).toEqual(new Set(['GAMMA tweak', 'beta change', 'feat work', 'Alpha change', 'first']))
    expect(new Set(subjects(await git.logPage(dir, { branch: 'origin/main' })))).toEqual(new Set(['GAMMA tweak', 'beta change', 'Alpha change', 'first']))
    // 없는 브랜치면(사라진 원격 따위) 무시 = HEAD 가보
    expect(new Set(subjects(await git.logPage(dir, { branch: 'gone' })))).toEqual(new Set(await git.logPage(dir).then((p) => subjects(p))))
  })

  it('사용자·날짜·경로 — 각각과 조합, 같은 필터로 “올리지 않음” 집합도', async () => {
    const { git } = await start()
    const dir = await fixture()
    expect(new Set(subjects(await git.logPage(dir, { author: 'Alpha', branch: 'all' })))).toEqual(new Set(['feat work', 'Alpha change']))
    expect(new Set(subjects(await git.logPage(dir, { since: '2026-10-12 00:00:00' })))).toEqual(new Set(['GAMMA tweak']))
    expect(new Set(subjects(await git.logPage(dir, { since: '2026-10-12 00:00:00', branch: 'all' })))).toEqual(new Set(['GAMMA tweak', 'feat work']))
    expect(subjects(await git.logPage(dir, { paths: ['b.txt'] }))).toEqual(['Alpha change']) // 경로가 바뀌지 않은 커밋은 없다
    expect(subjects(await git.logPage(dir, { branch: 'main', paths: ['c.txt'] }))).toEqual(['beta change'])
    expect(subjects(await git.logPage(dir, { branch: 'main', paths: ['c.txt', 'd.txt'] }))).toEqual(['GAMMA tweak', 'beta change'])
    // '올리지 않음' 도 같은 범위 — 올리지 않은 저장소이므로 전부 false
    const page = await git.logPage(dir, { branch: 'feat' })
    expect(page.commits.every((m) => m.pushed === false)).toBe(true)
  })

  it('사용자 목록 — 최근 200개(모든 브랜치) 작성자 중복 제거, 이름순', async () => {
    const { git } = await start()
    const dir = await fixture()
    expect(await git.logAuthors(dir)).toEqual(['Alpha', 'Beta', 'Gamma', 'Tester'])
  })
})

describe('보관 목록 읽기 (#389)', () => {
  it('stash list 의 글 → 번호·해시·메시지·브랜치·시각 (분리된 HEAD 는 브랜치 없음)', () => {
    const text = ['a'.repeat(40) + '\x1fOn main: wip a\x1f1700000000', 'b'.repeat(40) + '\x1fWIP on feat/x: 1234abc first\x1f1700000100', 'c'.repeat(40) + '\x1fOn (no branch): 메시지: 콜론\x1f1700000200', ''].join('\n')
    expect(parseStashList(text)).toEqual([
      { index: 0, hash: 'a'.repeat(40), message: 'wip a', branch: 'main', time: 1700000000000 },
      { index: 1, hash: 'b'.repeat(40), message: '1234abc first', branch: 'feat/x', time: 1700000100000 },
      { index: 2, hash: 'c'.repeat(40), message: '메시지: 콜론', time: 1700000200000 },
    ])
    expect(parseStashList('')).toEqual([])
  })
})

describe.skipIf(!hasGit)('GitService — 우클릭 메뉴 (#389)', () => {
  const headFiles = (dir: string) => sh(dir, '-c', 'core.quotepath=false', 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').filter(Boolean).sort()

  it('이 파일만 커밋 — 그 파일만 커밋되고 다른 stage 는 그대로. 새 파일은 같은 호출에서 add, 지운 파일·일부 stage 도. 빈 메시지 invalid, 바뀐 게 없으면 nothing', async () => {
    const { git, changed } = await start()
    const dir = await repo()
    await fs.writeFile(path.join(dir, 'a.txt'), 'A2\n')
    await fs.writeFile(path.join(dir, 's.txt'), 's\n')
    sh(dir, 'add', 's.txt')
    await fs.writeFile(path.join(dir, 'n 한글.txt'), 'new\n')

    expect(await git.commitPaths(dir, ['a.txt'], '   ')).toMatchObject({ ok: false, reason: 'invalid' })
    expect(await git.commitPaths(dir, ['nope.txt'], 'm')).toMatchObject({ ok: false, reason: 'nothing' })
    expect(await git.commitPaths(dir, [], 'm')).toMatchObject({ ok: false, reason: 'nothing' })

    const before = changed.length
    expect(await git.perform(dir, { kind: 'commitPaths', paths: ['a.txt'], message: 'only a' })).toMatchObject({ ok: true, files: 1 })
    expect(changed.length).toBeGreaterThan(before)
    expect(headFiles(dir)).toEqual(['a.txt'])
    expect(await git.view(dir)).toMatchObject({ staged: [{ path: 's.txt', kind: 'A' }], changed: [{ path: 'n 한글.txt', kind: 'U' }] })

    expect(await git.commitPaths(dir, ['n 한글.txt'], 'new file')).toMatchObject({ ok: true, files: 1 })
    expect(headFiles(dir)).toEqual(['n 한글.txt'])
    expect(await git.view(dir)).toMatchObject({ staged: [{ path: 's.txt', kind: 'A' }], changed: [] })

    // 일부만 stage 된 파일 — 작업 트리의 내용 그대로 (stage 된 쪽·안 된 쪽 합쳐서)
    await fs.writeFile(path.join(dir, 'a.txt'), 'A3\n')
    sh(dir, 'add', 'a.txt')
    await fs.writeFile(path.join(dir, 'a.txt'), 'A4\n')
    expect(await git.commitPaths(dir, ['a.txt'], 'a4')).toMatchObject({ ok: true })
    expect(sh(dir, 'show', 'HEAD:a.txt')).toBe('A4\n')
    expect(await git.view(dir)).toMatchObject({ staged: [{ path: 's.txt' }], changed: [] })

    // 지운 파일
    await fs.rm(path.join(dir, 'a.txt'))
    expect(await git.commitPaths(dir, ['a.txt'], 'remove a')).toMatchObject({ ok: true })
    expect(sh(dir, '-c', 'core.quotepath=false', 'ls-tree', '--name-only', 'HEAD').trim().split('\n').sort()).toEqual(['n 한글.txt'])
    expect(await git.view(dir)).toMatchObject({ staged: [{ path: 's.txt', kind: 'A' }], changed: [] })
  })

  it('이 파일만 커밋 — 첫 커밋 전에도 (다른 stage 는 남는다)', async () => {
    const { git } = await start()
    const fresh = await folder('fresh')
    sh(fresh, 'init', '-q')
    await fs.writeFile(path.join(fresh, 'x.txt'), 'x\n')
    await fs.writeFile(path.join(fresh, 'y.txt'), 'y\n')
    sh(fresh, 'add', 'y.txt')
    expect(await git.commitPaths(fresh, ['x.txt'], 'first x')).toMatchObject({ ok: true, files: 1 })
    expect(headFiles(fresh)).toEqual(['x.txt'])
    expect(await git.view(fresh)).toMatchObject({ hasCommits: true, staged: [{ path: 'y.txt', kind: 'A' }], changed: [] })
  })

  it('보관 — 그 파일만(다른 stage 는 그대로), 새 파일도. 목록은 최근 먼저. 바뀐 게 없거나 첫 커밋 전이면 nothing', async () => {
    const { git } = await start()
    const fresh = await folder('fresh')
    sh(fresh, 'init', '-q')
    await fs.writeFile(path.join(fresh, 'x.txt'), 'x\n')
    expect(await git.stash(fresh, ['x.txt'], 'm')).toMatchObject({ ok: false, reason: 'nothing' })
    expect(await git.stashes(fresh)).toEqual([])

    const dir = await repo()
    await fs.writeFile(path.join(dir, 'b.txt'), 'b\n')
    sh(dir, 'add', 'b.txt')
    sh(dir, 'commit', '-qm', 'b')
    expect(await git.stash(dir, ['a.txt'], 'm')).toMatchObject({ ok: false, reason: 'nothing' })
    await fs.writeFile(path.join(dir, 'a.txt'), 'A2\n')
    await fs.writeFile(path.join(dir, 'b.txt'), 'B2\n')
    sh(dir, 'add', 'b.txt')
    expect(await git.perform(dir, { kind: 'stash', paths: ['a.txt'], message: 'wip a' })).toEqual({ ok: true })
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('one\ntwo\n')
    expect(await git.view(dir)).toMatchObject({ staged: [{ path: 'b.txt', kind: 'M' }], changed: [] })

    await fs.writeFile(path.join(dir, 'n.txt'), 'new\n')
    expect(await git.stash(dir, ['n.txt'], '')).toEqual({ ok: true })
    await expect(fs.access(path.join(dir, 'n.txt'))).rejects.toThrow()
    const list = await git.stashes(dir)
    expect(list.map((entry) => [entry.index, entry.branch])).toEqual([
      [0, 'main'],
      [1, 'main'],
    ])
    expect(list[0]!.message).toMatch(/ b$/) // 메시지 없이 보관 → git 기본 (짧은 해시 + 커밋 제목)
    expect(list[1]).toMatchObject({ message: 'wip a' })
    expect(list[1]!.hash).toMatch(/^[0-9a-f]{40}$/)
    expect(list[1]!.time).toBeGreaterThan(0)
  })

  it('보관 적용(pop) — 되살리고 목록에서 빠진다. 충돌이면 멈춘 채 conflict 이고 보관은 남는다, 덮이면 overwrite. 삭제(drop). 해시가 다르면 invalid', async () => {
    const { git } = await start()
    const dir = await repo()
    await fs.writeFile(path.join(dir, 'n.txt'), 'new\n')
    await git.stash(dir, ['n.txt'], 'new file')
    await fs.writeFile(path.join(dir, 'a.txt'), 'mine\n')
    await git.stash(dir, ['a.txt'], 'mine')
    let list = await git.stashes(dir)
    expect(list.map((entry) => entry.message)).toEqual(['mine', 'new file'])

    // 해시가 맞지 않으면(그사이 목록이 바뀜) 아무것도 안 한다
    expect(await git.stashPop(dir, 1, list[0]!.hash)).toMatchObject({ ok: false, reason: 'invalid' })
    expect(await git.stashDrop(dir, -1, list[0]!.hash)).toMatchObject({ ok: false, reason: 'invalid' })

    // 새 파일 되살리기
    expect(await git.perform(dir, { kind: 'stashPop', index: 1, hash: list[1]!.hash })).toEqual({ ok: true })
    expect(await fs.readFile(path.join(dir, 'n.txt'), 'utf8')).toBe('new\n')
    list = await git.stashes(dir)
    expect(list.map((entry) => entry.message)).toEqual(['mine'])

    // 덮이면 overwrite — 보관은 남고 작업 트리 그대로
    await fs.writeFile(path.join(dir, 'a.txt'), 'local\n')
    expect(await git.stashPop(dir, 0, list[0]!.hash)).toMatchObject({ ok: false, reason: 'overwrite' })
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('local\n')
    expect(await git.stashes(dir)).toHaveLength(1)

    // 충돌 — 같은 줄을 다르게 커밋한 뒤 적용
    sh(dir, 'commit', '-qam', 'theirs')
    expect(await git.stashPop(dir, 0, list[0]!.hash)).toMatchObject({ ok: false, reason: 'conflict', conflicts: ['a.txt'] })
    expect(await git.stashes(dir)).toHaveLength(1)
    expect(await git.view(dir)).toMatchObject({ conflicts: [{ path: 'a.txt', kind: 'C' }] })
    sh(dir, 'checkout', '-q', 'HEAD', '--', 'a.txt')

    expect(await git.perform(dir, { kind: 'stashDrop', index: 0, hash: list[0]!.hash })).toEqual({ ok: true })
    expect(await git.stashes(dir)).toEqual([])
  })

  it('패치 — HEAD 대비 (stage 된 것 + 안 된 것), 새 파일은 통째로, 첫 커밋 전 stage 된 파일도', async () => {
    const { git } = await start()
    const dir = await repo()
    await fs.writeFile(path.join(dir, 'a.txt'), 'one\nTWO\n')
    sh(dir, 'add', 'a.txt')
    await fs.writeFile(path.join(dir, 'a.txt'), 'ONE\nTWO\n')
    const patch = await git.diff(dir, 'a.txt', 'head')
    expect(patch).toContain('-one')
    expect(patch).toContain('-two')
    expect(patch).toContain('+ONE')
    expect(patch).toContain('+TWO')
    await fs.writeFile(path.join(dir, 'n.txt'), 'hello\n')
    expect(await git.diff(dir, 'n.txt', 'head')).toContain('+hello')

    const fresh = await folder('fresh')
    sh(fresh, 'init', '-q')
    await fs.writeFile(path.join(fresh, 'x.txt'), 'x\n')
    sh(fresh, 'add', 'x.txt')
    expect(await git.diff(fresh, 'x.txt', 'head')).toContain('+x')
  })

  it('삭제 — 프로젝트 안 파일만 지우는 함수에 넘기고 git/changed. 밖·없는 파일은 invalid', async () => {
    const { git, changed } = await start()
    const dir = await repo()
    await fs.mkdir(path.join(dir, 'sub'))
    await fs.writeFile(path.join(dir, 'sub', 'f.txt'), 'f\n')
    await fs.writeFile(path.join(dir, 'root.txt'), 'r\n')
    const removed: string[] = []
    const remove = async (file: string) => {
      removed.push(file)
      await fs.rm(file)
    }
    const before = changed.length
    expect(await git.trash(dir, 'sub/f.txt', remove)).toEqual({ ok: true })
    expect(removed).toEqual([path.join(dir, 'sub', 'f.txt')])
    expect(changed.length).toBeGreaterThan(before)
    for (const bad of ['../x', 'nope.txt', '', '.']) expect(await git.trash(dir, bad, remove)).toMatchObject({ ok: false, reason: 'invalid' })
    // 프로젝트가 저장소의 하위 폴더면 그 밖(저장소 루트의 파일)은 못 지운다 — 경로는 저장소 루트 기준
    await fs.writeFile(path.join(dir, 'sub', 'g.txt'), 'g\n')
    const sub = path.join(dir, 'sub')
    expect(await git.trash(sub, 'root.txt', remove)).toMatchObject({ ok: false, reason: 'invalid' })
    expect(await git.trash(sub, 'sub/g.txt', remove)).toEqual({ ok: true })
    expect(removed).toHaveLength(2)
    await fs.access(path.join(dir, 'root.txt'))
  })
})

// ── .gitignore 연계 (#390, IntelliJ 방식) — 판정은 git 에 맡긴다 (check-ignore·ls-files). 쓰기는 새 파일 경로 한 줄 덧붙이기 ──

describe('무시 줄 (#390) — 순수 규칙', () => {
  it('그 경로 그대로 — 루트 파일은 / 로 고정(다른 폴더의 같은 이름까지 가리지 않게), 폴더는 폴더/', () => {
    expect(ignoreLine('scripts/tmp-probe.mjs')).toBe('scripts/tmp-probe.mjs')
    expect(ignoreLine('.env.local')).toBe('/.env.local')
    expect(ignoreLine('build/')).toBe('/build/')
    expect(ignoreLine('a/b/')).toBe('a/b/')
  })

  it('특수문자 이스케이프 — * ? [ ] \\ 는 앞에 \\, 맨 앞 ! # 는 \\, 끝 공백은 \\ 공백', () => {
    expect(ignoreLine('x[1]*?.txt')).toBe('/x\\[1\\]\\*\\?.txt')
    expect(ignoreLine('b\\c')).toBe('/b\\\\c')
    expect(ignoreLine('!b/x')).toBe('\\!b/x')
    expect(ignoreLine('#h/x')).toBe('\\#h/x')
    expect(ignoreLine('!b')).toBe('/!b') // / 로 시작하면 ! 는 글자 그대로
    expect(ignoreLine('tail  ')).toBe('/tail\\ \\ ')
  })
})

describe.skipIf(!hasGit)('GitService — .gitignore 연계 (#390)', () => {
  it('무시 목록 — 폴더 단위로 접고(node_modules 안을 열지 않는다), 규칙 파일:줄·패턴. 중첩 .gitignore·info/exclude, 부정 패턴(!)은 빠진다', async () => {
    const { git } = await start()
    const dir = await repo()
    await fs.writeFile(path.join(dir, '.gitignore'), 'node_modules/\n*.log\n# c\n!keep.log\n.env.local\n')
    await fs.writeFile(path.join(dir, '.git', 'info', 'exclude'), 'secret.txt\n')
    for (const file of ['node_modules/x/a.js', 'node_modules/y/b.js', 'logs/a.log', 'logs/b.log', 'mixed/a.log', 'mixed/b.txt', 'keep.log', 'x.log', '.env.local', 'secret.txt', 'sub/deep/y.tmp', 'sub/z.txt']) {
      await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true })
      await fs.writeFile(path.join(dir, file), 'x\n')
    }
    await fs.writeFile(path.join(dir, 'sub', '.gitignore'), '*.tmp\n')
    expect(await git.ignored(dir)).toEqual([
      { path: '.env.local', source: '.gitignore', line: 5, pattern: '.env.local' },
      { path: 'logs/', source: '.gitignore', line: 2, pattern: '*.log' }, // 안이 모두 같은 규칙 → 폴더 한 줄
      { path: 'mixed/a.log', source: '.gitignore', line: 2, pattern: '*.log' }, // 무시 안 된 파일이 섞인 폴더는 파일로
      { path: 'node_modules/', source: '.gitignore', line: 1, pattern: 'node_modules/' },
      { path: 'secret.txt', source: '.git/info/exclude', line: 1, pattern: 'secret.txt' },
      { path: 'sub/deep/', source: 'sub/.gitignore', line: 1, pattern: '*.tmp' },
      { path: 'x.log', source: '.gitignore', line: 2, pattern: '*.log' },
    ])
    // 무시된 것이 없으면 빈 목록
    expect(await git.ignored(await repo())).toEqual([])
  })

  it('.gitignore 에 추가 — 없으면 만들고, 있으면 덧붙인다(마지막 줄바꿈이 없으면 먼저). 같은 줄이 있으면 nothing. 새 파일은 목록에서 빠지고 무시 목록에 든다', async () => {
    const { git, changed } = await start()
    const dir = await repo()
    await fs.mkdir(path.join(dir, 'scripts'))
    await fs.writeFile(path.join(dir, 'scripts', 'tmp-probe.mjs'), 'x\n')
    await fs.writeFile(path.join(dir, 'scripts', 'other.mjs'), 'x\n')
    await fs.writeFile(path.join(dir, 'root.txt'), 'x\n')
    const before = changed.length
    expect(await git.addIgnore(dir, 'scripts/tmp-probe.mjs', 'gitignore')).toEqual({ ok: true, file: '.gitignore', line: 'scripts/tmp-probe.mjs' })
    expect(changed.length).toBeGreaterThan(before)
    expect(await fs.readFile(path.join(dir, '.gitignore'), 'utf8')).toBe('scripts/tmp-probe.mjs\n')
    const view = await git.view(dir)
    expect(view.state === 'ok' && view.changed.map((file) => file.path)).toEqual(['.gitignore', 'root.txt', 'scripts/other.mjs'])

    // 같은 줄 → nothing (파일 그대로)
    expect(await git.perform(dir, { kind: 'addIgnore', path: 'scripts/tmp-probe.mjs', where: 'gitignore' })).toMatchObject({ ok: false, reason: 'nothing' })
    expect(await fs.readFile(path.join(dir, '.gitignore'), 'utf8')).toBe('scripts/tmp-probe.mjs\n')

    // 마지막 줄바꿈이 없는 파일 — 기존 내용은 그대로, 줄바꿈을 먼저
    await fs.writeFile(path.join(dir, '.gitignore'), '# 팀 규칙\nscripts/tmp-probe.mjs')
    expect(await git.perform(dir, { kind: 'addIgnore', path: 'root.txt', where: 'gitignore' })).toMatchObject({ ok: true, line: '/root.txt' })
    expect(await fs.readFile(path.join(dir, '.gitignore'), 'utf8')).toBe('# 팀 규칙\nscripts/tmp-probe.mjs\n/root.txt\n')
    expect((await git.ignored(dir)).map((entry) => [entry.path, entry.line])).toEqual([
      ['root.txt', 3],
      ['scripts/tmp-probe.mjs', 2],
    ])
  })

  it('.git/info/exclude 에 추가 — .gitignore 는 건드리지 않는다. 특수문자 이름도 그 파일만 가린다', async () => {
    const { git } = await start()
    const dir = await repo()
    await fs.writeFile(path.join(dir, '!bang [1].txt'), 'x\n')
    await fs.writeFile(path.join(dir, '!bang 1.txt'), 'x\n')
    expect(await git.addIgnore(dir, '!bang [1].txt', 'exclude')).toEqual({ ok: true, file: '.git/info/exclude', line: '/!bang \\[1\\].txt' })
    expect(await fs.readFile(path.join(dir, '.git', 'info', 'exclude'), 'utf8')).toMatch(/\n\/!bang \\\[1\\\]\.txt\n$/)
    await expect(fs.access(path.join(dir, '.gitignore'))).rejects.toThrow()
    expect(await git.ignored(dir)).toEqual([{ path: '!bang [1].txt', source: '.git/info/exclude', line: expect.any(Number), pattern: '/!bang \\[1\\].txt' }])
  })

  it('저장소 밖·.git 안·빈 경로·줄바꿈·모르는 저장 위치는 invalid — 아무것도 쓰지 않는다', async () => {
    const { git } = await start()
    const dir = await repo()
    for (const bad of ['../x', '/etc/passwd', '.git/config', 'sub/.git/x', '', 'a\nb'])
      expect(await git.perform(dir, { kind: 'addIgnore', path: bad, where: 'gitignore' })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(await git.perform(dir, { kind: 'addIgnore', path: 'a.txt', where: 'elsewhere' as 'gitignore' })).toMatchObject({ ok: false, reason: 'invalid' })
    await expect(fs.access(path.join(dir, '.gitignore'))).rejects.toThrow()
  })
})
