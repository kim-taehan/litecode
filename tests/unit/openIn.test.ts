import { Context } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectsService } from '../../src/services/projects.ts'
import { OpenInService, detectApps, type Launch, type OpenInHost } from '../../src/services/openIn.ts'

// "다른 앱에서 열기" — 탐지는 정해진 허용 목록 중 앱 폴더에 실제로 있는 것만, 열기는 탐지된 앱 id + 등록된 프로젝트 폴더만.
// 그 밖은 실행기를 부르지 않고 거절한다 (렌더러가 오염돼도 사용자가 연 폴더를 허용 목록 앱으로 여는 것 말고는 못 한다)

let tmp: string
let roots: string[]
let fixed: string
let project: string

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-openin-')))
  roots = [path.join(tmp, 'Applications'), path.join(tmp, 'home-Applications')]
  for (const root of roots) await fs.mkdir(root)
  fixed = path.join(tmp, 'System')
  await fs.mkdir(path.join(fixed, 'Finder.app'), { recursive: true })
  await fs.mkdir(path.join(fixed, 'Terminal.app'), { recursive: true })
  project = path.join(tmp, 'project')
  await fs.mkdir(project)
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const fixedPaths = () => ({ finder: path.join(fixed, 'Finder.app'), terminal: path.join(fixed, 'Terminal.app') })

async function app(root: string, name: string): Promise<string> {
  const bundle = path.join(root, name)
  await fs.mkdir(bundle)
  return bundle
}

describe('detectApps', () => {
  it('허용 목록 중 앱 폴더에 있는 것만, 목록 순서(파일 관리자 → 편집기 → Git → 터미널)로', async () => {
    await app(roots[0], 'iTerm.app')
    await app(roots[0], 'Visual Studio Code.app')
    await app(roots[1], 'Sourcetree.app')
    await app(roots[0], 'Some Other.app') // 목록 밖 — 안 보인다
    const apps = detectApps({ roots, fixed: fixedPaths() })
    expect(apps.map((entry) => entry.id)).toEqual(['finder', 'vscode', 'sourcetree', 'iterm', 'terminal'])
    expect(apps.find((entry) => entry.id === 'sourcetree')!.bundle).toBe(path.join(roots[1], 'Sourcetree.app'))
    expect(apps.find((entry) => entry.id === 'iterm')!.name).toBe('iTerm2')
  })

  it('이름 후보 중 첫 번째로 있는 것 하나 — IntelliJ 가 둘 깔려 있어도 한 줄', async () => {
    await app(roots[0], 'IntelliJ IDEA CE.app')
    await app(roots[0], 'IntelliJ IDEA.app')
    const apps = detectApps({ roots, fixed: fixedPaths() }).filter((entry) => entry.id === 'intellij')
    expect(apps).toEqual([{ id: 'intellij', name: 'IntelliJ IDEA', bundle: path.join(roots[0], 'IntelliJ IDEA.app') }])
  })

  it('고정 앱(Finder·Terminal)도 경로가 없으면 빠진다', () => {
    expect(detectApps({ roots, fixed: { finder: path.join(tmp, 'nope.app'), terminal: path.join(tmp, 'nope2.app') } })).toEqual([])
  })
})

interface Recorder extends OpenInHost {
  launches: Launch[]
}

function recorder(): Recorder {
  const launches: Launch[] = []
  return { launches, icon: async (bundle) => `icon:${path.basename(bundle)}`, launch: async (what) => void launches.push(what) }
}

async function service(host: Recorder, platform: NodeJS.Platform = 'darwin'): Promise<{ openIn: OpenInService; projects: ProjectsService }> {
  const ctx = new Context()
  ctx.plugin(ProjectsService, { file: path.join(tmp, 'projects.json') })
  ctx.plugin(OpenInService, { host, roots, fixed: fixedPaths(), platform })
  return new Promise((resolve) => ctx.inject(['openIn', 'projects'], (ready) => resolve({ openIn: ready.openIn, projects: ready.projects })))
}

