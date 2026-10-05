import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 공용 셸 실행기(exec.ts)의 Windows 쪽 — 이 기계(macOS)에서는 cmd 를 못 띄우므로 spawn 에 넘기는 **인자 모양만** 고정한다 (이슈 #126 오류 3).
// 실제 Windows 실행은 미검증이다. macOS·Linux 의 실제 실행(로그인 셸·프로세스 그룹·기한)은 shell.test.ts · hooks.test.ts 가 진짜 셸로 댄다.

const spawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (original) => ({ ...(await original<typeof import('node:child_process')>()), spawn }))

const { execShell, shellCommand } = await import('../../src/services/exec.ts')

interface FakeChild extends EventEmitter {
  pid: number | undefined
  stdout: EventEmitter
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
}

function fakeChild(pid: number | undefined): FakeChild {
  return Object.assign(new EventEmitter(), { pid, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() })
}

const realPlatform = process.platform
function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

beforeEach(() => {
  spawn.mockReset()
})

afterEach(() => {
  onPlatform(realPlatform)
  vi.restoreAllMocks()
})

describe('shellCommand', () => {
  // cmd 는 /s 일 때 /c 뒤 글의 맨 앞·맨 뒤 따옴표만 떼고 그 사이는 그대로 읽는다 — 명령을 통째로 한 번 감싼다
  it('Windows: /d /s /c 뒤에 명령을 큰따옴표로 통째로 감싼다 — 명령 안의 따옴표는 손대지 않는다', () => {
    expect(shellCommand('dir', {}, 'win32')).toEqual(['cmd.exe', ['/d', '/s', '/c', '"dir"']])
    expect(shellCommand('echo "a b"', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, 'win32')).toEqual([
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', '"echo "a b""'],
    ])
  })

  it('macOS·Linux: 로그인 셸에 명령 그대로', () => {
    expect(shellCommand('echo "a b"', { SHELL: '/bin/zsh' }, 'darwin')).toEqual(['/bin/zsh', ['-lc', 'echo "a b"']])
    expect(shellCommand('ls', {}, 'linux')).toEqual(['/bin/sh', ['-lc', 'ls']])
  })
})

describe('execShell — Windows 인자 모양 (실행 미검증)', () => {
  it('인자를 Node 가 다시 이스케이프하지 않게 띄운다 (windowsVerbatimArguments)', () => {
    onPlatform('win32')
    spawn.mockReturnValue(fakeChild(4242))
    execShell({ command: '"C:\\Program Files\\x\\hook.cmd" "a b"', cwd: 'C:\\p', timeoutMs: 60_000, onOutput: () => {} }).stop('stopped')
    const [, args, options] = spawn.mock.calls[0]!
    expect(args).toEqual(['/d', '/s', '/c', '""C:\\Program Files\\x\\hook.cmd" "a b""'])
    expect(options).toMatchObject({ windowsVerbatimArguments: true, detached: false, windowsHide: true })
  })

  it('멈춤·기한: taskkill /pid <pid> /T /F 로 자식까지 한 번 끈다', async () => {
    vi.useFakeTimers()
    onPlatform('win32')
    const child = fakeChild(4242)
    const killer = fakeChild(1)
    spawn.mockReturnValueOnce(child).mockReturnValueOnce(killer)
    const stopped = execShell({ command: 'ping -t localhost', cwd: 'C:\\p', timeoutMs: 60_000, onOutput: () => {} })
    stopped.stop('stopped')
    stopped.stop('stopped') // 두 번 눌러도 한 번
    expect(spawn.mock.calls.slice(1).map(([file, args]) => [file, args])).toEqual([['taskkill', ['/pid', '4242', '/T', '/F']]])
    expect(spawn.mock.calls[1]![2]).toMatchObject({ windowsHide: true })
    child.emit('close', 1)
    expect(await stopped.done).toEqual({ exitCode: 1, status: 'stopped' })

    spawn.mockReset()
    spawn.mockReturnValueOnce(fakeChild(77)).mockReturnValueOnce(fakeChild(2))
    execShell({ command: 'ping -t localhost', cwd: 'C:\\p', timeoutMs: 500, onOutput: () => {} })
    vi.advanceTimersByTime(500)
    expect(spawn.mock.calls[1]!.slice(0, 2)).toEqual(['taskkill', ['/pid', '77', '/T', '/F']])
    vi.useRealTimers()
  })

  it('taskkill 을 못 띄우면 cmd 만이라도 끈다', () => {
    onPlatform('win32')
    const child = fakeChild(4242)
    const killer = fakeChild(undefined)
    spawn.mockReturnValueOnce(child).mockReturnValueOnce(killer)
    execShell({ command: 'x', cwd: 'C:\\p', timeoutMs: 60_000, onOutput: () => {} }).stop('stopped')
    killer.emit('error', new Error('spawn taskkill ENOENT'))
    expect(child.kill).toHaveBeenCalled()
  })
})

describe('execShell — macOS·Linux 는 그대로', () => {
  it('프로세스 그룹으로 띄우고 taskkill 을 부르지 않는다', () => {
    onPlatform('darwin')
    const child = fakeChild(undefined) // pid 가 없으면 그룹 시그널 대신 child.kill
    spawn.mockReturnValue(child)
    execShell({ command: 'sleep 30', cwd: '/p', timeoutMs: 60_000, onOutput: () => {} }).stop('stopped')
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]![1]).toEqual(['-lc', 'sleep 30'])
    expect(spawn.mock.calls[0]![2]).toMatchObject({ detached: true })
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })
})
