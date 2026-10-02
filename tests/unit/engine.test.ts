import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ENGINE_AGENTS, engineConfig, engineEnv, installMarkerDirs, isOurServer, MODE_AGENT, plantInstallMarkers, SUBAGENT_ASK } from '../../src/services/engine.ts'
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
      agent: engineConfig([], proxy).agent,
      permission: { task: { [SUBAGENT_ASK]: 'deny' }, webfetch: 'deny', websearch: 'deny' },
      snapshot: false,
      model: 'a/m1',
      enabled_providers: ['a', 'b'],
      share: 'disabled',
      autoupdate: false,
      lsp: false,
      formatter: false,
    })
  })

  // 01w 1절 스냅샷 행: 레거시는 매 스텝 작업 폴더의 스냅샷을 사용자 ~/.local/share/opencode 에 만든다 — litecode 는 revert 를 안 쓴다
  it('스냅샷을 끈다', () => {
    expect(engineConfig([], { token: 't', baseURLFor: () => '' }).snapshot).toBe(false)
  })
})

// 01x (이슈 #19): opencode 가 묻지 않고 밖으로 나가는 기능을 앱 설정 폴더 값으로 고정한다. 레거시는 사용자 전역 opencode.json 도 읽지만
// CONFIG_DIR 값이 이긴다(01x 2-5) — share·lsp·formatter·enabled_providers 를 사용자 설정과 무관하게 정한다
describe('engineConfig — 엔진 기본값 (#19)', () => {
  const proxy = { token: 't', baseURLFor: () => '' }

  it('공유·자동 업데이트·LSP·포매터를 끈다', () => {
    expect(engineConfig([], proxy)).toMatchObject({ share: 'disabled', autoupdate: false, lsp: false, formatter: false })
  })

  // 모델 없는 세션은 내장 opencode Zen(opencode.ai)으로 간다 — model 설정이 막는다(01x 2-4, 5/5). enabled_providers 는 Zen 을 레거시 목록에서
  // 빼고, 사용자 전역의 enabled_providers 가 앱 provider 를 끄는 것을 덮는다(01x 4)
  it('기본 모델은 모델이 있는 첫 provider 의 첫 모델이고, 켤 provider 는 앱 provider 전부다', () => {
    const empty = { ...provider('empty'), models: [] }
    const config = engineConfig([empty, { ...provider('b'), models: [{ id: 'org/m-2', displayName: 'M2' }, { id: 'm3', displayName: 'M3' }] }], proxy)
    expect(config.model).toBe('b/org/m-2')
    expect(config.enabled_providers).toEqual(['empty', 'b'])
  })

  it('모델이 있는 provider 가 없으면 model 을 넣지 않는다 (없는 모델을 가리키지 않게)', () => {
    expect(engineConfig([], proxy)).not.toHaveProperty('model')
    expect(engineConfig([{ ...provider('a'), models: [] }], proxy)).not.toHaveProperty('model')
    expect(engineConfig([], proxy).enabled_providers).toEqual([])
  })
})

