import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import path from 'node:path'
import { skillSource, type SkillSource } from '../../shared/skills.ts'
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

export interface SkillInfo {
  name: string
  description: string
  source: SkillSource
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

  constructor(ctx: Context) {
    super(ctx, 'skills')
  }

  /** 그 프로젝트에서 모델이 쓸 수 있는 스킬 (이름순). 파일을 못 읽으면 엔진이 준 본문 */
  async list(directory: string): Promise<SkillInfo[]> {
    const listed = (await this.ctx.llm.listSkills(directory)).filter((skill) => path.isAbsolute(skill.location))
    const skills = await Promise.all(
      listed.map(async (skill) => ({
        name: skill.name,
        description: skill.description ?? '',
        source: skillSource(skill.location),
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
}
