import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from 'cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EngineService } from '../../src/services/engine.ts'
import { LlmService } from '../../src/services/llm.ts'
import { McpService } from '../../src/services/mcp.ts'
import { ProviderRegistry } from '../../src/services/providers.ts'

// #93 (Cordis 감사 2026-10-05): JSON 으로는 멀쩡하지만 원소 모양이 틀린 userData 파일이 생성자를 던지게 하면 그 서비스와
// 그것을 inject 한 것 전부가 영영 안 뜬다. opencode 는 띄우지 않는다 (connection() 을 부르지 않는다)
describe('모양이 틀린 설정 파일로도 서비스가 뜬다 (#93)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litecode-ctor-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  async function up(files: { providers?: string; pid?: string; mcpProjects?: string; mcp?: string }): Promise<Record<string, boolean>> {
    const file = (name: string, text?: string): string => {
      const full = path.join(dir, name)
      if (text !== undefined) fs.writeFileSync(full, text)
      return full
    }
    const ctx = new Context()
    const fibers = [
      ctx.plugin(ProviderRegistry, { file: file('providers.json', files.providers), defaults: [] }),
      ctx.plugin(EngineService, { configDir: path.join(dir, 'opencode'), db: path.join(dir, 'opencode.db'), pidFile: file('opencode-server.json', files.pid) }),
      ctx.plugin(LlmService),
      ctx.plugin(McpService, { file: file('mcp.json', files.mcp), projectsFile: file('mcp-projects.json', files.mcpProjects) }),
    ]
    await new Promise((resolve) => setTimeout(resolve, 100))
    const state = Object.fromEntries(['providers', 'engine', 'llm', 'mcp'].map((name) => [name, ctx.get(name) !== undefined]))
    for (const fiber of fibers.reverse()) await fiber.dispose().catch(() => {})
    return state
  }
  const all = { providers: true, engine: true, llm: true, mcp: true }

  it('providers.json 의 원소가 null 이어도', async () => {
    expect(await up({ providers: '[null, {"nope":1}]' })).toEqual(all)
  })
  it('opencode-server.json 이 null 이어도', async () => {
    expect(await up({ pid: 'null' })).toEqual(all)
  })
  it('mcp.json·mcp-projects.json 의 원소가 null 이어도', async () => {
    expect(await up({ mcp: '[null]', mcpProjects: '{"/p":null}' })).toEqual(all)
  })
})
