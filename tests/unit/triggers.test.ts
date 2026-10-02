import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { detect, TriggerRegistry, type TriggerSource } from '../../src/services/triggers.ts'
import { AtTrigger, reference } from '../../src/triggers/at.ts'
import { expandTemplate, SlashTrigger } from '../../src/triggers/slash.ts'
import { BangTrigger } from '../../src/triggers/bang.ts'
import type { EngineCommand, EngineSkill, FileEntry } from '../../src/services/llm.ts'
import { SkillsService } from '../../src/services/skills.ts'

// 입력창 트리거 — ctx.triggers 등록소 + @·/·! 플러그인 (사용자 결정 2026-10-01). 감지 규칙은 closed-code composerMode
// (`@` 는 낱말·경로 중간이 아닐 때, `/`·`!` 는 입력 첫 글자일 때만), 실행 모양은 01d 권고안을 지킨다.

const source = (char: string, opensAt: TriggerSource['opensAt'], wholeLine?: boolean): TriggerSource => ({
  char,
  opensAt,
  wholeLine,
  candidates: async () => [],
  pick: async () => ({ kind: 'error', message: '' }),
})
const at = source('@', 'boundary')
const slash = source('/', 'start')
const bang = source('!', 'start', true)
const all = [at, slash, bang]
const hit = (draft: string, caret = draft.length) => {
  const found = detect(all, draft, caret)
  return found && { char: found.char, query: found.query, start: found.start, end: found.end }
}

describe('detect', () => {
  it('@ 는 글 첫머리·공백·구두점 뒤에서 열리고, 낱말·경로 중간에서는 안 열린다', () => {
    expect(hit('@sr')).toEqual({ char: '@', query: 'sr', start: 0, end: 3 })
    expect(hit('보세요 @src/a')).toEqual({ char: '@', query: 'src/a', start: 4, end: 10 })
    expect(hit('(@a')).toMatchObject({ char: '@', start: 1 })
    expect(hit('mail a@b')).toBeNull()
    expect(hit('src/@x')).toBeNull()
    expect(hit('@src done')).toBeNull() // 공백에서 닫힌다
  })

  it('@"…" 는 닫는 따옴표 전까지 공백을 품는다', () => {
    expect(hit('@"sp ace/f')).toEqual({ char: '@', query: 'sp ace/f', start: 0, end: 10 })
    expect(hit('@"sp ace/f.md" 다음')).toBeNull()
  })

  it('캐럿 뒤의 글자는 질의에 안 들어간다', () => {
    expect(hit('@alpha 뒤', 3)).toEqual({ char: '@', query: 'al', start: 0, end: 3 })
  })

  it('/ 는 입력 첫 글자일 때만 열리고, 공백(인자 구간)에서 닫힌다', () => {
    expect(hit('/hi')).toEqual({ char: '/', query: 'hi', start: 0, end: 3 })
    expect(hit('  /hi')).toMatchObject({ char: '/', start: 2 })
    expect(hit('경로 a/b')).toBeNull()
    expect(hit('/hi world')).toBeNull()
  })

  it('! 는 입력 첫 글자일 때 입력 전체가 구간이다 (캐럿·공백과 무관)', () => {
    expect(hit('!ls -la')).toEqual({ char: '!', query: 'ls -la', start: 0, end: 7 })
    expect(hit('!ls -la', 0)).toMatchObject({ char: '!' })
    expect(hit('안녕!')).toBeNull()
  })
})

/** ctx.llm 자리의 가짜 — 트리거가 부르는 메서드만 */
class FakeLlm extends Service {
  calls: string[] = []
  files: FileEntry[] = [
    { path: '.git/', type: 'directory' },
    { path: 'src/', type: 'directory' },
    { path: 'sp ace/', type: 'directory' },
    { path: 'README.md', type: 'file' },
  ]
  commands: EngineCommand[] = [
    { name: 'init', template: 'Create AGENTS.md $ARGUMENTS', description: 'guided setup' },
    { name: 'hi', template: 'Say $ARGUMENTS first=$1 second=$2 none=$3', description: 'say hi' },
  ]
  /** 레거시 GET /skill 자리 (이슈 #7) */
  skills: EngineSkill[] = []
  failing = false
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
  async listSkills(): Promise<EngineSkill[]> {
    return this.skills
  }
  async listDirectory(directory: string, rel: string): Promise<FileEntry[]> {
    this.calls.push(`list ${directory} ${rel}`)
    if (this.failing) throw new Error('엔진이 안 떠 있다')
    return this.files
  }
  async findFiles(directory: string, query: string, limit: number): Promise<FileEntry[]> {
    this.calls.push(`find ${directory} ${query} ${limit}`)
    return [{ path: 'src/deep/alpha.ts', type: 'file' }]
  }
  async listCommands(): Promise<EngineCommand[]> {
    return this.commands
  }
}

