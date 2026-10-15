import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesignSkillService, DESIGN_SKILL_FILE, DESIGN_SKILL_NAME } from '../../src/services/designSkill.ts'
import { DesignService, DesignWatcher } from '../../src/services/design.ts'

// 라이트코드 디자인 (이슈 #422) — 라이브 미리보기 코어(DesignWatcher)는 가짜 워처·가짜 타이머로, 스킬 물질화(DesignSkillService)
// 는 forwardSkill(#341)과 같은 틀로 본다: 올라오면 쓰고, 내려가면(내용 그대로면) 지운다.

class FakeLlm extends Service {
  reloads = 0
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
  reloadWhenIdle(): void {
    this.reloads++
  }
}

// ── DesignWatcher 코어 ──

interface FakeWatch {
  dirname: string
  filename: string
  fire(): void
}

function fakeDeps(resolveMap: Record<string, string>) {
  const watches: FakeWatch[] = []
  const changed: string[] = []
  const deps = {
    resolve: async (_directory: string, token: string): Promise<string | undefined> => resolveMap[token],
    watch: (dirname: string, filename: string, onChange: (absolute: string) => void): (() => void) => {
      const watch: FakeWatch = { dirname, filename, fire: () => onChange(path.join(dirname, filename)) }
      watches.push(watch)
      return () => {
        const at = watches.indexOf(watch)
        if (at >= 0) watches.splice(at, 1)
      }
    },
    onChange: (absolute: string) => changed.push(absolute),
    debouncedMs: 50,
  }
  return { deps, watches, changed }
}

describe('DesignWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('보는 파일이 바뀌면(디볼운스 뒤) 한 번 알린다 — 한 저장을 여러 사건으로 안 쪼갬', async () => {
    const { deps, watches, changed } = fakeDeps({ 'a.html': '/proj/a.html' })
    const watcher = new DesignWatcher(deps)
    expect(await watcher.start('/p', 'a.html')).toBe(true)
    expect(watches).toHaveLength(1)
    expect(watches[0]!.dirname).toBe('/proj')
    watches[0]!.fire() // write
    watches[0]!.fire() // rename
    expect(changed).toHaveLength(0) // 아직 디볼운스 중
    vi.advanceTimersByTime(50)
    expect(changed).toEqual(['/proj/a.html'])
  })

  it('프로젝트 밖·모르는 파일은 안 보고 false', async () => {
    const { deps, watches } = fakeDeps({})
    const watcher = new DesignWatcher(deps)
    expect(await watcher.start('/p', 'b.html')).toBe(false)
    expect(watches).toHaveLength(0)
    expect(await watcher.start('/p', 42 as never)).toBe(false)
  })

  it('서로 다른 표기가 같은 파일이면 워처 하나 — 다 멈출 때만 닫는다', async () => {
    const { deps, watches, changed } = fakeDeps({
      'a.html': '/proj/a.html',
      './a.html': '/proj/a.html',
      'x/../a.html': '/proj/a.html',
    })
    const watcher = new DesignWatcher(deps)
    await watcher.start('/p', 'a.html')
    await watcher.start('/p', './a.html')
    await watcher.start('/p', 'x/../a.html')
    expect(watches).toHaveLength(1)
    watcher.stop('/p', 'a.html')
    watcher.stop('/p', './a.html')
    expect(watches).toHaveLength(1) // 아직 보는 표기가 하나
    watcher.stop('/p', 'x/../a.html')
    expect(watches).toHaveLength(0)
    vi.advanceTimersByTime(100)
    expect(changed).toHaveLength(0) // 닫힌 뒤로는 아무 일도 없다
  })

  it(' 멈췄다가 다시 보면 다시 본다(타이머도 정리된다)', async () => {
    const { deps, watches, changed } = fakeDeps({ 'a.html': '/proj/a.html' })
    const watcher = new DesignWatcher(deps)
    await watcher.start('/p', 'a.html')
    watches[0]!.fire()
    watcher.stop('/p', 'a.html') // 디볼운스 타이머가 도는 중 멈춤
    vi.advanceTimersByTime(100)
    expect(changed).toHaveLength(0) // 멈춘 뒤의 사건은 안 간다
    expect(watches).toHaveLength(0)
    await watcher.start('/p', 'a.html')
    expect(watches).toHaveLength(1)
    watches[0]!.fire()
    vi.advanceTimersByTime(50)
    expect(changed).toEqual(['/proj/a.html'])
  })

  it('stopAll — 기능이 내려갈 때 전부 닫는다', async () => {
    const { deps, watches, changed } = fakeDeps({
      'a.html': '/proj/a.html',
      'b.html': '/proj/b.html',
    })
    const watcher = new DesignWatcher(deps)
    await watcher.start('/p', 'a.html')
    await watcher.start('/p', 'b.html')
    watches[0]!.fire()
    watcher.stopAll()
    expect(watches).toHaveLength(0)
    vi.advanceTimersByTime(100)
    expect(changed).toHaveLength(0)
  })
})