describe('OpenInService', () => {
  it('apps — 탐지된 것 + 아이콘. 아이콘을 못 구하면 null', async () => {
    await app(roots[0], 'Ghostty.app')
    const host = recorder()
    host.icon = async (bundle) => (bundle.endsWith('Ghostty.app') ? null : `icon:${path.basename(bundle)}`)
    const { openIn } = await service(host)
    expect(await openIn.apps()).toEqual([
      { id: 'finder', name: 'Finder', icon: 'icon:Finder.app' },
      { id: 'ghostty', name: 'Ghostty', icon: null },
      { id: 'terminal', name: 'Terminal', icon: 'icon:Terminal.app' },
    ])
  })

  it('mac 이 아니면 빈 목록 (첫 버전은 mac 만 — 버튼이 숨는다)', async () => {
    const { openIn } = await service(recorder(), 'win32')
    expect(await openIn.apps()).toEqual([])
  })

  it('등록된 프로젝트 폴더를 탐지된 앱으로 — open -a <번들> <폴더>, Finder 는 OS 열기', async () => {
    const iterm = await app(roots[0], 'iTerm.app')
    const host = recorder()
    const { openIn, projects } = await service(host)
    await projects.open(project)
    await openIn.open('iterm', project)
    await openIn.open('finder', project)
    expect(host.launches).toEqual([
      { kind: 'open-a', args: ['-a', iterm, project] },
      { kind: 'os-open', path: project },
    ])
  })

  it('목록 밖 앱 id·설치 안 된 앱은 거절하고 실행기를 부르지 않는다', async () => {
    const host = recorder()
    const { openIn, projects } = await service(host)
    await projects.open(project)
    await expect(openIn.open('calculator', project)).rejects.toThrow()
    await expect(openIn.open('vscode', project)).rejects.toThrow() // 목록엔 있지만 설치 안 됨
    await expect(openIn.open(undefined as unknown as string, project)).rejects.toThrow()
    expect(host.launches).toEqual([])
  })

  it('등록 안 된 폴더·상대 경로·옵션처럼 보이는 값·지워진 프로젝트 폴더는 거절', async () => {
    const host = recorder()
    const { openIn, projects } = await service(host)
    await projects.open(project)
    const other = path.join(tmp, 'other')
    await fs.mkdir(other)
    await expect(openIn.open('finder', other)).rejects.toThrow()
    await expect(openIn.open('finder', path.relative(process.cwd(), project))).rejects.toThrow()
    await expect(openIn.open('finder', '-n')).rejects.toThrow()
    await expect(openIn.open('finder', `${project}/../project`)).rejects.toThrow()
    await fs.rm(project, { recursive: true })
    await expect(openIn.open('finder', project)).rejects.toThrow()
    expect(host.launches).toEqual([])
  })

  it('실행이 실패하면 사유를 던지고, 다음 apps() 는 다시 탐지한다 (지운 앱이 목록에서 빠지게)', async () => {
    const bundle = await app(roots[0], 'Zed.app')
    const host = recorder()
    host.launch = async () => {
      throw new Error('boom')
    }
    const { openIn, projects } = await service(host)
    await projects.open(project)
    expect((await openIn.apps()).map((entry) => entry.id)).toContain('zed')
    await fs.rm(bundle, { recursive: true })
    await expect(openIn.open('zed', project)).rejects.toThrow()
    expect((await openIn.apps()).map((entry) => entry.id)).not.toContain('zed')
  })
})

describe('OpenInService.openFile — 패널의 PDF 를 기본 앱으로 (이슈 #214)', () => {
  const PDF = '%PDF-1.7\n'

  it('등록된 프로젝트 안의 .pdf(머리 %PDF-)를 OS 열기로 — 경로는 realpath', async () => {
    await fs.writeFile(path.join(project, 'doc.pdf'), PDF)
    await fs.symlink(path.join(project, 'doc.pdf'), path.join(project, 'alias.pdf'))
    const host = recorder()
    const { openIn, projects } = await service(host)
    await projects.open(project)
    await openIn.openFile(project, 'doc.pdf')
    await openIn.openFile(project, './alias.pdf')
    expect(host.launches).toEqual([
      { kind: 'os-open', path: path.join(project, 'doc.pdf') },
      { kind: 'os-open', path: path.join(project, 'doc.pdf') },
    ])
  })

  it('pdf 가 아닌 것·이름만 pdf·프로젝트 밖·밖을 가리키는 링크·등록 안 된 폴더는 거절하고 실행기를 부르지 않는다', async () => {
    const outside = path.join(tmp, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'secret.pdf'), PDF)
    await fs.symlink(path.join(outside, 'secret.pdf'), path.join(project, 'leak.pdf'))
    await fs.writeFile(path.join(project, 'doc.pdf'), PDF)
    await fs.writeFile(path.join(project, 'run.command'), '#!/bin/sh\n')
    await fs.writeFile(path.join(project, 'fake.pdf'), 'not a pdf')
    const host = recorder()
    const { openIn, projects } = await service(host)
    await expect(openIn.openFile(project, 'doc.pdf')).rejects.toThrow() // 등록 전
    await projects.open(project)
    await expect(openIn.openFile(project, 'run.command')).rejects.toThrow()
    await expect(openIn.openFile(project, 'fake.pdf')).rejects.toThrow()
    await expect(openIn.openFile(project, '../outside/secret.pdf')).rejects.toThrow()
    await expect(openIn.openFile(project, 'leak.pdf')).rejects.toThrow()
    await expect(openIn.openFile(project, 7 as unknown as string)).rejects.toThrow()
    expect(host.launches).toEqual([])
  })
})
