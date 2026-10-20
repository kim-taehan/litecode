import { execFileSync } from 'node:child_process'
import { Context } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsService } from '../../src/services/settings.ts'
import { ExtensionsService, type ExtensionsOptions } from '../../src/services/extensions.ts'
import { changedFiles, pickBase } from '../../src/services/extensions/changes.ts'
import { projectRelativePaths } from '../../src/services/extensions/pick.ts'
import { ExtensionStore } from '../../src/services/extensions/store.ts'
import { makeZip } from './support/zipWriter.ts'

// 통로 메서드 project.pickPath · project.changedFiles (이슈 #538) — 고른 경로를 프로젝트 기준 상대 경로로(밖은 빼고 개수만), "내 변경" =
// 기준 브랜치의 merge-base 대비 바뀐 파일 ∪ 커밋 안 한 변경. 임시 git 저장소는 시스템 git 으로 만든다. ctx.git(선택 기능)은 띄우지 않는다

let dir: string
let project: string

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-ext-pick-')))
  project = path.join(dir, 'project')
  await fs.mkdir(project)
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('projectRelativePaths — 고른 경로 → 프로젝트 기준', () => {
  it('파일은 상대 경로, 폴더는 끝에 `/`, 프로젝트 자체는 `./`. 구분자는 `/`, 공백·한글 그대로', async () => {
    await fs.mkdir(path.join(project, 'src', '한글 폴더'), { recursive: true })
    await fs.writeFile(path.join(project, 'src', '한글 폴더', 'My Class.java'), '')
    expect(await projectRelativePaths(project, [path.join(project, 'src', '한글 폴더', 'My Class.java'), path.join(project, 'src'), project])).toEqual({
      paths: ['src/한글 폴더/My Class.java', 'src/', './'],
      outside: 0,
    })
  })

  it('프로젝트 밖·밖을 가리키는 심볼릭 링크·없는 경로는 빼고 outside 로 센다. 안을 가리키는 링크는 실제 경로로', async () => {
    await fs.writeFile(path.join(dir, 'outside.txt'), '')
    await fs.mkdir(path.join(project, 'real'))
    await fs.symlink(path.join(dir, 'outside.txt'), path.join(project, 'out-link'))
    await fs.symlink(path.join(project, 'real'), path.join(project, 'in-link'))
    // 이름이 프로젝트 이름으로 시작하는 옆 폴더도 밖이다
    await fs.mkdir(`${project}-other`)
    const chosen = [path.join(dir, 'outside.txt'), path.join(project, 'out-link'), path.join(project, 'in-link'), `${project}-other`, path.join(project, 'gone.txt')]
    expect(await projectRelativePaths(project, chosen)).toEqual({ paths: ['real/'], outside: 4 })
  })
})

