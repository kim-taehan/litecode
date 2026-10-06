import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import path from 'node:path'
import { skillSource, type SkillSource } from '../../shared/skills.ts'
import { isSkillName } from '../../shared/make.ts'
import { insideOf } from './projectPath.ts'
import './llm.ts'

// 스킬 (ctx.skills, 이슈 #7 — 사용자 결정 _workspace/00_next_skills.md). 첫 버전은 보여 주고 쓰기만 한다 (만들기·편집·삭제는 다음).
// - 목록은 엔진에 묻는다(ctx.llm.listSkills — 모델이 보는 것과 같은 출처). 출처 배지는 파일 위치로 가른다(shared/skills.ts)
// - 내장 스킬(customize-opencode, 위치 `<built-in>`)은 엔진이 모델에게서 숨긴다(ctx.engine) — 목록에서도 뺀다
// - 본문은 SKILL.md 를 **직접** 읽는다. 엔진의 본문은 재시작 전까지 옛것이다(실측) — `/이름` 으로 부를 때 최신 본문을 결정적으로 붙인다
//   (dsh 방식: 사람이 부른 스킬은 모델에게 부탁하지 않고 앱이 넣는다. opencode 에 그 훅이 없어 프롬프트 글에 붙인다)
// 기능 묶음이다 — 설정 > 기능에서 스킬을 끄면 이 서비스가 내려가 목록·`/` 후보·본문 붙이기가 없어진다(엔진은 skill 도구를 뺀다).

declare module 'cordis' {
  interface Context {
    skills: SkillsService
  }
}

/** 스킬 팝업의 묶음 (이슈 #43) — "이 프로젝트만"(프로젝트 폴더 아래의 스킬) / "모든 프로젝트"(앱 설정 폴더·홈의 스킬) */
export type SkillScope = 'project' | 'all'

/** 스킬 파일 위치 → 묶음. roots 는 그 프로젝트 폴더(받은 경로와 realpath 한 경로 — 엔진은 realpath 로 돌려준다) */
export function skillScope(location: string, roots: readonly string[]): SkillScope {
  const inside = roots.some((root) => {
    const relative = path.relative(root, location)
    return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative)
  })
  return inside ? 'project' : 'all'
}

export interface SkillsOptions {
  /** 앱 스킬 폴더 (앱 설정 폴더의 skills — "모든 프로젝트" 묶음의 "폴더 열기") */
  appDir?: string
}

export interface SkillInfo {
  name: string
  description: string
  source: SkillSource
  scope: SkillScope
  /** SKILL.md 경로 */
  location: string
  /** frontmatter 를 뺀 본문 (파일에서 지금 읽은 것) */
  body: string
}

/** SKILL.md 글 → frontmatter 를 뺀 본문 */
export function skillBody(markdown: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown)
  return (match ? markdown.slice(match[0].length) : markdown).trim()
}

