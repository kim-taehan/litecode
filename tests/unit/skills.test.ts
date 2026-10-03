import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ENGINE_AGENTS, engineConfig, MODE_AGENT } from '../../src/services/engine.ts'
import type { EngineSkill } from '../../src/services/llm.ts'
import { skillBody, SkillsService } from '../../src/services/skills.ts'
import { messageItems } from '../../src/services/turnProgress.ts'
import { skillSource } from '../../shared/skills.ts'
import { skillInstructions } from '../../renderer/turnView.ts'

// 스킬 (이슈 #7). 엔진 설정 모양은 레거시 실측(2026-10-02, opencode 1.18.18, 가짜 LLM 이 받은 요청)을 지킨다:
// - OPENCODE_DISABLE_PROJECT_CONFIG 가 프로젝트 .opencode/skills 를 끄므로 skills.paths 로 되살린다. Claude 경로는 스위치를 켰을 때만
// - 내장 customize-opencode 는 전역 deny 만으로는 litecode-full("*":allow)에서 되살아난다 → 에이전트마다 맨 뒤에도
// - 기능을 끄면 skill: deny (도구째 빠진다)

const proxy = { token: 't', baseURLFor: () => '' }
type Agents = Record<string, { permission: Record<string, unknown> }>

describe('engineConfig — 스킬', () => {
  it('켬(Claude 끔): 프로젝트 .opencode/skills 를 paths 로 되살리고, customize-opencode 는 전역·에이전트마다 맨 뒤 deny', () => {
    const config = engineConfig([], proxy, { skills: { enabled: true, claude: false } })
    expect(config.skills).toEqual({ paths: ['.opencode/skills', '.opencode/skill'] })
    expect(config.permission).toEqual({ task: { 'general-ask': 'deny' }, webfetch: 'deny', websearch: 'deny', skill: { 'customize-opencode': 'deny' } })
    const agent = config.agent as Agents
    expect(Object.keys(agent).sort()).toEqual(Object.keys(ENGINE_AGENTS).sort())
    for (const [name, { permission }] of Object.entries(agent)) {
      expect(Object.entries(permission).at(-1), name).toEqual(['skill', { 'customize-opencode': 'deny' }])
      expect(Object.entries(permission).slice(-3, -1), name).toEqual([
        ['webfetch', 'deny'],
        ['websearch', 'deny'],
      ]) // 웹 도구 규칙은 그대로
    }
    expect(agent[MODE_AGENT.full]!.permission).toEqual({ '*': 'allow', task: { 'general-ask': 'deny' }, webfetch: 'deny', websearch: 'deny', skill: { 'customize-opencode': 'deny' } })
  })

  it('Claude 켬: ~/.claude/skills·.claude/skills 를 뒤에 더한다', () => {
    const config = engineConfig([], proxy, { skills: { enabled: true, claude: true } })
    expect(config.skills).toEqual({ paths: ['.opencode/skills', '.opencode/skill', '~/.claude/skills', '.claude/skills'] })
  })

  it('끔: skill 도구째 deny(전역·에이전트마다 맨 뒤), paths 없음 — Claude 스위치와 무관', () => {
    const config = engineConfig([], proxy, { skills: { enabled: false, claude: true } })
    expect(config).not.toHaveProperty('skills')
    expect(config.permission).toMatchObject({ skill: 'deny' })
    for (const [name, { permission }] of Object.entries(config.agent as Agents)) expect(Object.entries(permission).at(-1), name).toEqual(['skill', 'deny'])
  })

  it('웹 도구를 켜도 스킬 규칙은 남는다 (전역 permission 은 하위 작업 규칙 + skill)', () => {
    const config = engineConfig([], proxy, { webTools: true, skills: { enabled: true, claude: false } })
    expect(config.permission).toEqual({ task: { 'general-ask': 'deny' }, skill: { 'customize-opencode': 'deny' } })
    expect((config.agent as Agents)[MODE_AGENT.ask]!.permission).toMatchObject({ webfetch: 'ask', skill: { 'customize-opencode': 'deny' } })
  })

  it('skills 를 안 주면 스킬 규칙을 안 넣는다 (예전 모양 그대로)', () => {
    const config = engineConfig([], proxy)
    expect(config).not.toHaveProperty('skills')
    expect(config.permission).toEqual({ task: { 'general-ask': 'deny' }, webfetch: 'deny', websearch: 'deny' })
  })
})