describe('pickBase — 기준 브랜치 고르기', () => {
  const probe = (refs: string[], originHead?: string) => ({
    originHead: async () => originHead,
    exists: async (ref: string) => refs.includes(ref),
  })

  it('origin/HEAD 가 있으면 그것', async () => {
    expect(await pickBase(probe(['refs/heads/dev', 'refs/heads/main'], 'origin/main'))).toBe('origin/main')
  })

  it('없으면 dev → main → master 순 — 로컬 브랜치, 없으면 origin 의 같은 이름', async () => {
    expect(await pickBase(probe(['refs/heads/master', 'refs/heads/main', 'refs/remotes/origin/dev']))).toBe('origin/dev')
    expect(await pickBase(probe(['refs/heads/master', 'refs/heads/main']))).toBe('main')
    expect(await pickBase(probe(['refs/remotes/origin/master']))).toBe('origin/master')
    expect(await pickBase(probe([]))).toBeUndefined()
  })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
}

async function write(file: string, text = 'x\n'): Promise<void> {
  await fs.mkdir(path.dirname(path.join(project, file)), { recursive: true })
  await fs.writeFile(path.join(project, file), text)
}

describe('changedFiles — 임시 저장소', () => {
  async function repo(): Promise<void> {
    git(project, 'init', '-q', '-b', 'main')
    for (const file of ['a.txt', 'b.txt', 'd.txt', 'keep.txt', 'u.txt']) await write(file)
    await write('.gitignore', 'ignored.log\n')
    git(project, 'add', '-A')
    git(project, 'commit', '-q', '-m', 'base')
    git(project, 'checkout', '-q', '-b', 'feature')
  }

  it('기준(main) 대비 이 브랜치의 커밋 ∪ 스테이지 ∪ 작업 트리 ∪ 새 파일. 이름 바뀜은 새 이름, 지운 파일·무시한 파일은 없다, 공백·한글 경로', async () => {
    await repo()
    await write('a.txt', 'changed\n')
    git(project, 'mv', 'b.txt', 'c.txt')
    git(project, 'rm', '-q', 'd.txt')
    git(project, 'commit', '-q', '-am', 'branch work')
    await write('공백 파일.txt')
    git(project, 'add', '공백 파일.txt')
    await write('u.txt', 'unstaged\n')
    await write('한글/새 파일.md')
    await write('ignored.log')
    expect(await changedFiles('git', project)).toEqual({ ok: true, base: 'main', files: ['a.txt', 'c.txt', 'u.txt', '공백 파일.txt', '한글/새 파일.md'] })
  })

  it('프로젝트가 저장소의 하위 폴더면 그 아래만, 그 폴더 기준 경로로', async () => {
    await repo()
    await write('sub/in.txt')
    await write('top.txt')
    expect(await changedFiles('git', path.join(project, 'sub'))).toEqual({ ok: true, base: 'main', files: ['in.txt'] })
  })

  it('기준 브랜치가 없으면 base null — 커밋 안 한 변경만', async () => {
    git(project, 'init', '-q', '-b', 'work')
    await write('a.txt')
    git(project, 'add', '-A')
    git(project, 'commit', '-q', '-m', 'one')
    await write('a.txt', 'changed\n')
    await write('new.txt')
    expect(await changedFiles('git', project)).toEqual({ ok: true, base: null, files: ['a.txt', 'new.txt'] })
  })

  it('커밋이 하나도 없는 저장소 — 스테이지·새 파일 모두', async () => {
    git(project, 'init', '-q', '-b', 'main')
    await write('staged.txt')
    git(project, 'add', 'staged.txt')
    await write('new.txt')
    expect(await changedFiles('git', project)).toEqual({ ok: true, base: null, files: ['new.txt', 'staged.txt'] })
  })

  it('저장소가 아니면 not-a-repo, git 이 없으면 git-unavailable', async () => {
    expect(await changedFiles('git', project)).toEqual({ ok: false, error: 'not-a-repo' })
    expect(await changedFiles(path.join(dir, 'no-git-here'), project)).toEqual({ ok: false, error: 'git-unavailable' })
  })
})

describe('서비스 — ctx.extensions.call', () => {
  const root = () => path.join(dir, 'extensions')

  async function install(id: string, permissions?: string[]): Promise<void> {
    const file = path.join(dir, `${id}.zip`)
    const manifest = { id, name: id, description: '설명', version: '1.0.0', entry: 'index.html', ...(permissions && { permissions }) }
    await fs.writeFile(file, makeZip([{ name: 'extension.json', data: JSON.stringify(manifest) }, { name: 'index.html', data: '<p>x</p>' }]))
    const store = new ExtensionStore(root())
    const staged = await store.stage(file, '1.0.0')
    await store.install(staged.token!, '1.0.0')
    await store.applyPending()
  }

  async function boot(options: Partial<ExtensionsOptions> = {}) {
    const ctx = new Context()
    ctx.plugin(SettingsService, { file: path.join(dir, 'settings.json') })
    ctx.plugin(ExtensionsService, { root: root(), appVersion: '1.0.0', ...options })
    const ready = await new Promise<Context>((resolve) => ctx.inject(['extensions'], (injected) => resolve(injected)))
    await ready.extensions.idle()
    return ready.extensions
  }

  const here = () => ({ directory: project, name: 'p' })

  it('project 권한이 없으면 두 메서드 다 permission-missing', async () => {
    await install('bare-ext')
    const ext = await boot({ pickPaths: async () => [] })
    expect(await ext.call('bare-ext', 'project.pickPath', {}, here())).toEqual({ ok: false, error: 'permission-missing' })
    expect(await ext.call('bare-ext', 'project.changedFiles', undefined, here())).toEqual({ ok: false, error: 'permission-missing' })
  })

  it('pickPath — 요청한 창·시작 폴더·multiple 을 대화상자에 넘기고 상대 경로로 돌려준다. 취소면 canceled', async () => {
    await install('p-ext', ['project'])
    await write('src/A.java')
    const seen: unknown[] = []
    let answer: string[] | undefined = [path.join(project, 'src'), path.join(project, 'src', 'A.java'), path.join(dir, 'x')]
    const ext = await boot({
      pickPaths: async (owner, request) => {
        seen.push([owner, request])
        return answer
      },
    })
    expect(await ext.call('p-ext', 'project.pickPath', { multiple: true }, here(), 'win-1')).toEqual({ ok: true, result: { paths: ['src/', 'src/A.java'], outside: 1 } })
    expect(seen).toEqual([['win-1', { directory: project, multiple: true }]])
    answer = undefined
    expect(await ext.call('p-ext', 'project.pickPath', undefined, here())).toEqual({ ok: true, result: { paths: [], canceled: true } })
    expect(seen.at(-1)).toEqual([undefined, { directory: project, multiple: false }])
  })

  it('pickPath — 대화상자가 떠 있는 동안 같은 확장의 두 번째 요청은 busy (다른 확장은 막지 않는다), 닫히면 다시 된다', async () => {
    await install('p-ext', ['project'])
    await install('q-ext', ['project'])
    const open: ((paths: string[] | undefined) => void)[] = []
    const ext = await boot({ pickPaths: () => new Promise((resolve) => open.push(resolve)) })
    const tick = () => new Promise((resolve) => setTimeout(resolve, 10))
    const first = ext.call('p-ext', 'project.pickPath', {}, here())
    await tick()
    expect(await ext.call('p-ext', 'project.pickPath', {}, here())).toEqual({ ok: false, error: 'busy' })
    const other = ext.call('q-ext', 'project.pickPath', {}, here())
    await tick()
    expect(open).toHaveLength(2)
    open[0]!(undefined)
    open[1]!([])
    expect(await first).toEqual({ ok: true, result: { paths: [], canceled: true } })
    expect(await other).toEqual({ ok: true, result: { paths: [], outside: 0 } })
    const again = ext.call('p-ext', 'project.pickPath', {}, here())
    await tick()
    open[2]!([project])
    expect(await again).toEqual({ ok: true, result: { paths: ['./'], outside: 0 } })
  })

  it('pickPath — 대화상자가 없거나 던지면 io-failed, multiple 이 불이 아니면 params-invalid, 프로젝트가 없으면 no-project', async () => {
    await install('p-ext', ['project'])
    let ext = await boot()
    expect(await ext.call('p-ext', 'project.pickPath', {}, here())).toEqual({ ok: false, error: 'io-failed' })
    ext = await boot({ pickPaths: async () => Promise.reject(new Error('no window')) })
    expect(await ext.call('p-ext', 'project.pickPath', {}, here())).toEqual({ ok: false, error: 'io-failed' })
    expect(await ext.call('p-ext', 'project.pickPath', { multiple: 'yes' }, here())).toEqual({ ok: false, error: 'params-invalid' })
    expect(await ext.call('p-ext', 'project.pickPath', {})).toEqual({ ok: false, error: 'no-project' })
  })

  it('changedFiles — git 기능(ctx.git) 없이 돈다. git 이 없으면 git-unavailable', async () => {
    await install('p-ext', ['project'])
    git(project, 'init', '-q', '-b', 'main')
    await write('new.txt')
    let ext = await boot()
    expect(await ext.call('p-ext', 'project.changedFiles', undefined, here())).toEqual({ ok: true, result: { base: null, files: ['new.txt'] } })
    ext = await boot({ git: path.join(dir, 'no-git-here') })
    expect(await ext.call('p-ext', 'project.changedFiles', undefined, here())).toEqual({ ok: false, error: 'git-unavailable' })
  })
})
