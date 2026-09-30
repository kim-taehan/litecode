import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { engineConfig, engineEnv, isOurServer } from '../../src/services/engine.ts'
import { findOpencodeBinary } from '../../src/services/opencodeBinary.ts'
import type { ProviderConfig } from '../../src/services/providers.ts'

const provider = (id: string, baseURL = `http://${id}.local/v1`): ProviderConfig => ({
  id,
  displayName: id.toUpperCase(),
  baseURL,
  protocol: 'openai-chat-completions',
  models: [{ id: 'm1', displayName: 'Model 1' }],
})

describe('engineConfig — 앱이 생성하는 opencode.json', () => {
  it('모든 provider 가 키 프록시 주소와 프록시 토큰을 쓴다 — 저장된 baseURL·진짜 키는 파일에 없다', () => {
    const proxy = { token: 'proxy-token', baseURLFor: (id: string) => `http://127.0.0.1:9/${id}` }
    const config = engineConfig([provider('a'), provider('b')], proxy)

    expect(JSON.stringify(config)).not.toContain('.local') // 저장된 baseURL 은 프록시만 안다
    expect(config).toEqual({
      $schema: 'https://opencode.ai/config.json',
      provider: {
        a: { npm: '@ai-sdk/openai-compatible', name: 'A', options: { baseURL: 'http://127.0.0.1:9/a', apiKey: 'proxy-token' }, models: { m1: { name: 'Model 1' } } },
        b: { npm: '@ai-sdk/openai-compatible', name: 'B', options: { baseURL: 'http://127.0.0.1:9/b', apiKey: 'proxy-token' }, models: { m1: { name: 'Model 1' } } },
      },
    })
  })
})

describe('engineEnv — opencode 자식 프로세스 env', () => {
  it('설정 폴더·DB·비밀번호를 싣고, 카탈로그 받기를 끄며(폐쇄망), 사용자명 재정의는 뺀다', () => {
    const env = engineEnv({ PATH: '/bin', OPENCODE_SERVER_USERNAME: 'x' }, { configDir: '/c', db: '/d.db', password: 'pw' })
    expect(env).toEqual({
      PATH: '/bin',
      OPENCODE_CONFIG_DIR: '/c',
      OPENCODE_DB: '/d.db',
      OPENCODE_SERVER_PASSWORD: 'pw',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
    })
  })
})

describe('findOpencodeBinary — OPENCODE_BIN > PATH > 알려진 자리', () => {
  const env = (extra: NodeJS.ProcessEnv) => ({ HOME: '/home/u', PATH: '/p1:/p2', ...extra })

  it('OPENCODE_BIN 이 실행 가능하면 그것을 쓴다', () => {
    expect(findOpencodeBinary(env({ OPENCODE_BIN: '/x/opencode' }), () => true).path).toBe('/x/opencode')
  })

  it('PATH 를 앞에서부터 보고, 없으면 알려진 자리(~/.bun/bin 등)를 본다 — GUI 앱의 빈 PATH', () => {
    const found = findOpencodeBinary(env({ PATH: '/usr/bin:/bin' }), (file) => file === path.join('/home/u/.bun/bin', 'opencode'))
    expect(found.path).toBe('/home/u/.bun/bin/opencode')
    expect(found.searched.slice(0, 3)).toEqual(['/usr/bin/opencode', '/bin/opencode', '/home/u/.bun/bin/opencode'])
  })

  it('못 찾으면 본 자리를 전부(OPENCODE_BIN 포함, 중복 없이) 돌려준다', () => {
    const found = findOpencodeBinary(env({ OPENCODE_BIN: '/nope', PATH: '/usr/local/bin' }), () => false)
    expect(found.path).toBeUndefined()
    expect(found.searched[0]).toBe('/nope (OPENCODE_BIN)')
    expect(found.searched.filter((entry) => entry === '/usr/local/bin/opencode')).toHaveLength(1)
  })
})

describe('isOurServer — 지난 실행의 PID 를 거둬도 되나', () => {
  const ours = '/home/u/.bun/bin/opencode serve --hostname 127.0.0.1 --port 50123 --pure'
  const record = { command: ours, started: 'Tue Sep 30 15:00:00 2026' }

  it('명령줄 전체와 시작 시각이 둘 다 같을 때만 참', () => {
    expect(isOurServer(record, { command: ours, started: record.started })).toBe(true)
    expect(isOurServer(record, { command: ours, started: 'Wed Oct  1 09:00:00 2026' })).toBe(false) // 같은 모양으로 나중에 뜬 것
    expect(isOurServer(record, { command: '/usr/bin/sleep 30', started: record.started })).toBe(false)
    expect(isOurServer(record, {})).toBe(false) // 없는 PID
  })

  // 03_qa 경고: 사용자가 같은 실행 파일로 띄운 opencode 가 그 PID 를 물려받은 경우
  it('사용자 opencode(같은 실행 파일의 serve, 포트·--pure 없음)는 거두지 않는다', () => {
    expect(isOurServer(record, { command: '/home/u/.bun/bin/opencode serve --hostname 127.0.0.1', started: record.started })).toBe(false)
    expect(isOurServer(record, { command: '/home/u/.bun/bin/opencode serve --hostname 127.0.0.1 --port 50124 --pure', started: record.started })).toBe(false)
  })

  it('시작 시각을 못 적었으면 거두지 않는다', () => {
    expect(isOurServer({ command: ours }, { command: ours })).toBe(false)
  })
})