// 01w 3-2 / 01u 실측 5: opencode 는 MCP 자식에 자기 env 전체(서버 비밀번호 포함)를 넘긴다. 앱이 정의한 서버는 environment 에 빈 값을 넣으면 덮인다
describe('engineConfig — 앱이 정의한 MCP 의 자식 env', () => {
  const proxy = { token: 't', baseURLFor: () => '' }
  const childEnv = {
    PATH: '/bin',
    HOME: '/home/u',
    OPENCODE_SERVER_PASSWORD: 'pw',
    OPENCODE_DB: '/d.db',
    LITECODE_GATEWAY_URL: 'http://x',
    GITHUB_TOKEN: 'ghp',
    MY_API_KEY: 'k',
    db_password: 'p',
    AWS_SECRET_ACCESS_KEY: 's',
  }

  it('opencode 자식 env 의 OPENCODE_*·LITECODE_*·KEY/PASSWORD/SECRET/TOKEN 이름을 빈 값으로 덮고, 정의의 environment 는 그 위에 얹는다', () => {
    const config = engineConfig([], proxy, {
      childEnv,
      mcp: { tools: { type: 'local', command: ['node', 'srv.js'], environment: { MY_API_KEY: 'for-this-server', MODE: 'x' } } },
    })
    expect(config.mcp).toEqual({
      tools: {
        type: 'local',
        command: ['node', 'srv.js'],
        environment: {
          OPENCODE_SERVER_PASSWORD: '',
          OPENCODE_DB: '',
          LITECODE_GATEWAY_URL: '',
          GITHUB_TOKEN: '',
          db_password: '',
          AWS_SECRET_ACCESS_KEY: '',
          MY_API_KEY: 'for-this-server',
          MODE: 'x',
        },
      },
    })
  })

  it('정의가 없으면 mcp 를 싣지 않는다', () => {
    expect(engineConfig([], proxy, { childEnv })).not.toHaveProperty('mcp')
  })
})

// 모드 = opencode 에이전트 (01f·01k, 2026-10-02 실측: plan 에 edit·bash·webfetch deny 를 덧붙이면 도구가 빠지고 .opencode/plans 예외도 막힌다)
describe('engineConfig — 모드 에이전트 (웹 도구 켬)', () => {
  const agent = engineConfig([], { token: 't', baseURLFor: () => '' }, { webTools: true }).agent as Record<string, { mode?: string; prompt?: string; description?: string; permission: Record<string, unknown> }>

  it('모든 모드에 에이전트가 있다 — build 는 opencode 기본, 나머지는 생성한 opencode.json 에 정의', () => {
    for (const mode of MODES) if (mode !== 'build') expect(agent[MODE_AGENT[mode]], mode).toBeDefined()
    expect(MODE_AGENT.build).toBe('build')
    expect(agent['build']).toBeUndefined()
  })

  it('계획은 opencode plan 을 덮어써 편집·명령·웹을 막고 계획 프롬프트를 준다', () => {
    expect(MODE_AGENT.plan).toBe('plan')
    expect(agent['plan']!.permission).toEqual({ edit: 'deny', bash: 'deny', webfetch: 'deny', websearch: 'deny', task: 'deny' })
    expect(agent['plan']!.prompt).toMatch(/plan mode/)
  })

  it('매번 묻기는 편집·명령·웹을 묻고 질문 도구를 다시 허용한다, 전체 권한은 모두 허용 — 둘 다 primary 에 build 첫 줄 프롬프트', () => {
    expect(agent[MODE_AGENT.ask]).toMatchObject({ mode: 'primary', permission: { edit: 'ask', bash: 'ask', webfetch: 'ask', websearch: 'ask', question: 'allow' } })
    expect(agent[MODE_AGENT.full]).toMatchObject({ mode: 'primary', permission: { '*': 'allow' } })
    expect(agent[MODE_AGENT.full]!.permission).toEqual({ '*': 'allow', task: { [SUBAGENT_ASK]: 'deny' } })
    expect(agent[MODE_AGENT.ask]!.prompt).toMatch(/^You are an AI coding agent\./)
    expect(agent[MODE_AGENT.full]!.prompt).toBe(agent[MODE_AGENT.ask]!.prompt)
  })

  // 이슈 #31 실측: 하위 작업(task 자식 세션)은 부모 모드 권한을 물려받지 않는다 — 매번 묻기에서 general 이 묻지 않고 bash 를 돌렸고, 레거시 explore 엔 bash 가 있다
  it('하위 작업: 매번 묻기는 묻는 하위 에이전트만, 계획은 task 를 막고, 그 하위 에이전트는 다른 모드(전역·전체 권한)에서 막는다', () => {
    expect(agent[MODE_AGENT.ask]!.permission['task']).toEqual({ '*': 'deny', [SUBAGENT_ASK]: 'allow' })
    expect(agent[SUBAGENT_ASK]).toMatchObject({ mode: 'subagent', permission: { edit: 'ask', bash: 'ask', webfetch: 'ask', websearch: 'ask', todowrite: 'deny' } })
    expect(agent[SUBAGENT_ASK]!.description).toMatch(/^General-purpose agent/)
    expect(agent[SUBAGENT_ASK]!.prompt).toBeUndefined() // general 처럼 opencode 기본 시스템 프롬프트
    expect(engineConfig([], { token: 't', baseURLFor: () => '' }, { webTools: true }).permission).toEqual({ task: { [SUBAGENT_ASK]: 'deny' } })
  })
})

