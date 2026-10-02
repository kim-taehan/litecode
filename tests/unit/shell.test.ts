import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from 'cordis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OUTPUT_LIMIT, ShellService, shellCommand, shellContext } from '../../src/services/shell.ts'

// `!명령` 실행 (ctx.shell) — 프로젝트 폴더·로그인 셸·출력 합치기·상한·■·기한 (closed-code shellRunner + 01h)

let tmp: string

beforeAll(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-shell-')))
})

afterAll(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

async function start(timeoutMs?: number): Promise<{ shell: ShellService; chunks: string[] }> {
  const ctx = new Context()
  const chunks: string[] = []
  ctx.on('shell/data', (_runId, chunk) => void chunks.push(chunk))
  ctx.plugin(ShellService, { timeoutMs })
  return new Promise((resolve) => ctx.inject(['shell'], (ready) => resolve({ shell: ready.shell, chunks })))
}

describe('shellCommand', () => {
  it('로그인 셸에 명령 하나 — SHELL 이 없으면 /bin/sh, Windows 는 cmd', () => {
    expect(shellCommand('ls', { SHELL: '/bin/zsh' }, 'darwin')).toEqual(['/bin/zsh', ['-lc', 'ls']])
    expect(shellCommand('ls', {}, 'linux')).toEqual(['/bin/sh', ['-lc', 'ls']])
    expect(shellCommand('dir', {}, 'win32')).toEqual(['cmd.exe', ['/d', '/s', '/c', 'dir']])
  })
})

describe('ShellService', () => {
  it('프로젝트 폴더에서 돌고, stdout·stderr 를 합치고, 종료 코드를 준다. 조각은 shell/data 로', async () => {
    const { shell, chunks } = await start()
    const result = await shell.run('r1', tmp, 'pwd; echo err >&2; exit 3')
    expect(result).toMatchObject({ command: 'pwd; echo err >&2; exit 3', exitCode: 3, status: 'done', truncated: false })
    expect(result.output).toContain(tmp)
    expect(result.output).toContain('err')
    expect(chunks.join('')).toBe(result.output)
  })

  it('출력은 상한에서 자른다', async () => {
    const { shell } = await start()
    const result = await shell.run('r2', tmp, `head -c ${OUTPUT_LIMIT * 2} /dev/zero | tr '\\0' a`)
    expect(result.output.length).toBe(OUTPUT_LIMIT)
    expect(result.truncated).toBe(true)
  })

  it('■ 로 멈추면 자식까지 끄고 stopped, 기한을 넘기면 timeout', async () => {
    const { shell } = await start(300)
    const running = shell.run('r3', tmp, 'sleep 30 & sleep 31')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(shell.stop('r3')).toBe(true)
    expect(await running).toMatchObject({ status: 'stopped', exitCode: null })
    expect(await shell.run('r4', tmp, 'sleep 30')).toMatchObject({ status: 'timeout' })
    expect(shell.stop('r4')).toBe(false) // 끝난 것은 없다
  })

  it('없는 폴더는 돌리지 않는다', async () => {
    const { shell } = await start()
    expect(await shell.run('r5', path.join(tmp, 'nope'), 'ls')).toMatchObject({ status: 'error', exitCode: null })
  })
})

describe('shellContext (AI 에 넣는 본문)', () => {
  it('어디서 무엇을 돌렸는지·끝난 사정·코드 블록 출력·잘림 표시', () => {
    const text = shellContext({ command: 'npm test', output: 'FAIL x\n', exitCode: 1, status: 'done', truncated: true }, '/p')
    expect(text).toContain('/p')
    expect(text).toContain('$ npm test\n(종료 코드 1)\n\n```\nFAIL x\n```')
    expect(text).toContain('100KB 에서 잘렸습니다')
  })

  it('출력에 ``` 가 있으면 더 긴 울타리로 감싼다. 멈춘 것은 그 사정을', () => {
    const text = shellContext({ command: 'cat a.md', output: '```js\nx\n```', exitCode: null, status: 'stopped', truncated: false }, '/p')
    expect(text).toContain('(사용자가 중단함)')
    expect(text).toContain('````\n```js\nx\n```\n````')
  })
})