// ── DesignSkillService (물질화) ──

let disposers: { dispose(): Promise<void> }[] = []

afterEach(async () => {
  for (const fiber of disposers.reverse()) await fiber.dispose()
  disposers = []
})

const hasFile = (file: string) => fs.access(file).then(() => true, () => false)

async function untilFile(file: string, present: boolean): Promise<void> {
  for (let tries = 0; tries < 200 && (await hasFile(file)) !== present; tries++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(await hasFile(file)).toBe(present)
}

describe('DesignSkillService', () => {
  it('올라오면 <앱 스킬 폴더>/design/SKILL.md 를 쓰고, 내려가면(내용 그대로면) 지운다', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-designskill-'))
    try {
      const appDir = path.join(root, 'skills')
      const ctx = new Context()
      ctx.plugin(FakeLlm)
      const fiber = ctx.plugin(DesignSkillService, { appDir })
      disposers.push(fiber)
      await fiber
      const file = path.join(appDir, DESIGN_SKILL_NAME, 'SKILL.md')
      await untilFile(file, true)
      expect(await fs.readFile(file, 'utf8')).toBe(DESIGN_SKILL_FILE)
      await fiber.dispose()
      disposers = disposers.filter((entry) => entry !== fiber)
      await untilFile(file, false)
      expect(await hasFile(path.dirname(file))).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('그사이 사용자가 고쳤으면(내용 다르면) 내려갈 때 지우지 않는다', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-designskill-'))
    try {
      const appDir = path.join(root, 'skills')
      const ctx = new Context()
      ctx.plugin(FakeLlm)
      const fiber = ctx.plugin(DesignSkillService, { appDir })
      disposers.push(fiber)
      await fiber
      const file = path.join(appDir, DESIGN_SKILL_NAME, 'SKILL.md')
      await untilFile(file, true)
      await fs.writeFile(file, `---\nname: ${DESIGN_SKILL_NAME}\ndescription: "사용자 고침"\n---\n\n사용자가 고친 스킬\n`)
      await fiber.dispose()
      disposers = disposers.filter((entry) => entry !== fiber)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(await fs.readFile(file, 'utf8')).toContain('사용자가 고친 스킬')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('본문은 "같은 화면은 같은 파일을 고치고, 패널이 알아서 갱신된다" 를 못 박는다', () => {
    expect(DESIGN_SKILL_FILE).toContain('edit the SAME file')
    expect(DESIGN_SKILL_FILE).toContain('re-renders the preview by itself')
    expect(DESIGN_SKILL_FILE).toContain('NO external fonts, CDNs, images or fetch')
    expect(DESIGN_SKILL_FILE).toContain('litecode_open')
  })

  it('A/B 변형은 두 파일(-a·-b)로, 비교 보기(위아래)로 본다', () => {
    expect(DESIGN_SKILL_FILE).toContain('mock-<screen>-a.html')
    expect(DESIGN_SKILL_FILE).toContain('mock-<screen>-b.html')
    expect(DESIGN_SKILL_FILE).toContain('stacked top/bottom 50/50')
  })
})

// ── DesignService (진짜 fs.watch + cordis) ──

describe('DesignService', () => {
  it('보고 있는 파일이 바뀌면 design/changed 를 흘리고, 멈추면(내려가면) 흐르지 않는다', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-design-'))
    const fiberCleanups: { dispose(): Promise<void> }[] = []
    try {
      const file = path.join(root, 'login.html')
      await fs.writeFile(file, '<html></html>')
      const realFile = await fs.realpath(file) // macOS: /var → /private/var — 이벤트는 realpath 로
      const ctx = new Context()
      const fiber = ctx.plugin(DesignService)
      fiberCleanups.push(fiber)
      const ready = await new Promise<Context>((resolve) => ctx.inject(['design'], resolve))
      const changed: string[] = []
      ctx.on('design/changed', (absolute) => changed.push(absolute))
      expect(await ready.design.watch(root, 'login.html')).toBe(true)
      // 바깥·없는 파일은 false
      expect(await ready.design.watch(root, '../outside.html')).toBe(false)
      await fs.writeFile(file, '<html><body>a</body></html>')
      for (let tries = 0; tries < 100 && changed.length === 0; tries++) await new Promise((resolve) => setTimeout(resolve, 20))
      expect(changed).toEqual([realFile])
      ready.design.unwatch(root, 'login.html')
      await fs.writeFile(file, '<html><body>b</body></html>')
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(changed).toHaveLength(1) // 멈춘 뒤로는 안 간다
    } finally {
      for (const cleanup of fiberCleanups.reverse()) await cleanup.dispose()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