async function start(): Promise<{ ctx: Context; triggers: TriggerRegistry; llm: FakeLlm }> {
  const ctx = new Context()
  ctx.plugin(FakeLlm)
  ctx.plugin(TriggerRegistry)
  return new Promise((resolve) =>
    ctx.inject(['triggers', 'llm'], (ready) => resolve({ ctx, triggers: ready.triggers, llm: ready.llm as unknown as FakeLlm })),
  )
}

const scope = { directory: '/work/a' }
/** 플러그인 마운트는 비동기다 — 등록될 때까지 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('ctx.triggers', () => {
  it('같은 문자를 두 번 등록하면 실패하고, 해제하면 그 문자는 평범한 글자가 된다', async () => {
    const { triggers } = await start()
    const release = triggers.register(at)
    expect(() => triggers.register(source('@', 'boundary'))).toThrow()
    expect(await triggers.query(scope, '@a', 2)).not.toBeNull()
    release()
    expect(await triggers.query(scope, '@a', 2)).toBeNull()
  })

  it('플러그인을 내리면(fiber dispose) 그 트리거가 사라지고, 다시 올리면 돌아온다 — 등록이 effect 다', async () => {
    const { ctx, triggers } = await start()
    const fiber = ctx.plugin(BangTrigger)
    await settle()
    expect((await triggers.query(scope, '!ls', 3))?.tone).toBe('danger')
    expect(await triggers.submit(scope, '!ls')).toEqual({ kind: 'shell', directory: '/work/a', command: 'ls' })

    await fiber.dispose()
    expect(await triggers.query(scope, '!ls', 3)).toBeNull()
    expect(await triggers.submit(scope, '!ls')).toBeNull() // 평범한 프롬프트로 간다

    ctx.plugin(BangTrigger)
    await settle()
    expect(await triggers.submit(scope, '!ls')).toEqual({ kind: 'shell', directory: '/work/a', command: 'ls' })
  })

  it('후보 조회가 실패하면 빈 목록이다 (팝업이 깨지지 않는다)', async () => {
    const { ctx, triggers, llm } = await start()
    ctx.plugin(AtTrigger)
    await settle()
    llm.failing = true
    expect((await triggers.query(scope, '@', 1))?.candidates).toEqual([])
  })
})

describe('@ 파일', () => {
  it('질의가 비었거나 / 로 끝나면 폴더 목록, 아니면 퍼지 검색 — .git 은 뺀다', async () => {
    const { ctx, triggers, llm } = await start()
    ctx.plugin(AtTrigger)
    await settle()

    const top = await triggers.query(scope, '@', 1)
    expect(top?.candidates.map((entry) => entry.label)).toEqual(['src/', 'sp ace/', 'README.md'])
    expect(top?.candidates[0]).toMatchObject({ icon: 'folder', drill: true })
    await triggers.query(scope, '@src/', 5)
    const found = await triggers.query(scope, '@alp', 4)
    expect(found?.candidates).toEqual([{ id: 'src/deep/alpha.ts', label: 'alpha.ts', detail: 'src/deep', icon: 'file', group: '파일', drill: false }])
    expect(llm.calls).toEqual(['list /work/a ', 'list /work/a src/', 'find /work/a alp 20'])
  })

  it('고르면 경로 텍스트만 넣고(공백 경로는 따옴표), 폴더로 들어가면 메뉴를 연 채 둔다', async () => {
    const { ctx, triggers } = await start()
    ctx.plugin(AtTrigger)
    await settle()
    expect(await triggers.pick(scope, '@', 'src/deep/alpha.ts', 'pick')).toEqual({ kind: 'insert', text: '@src/deep/alpha.ts ' })
    expect(await triggers.pick(scope, '@', 'sp ace/f.md', 'pick')).toEqual({ kind: 'insert', text: '@"sp ace/f.md" ' })
    expect(await triggers.pick(scope, '@', 'src/', 'drill')).toEqual({ kind: 'drill', text: '@src/' })
    expect(reference('sp ace/', true)).toBe('@"sp ace/')
    expect(await triggers.submit(scope, '@src/a.ts 봐 줘')).toBeNull() // 평범한 프롬프트
  })
})

describe('/ 명령', () => {
  it('template 을 opencode 규칙으로 푼다 — $ARGUMENTS 전체, $n 은 공백 조각, 없는 조각은 빈 글자', () => {
    expect(expandTemplate('Say $ARGUMENTS first=$1 second=$2 none=$3', 'world foo')).toBe('Say world foo first=world second=foo none=')
  })

  it('후보는 이름에 질의가 든 명령, 접두가 먼저', async () => {
    const { ctx, triggers } = await start()
    ctx.plugin(SlashTrigger)
    await settle()
    expect((await triggers.query(scope, '/i', 2))?.candidates.map((entry) => entry.label)).toEqual(['/init', '/hi'])
    expect(await triggers.pick(scope, '/', 'hi', 'pick')).toEqual({ kind: 'insert', text: '/hi ' })
  })

  it('Enter 로 내면 풀어 쓴 본문을 보내고 말풍선엔 친 글 그대로, 모르는 명령은 막고 알린다', async () => {
    const { ctx, triggers } = await start()
    ctx.plugin(SlashTrigger)
    await settle()
    expect(await triggers.submit(scope, '/hi world foo')).toEqual({
      kind: 'send',
      text: 'Say world foo first=world second=foo none=',
      display: '/hi world foo',
    })
    expect(await triggers.submit(scope, '/nope 인자')).toEqual({ kind: 'error', message: '모르는 명령입니다: /nope' })
    expect(await triggers.submit(scope, '/')).toMatchObject({ kind: 'error' })
  })
})

// 스킬 (이슈 #7): `/` 에 "스킬" 그룹으로 섞는다 — 명령과 이름이 겹치면 명령, 내장(<built-in>)은 없다. 내면 SKILL.md 를 직접 읽어(엔진 본문은
// 재시작 전까지 옛것) 본문을 붙여 보내고 말풍선엔 친 글. 스킬 기능(ctx.skills)이 꺼져 있으면 후보도 실행도 없다
describe('/ 스킬', () => {
  async function withSkills(): Promise<{ ctx: Context; triggers: TriggerRegistry; llm: FakeLlm; dir: string }> {
    const started = await start()
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-unit-skills-'))
    const write = async (folder: string, name: string, body: string) => {
      await fs.mkdir(path.join(dir, folder, name), { recursive: true })
      const file = path.join(dir, folder, name, 'SKILL.md')
      await fs.writeFile(file, `---\nname: ${name}\ndescription: ${name} desc\n---\n${body}\n`)
      return file
    }
    started.llm.skills = [
      { name: 'customize-opencode', description: 'builtin', location: '<built-in>', content: 'x' },
      { name: 'review-pr', description: 'review a PR', location: await write('cfg/skills', 'review-pr', 'BODY-REVIEW'), content: 'OLD' },
      { name: 'hi', description: 'same name as a command', location: await write('cfg/skills', 'hi', 'BODY-HI') },
      { name: 'proj-only', description: 'from project', location: await write('work/.opencode/skills', 'proj-only', 'BODY-PROJ') },
    ]
    started.ctx.plugin(SlashTrigger)
    return { ...started, dir }
  }

  it('후보: 명령 다음에 "스킬" 그룹 — 명령과 같은 이름·내장은 빠진다', async () => {
    const { ctx, triggers, dir } = await withSkills()
    ctx.plugin(SkillsService)
    await settle()
    const candidates = (await triggers.query(scope, '/', 1))?.candidates ?? []
    expect(candidates.map((entry) => `${entry.group}:${entry.label}`)).toEqual(['명령:/init', '명령:/hi', '스킬:/proj-only', '스킬:/review-pr'])
    expect(candidates.at(-1)).toMatchObject({ icon: 'skill', detail: 'review a PR' })
    expect(await triggers.pick(scope, '/', 'review-pr', 'pick')).toEqual({ kind: 'insert', text: '/review-pr ' })
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('내면 파일의 지금 본문을 skill_content 로 붙여 보내고 말풍선엔 친 글 — 인자가 없으면 블록만', async () => {
    const { ctx, triggers, dir } = await withSkills()
    ctx.plugin(SkillsService)
    await settle()
    const sent = await triggers.submit(scope, '/review-pr  look at #12')
    expect(sent).toMatchObject({ kind: 'send', display: '/review-pr  look at #12' })
    const text = (sent as { text: string }).text
    expect(text).toContain('<skill_content name="review-pr">\n# Skill: review-pr\n\nBODY-REVIEW\n')
    expect(text).toContain(`Base directory for this skill: ${path.join(dir, 'cfg/skills/review-pr')}`)
    expect(text).not.toContain('OLD') // 엔진의 캐시된 본문이 아니다
    expect(text.endsWith('</skill_content>\n\nlook at #12')).toBe(true)
    expect((await triggers.submit(scope, '/proj-only')) as { text: string }).toMatchObject({ text: expect.stringMatching(/BODY-PROJ\n[\s\S]*<\/skill_content>$/) })
    // 같은 이름이면 명령이 이긴다
    expect(await triggers.submit(scope, '/hi there')).toMatchObject({ kind: 'send', text: 'Say there first=there second= none=' })
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('스킬 기능이 꺼져 있으면(ctx.skills 없음) 후보도 실행도 없다', async () => {
    const { triggers, dir } = await withSkills()
    await settle()
    expect((await triggers.query(scope, '/', 1))?.candidates.map((entry) => entry.label)).toEqual(['/init', '/hi'])
    expect(await triggers.submit(scope, '/review-pr x')).toEqual({ kind: 'error', message: '모르는 명령입니다: /review-pr' })
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe('! 셸', () => {
  it('명령을 결과 카드로 내고(화면이 ctx.shell 로 돌린다) 대화로는 안 보낸다. 빈 명령은 막는다', async () => {
    const { ctx, triggers } = await start()
    ctx.plugin(BangTrigger)
    await settle()
    expect(await triggers.submit(scope, '  !pwd ')).toEqual({ kind: 'shell', directory: '/work/a', command: 'pwd' })
    expect(await triggers.submit(scope, '!')).toMatchObject({ kind: 'error' })
  })
})
