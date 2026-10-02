import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { previewFile } from '../../src/services/filePreview.ts'

// 파일 미리보기 — 메인이 지키는 것: 프로젝트 안의 일반 파일만(링크로 밖 금지), 크기 한도, 이진 파일은 내용 없이

let tmp: string
let project: string
let outside: string

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-preview-')))
  project = path.join(tmp, 'project')
  outside = path.join(tmp, 'outside')
  await fs.mkdir(path.join(project, 'src'), { recursive: true })
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret\n')
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('previewFile', () => {
  it('프로젝트 안 글 파일 — 상대 경로·realpath·내용·크기', async () => {
    await fs.writeFile(path.join(project, 'src', 'a.ts'), 'const a = 1\n한글 줄\n')
    expect(await previewFile(project, 'src/a.ts')).toEqual({
      status: 'text',
      path: path.join('src', 'a.ts'),
      absolute: path.join(project, 'src', 'a.ts'),
      size: Buffer.byteLength('const a = 1\n한글 줄\n'),
      text: 'const a = 1\n한글 줄\n',
      truncated: false,
    })
  })

  it('밖 경로(../·절대 경로)·없는 파일·폴더는 unavailable', async () => {
    expect(await previewFile(project, '../outside/secret.txt')).toEqual({ status: 'unavailable' })
    expect(await previewFile(project, path.join(outside, 'secret.txt'))).toEqual({ status: 'unavailable' })
    expect(await previewFile(project, 'src/nope.ts')).toEqual({ status: 'unavailable' })
    expect(await previewFile(project, 'src')).toEqual({ status: 'unavailable' })
    expect(await previewFile(path.join(tmp, 'no-such-project'), 'a.ts')).toEqual({ status: 'unavailable' })
  })

  it('밖을 가리키는 심볼릭 링크(파일·폴더 모두)는 unavailable — 안을 가리키는 링크는 된다', async () => {
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(project, 'leak.txt'))
    await fs.symlink(outside, path.join(project, 'out'))
    expect(await previewFile(project, 'leak.txt')).toEqual({ status: 'unavailable' })
    expect(await previewFile(project, 'out/secret.txt')).toEqual({ status: 'unavailable' })
    await fs.writeFile(path.join(project, 'src', 'real.ts'), 'ok\n')
    await fs.symlink(path.join(project, 'src', 'real.ts'), path.join(project, 'alias.ts'))
    expect(await previewFile(project, 'alias.ts')).toMatchObject({ status: 'text', text: 'ok\n', path: path.join('src', 'real.ts') })
  })

  it('한도를 넘으면 앞부분만 + truncated, size 는 전체 — 잘린 끝의 덜 끝난 한글은 이진으로 보지 않는다', async () => {
    await fs.writeFile(path.join(project, 'big.txt'), 'a'.repeat(100))
    expect(await previewFile(project, 'big.txt', 10)).toMatchObject({ status: 'text', text: 'a'.repeat(10), size: 100, truncated: true })
    await fs.writeFile(path.join(project, 'ko.txt'), '가나다라') // 글자마다 3바이트
    expect(await previewFile(project, 'ko.txt', 7)).toMatchObject({ status: 'text', text: '가나', size: 12, truncated: true })
  })

  it('이진 파일(NUL 바이트·UTF-8 아님)은 내용 없이 binary', async () => {
    await fs.writeFile(path.join(project, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
    await fs.writeFile(path.join(project, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])) // "café" latin-1
    expect(await previewFile(project, 'img.png')).toEqual({ status: 'binary', path: 'img.png', absolute: path.join(project, 'img.png'), size: 6 })
    expect(await previewFile(project, 'latin1.txt')).toMatchObject({ status: 'binary', size: 5 })
  })

  it('빈 파일은 빈 글', async () => {
    await fs.writeFile(path.join(project, 'empty.txt'), '')
    expect(await previewFile(project, 'empty.txt')).toMatchObject({ status: 'text', text: '', size: 0, truncated: false })
  })
})
