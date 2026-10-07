import { Context } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectsService } from '../../src/services/projects.ts'

// 최근 프로젝트 목록 — userData 의 작은 JSON. 재시작해도 남아야 하고(사용자 결정 1),
// 목록 키는 opencode 에 넘기는 작업 디렉터리와 같은 realpath 여야 한다 (01_probe: opencode 는 경로를 문자열 그대로 비교).

let root: string
let file: string

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-projects-')))
  file = path.join(root, 'userData', 'projects.json')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

async function projects(): Promise<ProjectsService> {
  const ctx = new Context()
  ctx.plugin(ProjectsService, { file })
  return new Promise((resolve) => ctx.inject(['projects'], (ready) => resolve(ready.projects)))
}

async function folder(name: string): Promise<string> {
  const dir = path.join(root, name)
  await fs.mkdir(dir)
  return dir
}

describe('ProjectsService', () => {
  it('처음(파일 없음)에는 빈 목록이다', async () => {
    expect(await (await projects()).list()).toEqual([])
  })

  it('연 폴더가 맨 앞에 오고, 다시 열면 중복 없이 맨 앞으로 올라온다', async () => {
    const service = await projects()
    const a = await folder('alpha')
    const b = await folder('beta')

    await service.open(a)
    await service.open(b)
    expect((await service.list()).map((project) => project.path)).toEqual([b, a])

    await service.open(a)
    expect((await service.list()).map((project) => project.path)).toEqual([a, b])
  })

  it('이름은 폴더 이름이다', async () => {
    const service = await projects()
    expect(await service.open(await folder('my-app'))).toMatchObject({ name: 'my-app' })
  })

  it('심볼릭 링크·끝 슬래시로 열어도 realpath 하나로 저장된다', async () => {
    const service = await projects()
    const real = await folder('real')
    const link = path.join(root, 'link')
    await fs.symlink(real, link)

    expect((await service.open(link)).path).toBe(real)
    await service.open(`${real}/`)
    expect((await service.list()).map((project) => project.path)).toEqual([real])
  })

  it('has 는 목록의 path 와 글자 그대로 같을 때만 참이다 — 끝 슬래시·심볼릭 링크·대소문자가 다르면 거짓 (IPC 의 폴더 문)', async () => {
    const service = await projects()
    const real = await folder('real')
    const link = path.join(root, 'link')
    await fs.symlink(real, link)
    expect(await service.has(real)).toBe(false)
    await service.open(real)

    expect(await service.has(real)).toBe(true)
    expect(await service.has(`${real}/`)).toBe(false)
    expect(await service.has(link)).toBe(false)
    expect(await service.has(real.toUpperCase())).toBe(false)
    expect(await service.has(path.join(real, 'sub'))).toBe(false)
    expect(await service.has(undefined as unknown as string)).toBe(false) // 화면이 문자열이 아닌 값을 보내도
    await service.remove(real)
    expect(await service.has(real)).toBe(false)
  })

  it('없는 경로·파일은 거절하고 목록을 안 바꾼다', async () => {
    const service = await projects()
    const a = await folder('alpha')
    await service.open(a)
    const notDir = path.join(root, 'file.txt')
    await fs.writeFile(notDir, 'x')

    await expect(service.open(path.join(root, 'nope'))).rejects.toThrow()
    await expect(service.open(notDir)).rejects.toThrow()
    expect((await service.list()).map((project) => project.path)).toEqual([a])
  })

  it('다른 인스턴스(앱 재시작)가 같은 파일을 읽으면 목록과 순서가 그대로다', async () => {
    const a = await folder('alpha')
    const b = await folder('beta')
    const first = await projects()
    await first.open(a)
    await first.open(b)

    expect((await (await projects()).list()).map((project) => project.path)).toEqual([b, a])
  })

  it.each([['{ 깨진'], ['"문자열"'], ['{"recent":"x"}'], ['{"recent":[1,null]}']])('손상된 JSON(%s)이면 빈 목록으로 시작하고 다음 open 이 파일을 다시 쓴다', async (raw) => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, raw)
    const service = await projects()

    expect(await service.list()).toEqual([])
    const a = await folder('alpha')
    await service.open(a)
    expect((await (await projects()).list()).map((project) => project.path)).toEqual([a])
  })

  // 참고 레포 검토(02x A): 깨진 파일을 다음 쓰기가 덮지 않게 옆에 옮겨 둔다 (JSON 이 아니거나 맨 위가 객체가 아닐 때)
  it.each([['{ 깨진'], ['"문자열"']])('손상된 파일(%s)은 덮어쓰지 않고 옆에 .corrupt-<시각> 으로 옮겨 둔다', async (raw) => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, raw)
    await (await projects()).open(await folder('alpha'))

    const backups = (await fs.readdir(path.dirname(file))).filter((name) => name.startsWith('projects.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(await fs.readFile(path.join(path.dirname(file), backups[0]!), 'utf8')).toBe(raw)
  })

  it('즐겨찾기는 표시되고 재시작해도 남으며, 다시 누르면 풀린다', async () => {
    const a = await folder('alpha')
    const b = await folder('beta')
    const service = await projects()
    await service.open(a)
    await service.open(b)

    const listed = await service.setFavorite(a, true)
    expect(listed.map((project) => [project.path, project.favorite])).toEqual([[b, false], [a, true]])
    expect((await (await projects()).list()).find((project) => project.path === a)?.favorite).toBe(true)

    await service.setFavorite(a, false)
    expect((await service.list()).every((project) => !project.favorite)).toBe(true)
  })

  // 목록에서 빼기는 목록만 고친다 — 사용자 폴더는 디스크에 그대로 (00_request C)
  it('remove 는 projects/removed 로 뺀 폴더를 알린다 — ctx.notifications 가 그 프로젝트의 알림을 거둔다', async () => {
    const service = await projects()
    const dir = await folder('notify')
    await service.open(dir)
    const removed: string[] = []
    service['ctx'].on('projects/removed', (entry) => void removed.push(entry))
    await service.remove(dir)
    expect(removed).toEqual([dir])
  })

  it('remove 는 목록·즐겨찾기에서만 빼고 폴더는 지우지 않는다', async () => {
    const a = await folder('alpha')
    await fs.writeFile(path.join(a, 'keep.txt'), 'x')
    const b = await folder('beta')
    const service = await projects()
    await service.open(a)
    await service.open(b)
    await service.setFavorite(a, true)

    expect((await service.remove(a)).map((project) => project.path)).toEqual([b])
    expect((await (await projects()).list()).map((project) => project.path)).toEqual([b])
    expect(await fs.readFile(path.join(a, 'keep.txt'), 'utf8')).toBe('x')
  })

  it('디스크에서 지워진 폴더도 remove 로 뺄 수 있다', async () => {
    const a = await folder('alpha')
    const service = await projects()
    await service.open(a)
    await fs.rm(a, { recursive: true })

    expect(await service.remove(a)).toEqual([])
  })

  // 한 파일을 여러 동작이 고친다 — 겹쳐도 갱신이 사라지거나 rename 이 깨지지 않아야 한다 (03_qa 참고)
  it('동시에 여러 번 고쳐도 갱신이 사라지지 않는다', async () => {
    const dirs = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map(folder))
    const service = await projects()

    await Promise.all(dirs.map((dir) => service.open(dir)))
    await Promise.all([service.setFavorite(dirs[0]!, true), service.setFavorite(dirs[1]!, true), service.remove(dirs[2]!)])

    const listed = await (await projects()).list()
    expect(listed.map((project) => project.path).sort()).toEqual([dirs[0], dirs[1], dirs[3], dirs[4], dirs[5]].sort())
    expect(listed.filter((project) => project.favorite).map((project) => project.path).sort()).toEqual([dirs[0], dirs[1]].sort())
  })

  it('favorites 필드가 없는 옛 파일도 읽는다', async () => {
    const a = await folder('alpha')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ recent: [a] }))

    expect(await (await projects()).list()).toMatchObject([{ path: a, favorite: false }])
  })

  it('홈 아래 경로는 displayPath 에서 ~ 로 줄인다', async () => {
    vi.spyOn(os, 'homedir').mockReturnValue(root)
    const service = await projects()

    expect(await service.open(await folder('alpha'))).toMatchObject({ displayPath: '~/alpha' })
  })

  it('rename 은 보이는 이름만 바꾸고 재시작해도 남는다 — 폴더 이름·경로는 그대로', async () => {
    const alpha = await folder('alpha')
    await (await projects()).open(alpha)

    const renamed = await (await projects()).rename(alpha, '  내 프로젝트  ')
    expect(renamed.find((project) => project.path === alpha)?.name).toBe('내 프로젝트')
    expect((await (await projects()).list())[0]).toMatchObject({ path: alpha, name: '내 프로젝트' })
    expect(await fs.stat(alpha).then((stat) => stat.isDirectory())).toBe(true)
  })

  it('빈 이름으로 rename 하면 폴더 이름으로 돌아가고, remove 하면 붙인 이름도 사라진다', async () => {
    const service = await projects()
    const alpha = await folder('alpha')
    await service.open(alpha)
    await service.rename(alpha, '별명')

    expect((await service.rename(alpha, '   '))[0]?.name).toBe('alpha')
    await service.rename(alpha, '별명')
    await service.remove(alpha)
    await service.open(alpha)
    expect((await service.list())[0]?.name).toBe('alpha')
  })
})