// 이슈 #14 실측 (2026-10-02, opencode 1.18.18, 가짜 LLM 이 받은 tools): 전역 permission(또는 tools:false) 의 deny 는 에이전트 규칙에 진다 —
// litecode-ask 의 webfetch:ask·litecode-full 의 "*":allow 가 되살린다. 에이전트마다 **맨 뒤에** deny 를 덧붙여야 4 모드 모두에서 빠진다
// (신규 /api prompt·레거시 prompt_async 둘 다, 레거시 task 하위 에이전트까지). build 는 정의가 없어 전역 permission 이 맡는다
describe('engineConfig — 웹 도구 끔 (기본)', () => {
  const config = engineConfig([], { token: 't', baseURLFor: () => '' })
  const agent = config.agent as Record<string, { permission: Record<string, string> }>

  it('전역 permission 에 webfetch·websearch deny (build·하위 에이전트용) — 묻는 하위 에이전트 막기와 함께', () => {
    expect(config.permission).toEqual({ task: { [SUBAGENT_ASK]: 'deny' }, webfetch: 'deny', websearch: 'deny' })
  })

  it('정의한 에이전트마다 규칙 맨 뒤에 webfetch·websearch deny — "*":allow·ask 를 덮는다', () => {
    expect(Object.keys(agent).sort()).toEqual(Object.keys(ENGINE_AGENTS).sort())
    for (const [name, { permission }] of Object.entries(agent)) {
      expect(Object.entries(permission).slice(-2), name).toEqual([
        ['webfetch', 'deny'],
        ['websearch', 'deny'],
      ])
    }
    expect(agent[MODE_AGENT.full]!.permission).toEqual({ '*': 'allow', task: { [SUBAGENT_ASK]: 'deny' }, webfetch: 'deny', websearch: 'deny' })
    expect(agent[MODE_AGENT.ask]!.permission).toMatchObject({ edit: 'ask', bash: 'ask', question: 'allow' })
  })

  it('켜면 전역 permission 에 웹 deny 가 없고 에이전트 정의는 ENGINE_AGENTS 그대로', () => {
    const on = engineConfig([], { token: 't', baseURLFor: () => '' }, { webTools: true })
    expect(on.permission).toEqual({ task: { [SUBAGENT_ASK]: 'deny' } })
    expect(on.agent).toEqual(ENGINE_AGENTS)
  })
})