/** `/이름 인자` 로 부른 스킬을 보낼 글 — opencode skill 도구 결과와 같은 모양의 블록(모델이 이미 아는 모양) 뒤에 인자 */
export function skillPrompt(skill: Pick<SkillInfo, 'name' | 'location' | 'body'>, args: string): string {
  const block = [
    `<skill_content name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    '',
    skill.body,
    '',
    `Base directory for this skill: ${path.dirname(skill.location)}`,
    'Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.',
    '</skill_content>',
  ].join('\n')
  return args ? `${block}\n\n${args}` : block
}

export class SkillsService extends Service {
  static readonly inject = ['llm']

  constructor(
    ctx: Context,
    private opts: SkillsOptions = {},
  ) {
    super(ctx, 'skills')
  }

  /** 스킬 팝업의 "폴더 열기" 가 열 폴더 — 없으면 만든다(빈 폴더). 프로젝트 묶음은 `<프로젝트>/.opencode/skills`, 모든 프로젝트는 앱 스킬 폴더 */
  async folder(scope: SkillScope, directory: string): Promise<string | undefined> {
    const dir = scope === 'project' ? path.join(directory, '.opencode', 'skills') : this.opts.appDir
    if (dir) await fs.mkdir(dir, { recursive: true })
    return dir
  }

  /** 그 프로젝트에서 모델이 쓸 수 있는 스킬 (이름순). 파일을 못 읽으면 엔진이 준 본문 */
  async list(directory: string): Promise<SkillInfo[]> {
    const listed = (await this.ctx.llm.listSkills(directory)).filter((skill) => path.isAbsolute(skill.location))
    const roots = [directory, await fs.realpath(directory).catch(() => directory)]
    const skills = await Promise.all(
      listed.map(async (skill) => ({
        name: skill.name,
        description: skill.description ?? '',
        source: skillSource(skill.location),
        scope: skillScope(skill.location, roots),
        location: skill.location,
        body: await fs.readFile(skill.location, 'utf8').then(skillBody, () => skill.content?.trim() ?? ''),
      })),
    )
    return skills.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 이름으로 하나 — 없으면 undefined */
  async find(directory: string, name: string): Promise<SkillInfo | undefined> {
    return (await this.list(directory)).find((skill) => skill.name === name)
  }

  /** 대화로 만든 스킬을 쓴다 (이슈 #145 — 앱 MCP 의 create_skill 이 사용자 승인 뒤에 부른다). 자리는 앱이 정한다: project 는
   *  `<프로젝트>/.opencode/skills/<이름>/SKILL.md`, all 은 앱 스킬 폴더. frontmatter(name·description)는 여기서 쓴다. 같은 이름이 그 프로젝트에서
   *  이미 보이거나 그 자리에 파일이 있으면 덮어쓰지 않고 던진다. 프로젝트 폴더에 쓸 때는 링크를 풀어 폴더 안인지 본다.
   *  엔진은 스킬 목록을 폴더별로 기억한다(다시 띄워야 바뀐다) → 도는 턴이 다 끝난 뒤 다시 띄우게 한다 (ctx.llm.reloadWhenIdle).
   *  던지는 글은 모델이 읽는다(영어). 돌려주는 것은 쓴 SKILL.md 의 경로 */
  async create(skill: { name: string; description: string; body: string }, scope: SkillScope, directory: string): Promise<string> {
    if (!isSkillName(skill.name)) throw new Error('name must be lowercase letters, digits and hyphens.')
    const taken = `A skill named "${skill.name}" already exists`
    const existing = await this.find(directory, skill.name)
    if (existing) throw new Error(`${taken} (${existing.location}). Nothing was written — pick another name.`)
    const root = scope === 'project' ? await fs.realpath(directory) : this.opts.appDir
    if (!root) throw new Error('The app skill folder is not available.')
    const dir = scope === 'project' ? path.join(root, '.opencode', 'skills', skill.name) : path.join(root, skill.name)
    const outside = 'The skill folder of this project points outside the project folder. Nothing was written.'
    if (scope === 'project' && !(await within(root, await deepestExisting(dir)))) throw new Error(outside)
    await fs.mkdir(dir, { recursive: true })
    if (scope === 'project' && !(await within(root, dir))) throw new Error(outside)
    const file = path.join(dir, 'SKILL.md')
    const markdown = `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.body.trim()}\n`
    try {
      await fs.writeFile(file, markdown, { flag: 'wx' }) // 있으면 실패 — 덮어쓰지 않고, 그 자리의 링크도 따라가지 않는다
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${taken} (${file}). Nothing was written — pick another name.`)
      throw error
    }
    this.ctx.llm.reloadWhenIdle()
    return file
  }
}

/** 그 경로에서 위로 올라가며 처음 만나는 "있는 것" (끊어진 링크도 있는 것이다) */
async function deepestExisting(target: string): Promise<string> {
  let current = target
  while (!(await fs.lstat(current).catch(() => undefined)) && path.dirname(current) !== current) current = path.dirname(current)
  return current
}

/** 링크를 푼 자리가 root(realpath) 자신이거나 그 안인가 — 못 풀면(끊어진 링크) 아니다 */
async function within(root: string, target: string): Promise<boolean> {
  const real = await fs.realpath(target).catch(() => undefined)
  return real !== undefined && (real === root || insideOf(root, real) !== undefined)
}
