import { Context } from 'cordis'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsService } from '../../src/services/settings.ts'
import { ExtensionsService } from '../../src/services/extensions.ts'
import { checkManifest } from '../../src/services/extensions/manifest.ts'
import { syncExtensionSkills } from '../../src/services/extensions/skills.ts'
import { ExtensionStore } from '../../src/services/extensions/store.ts'
import { makeZip } from './support/zipWriter.ts'

// 확장이 담아 온 스킬 (이슈 #561) — manifest skills 검사, 앱 스킬 폴더에 켜져 있는 동안만 둔다(끄거나 지우면 빠진다), 남의 같은 이름 폴더는 안 건드린다

let dir: string
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-ext-skills-')))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const base = { id: 'sk-ext', name: 'n', description: 'd', version: '1.0.0', entry: 'index.html' }

describe('manifest skills', () => {
  it('확장 안 폴더 경로 목록, 폴더 이름은 스킬 이름 규칙 — 아니면 skills-invalid. 언어 팩은 못 담는다', () => {
    expect(checkManifest({ ...base, skills: ['skills/sonarqube-fix', 'my-skill/'] }, '1.0.0').problems).toEqual([])
    for (const skills of ['skills/a', ['../x'], ['/abs/x'], ['skills/Bad_Name'], [1]]) {
      expect(checkManifest({ ...base, skills }, '1.0.0').problems.map((p) => p.code), JSON.stringify(skills)).toContain('skills-invalid')
    }
    expect(checkManifest({ ...base, type: 'locale', entry: 'l.json', locale: { language: 'zh-CN', label: '中文' }, skills: ['s/x'] }, '1.0.0').problems.map((p) => p.code)).toContain('skills-invalid')
  })
})

describe('syncExtensionSkills', () => {
  it('원하는 것은 쓰고(표식과 같이), 더는 원하지 않는 우리 것은 지우고, 표식 없는 같은 이름 폴더는 그대로', async () => {
    const skills = path.join(dir, 'skills')
    const source = path.join(dir, 'src.md')
    await fs.writeFile(source, '---\nname: fix\n---\nbody')
    await fs.mkdir(path.join(skills, 'mine'), { recursive: true })
    await fs.writeFile(path.join(skills, 'mine', 'SKILL.md'), 'user skill')
    expect(await syncExtensionSkills(skills, [{ id: 'a', name: 'fix', file: source }, { id: 'a', name: 'mine', file: source }])).toBe(true)
    expect(await fs.readFile(path.join(skills, 'fix', 'SKILL.md'), 'utf8')).toBe('---\nname: fix\n---\nbody')
    expect(await fs.readFile(path.join(skills, 'mine', 'SKILL.md'), 'utf8')).toBe('user skill')
    expect(await syncExtensionSkills(skills, [{ id: 'a', name: 'fix', file: source }])).toBe(false) // 그대로면 바뀜 없음
    expect(await syncExtensionSkills(skills, [])).toBe(true)
    await expect(fs.stat(path.join(skills, 'fix'))).rejects.toThrow()
    expect(await fs.readFile(path.join(skills, 'mine', 'SKILL.md'), 'utf8')).toBe('user skill')
  })
})

describe('ctx.extensions — 켜져 있는 동안만 앱 스킬', () => {
  it('설치하면 생기고, 끄면 빠지고, 다시 켜면 생기고, 지우면 빠진다 — 바뀔 때마다 엔진에 다시 읽게 한다', async () => {
    const root = path.join(dir, 'extensions')
    const skills = path.join(dir, 'skills')
    const file = path.join(dir, 'e.zip')
    await fs.writeFile(
      file,
      makeZip([
        { name: 'extension.json', data: JSON.stringify({ ...base, skills: ['skills/sonarqube-fix'] }) },
        { name: 'index.html', data: '<p>x</p>' },
        { name: 'skills/sonarqube-fix/SKILL.md', data: '---\nname: sonarqube-fix\n---\nfix only' },
      ]),
    )
    const ctx = new Context()
    ctx.plugin(SettingsService, { file: path.join(dir, 'settings.json') })
    let reloads = 0
    ctx.plugin(ExtensionsService, { root, appVersion: '1.0.0', skills: { dir: skills, reload: () => reloads++ } })
    const ext = await new Promise<ExtensionsService>((resolve) => ctx.inject(['extensions'], (c) => resolve(c.extensions)))
    await ext.idle()
    const skillFile = path.join(skills, 'sonarqube-fix', 'SKILL.md')
    const exists = () => fs.stat(skillFile).then(() => true, () => false)

    const store = new ExtensionStore(root)
    expect((await ext.install((await store.stage(file, '1.0.0')).token!)).ok).toBe(true)
    await ext.idle()
    expect(await fs.readFile(skillFile, 'utf8')).toContain('fix only')
    expect(reloads).toBe(1)

    await ext.setEnabled('sk-ext', false)
    await ext.idle()
    expect(await exists()).toBe(false)
    await ext.setEnabled('sk-ext', true)
    await ext.idle()
    expect(await exists()).toBe(true)
    await ext.remove('sk-ext')
    await ext.idle()
    expect(await exists()).toBe(false)
    expect(reloads).toBe(4)
  })
})
