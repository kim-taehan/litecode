import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existingFiles, projectFile } from '../../src/services/fileMentions.ts'

// 파일 언급 칩의 판정 — 프로젝트 안의 실제 파일만. 밖(../, 다른 절대 경로, 밖을 가리키는 링크)은 있는지도 알려 주지 않는다

let tmp: string
let project: string

beforeAll(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-mentions-')))
  project = path.join(tmp, 'proj')
  await fs.mkdir(path.join(project, 'src'), { recursive: true })
  await fs.writeFile(path.join(project, 'src', 'a.ts'), '')
  await fs.writeFile(path.join(tmp, 'secret.txt'), '')
  await fs.symlink(path.join(tmp, 'secret.txt'), path.join(project, 'out-link'))
})

afterAll(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

describe('projectFile·existingFiles', () => {
  it('상대·프로젝트 안 절대 경로의 파일만 찾는다 — 폴더·없는 파일은 아니다', async () => {
    expect(await projectFile(project, 'src/a.ts')).toBe(path.join(project, 'src', 'a.ts'))
    expect(await projectFile(project, path.join(project, 'src/a.ts'))).toBe(path.join(project, 'src', 'a.ts'))
    expect(await projectFile(project, 'src')).toBeUndefined()
    expect(await projectFile(project, 'src/none.ts')).toBeUndefined()
  })

  it('프로젝트 밖은 있어도 아니다 (../, 다른 절대 경로, 밖을 가리키는 링크)', async () => {
    expect(await projectFile(project, '../secret.txt')).toBeUndefined()
    expect(await projectFile(project, path.join(tmp, 'secret.txt'))).toBeUndefined()
    expect(await projectFile(project, 'out-link')).toBeUndefined()
  })

  it('있는 것만 받은 글자 그대로, 중복 없이', async () => {
    expect(await existingFiles(project, ['src/a.ts', 'nope', 'src/a.ts', '../secret.txt', ''])).toEqual(['src/a.ts'])
  })
})
