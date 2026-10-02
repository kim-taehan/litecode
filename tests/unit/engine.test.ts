import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ENGINE_AGENTS, engineConfig, engineEnv, isOurServer, MODE_AGENT } from '../../src/services/engine.ts'
import { MODES } from '../../shared/modes.ts'
import { bundledPaths, findOpencodeBinary } from '../../src/services/opencodeBinary.ts'
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
      agent: ENGINE_AGENTS,
    })
  })
})

// 모드 = opencode 에이전트 (01f·01k, 2026-10-02 실측: plan 에 edit·bash·webfetch deny 를 덧붙이면 도구가 빠지고 .opencode/plans 예외도 막힌다)
describe('engineConfig — 모드 에이전트', () => {
  const agent = engineConfig([], { token: 't', baseURLFor: () => '' }).agent as Record<string, { mode?: string; prompt?: string; permission: Record<string, string> }>

  it('모든 모드에 에이전트가 있다 — build 는 opencode 기본, 나머지는 생성한 opencode.json 에 정의', () => {
    for (const mode of MODES) if (mode !== 'build') expect(agent[MODE_AGENT[mode]], mode).toBeDefined()
    expect(MODE_AGENT.build).toBe('build')
    expect(agent['build']).toBeUndefined()
  })

  it('계획은 opencode plan 을 덮어써 편집·명령·웹을 막고 계획 프롬프트를 준다', () => {
    expect(MODE_AGENT.plan).toBe('plan')
    expect(agent['plan']!.permission).toEqual({ edit: 'deny', bash: 'deny', webfetch: 'deny' })
    expect(agent['plan']!.prompt).toMatch(/plan mode/)
  })

  it('매번 묻기는 편집·명령·웹을 묻고 질문 도구를 다시 허용한다, 전체 권한은 모두 허용 — 둘 다 primary 에 build 첫 줄 프롬프트', () => {
    expect(agent[MODE_AGENT.ask]).toMatchObject({ mode: 'primary', permission: { edit: 'ask', bash: 'ask', webfetch: 'ask', question: 'allow' } })
    expect(agent[MODE_AGENT.full]).toMatchObject({ mode: 'primary', permission: { '*': 'allow' } })
    expect(agent[MODE_AGENT.ask]!.prompt).toMatch(/^You are an AI coding agent\./)
    expect(agent[MODE_AGENT.full]!.prompt).toBe(agent[MODE_AGENT.ask]!.prompt)
  })
})

// 01_probe (2026-10-01): custom 모델의 한도는 opencode 가 모른다(limit.context 0). 모델에 limit 을 적으면 /api/model 에 그대로 보인다
describe('engineConfig — 컨텍스트 길이', () => {
  it('컨텍스트 길이를 준 모델만 limit {context, output: 0} 을 싣는다', () => {
    const proxy = { token: 't', baseURLFor: (id: string) => `http://127.0.0.1:9/${id}` }
    const config = engineConfig([{ ...provider('a'), models: [{ id: 'm1', displayName: 'M1', contextLength: 32_768 }, { id: 'm2', displayName: 'M2' }] }], proxy)
    expect((config.provider as Record<string, { models: unknown }>)['a']!.models).toEqual({
      m1: { name: 'M1', limit: { context: 32_768, output: 0 } },
      m2: { name: 'M2' },
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

  // 01b_offline: rg 가 PATH 에 없으면 grep·glob 도구가 github 에서 받으려 한다 — 폐쇄망에선 실패하거나 ~300초 멈춘다
  it('동봉 rg 폴더가 있으면 PATH 맨 앞에 붙인다', () => {
    const env = engineEnv({ PATH: `/usr/bin${path.delimiter}/bin` }, { configDir: '/c', db: '/d.db', password: 'pw', rgDir: '/app/Resources/rg' })
    expect(env['PATH']).toBe(['/app/Resources/rg', '/usr/bin', '/bin'].join(path.delimiter))
    expect(engineEnv({}, { configDir: '/c', db: '/d.db', password: 'pw', rgDir: '/r' })['PATH']).toBe('/r')
  })

  it('Windows 식 이름(Path)도 같은 키에 붙인다 — PATH 가 둘이 되지 않게', () => {
    const env = engineEnv({ Path: 'C:\\Windows' }, { configDir: '/c', db: '/d.db', password: 'pw', rgDir: 'C:\\app\\rg' })
    expect(env['Path']).toBe(['C:\\app\\rg', 'C:\\Windows'].join(path.delimiter))
    expect(env['PATH']).toBeUndefined()
  })
})

describe('bundledPaths — 설치본에 실린 opencode·rg 자리 (electron-builder extraResources)', () => {
  it('mac 은 Resources/opencode/opencode 와 Resources/rg, win 은 .exe', () => {
    expect(bundledPaths('/A.app/Contents/Resources', 'darwin')).toEqual({
      opencode: path.join('/A.app/Contents/Resources', 'opencode', 'opencode'),
      rgDir: path.join('/A.app/Contents/Resources', 'rg'),
    })
    expect(bundledPaths('/app/resources', 'win32').opencode).toBe(path.join('/app/resources', 'opencode', 'opencode.exe'))
  })
})

describe('findOpencodeBinary — OPENCODE_BIN > 동봉 > PATH > 알려진 자리', () => {
  const env = (extra: NodeJS.ProcessEnv) => ({ HOME: '/home/u', PATH: '/p1:/p2', ...extra })
  const bundled = '/A.app/Contents/Resources/opencode/opencode'

  it('OPENCODE_BIN 이 실행 가능하면 그것을 쓴다 — 동봉보다 앞', () => {
    expect(findOpencodeBinary(env({ OPENCODE_BIN: '/x/opencode' }), () => true, bundled).path).toBe('/x/opencode')
  })

  it('동봉이 있으면 PATH 보다 앞선다 — 검증한 버전으로 고정', () => {
    const found = findOpencodeBinary(env({ OPENCODE_BIN: '/nope' }), (file) => file !== '/nope', bundled)
    expect(found.path).toBe(bundled)
    expect(found.searched).toEqual(['/nope (OPENCODE_BIN)', `${bundled} (동봉)`])
  })

  it('동봉이 실행 불가면 PATH 로 넘어가고, 본 자리에 동봉을 남긴다', () => {
    const found = findOpencodeBinary(env({}), (file) => file === path.join('/p2', 'opencode'), bundled)
    expect(found.path).toBe('/p2/opencode')
    expect(found.searched[0]).toBe(`${bundled} (동봉)`)
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
