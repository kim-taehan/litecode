import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from 'cordis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OUTPUT_LIMIT, ShellService, shellCommand, shellContext } from '../../src/services/shell.ts'
import { setMainLanguage } from '../../src/i18n.ts'

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
    expect(shellCommand('dir', {}, 'win32')).toEqual(['cmd.exe', ['/d', '/s', '/c', '"dir"']]) // 따옴표 규칙은 exec.test.ts
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

  // 참고 레포 검토(02x A·B): 앞 100KB 만 남기면 빌드 오류(끝)가 잘린다 — 앞과 끝을 함께 남기고 가운데에 생략 표시 한 줄
  it('출력이 상한을 넘으면 앞과 끝을 남기고 가운데를 생략한다', async () => {
    const { shell } = await start()
    const result = await shell.run('r2', tmp, `echo START; head -c ${OUTPUT_LIMIT * 2} /dev/zero | tr '\\0' a; echo; echo 'error: END'`)
    expect(result.truncated).toBe(true)
    expect(result.output.startsWith('START\n')).toBe(true)
    expect(result.output.endsWith('error: END\n')).toBe(true)
    const marker = result.output.match(/\n… .*생략.* …\n/)
    expect(marker).not.toBeNull()
    expect(result.output.length).toBe(OUTPUT_LIMIT + marker![0].length)
  })

  it('상한 안쪽이면 그대로다 (생략 표시 없음)', async () => {
    const { shell } = await start()
    const result = await shell.run('r2b', tmp, `head -c ${OUTPUT_LIMIT - 10} /dev/zero | tr '\\0' a`)
    expect(result.output.length).toBe(OUTPUT_LIMIT - 10)
    expect(result.truncated).toBe(false)
  })

  // 조각마다 toString() 하면 조각 경계에 걸린 한글이 깨진다 — '한'(ed 95 9c)을 두 번에 나눠 쓴다
  it('여러 바이트 글자가 조각 경계에 걸려도 깨지지 않는다', async () => {
    const { shell, chunks } = await start()
    const result = await shell.run('r2c', tmp, `printf '\\355\\225'; sleep 0.3; printf '\\234\\n'`)
    expect(result.output).toBe('한\n')
    expect(chunks.join('')).toBe('한\n')
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

  // 카드에 보이는 오류다 — 화면 언어를 따른다 (이슈 #126 오류 6)
  it('없는 폴더의 오류 문구는 지금 언어로 나간다', async () => {
    const { shell } = await start()
    const missing = path.join(tmp, 'nope')
    setMainLanguage('en')
    try {
      expect((await shell.run('r6', missing, 'ls')).error).toBe(`Working directory not found: ${missing}`)
    } finally {
      setMainLanguage('ko')
    }
  })
})

// 모델이 읽는 글이다 — 화면 언어와 무관하게 영어 (present 도구와 같은 규칙, 이슈 #126 오류 6)
describe('shellContext (AI 에 넣는 본문)', () => {
  it('어디서 무엇을 돌렸는지·끝난 사정·코드 블록 출력·잘림 표시', () => {
    const text = shellContext({ command: 'npm test', output: 'FAIL x\n', exitCode: 1, status: 'done', truncated: true }, '/p')
    expect(text.split('\n')[0]).toBe('Shell command the user ran directly in the project folder (/p), with its output.')
    expect(text).toContain('$ npm test\n(exit code 1)\n\n```\nFAIL x\n```')
    expect(text).toContain(`(output exceeded ${OUTPUT_LIMIT / 1024}KB; the middle was omitted, only the start and the end are shown)`)
  })

  it('출력에 ``` 가 있으면 더 긴 울타리로 감싼다. 멈춘 것은 그 사정을', () => {
    const text = shellContext({ command: 'cat a.md', output: '```js\nx\n```', exitCode: null, status: 'stopped', truncated: false }, '/p')
    expect(text).toContain('(stopped by the user)')
    expect(text).toContain('````\n```js\nx\n```\n````')
  })

  it('기한 초과·실행 안 됨도 영어로 — 한글이 섞이지 않는다', () => {
    const base = { command: 'x', output: '', truncated: true }
    const timeout = shellContext({ ...base, exitCode: null, status: 'timeout' }, '/p')
    const failed = shellContext({ ...base, exitCode: null, status: 'error' }, '/p')
    expect(timeout).toContain('(stopped after exceeding 60 seconds)')
    expect(failed).toContain('(did not run)')
    expect(timeout + failed).not.toMatch(/[가-힣]/)
  })
})
