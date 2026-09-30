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
