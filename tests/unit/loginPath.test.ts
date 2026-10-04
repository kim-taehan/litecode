import { describe, expect, it } from 'vitest'
import { mergePath, parseLoginPath, readLoginPath } from '../../src/services/loginPath.ts'

describe('loginPath — 로그인 셸의 PATH (#84)', () => {
  it('표식 사이의 PATH 만 꺼낸다 — 로그인 스크립트가 찍은 글은 버린다', () => {
    expect(parseLoginPath('welcome!\n__LITECODE_PATH__/opt/homebrew/bin:/usr/bin__LITECODE_PATH__\nbye')).toBe('/opt/homebrew/bin:/usr/bin')
    expect(parseLoginPath('no marker')).toBeUndefined()
    expect(parseLoginPath('__LITECODE_PATH____LITECODE_PATH__')).toBeUndefined()
  })

  it('로그인 셸 것을 앞에 두고 겹치는 것은 한 번만', () => {
    expect(mergePath('/opt/homebrew/bin:/usr/bin', '/usr/bin:/bin', ':')).toBe('/opt/homebrew/bin:/usr/bin:/bin')
    expect(mergePath(undefined, '/usr/bin:/bin', ':')).toBe('/usr/bin:/bin')
    expect(mergePath('/a', undefined, ':')).toBe('/a')
  })

  it('Windows 에선 읽지 않는다', async () => {
    expect(await readLoginPath({}, 'win32')).toBeUndefined()
  })

  it('셸이 PATH 를 찍으면 그것을, 셸을 못 띄우면 undefined 를 준다', async () => {
    expect(await readLoginPath({ SHELL: '/bin/sh', PATH: '/usr/bin:/bin' }, 'darwin')).toContain('/usr/bin')
    expect(await readLoginPath({ SHELL: '/nonexistent/shell', PATH: '/usr/bin' }, 'darwin')).toBeUndefined()
  })
})