// 01_probe (2026-10-01): custom 모델의 한도는 opencode 가 모른다(limit.context 0). 모델에 limit 을 적으면 /api/model 에 그대로 보인다
describe('engineConfig — 컨텍스트 길이', () => {
  // 이슈 #27 실측: limit.output 은 요청의 max_tokens 이자 요약 문턱의 출력 몫 — 0 이면 둘 다 32000 이라 작은 모델에서 요약이 끝없이 돈다
  it('컨텍스트 길이·최대 출력 중 하나라도 준 모델만 limit 을 싣는다 — 최대 출력을 비우면 컨텍스트의 1/4(최대 32000)', () => {
    const proxy = { token: 't', baseURLFor: (id: string) => `http://127.0.0.1:9/${id}` }
    const config = engineConfig(
      [
        {
          ...provider('a'),
          models: [
            { id: 'm1', displayName: 'M1', contextLength: 32_768 },
            { id: 'm2', displayName: 'M2' },
            { id: 'm3', displayName: 'M3', contextLength: 24_000, maxOutput: 4_000 },
            { id: 'm4', displayName: 'M4', maxOutput: 8_000 },
            { id: 'm5', displayName: 'M5', contextLength: 256_000 },
          ],
        },
      ],
      proxy,
    )
    expect((config.provider as Record<string, { models: unknown }>)['a']!.models).toEqual({
      m1: { name: 'M1', limit: { context: 32_768, output: 8_192 } },
      m2: { name: 'M2' },
      m3: { name: 'M3', limit: { context: 24_000, output: 4_000 } },
      m4: { name: 'M4', limit: { context: 0, output: 8_000 } },
      m5: { name: 'M5', limit: { context: 256_000, output: 32_000 } },
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
      OPENCODE_DISABLE_SHARE: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    })
  })

  // 01x 7·표 14·20 (이슈 #19): 물려받은 env 가 엔진을 바꾼다 — OPENCODE_EXPERIMENTAL 하나로 레거시에 exa 검색·lsp 도구가 생기고,
  // OTEL_* 는 trace 를 내보내고, 개발 셸의 OPENCODE_DISABLE_* 때문에 개발·테스트와 Finder 실행본이 달랐다. 앱이 정한 것만 남긴다
  it('앱이 정하지 않은 OPENCODE_*·EXA_API_KEY·PARALLEL_API_KEY·OTEL_* 는 물려주지 않는다', () => {
    const env = engineEnv(
      {
        PATH: '/bin',
        HOME: '/h',
        HTTPS_PROXY: 'http://proxy',
        OPENCODE_EXPERIMENTAL: '1',
        OPENCODE_AUTO_SHARE: '1',
        OPENCODE_CONFIG_CONTENT: '{}',
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        OPENCODE_DISABLE_SHARE: '0',
        opencode_permission: 'x',
        EXA_API_KEY: 'exa',
        PARALLEL_API_KEY: 'par',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel',
        OTEL_RESOURCE_ATTRIBUTES: 'a=b',
        LITECODE_TEST_LANGUAGE: 'ko',
      },
      { configDir: '/c', db: '/d.db', password: 'pw' },
    )
    expect(Object.keys(env).filter((name) => !/^OPENCODE_(CONFIG_DIR|DB|SERVER_PASSWORD|DISABLE_)/.test(name)).sort()).toEqual(
      ['HOME', 'HTTPS_PROXY', 'LITECODE_TEST_LANGUAGE', 'PATH'],
    )
    expect(env['OPENCODE_DISABLE_SHARE']).toBe('1')
    expect(env).not.toHaveProperty('OPENCODE_DISABLE_PROJECT_CONFIG') // blockProjectConfig 를 안 켰다
  })

  // 01x 표 21 + #19 실측(2026-10-02): 레거시는 ~/.claude/CLAUDE.md·~/.claude/skills·~/.agents/skills(+ 프로젝트 CLAUDE.md·.claude/skills)를
  // 묻지 않고 싣는다. 신규 세대는 원래 다섯 다 안 싣는다. 사용자 결정 — "Claude Code 스킬 함께 쓰기" 는 기본 꺼짐(켜는 스위치는 #7)
  it('Claude Code 지시문·스킬 자동 싣기를 끈다', () => {
    const env = engineEnv({}, { configDir: '/c', db: '/d.db', password: 'pw' })
    expect(env).toMatchObject({ OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1' })
  })

  // 01w 3-1 / 사용자 결정 00_next_legacy 2. AGENTS.md 도 같이 꺼지므로(신규 경로 포함) L1 의 AGENTS.md 주입과 같이 켠다 — 기본 꺼짐
  it('blockProjectConfig 면 프로젝트 opencode 설정을 막는 플래그를 싣는다', () => {
    expect(engineEnv({}, { configDir: '/c', db: '/d.db', password: 'pw', blockProjectConfig: true })['OPENCODE_DISABLE_PROJECT_CONFIG']).toBe('1')
    expect(engineEnv({}, { configDir: '/c', db: '/d.db', password: 'pw' })).not.toHaveProperty('OPENCODE_DISABLE_PROJECT_CONFIG')
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

// 01w 4절: opencode 는 설정 폴더마다 @opencode-ai/plugin 을 npm 으로 설치하려 한다(끄는 플래그 없음). node_modules/ + package.json +
// package-lock.json(packages[""] 에 같은 의존성) 이 있으면 건너뛴다 — 사용자 결정(00_next_legacy 3): 개인 폴더에도 표식만, 있는 것은 안 덮는다
describe('설치 표식 — npm 설치 시도 0', () => {
  const made: string[] = []
  const tmp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litecode-marker-'))
    made.push(dir)
    return dir
  }
  const read = (file: string) => fs.readFileSync(file, 'utf8')
  afterEach(() => {
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('빈 폴더엔 01w 모양 그대로 세 개를 둔다', () => {
    const dir = tmp()
    plantInstallMarkers(dir)
    expect(fs.statSync(path.join(dir, 'node_modules')).isDirectory()).toBe(true)
    expect(fs.readdirSync(path.join(dir, 'node_modules'))).toEqual([])
    expect(JSON.parse(read(path.join(dir, 'package.json')))).toEqual({ dependencies: { '@opencode-ai/plugin': '1.18.18' } })
    expect(JSON.parse(read(path.join(dir, 'package-lock.json')))).toEqual({
      lockfileVersion: 3,
      packages: { '': { dependencies: { '@opencode-ai/plugin': '1.18.18' } } },
    })
  })

  it('있는 표식은 내용이 달라도 덮지 않는다 — 없는 것만 만든다', () => {
    const dir = tmp()
    fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'package-lock.json'), 'USER LOCK')
    fs.writeFileSync(path.join(dir, 'opencode.json'), 'USER CONFIG')
    plantInstallMarkers(dir)
    expect(read(path.join(dir, 'package-lock.json'))).toBe('USER LOCK')
    expect(read(path.join(dir, 'opencode.json'))).toBe('USER CONFIG')
    expect(fs.readdirSync(path.join(dir, 'node_modules'))).toEqual(['x'])
    expect(JSON.parse(read(path.join(dir, 'package.json')))).toEqual({ dependencies: { '@opencode-ai/plugin': '1.18.18' } })
  })

  it('package.json 이 다른 의존성을 가지면 잠금 파일을 지어내지 않는다 (사용자 것이라 맞지 않는 잠금이 된다)', () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { 'my-plugin': '1.0.0' } }))
    plantInstallMarkers(dir)
    expect(JSON.parse(read(path.join(dir, 'package.json')))).toEqual({ dependencies: { 'my-plugin': '1.0.0' } })
    expect(fs.existsSync(path.join(dir, 'package-lock.json'))).toBe(false)
  })

  it('opencode 가 남긴 package.json(플러그인만, 설치 실패로 잠금 없음)이면 그 버전으로 잠금을 둔다', () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { '@opencode-ai/plugin': '1.18.10' } }))
    plantInstallMarkers(dir)
    expect(JSON.parse(read(path.join(dir, 'package-lock.json'))).packages['']).toEqual({ dependencies: { '@opencode-ai/plugin': '1.18.10' } })
  })

  it('대상: 앱 설정 폴더 + 사용자 $XDG_CONFIG_HOME/opencode(없으면 ~/.config/opencode) + 있으면 ~/.opencode', () => {
    const home = tmp()
    expect(installMarkerDirs('/app/opencode', { HOME: home })).toEqual([
      { dir: '/app/opencode', create: true },
      { dir: path.join(home, '.config', 'opencode'), create: true },
      { dir: path.join(home, '.opencode'), create: false },
    ])
    expect(installMarkerDirs('/app/opencode', { HOME: home, XDG_CONFIG_HOME: '/x' })[1]).toEqual({ dir: path.join('/x', 'opencode'), create: true })
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