describe('skillSource — 출처 배지', () => {
  it('.claude/skills 아래(홈·프로젝트) = Claude, .opencode/skill(s) 아래 = 프로젝트, 그 밖 = 앱', () => {
    expect(skillSource('/Users/u/.claude/skills/x/SKILL.md')).toBe('claude')
    expect(skillSource('/work/app/.claude/skills/x')).toBe('claude') // 도구 결과 metadata.dir (끝 슬래시 없음)
    expect(skillSource('/work/app/.opencode/skills/x/SKILL.md')).toBe('project')
    expect(skillSource('/work/app/.opencode/skill/x')).toBe('project')
    expect(skillSource('/Users/u/Library/Application Support/litecode/opencode/skills/x/SKILL.md')).toBe('app')
    expect(skillSource('C:\\Users\\u\\.claude\\skills\\x\\SKILL.md')).toBe('claude')
  })
})

describe('skillBody', () => {
  it('frontmatter 를 뺀 본문', () => {
    expect(skillBody('---\nname: a\ndescription: d\n---\n# Title\n\nbody\n')).toBe('# Title\n\nbody')
    expect(skillBody('no frontmatter')).toBe('no frontmatter')
  })
})

class FakeLlm extends Service {
  skills: EngineSkill[] = []
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
  async listSkills(): Promise<EngineSkill[]> {
    return this.skills
  }
}

describe('ctx.skills.list', () => {
  it('내장은 빼고 이름순, 본문은 파일에서 지금 읽고 못 읽으면 엔진 본문, 출처는 위치로', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-unit-skills-'))
    const file = path.join(dir, '.opencode', 'skills', 'b-proj', 'SKILL.md')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '---\nname: b-proj\ndescription: proj\n---\nFRESH\n')
    const ctx = new Context()
    ctx.plugin(FakeLlm)
    ctx.plugin(SkillsService)
    const { skills, llm } = await new Promise<{ skills: SkillsService; llm: FakeLlm }>((resolve) =>
      ctx.inject(['skills', 'llm'], (ready) => resolve({ skills: ready.skills, llm: ready.llm as unknown as FakeLlm })),
    )
    llm.skills = [
      { name: 'customize-opencode', description: 'x', location: '<built-in>', content: 'x' },
      { name: 'b-proj', description: 'proj', location: file, content: 'STALE' },
      { name: 'a-gone', location: path.join(dir, 'gone', 'SKILL.md'), content: ' CACHED ' },
    ]
    expect(await skills.list(dir)).toEqual([
      { name: 'a-gone', description: '', source: 'app', location: path.join(dir, 'gone', 'SKILL.md'), body: 'CACHED' },
      { name: 'b-proj', description: 'proj', source: 'project', location: file, body: 'FRESH' },
    ])
    expect((await skills.find(dir, 'b-proj'))?.body).toBe('FRESH')
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe('skill 도구 줄', () => {
  const result = '<skill_content name="lc">\n# Skill: lc\n\n## Steps\n\n1. do it\n\nBase directory for this skill: /x/.claude/skills/lc\nRelative paths…\n\n<skill_files>\n</skill_files>\n</skill_content>'

  it('끝난 skill 파트 → "스킬 · 이름" + 출처 (metadata.dir), 진행 중엔 출처 없음', () => {
    const done = messageItems([
      { id: 'p1', messageID: 'm1', type: 'tool', tool: 'skill', state: { status: 'completed', input: { name: 'lc' }, output: result, metadata: { name: 'lc', dir: '/x/.claude/skills/lc', truncated: false } } },
    ])
    expect(done[0]).toMatchObject({ kind: 'tool', name: 'skill', status: 'done', summary: 'lc', skill: { name: 'lc', source: 'claude' }, result })
    const running = messageItems([{ id: 'p1', messageID: 'm1', type: 'tool', tool: 'skill', state: { status: 'running', input: { name: 'lc' } } }])
    expect(running[0]).toMatchObject({ summary: 'lc', skill: { name: 'lc' } })
    expect((running[0] as { skill: object }).skill).not.toHaveProperty('source')
    const other = messageItems([{ id: 'p2', messageID: 'm1', type: 'tool', tool: 'read', state: { status: 'running', input: { filePath: 'a', name: 'x' } } }])
    expect(other[0]).not.toHaveProperty('skill')
  })

  it('펼친 지침은 본문만 — 모양이 다르면 받은 그대로', () => {
    expect(skillInstructions(result)).toBe('## Steps\n\n1. do it')
    expect(skillInstructions('plain output')).toBe('plain output')
  })
})
