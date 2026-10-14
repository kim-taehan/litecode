import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FORWARD_SKILL_FILE, FORWARD_SKILL_NAME, ForwardSkillService } from '../../src/services/appMcp/forwardSkill.ts'

// /forward 스킬 물질화 (이슈 #341) — 데스크탑 MCP(appMcp) 기능 묶음과 같은 운명: 올라오면 앱 스킬 폴더에 쓰고, 내려가면 지운다.
// 엔진은 이 파일을 스캔해 스킬을 안다 — 파일이 없으면 모델에게 안 뜬다(게이팅)

class FakeLlm extends Service {
  reloads = 0
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
  reloadWhenIdle(): void {
    this.reloads++
  }
}

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

describe('ForwardSkillService', () => {
  it('올라오면 <앱 스킬 폴더>/forward/SKILL.md 를 쓰고, 내려가면(내용 그대로면) 지운다', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-forwardskill-'))
    try {
      const appDir = path.join(root, 'skills')
      const ctx = new Context()
      ctx.plugin(FakeLlm)
      const fiber = ctx.plugin(ForwardSkillService, { appDir })
      disposers.push(fiber)
      await fiber
      const file = path.join(appDir, FORWARD_SKILL_NAME, 'SKILL.md')
      await untilFile(file, true)
      expect(await fs.readFile(file, 'utf8')).toBe(FORWARD_SKILL_FILE)
      await fiber.dispose()
      disposers = disposers.filter((entry) => entry !== fiber)
      await untilFile(file, false)
      expect(await hasFile(path.dirname(file))).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('그사이 사용자가 고쳤으면(내용 다르면) 내려갈 때 지우지 않는다', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-forwardskill-'))
    try {
      const appDir = path.join(root, 'skills')
      const ctx = new Context()
      ctx.plugin(FakeLlm)
      const fiber = ctx.plugin(ForwardSkillService, { appDir })
      disposers.push(fiber)
      await fiber
      const file = path.join(appDir, FORWARD_SKILL_NAME, 'SKILL.md')
      await untilFile(file, true)
      await fs.writeFile(file, `---\nname: ${FORWARD_SKILL_NAME}\ndescription: "사용자 고침"\n---\n\n사용자가 고친 스킬\n`)
      await fiber.dispose()
      disposers = disposers.filter((entry) => entry !== fiber)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(await fs.readFile(file, 'utf8')).toContain('사용자가 고친 스킬')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
