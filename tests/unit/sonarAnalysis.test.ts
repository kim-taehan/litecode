import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { projectTsconfigs, reportTaskId, sonarProjectKey, sonarScanArgs } from '../../src/services/extensions/sonarAnalysis.ts'

// SonarQube 분석 (이슈 #545) — 프로젝트 키 정하기·스캐너 인자·분석 작업 id 읽기. 스캐너를 띄우는 쪽은 servers.ts

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'litecode-sonar-')))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
let serial = 0
const folder = (): string => {
  const dir = path.join(root, String(serial++))
  fs.mkdirSync(dir)
  return dir
}

describe('sonarProjectKey', () => {
  it('sonar-project.properties 의 sonar.projectKey 를 먼저 쓴다', () => {
    const dir = folder()
    fs.writeFileSync(path.join(dir, 'sonar-project.properties'), '# 주석\nsonar.projectName=무엇\n  sonar.projectKey = team:litecode-desktop \nsonar.sources=src\n')
    expect(sonarProjectKey(dir, 'litecode')).toBe('team:litecode-desktop')
  })

  it('없으면 프로젝트 이름에서 만든다 — 허용 글자 밖은 - 로, 숫자만이면 앞에 p', () => {
    const dir = folder()
    expect(sonarProjectKey(dir, 'my project (dev)')).toBe('my-project-dev')
    expect(sonarProjectKey(dir, '2026')).toBe('p2026')
    expect(sonarProjectKey(dir, '한글폴더')).toBe('project')
  })

  it('파일에 키가 비었거나 허용 글자 밖이면 이름에서 만든다', () => {
    const dir = folder()
    fs.writeFileSync(path.join(dir, 'sonar-project.properties'), 'sonar.projectKey=\n')
    expect(sonarProjectKey(dir, 'app')).toBe('app')
    fs.writeFileSync(path.join(dir, 'sonar-project.properties'), 'sonar.projectKey=a b\n')
    expect(sonarProjectKey(dir, 'app')).toBe('app')
  })
})

describe('sonarScanArgs', () => {
  const base = { serverUrl: 'http://127.0.0.1:9000', projectKey: 'app', projectDir: '/p', workDir: '/d/work' }

  it('전체 — 프로젝트 키 그대로, sources 는 프로젝트 폴더 전체, 작업 폴더는 데이터 폴더(프로젝트에 .scannerwork 를 남기지 않는다)', () => {
    const result = sonarScanArgs(base, undefined, () => true)
    expect(result).toEqual({
      ok: true,
      projectKey: 'app',
      skipped: [],
      args: [
        '-Dsonar.host.url=http://127.0.0.1:9000',
        '-Dsonar.projectBaseDir=/p',
        '-Dsonar.working.directory=/d/work',
        '-Dsonar.scanner.skipJreProvisioning=true',
        '-Dsonar.projectKey=app',
        '-Dsonar.sources=.',
      ],
    })
  })

  it('범위 — 별도 키(__scope)와 고른 경로만, 없는 경로는 skipped', () => {
    const result = sonarScanArgs(base, ['src/', 'gone.ts'], (p) => p === 'src')
    expect(result).toEqual({
      ok: true,
      projectKey: 'app__scope',
      skipped: ['gone.ts'],
      args: [
        '-Dsonar.host.url=http://127.0.0.1:9000',
        '-Dsonar.projectBaseDir=/p',
        '-Dsonar.working.directory=/d/work',
        '-Dsonar.scanner.skipJreProvisioning=true',
        '-Dsonar.projectKey=app__scope',
        '-Dsonar.sources=src',
      ],
    })
  })

  it('범위가 비면 scope-empty', () => {
    expect(sonarScanArgs(base, ['gone.ts'], () => false)).toEqual({ ok: false, error: 'scope-empty' })
  })
})

describe('reportTaskId', () => {
  it('작업 폴더의 report-task.txt 에서 ceTaskId 를 읽는다, 없으면 undefined', () => {
    const dir = folder()
    expect(reportTaskId(dir)).toBeUndefined()
    fs.writeFileSync(path.join(dir, 'report-task.txt'), 'projectKey=app\nceTaskId=AZ-abc_123\nceTaskUrl=http://x\n')
    expect(reportTaskId(dir)).toBe('AZ-abc_123')
  })
})

describe('projectTsconfigs (이슈 #548)', () => {
  it('숨김 폴더·node_modules 안의 tsconfig.json 은 빼고 프로젝트 기준 경로로', () => {
    const dir = folder()
    for (const file of ['tsconfig.json', 'mobile/tsconfig.json', '.claude/worktrees/a/tsconfig.json', 'node_modules/x/tsconfig.json', 'a/b/tsconfig.json']) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
      fs.writeFileSync(path.join(dir, file), '{}')
    }
    expect(projectTsconfigs(dir)).toEqual(['a/b/tsconfig.json', 'mobile/tsconfig.json', 'tsconfig.json'])
    expect(projectTsconfigs(dir, 6, 2)).toHaveLength(2)
  })

  it('목록이 있으면 스캐너 인자로 넘긴다 — 쉼표가 든 경로는 뺀다', () => {
    const result = sonarScanArgs({ serverUrl: 'http://s', projectKey: 'app', projectDir: '/p', workDir: '/w', tsconfigs: ['tsconfig.json', 'a,b/tsconfig.json', 'mobile/tsconfig.json'] }, undefined, () => true)
    expect(result.ok && result.args).toContain('-Dsonar.typescript.tsconfigPaths=tsconfig.json,mobile/tsconfig.json')
  })
})
