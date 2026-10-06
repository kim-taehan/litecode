import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ENGINE_AGENTS, engineConfig, engineEnv, installMarkerDirs, isGated, isOurServer, MODE_AGENT, plantInstallMarkers, SUBAGENT_ASK, toolGate } from '../../src/services/engine.ts'
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
      permission: { task: { [SUBAGENT_ASK]: 'deny' }, litecode_send_to_project: 'deny', litecode_read_project: 'deny', litecode_create_skill: 'deny', litecode_add_mcp_server: 'deny', litecode_add_hook: 'deny', litecode_present: 'deny', webfetch: 'deny', websearch: 'deny' },
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

  it('모든 모드에 에이전트가 있다 — build 는 opencode 기본에 권한 규칙만 얹는다(모드·프롬프트를 적지 않는다), 나머지는 생성한 opencode.json 에 정의', () => {
    for (const mode of MODES) expect(agent[MODE_AGENT[mode]], mode).toBeDefined()
    expect(MODE_AGENT.build).toBe('build')
    expect(Object.keys(agent['build']!)).toEqual(['permission'])
  })

  it('계획은 opencode plan 을 덮어써 편집·명령·웹을 막고 계획 프롬프트를 준다', () => {
    expect(MODE_AGENT.plan).toBe('plan')
    expect(agent['plan']!.permission).toEqual({ edit: 'deny', bash: 'deny', webfetch: 'deny', websearch: 'deny', task: 'deny', '*_*': 'deny', litecode_open_file: 'allow', litecode_list_projects: 'allow', litecode_read_project: 'ask', litecode_present: 'allow', external_directory: 'ask', doom_loop: 'ask' })
    expect(agent['plan']!.prompt).toMatch(/plan mode/)
  })

  it('매번 묻기는 편집·명령·웹을 묻고 질문 도구를 다시 허용한다, 전체 권한은 모두 허용 — 둘 다 primary 에 build 첫 줄 프롬프트', () => {
    expect(agent[MODE_AGENT.ask]).toMatchObject({ mode: 'primary', permission: { edit: 'ask', bash: 'ask', webfetch: 'ask', websearch: 'ask', question: 'allow' } })
    expect(agent[MODE_AGENT.full]).toMatchObject({ mode: 'primary', permission: { '*': 'allow' } })
    expect(agent[MODE_AGENT.full]!.permission).toEqual({ '*': 'allow', task: { [SUBAGENT_ASK]: 'deny' }, litecode_send_to_project: 'ask', litecode_read_project: 'ask', litecode_create_skill: 'ask', litecode_add_mcp_server: 'ask', litecode_add_hook: 'ask', litecode_present: 'allow' })
    expect(agent[MODE_AGENT.ask]!.prompt).toMatch(/^You are an AI coding agent\./)
    expect(agent[MODE_AGENT.full]!.prompt).toBe(agent[MODE_AGENT.ask]!.prompt)
  })

  // 이슈 #31 실측: 하위 작업(task 자식 세션)은 부모 모드 권한을 물려받지 않는다 — 매번 묻기에서 general 이 묻지 않고 bash 를 돌렸고, 레거시 explore 엔 bash 가 있다
  it('하위 작업: 매번 묻기는 묻는 하위 에이전트만, 계획은 task 를 막고, 그 하위 에이전트는 다른 모드(전역·전체 권한)에서 막는다', () => {
    expect(agent[MODE_AGENT.ask]!.permission['task']).toEqual({ '*': 'deny', [SUBAGENT_ASK]: 'allow' })
    expect(agent[SUBAGENT_ASK]).toMatchObject({ mode: 'subagent', permission: { edit: 'ask', bash: 'ask', webfetch: 'ask', websearch: 'ask', todowrite: 'deny' } })
    expect(agent[SUBAGENT_ASK]!.description).toMatch(/^General-purpose agent/)
    expect(agent[SUBAGENT_ASK]!.prompt).toBeUndefined() // general 처럼 opencode 기본 시스템 프롬프트
    expect(engineConfig([], { token: 't', baseURLFor: () => '' }, { webTools: true }).permission).toEqual({ task: { [SUBAGENT_ASK]: 'deny' }, litecode_send_to_project: 'deny', litecode_read_project: 'deny', litecode_create_skill: 'deny', litecode_add_mcp_server: 'deny', litecode_add_hook: 'deny', litecode_present: 'deny' })
  })
})

// 이슈 #14 실측 (2026-10-02, opencode 1.18.18, 가짜 LLM 이 받은 tools): 전역 permission(또는 tools:false) 의 deny 는 에이전트 규칙에 진다 —
// litecode-ask 의 webfetch:ask·litecode-full 의 "*":allow 가 되살린다. 에이전트마다 **맨 뒤에** deny 를 덧붙여야 4 모드 모두에서 빠진다
// (신규 /api prompt·레거시 prompt_async 둘 다, 레거시 task 하위 에이전트까지). build 는 정의가 없어 전역 permission 이 맡는다
describe('engineConfig — 웹 도구 끔 (기본)', () => {
  const config = engineConfig([], { token: 't', baseURLFor: () => '' })
  const agent = config.agent as Record<string, { permission: Record<string, string> }>

  it('전역 permission 에 webfetch·websearch deny (build·하위 에이전트용) — 묻는 하위 에이전트 막기와 함께', () => {
    expect(config.permission).toEqual({ task: { [SUBAGENT_ASK]: 'deny' }, litecode_send_to_project: 'deny', litecode_read_project: 'deny', litecode_create_skill: 'deny', litecode_add_mcp_server: 'deny', litecode_add_hook: 'deny', litecode_present: 'deny', webfetch: 'deny', websearch: 'deny' })
  })

  it('정의한 에이전트마다 규칙 맨 뒤에 webfetch·websearch deny — "*":allow·ask 를 덮는다', () => {
    expect(Object.keys(agent).sort()).toEqual(Object.keys(ENGINE_AGENTS).sort())
    for (const [name, { permission }] of Object.entries(agent)) {
      expect(Object.entries(permission).slice(-2), name).toEqual([
        ['webfetch', 'deny'],
        ['websearch', 'deny'],
      ])
    }
    expect(agent[MODE_AGENT.full]!.permission).toEqual({ '*': 'allow', task: { [SUBAGENT_ASK]: 'deny' }, litecode_send_to_project: 'ask', litecode_read_project: 'ask', litecode_create_skill: 'ask', litecode_add_mcp_server: 'ask', litecode_add_hook: 'ask', litecode_present: 'allow', webfetch: 'deny', websearch: 'deny' })
    expect(agent[MODE_AGENT.ask]!.permission).toMatchObject({ edit: 'ask', bash: 'ask', question: 'allow' })
  })

  it('켜면 전역 permission 에 웹 deny 가 없고 에이전트 정의는 ENGINE_AGENTS 그대로', () => {
    const on = engineConfig([], { token: 't', baseURLFor: () => '' }, { webTools: true })
    expect(on.permission).toEqual({ task: { [SUBAGENT_ASK]: 'deny' }, litecode_send_to_project: 'deny', litecode_read_project: 'deny', litecode_create_skill: 'deny', litecode_add_mcp_server: 'deny', litecode_add_hook: 'deny', litecode_present: 'deny' })
    expect(Object.keys(on.agent as object).sort()).toEqual(Object.keys(ENGINE_AGENTS).sort())
    for (const [name, def] of Object.entries(ENGINE_AGENTS)) expect((on.agent as Record<string, unknown>)[name], name).toMatchObject(def)
  })
})

// 이슈 #28 실측 (2026-10-02, opencode 1.18.18 레거시): MCP 도구 이름 = 권한 이름 = `<서버>_<도구>`. 와일드카드 `*_*` deny 면 LLM 요청에서 빠지고,
// ask 면 permission.asked{permission:"<서버>_<도구>"} 가 온다. 밑줄 있는 내장 권한은 기본값을 다시 적는다
describe('engineConfig — MCP 도구 권한 (#28)', () => {
  const agent = engineConfig([], { token: 't', baseURLFor: () => '' }).agent as Record<string, { permission: Record<string, unknown> }>

  it('계획은 MCP 도구를 막고 external_directory·doom_loop 는 opencode 기본(ask)으로 되돌린다 — 그 뒤에 웹 deny', () => {
    const keys = Object.keys(agent['plan']!.permission)
    expect(agent['plan']!.permission).toMatchObject({ '*_*': 'deny', external_directory: 'ask', doom_loop: 'ask' })
    expect(keys.indexOf('external_directory')).toBeGreaterThan(keys.indexOf('*_*'))
    expect(keys.slice(-2)).toEqual(['webfetch', 'websearch'])
  })

  it('매번 묻기와 그 하위 작업은 MCP 도구를 묻는다, 기본(build)·전체 권한은 와일드카드 규칙이 없다(허용)', () => {
    expect(agent[MODE_AGENT.ask]!.permission).toMatchObject({ '*_*': 'ask', plan_enter: 'deny', plan_exit: 'deny' })
    expect(agent[SUBAGENT_ASK]!.permission).toMatchObject({ '*_*': 'ask', plan_enter: 'deny', plan_exit: 'deny' })
    expect(agent[MODE_AGENT.full]!.permission).toEqual({ '*': 'allow', task: { [SUBAGENT_ASK]: 'deny' }, litecode_send_to_project: 'ask', litecode_read_project: 'ask', litecode_create_skill: 'ask', litecode_add_mcp_server: 'ask', litecode_add_hook: 'ask', litecode_present: 'allow', webfetch: 'deny', websearch: 'deny' })
    expect(agent['build']!.permission).not.toHaveProperty('*_*')
  })
})

// 01_probe (2026-10-01): custom 모델의 한도는 opencode 가 모른다(limit.context 0). 모델에 limit 을 적으면 /api/model 에 그대로 보인다
// 이슈 #51 실측 (2026-10-04, _workspace/01z_desktop_mcp.md 1-3): `*_*` 뒤에 개별 이름을 적으면 그 도구만 다르게 된다 — 규칙은 뒤가 이긴다.
// 그래서 순서가 계약이다: 앱 MCP 도구의 규칙이 와일드카드보다 앞에 오면 와일드카드에 진다
describe('engineConfig — 앱 MCP 도구(litecode_*)의 모드별 권한 (#51)', () => {
  for (const webTools of [false, true]) {
    const config = engineConfig([], { token: 't', baseURLFor: () => '' }, { webTools, skills: { enabled: true, claude: false } })
    const agent = config.agent as Record<string, { permission: Record<string, unknown> }>
    const order = (name: string) => Object.keys(agent[name]!.permission)

    it(`계획: open_file 만 허용(와일드카드 deny 뒤), open_terminal 은 없다 — 웹 도구 ${webTools ? '켬' : '끔'}`, () => {
      expect(agent['plan']!.permission).toMatchObject({ '*_*': 'deny', litecode_open_file: 'allow' })
      expect(order('plan').indexOf('litecode_open_file')).toBeGreaterThan(order('plan').indexOf('*_*'))
      expect(agent['plan']!.permission).not.toHaveProperty('litecode_open_terminal')
    })

    it(`매번 묻기: open_file·open_terminal 은 묻지 않는다(와일드카드 ask 뒤), 그 하위 작업은 와일드카드대로 묻는다 — 웹 도구 ${webTools ? '켬' : '끔'}`, () => {
      const ask = MODE_AGENT.ask
      expect(agent[ask]!.permission).toMatchObject({ '*_*': 'ask', litecode_open_file: 'allow', litecode_open_terminal: 'allow' })
      expect(order(ask).indexOf('litecode_open_file')).toBeGreaterThan(order(ask).indexOf('*_*'))
      expect(order(ask).indexOf('litecode_open_terminal')).toBeGreaterThan(order(ask).indexOf('*_*'))
      expect(JSON.stringify(agent[SUBAGENT_ASK]!.permission)).not.toContain('litecode_open')
    })

    it(`기본(build)·전체 권한엔 화면 도구 규칙이 없다 — opencode 기본(허용), 전역 규칙에도 없다 — 웹 도구 ${webTools ? '켬' : '끔'}`, () => {
      expect(JSON.stringify(agent['build']!.permission)).not.toContain('litecode_open')
      expect(JSON.stringify(agent[MODE_AGENT.full]!.permission)).not.toContain('litecode_open')
      expect(JSON.stringify(config.permission)).not.toContain('litecode_open')
    })
  }
})

// 이슈 #55 실측 (2026-10-04, _workspace/01z_desktop_mcp.md 1-3·1-6·3-5): 다른 대화에 지시를 보내는 도구는 **전역 deny + 기본 모드 에이전트에만 ask**.
// 그래야 하위 작업(general·explore)·모르는 에이전트의 도구 목록에서 빠지고(9/9), 사람이 고른 모드에서는 보낼 때마다 묻는다. 순서가 계약이다 —
// 규칙은 뒤가 이긴다: 전체 권한의 `"*":"allow"`·매번 묻기 하위 작업의 `*_*: ask` 뒤에 개별 규칙이 와야 한다.
// 이슈 #137: 대상이 다른 프로젝트로 바뀌며 이름이 list_projects·read_project·send_to_project 가 됐고, 새 대화를 만드는 도구(start_session)는 없다.
// 읽기도 보내기와 같은 모양으로 묻는다 (다른 프로젝트의 내용이 이 대화로 들어온다) — 계획 모드에서도 읽기는 묻고 쓴다
describe('engineConfig — 세션 도구(litecode_*_project)의 모드별 권한 (#55·#137)', () => {
  const SEND = 'litecode_send_to_project'
  const READ = 'litecode_read_project'
  const LIST = 'litecode_list_projects'
  for (const webTools of [false, true]) {
    const label = `웹 도구 ${webTools ? '켬' : '끔'}`
    const config = engineConfig([], { token: 't', baseURLFor: () => '' }, { webTools, skills: { enabled: true, claude: false } })
    const agent = config.agent as Record<string, { permission: Record<string, unknown> }>
    const order = (name: string) => Object.keys(agent[name]!.permission)
    const after = (name: string, rule: string, wildcard: string) => expect(order(name).indexOf(rule), `${name} ${rule}`).toBeGreaterThan(order(name).indexOf(wildcard))

    it(`없앤 이름(start_session 과 옛 *_session 셋)은 설정 어디에도 없다 — ${label}`, () => {
      const whole = JSON.stringify(config)
      for (const gone of ['litecode_start_session', 'litecode_send_to_session', 'litecode_list_sessions', 'litecode_read_session']) expect(whole, gone).not.toContain(gone)
    })

    it(`전역: 보내기·읽기는 deny (하위 작업·모르는 에이전트는 못 본다), 목록은 규칙 없음 — ${label}`, () => {
      expect(config.permission).toMatchObject({ [SEND]: 'deny', [READ]: 'deny' })
      expect(config.permission).not.toHaveProperty(LIST)
    })

    it(`기본(build): 보내기·읽기는 ask — ${label}`, () => {
      expect(agent['build']!.permission).toMatchObject({ [SEND]: 'ask', [READ]: 'ask' })
      expect(agent['build']!.permission).not.toHaveProperty(LIST)
    })

    it(`전체 권한: "*": allow 뒤에 보내기·읽기 ask — ${label}`, () => {
      const full = MODE_AGENT.full
      expect(agent[full]!.permission).toMatchObject({ '*': 'allow', [SEND]: 'ask', [READ]: 'ask' })
      for (const name of [SEND, READ]) after(full, name, '*')
    })

    it(`매번 묻기: 목록은 와일드카드 ask 뒤에 allow, 보내기·읽기는 와일드카드대로 묻는다(개별 규칙 없음) — ${label}`, () => {
      const ask = MODE_AGENT.ask
      expect(agent[ask]!.permission).toMatchObject({ '*_*': 'ask', [LIST]: 'allow' })
      after(ask, LIST, '*_*')
      for (const name of [SEND, READ]) expect(agent[ask]!.permission).not.toHaveProperty(name)
    })

    it(`계획: 목록은 와일드카드 deny 뒤에 allow, 읽기는 그 뒤에 ask, 보내기 도구는 없다(와일드카드 deny 그대로) — ${label}`, () => {
      expect(agent['plan']!.permission).toMatchObject({ '*_*': 'deny', [LIST]: 'allow', [READ]: 'ask' })
      for (const name of [LIST, READ]) after('plan', name, '*_*')
      expect(agent['plan']!.permission).not.toHaveProperty(SEND)
    })

    it(`매번 묻기의 하위 작업(general-ask): 와일드카드 ask 가 전역 deny 를 되살리므로 그 뒤에 개별 deny — ${label}`, () => {
      expect(agent[SUBAGENT_ASK]!.permission).toMatchObject({ '*_*': 'ask', [SEND]: 'deny', [READ]: 'deny' })
      for (const name of [SEND, READ]) after(SUBAGENT_ASK, name, '*_*')
      // MCP 규칙 가운데 맨 뒤다 — 뒤에 오는 것은 다른 이름의 규칙(웹 deny·스킬)뿐이라 덮이지 않는다
      const rest = order(SUBAGENT_ASK).slice(order(SUBAGENT_ASK).indexOf(READ) + 1)
      expect(rest.filter((name) => name.includes('_') || name === '*')).toEqual([])
    })
  }
})

// 이슈 #145 — 스킬·MCP 서버·훅을 만드는 도구 셋은 보내기 도구와 같은 모양이다: 계획엔 없고, 기본·매번 묻기·전체 권한은 부를 때마다 묻고
// (전체 권한도 — 이 PC 에서 명령이 도는 일이라 "전체 권한" 이 대신 승인하지 않는다), 하위 작업은 못 쓴다
describe('engineConfig — 만들기 도구(create_skill·add_mcp_server·add_hook)의 모드별 권한 (#145)', () => {
  const MAKE = ['litecode_create_skill', 'litecode_add_mcp_server', 'litecode_add_hook']
  for (const webTools of [false, true]) {
    const label = `웹 도구 ${webTools ? '켬' : '끔'}`
    const config = engineConfig([], { token: 't', baseURLFor: () => '' }, { webTools, skills: { enabled: true, claude: false } })
    const agent = config.agent as Record<string, { permission: Record<string, unknown> }>
    const order = (name: string) => Object.keys(agent[name]!.permission)
    const after = (name: string, rule: string, wildcard: string) => expect(order(name).indexOf(rule), `${name} ${rule}`).toBeGreaterThan(order(name).indexOf(wildcard))

    it(`전역 deny — 하위 작업(general·explore)·모르는 에이전트의 도구 목록에 없다 — ${label}`, () => {
      for (const name of MAKE) expect(config.permission).toMatchObject({ [name]: 'deny' })
    })

    it(`기본(build)·전체 권한: 개별 ask ("*": allow 뒤) — ${label}`, () => {
      for (const name of MAKE) {
        expect(agent['build']!.permission).toMatchObject({ [name]: 'ask' })
        expect(agent[MODE_AGENT.full]!.permission).toMatchObject({ '*': 'allow', [name]: 'ask' })
        after(MODE_AGENT.full, name, '*')
      }
    })

    it(`매번 묻기: 와일드카드대로 묻는다(개별 규칙 없음), 계획: 와일드카드 deny 그대로(도구가 없다) — ${label}`, () => {
      expect(agent[MODE_AGENT.ask]!.permission).toMatchObject({ '*_*': 'ask' })
      expect(agent['plan']!.permission).toMatchObject({ '*_*': 'deny' })
      for (const name of MAKE) {
        expect(agent[MODE_AGENT.ask]!.permission).not.toHaveProperty(name)
        expect(agent['plan']!.permission).not.toHaveProperty(name)
      }
    })

    it(`매번 묻기의 하위 작업(general-ask): 와일드카드 ask 뒤에 개별 deny — ${label}`, () => {
      for (const name of MAKE) {
        expect(agent[SUBAGENT_ASK]!.permission).toMatchObject({ [name]: 'deny' })
        after(SUBAGENT_ASK, name, '*_*')
      }
    })
  }
})

// 이슈 #91 — 결과물 선언(litecode_present)은 화면을 조작하지 않는 읽기 전용 선언이라 **네 모드 모두 묻지 않는다**(계획 포함).
// 하위 작업은 못 쓴다(결과물은 메인 대화가 선언한다) — 보내기 도구와 같은 모양: 전역 deny + 모드 에이전트마다 개별 allow, general-ask 는
// 자기 `*_*: ask` 가 전역 deny 를 되살리므로 그 뒤에 개별 deny. 규칙은 뒤가 이긴다 — 순서가 계약이다
describe('engineConfig — 결과물 선언(litecode_present)의 모드별 권한 (#91)', () => {
  for (const webTools of [false, true]) {
    const label = `웹 도구 ${webTools ? '켬' : '끔'}`
    const config = engineConfig([], { token: 't', baseURLFor: () => '' }, { webTools, skills: { enabled: true, claude: false } })
    const agent = config.agent as Record<string, { permission: Record<string, unknown> }>
    const order = (name: string) => Object.keys(agent[name]!.permission)

    it(`네 모드 모두 allow — 계획·매번 묻기는 와일드카드 뒤, 전체 권한은 "*" 뒤 — ${label}`, () => {
      for (const name of ['plan', 'build', MODE_AGENT.ask, MODE_AGENT.full]) expect(agent[name]!.permission, name).toMatchObject({ litecode_present: 'allow' })
      expect(order('plan').indexOf('litecode_present')).toBeGreaterThan(order('plan').indexOf('*_*'))
      expect(order(MODE_AGENT.ask).indexOf('litecode_present')).toBeGreaterThan(order(MODE_AGENT.ask).indexOf('*_*'))
      expect(order(MODE_AGENT.full).indexOf('litecode_present')).toBeGreaterThan(order(MODE_AGENT.full).indexOf('*'))
    })

    it(`하위 작업은 못 쓴다 — 전역 deny, general-ask 는 와일드카드 ask 뒤에 개별 deny — ${label}`, () => {
      expect(config.permission).toMatchObject({ litecode_present: 'deny' })
      expect(agent[SUBAGENT_ASK]!.permission).toMatchObject({ '*_*': 'ask', litecode_present: 'deny' })
      expect(order(SUBAGENT_ASK).indexOf('litecode_present')).toBeGreaterThan(order(SUBAGENT_ASK).indexOf('*_*'))
    })
  }
})

// 도구 실행 전 게이트 (이슈 #102 2단계, 01af §4·§6-1) — 훅이 걸린 도구의 권한에 에이전트마다 맨 뒤 ask
describe('toolGate — 매처 → 게이트 대상', () => {
  it('내장 도구 이름의 나열은 그 권한 이름만 — write·apply_patch 는 edit, 대소문자(Claude Code 이름)는 가리지 않는다', () => {
    expect(toolGate(['bash'])).toEqual({ permissions: ['bash'], mcp: false })
    expect(toolGate(['Edit|Write'])).toEqual({ permissions: ['edit'], mcp: false })
    expect(toolGate(['apply_patch'])).toEqual({ permissions: ['edit'], mcp: false })
    expect(toolGate(['Bash', ' read|Skill ', 'TodoWrite|Task'])).toEqual({ permissions: ['bash', 'read', 'skill', 'task', 'todowrite'], mcp: false })
  })

  // 승인 목록 400 은 #107 의 이벤트 폴백으로 풀렸다 (01ai "훅 게이트" 각 3/3) — glob·grep·webfetch 도 자기 권한 이름으로 건다
  it('glob·grep·webfetch 는 자기 권한 이름으로 건다 — 대소문자를 가리지 않고, MCP 로 번지지 않는다', () => {
    expect(toolGate(['glob', 'Grep|WebFetch'])).toEqual({ permissions: ['glob', 'grep', 'webfetch'], mcp: false })
    expect(toolGate(['read|glob|grep'])).toEqual({ permissions: ['glob', 'grep', 'read'], mcp: false })
  })

  it('websearch 에는 걸지 않는다 (레거시 경로에 그 도구가 없다) — 이름은 아는 내장 도구라 MCP 로 번지지도 않는다', () => {
    expect(toolGate(['websearch'])).toEqual({ permissions: [], mcp: false })
    expect(toolGate(['WebFetch|WebSearch'])).toEqual({ permissions: ['webfetch'], mcp: false })
  })

  it('빈 매처·* 는 전부 — 걸 수 있는 내장 권한 전부 + MCP 도구', () => {
    const all = { permissions: ['bash', 'edit', 'glob', 'grep', 'read', 'skill', 'task', 'todowrite', 'webfetch'], mcp: true }
    expect(toolGate([''])).toEqual(all)
    expect(toolGate(['  '])).toEqual(all)
    expect(toolGate(['*'])).toEqual(all)
  })

  it('내장 도구 이름의 나열이 아니면(정규식·MCP 도구 이름) MCP 도구에도 건다 — 맞는 내장 도구는 그대로 더한다', () => {
    expect(toolGate(['github_create_issue'])).toEqual({ permissions: [], mcp: true })
    expect(toolGate(['mcp_.*'])).toEqual({ permissions: [], mcp: true })
    expect(toolGate(['bash|github_.*'])).toEqual({ permissions: ['bash'], mcp: true })
    expect(toolGate(['(edit|write)'])).toEqual({ permissions: ['edit'], mcp: true })
  })

  it('잘못된 정규식은 아무것도 걸지 않는다, 매처가 없으면 게이트도 없다', () => {
    expect(toolGate(['(', 'bash('])).toEqual({ permissions: [], mcp: false })
    expect(toolGate([])).toEqual({ permissions: [], mcp: false })
  })

  it('isGated: 건 권한 이름, MCP 를 걸었으면 밑줄 있는 이름 전부', () => {
    expect(isGated(toolGate(['bash']), 'bash')).toBe(true)
    expect(isGated(toolGate(['bash']), 'edit')).toBe(false)
    expect(isGated(toolGate(['bash']), 'github_search')).toBe(false)
    expect(isGated(toolGate(['github_.*']), 'github_search')).toBe(true)
    expect(isGated(toolGate(['github_.*']), 'external_directory')).toBe(true)
    expect(isGated(toolGate(['github_.*']), 'bash')).toBe(false)
  })
})

describe('engineConfig — 도구 실행 전 게이트 (#102)', () => {
  const proxy = { token: 'T', baseURLFor: (id: string) => `http://127.0.0.1:1/${id}` }
  const variants = [
    { webTools: false, skills: { enabled: true, claude: false } },
    { webTools: true, skills: { enabled: true, claude: true } },
    { webTools: true, skills: { enabled: false, claude: false } },
    { webTools: false },
  ]
  type Agents = Record<string, { permission: Record<string, unknown> } | undefined>
  const agents = (matchers: string[], extra: Parameters<typeof engineConfig>[2] = { webTools: true, skills: { enabled: true, claude: false } }) =>
    engineConfig([provider('gw')], proxy, { ...extra, gate: toolGate(matchers) }).agent as Agents
  const last = (permission: Record<string, unknown>, count: number) => Object.entries(permission).slice(-count)

  it('게이트가 없으면(훅 기능 꺼짐·도구 실행 전 훅 0개) 설정이 한 글자도 달라지지 않는다 — 웹 도구·스킬 조합마다', () => {
    for (const extra of variants) {
      const plain = JSON.stringify(engineConfig([provider('gw')], proxy, extra), null, 2)
      expect(JSON.stringify(engineConfig([provider('gw')], proxy, { ...extra, gate: toolGate([]) }), null, 2)).toBe(plain)
      expect(JSON.stringify(engineConfig([provider('gw')], proxy, { ...extra, gate: toolGate(['(']) }), null, 2)).toBe(plain)
    }
  })

  it('게이트를 걸어도 에이전트 정의 밖(전역 permission·provider·그 밖)은 그대로다', () => {
    for (const extra of variants) {
      const { agent: _plain, ...plain } = engineConfig([provider('gw')], proxy, extra)
      const { agent: _gated, ...gated } = engineConfig([provider('gw')], proxy, { ...extra, gate: toolGate(['']) })
      expect(gated).toEqual(plain)
    }
  })

  it('bash|edit: 기본·전체 권한은 맨 뒤에 ask (전체 권한의 "*":allow 도 덮는다), 하위 에이전트 general·explore 에도 — explore 는 원래 편집이 없어 bash 만', () => {
    const agent = agents(['bash|edit'])
    expect(last(agent[MODE_AGENT.build]!.permission, 2)).toEqual([['bash', 'ask'], ['edit', 'ask']])
    expect(last(agent[MODE_AGENT.full]!.permission, 2)).toEqual([['bash', 'ask'], ['edit', 'ask']])
    expect(Object.keys(agent[MODE_AGENT.full]!.permission)[0]).toBe('*')
    expect(agent['general']).toEqual({ permission: { bash: 'ask', edit: 'ask' } })
    expect(agent['explore']).toEqual({ permission: { bash: 'ask' } })
  })

  it('bash|edit: 계획은 그대로다(deny 인 도구에 ask 를 얹으면 되살아난다 — 훅도 돌지 않는다), 이미 묻는 매번 묻기와 그 하위 에이전트도 그대로', () => {
    const plain = agents([])
    const agent = agents(['bash|edit'])
    for (const name of ['plan', MODE_AGENT.ask, SUBAGENT_ASK]) expect(JSON.stringify(agent[name])).toBe(JSON.stringify(plain[name]))
    expect(agent['plan']!.permission).toMatchObject({ edit: 'deny', bash: 'deny' })
  })

  it('읽기·검색(read·glob·grep)은 계획에서도 걸린다 — 계획은 그 도구를 쓴다. 모든 모드와 하위 에이전트에 맨 뒤 ask', () => {
    const agent = agents(['read|glob|grep'])
    for (const name of ['plan', MODE_AGENT.build, MODE_AGENT.ask, MODE_AGENT.full, SUBAGENT_ASK, 'general', 'explore']) {
      expect(last(agent[name]!.permission, 3), name).toEqual([['glob', 'ask'], ['grep', 'ask'], ['read', 'ask']])
    }
    expect(agent['plan']!.permission).toMatchObject({ edit: 'deny', bash: 'deny', webfetch: 'deny' })
  })

  it('webfetch: 허용하던 곳(기본·전체 권한·general·explore)만 ask 로 — 계획의 deny, 매번 묻기와 그 하위 에이전트의 ask 는 그대로', () => {
    const plain = agents([])
    const agent = agents(['webfetch'])
    for (const name of ['plan', MODE_AGENT.ask, SUBAGENT_ASK]) expect(JSON.stringify(agent[name]), name).toBe(JSON.stringify(plain[name]))
    expect(agent['plan']!.permission['webfetch']).toBe('deny')
    expect(agent[MODE_AGENT.ask]!.permission['webfetch']).toBe('ask')
    expect(last(agent[MODE_AGENT.build]!.permission, 1)).toEqual([['webfetch', 'ask']])
    expect(last(agent[MODE_AGENT.full]!.permission, 1)).toEqual([['webfetch', 'ask']]) // "*":allow 뒤
    expect(agent['general']).toEqual({ permission: { webfetch: 'ask' } })
    expect(agent['explore']).toEqual({ permission: { webfetch: 'ask' } })
  })

  it('웹 가져오기를 껐으면 webfetch 훅이 있어도 어디에도 얹지 않는다 — ask 를 얹으면 도구가 되살아난다 (설정이 한 글자도 안 달라진다)', () => {
    for (const extra of variants.filter((variant) => !variant.webTools)) {
      const plain = JSON.stringify(engineConfig([provider('gw')], proxy, extra), null, 2)
      expect(JSON.stringify(engineConfig([provider('gw')], proxy, { ...extra, gate: toolGate(['webfetch']) }), null, 2)).toBe(plain)
    }
    const all = agents([''], { webTools: false, skills: { enabled: true, claude: false } })
    for (const name of ['plan', MODE_AGENT.build, MODE_AGENT.ask, MODE_AGENT.full, SUBAGENT_ASK]) expect(all[name]!.permission['webfetch'], name).toBe('deny')
    for (const name of ['general', 'explore']) expect(all[name]!.permission, name).not.toHaveProperty('webfetch') // 전역 deny 그대로
  })

  it('끈 스킬·끈 웹 도구에는 얹지 않는다 (deny 그대로), 켠 스킬에는 얹는다 — 숨긴 내장 스킬은 숨긴 채. websearch 규칙은 건드리지 않는다', () => {
    const plain = agents([])
    const off = agents(['webfetch|websearch|skill'], { webTools: false, skills: { enabled: false, claude: false } })
    expect(off[MODE_AGENT.full]!.permission).toMatchObject({ webfetch: 'deny', websearch: 'deny', skill: 'deny' })
    expect(off['general']).toBeUndefined()
    const on = agents(['webfetch|websearch|skill'])
    for (const name of ['plan', MODE_AGENT.build, MODE_AGENT.ask, MODE_AGENT.full]) {
      expect(on[name]!.permission['skill'], name).toEqual({ '*': 'ask', 'customize-opencode': 'deny' })
      expect(on[name]!.permission['websearch'], name).toEqual(plain[name]!.permission['websearch'])
    }
    expect(on['general']!.permission).toEqual({ skill: { '*': 'ask', 'customize-opencode': 'deny' }, webfetch: 'ask' })
  })

  it('task: 허용된 하위 에이전트만 묻게 한다 — 막은 하위 에이전트(다른 모드의 general-ask, 매번 묻기의 나머지)는 막힌 채, 계획은 그대로', () => {
    const agent = agents(['task'])
    expect(agent[MODE_AGENT.build]!.permission['task']).toEqual({ '*': 'ask', [SUBAGENT_ASK]: 'deny' })
    expect(agent[MODE_AGENT.full]!.permission['task']).toEqual({ '*': 'ask', [SUBAGENT_ASK]: 'deny' })
    expect(agent[MODE_AGENT.ask]!.permission['task']).toEqual({ '*': 'deny', [SUBAGENT_ASK]: 'ask' })
    expect(agent['plan']!.permission['task']).toBe('deny')
    expect(Object.keys(agent[MODE_AGENT.build]!.permission).at(-1)).toBe('task')
  })

  it('MCP 도구(와일드카드): 기본·전체 권한·general 은 맨 뒤에 *_* ask — 그 뒤에 막혀 있던 밑줄 이름을 다시 막는다', () => {
    const agent = agents(['github_.*'])
    const build = Object.entries(agent[MODE_AGENT.build]!.permission)
    // 기본 모드에서 막혀 있던 밑줄 이름은 엔진 기본의 plan_exit 뿐이다 (plan_enter 는 내장 build 가 허용, 보내기 도구는 원래 ask)
    expect(build.slice(build.findIndex(([name]) => name === '*_*'))).toEqual([['*_*', 'ask'], ['plan_exit', 'deny']])
    expect(agent[MODE_AGENT.build]!.permission).toMatchObject({ litecode_send_to_project: 'ask', litecode_present: 'allow' })
    const full = Object.entries(agent[MODE_AGENT.full]!.permission)
    expect(full.at(-1)).toEqual(['*_*', 'ask'])
    const general = Object.entries(agent['general']!.permission)
    expect(general[0]).toEqual(['*_*', 'ask'])
    expect(Object.fromEntries(general.slice(1))).toEqual({ plan_enter: 'deny', plan_exit: 'deny', litecode_send_to_project: 'deny', litecode_read_project: 'deny', litecode_create_skill: 'deny', litecode_add_mcp_server: 'deny', litecode_add_hook: 'deny', litecode_present: 'deny' })
    expect(agent['explore']).toBeUndefined() // explore 는 MCP 도구가 없다 ("*": deny)
  })

  it('MCP 도구(와일드카드): 계획은 와일드카드 deny 그대로 — 따로 허용한 앱 도구만 ask. 매번 묻기도 따로 허용한 앱 도구만 ask 로', () => {
    const agent = agents(['github_.*'])
    const plan = agent['plan']!.permission
    expect(plan['*_*']).toBe('deny')
    expect(plan).toMatchObject({ litecode_open_file: 'ask', litecode_list_projects: 'ask', litecode_read_project: 'ask', litecode_present: 'ask', external_directory: 'ask', doom_loop: 'ask' })
    expect(Object.keys(plan).indexOf('litecode_open_file')).toBeGreaterThan(Object.keys(plan).indexOf('*_*'))
    const ask = agent[MODE_AGENT.ask]!.permission
    expect(ask).toMatchObject({ '*_*': 'ask', litecode_open_file: 'ask', litecode_open_terminal: 'ask', litecode_present: 'ask', plan_enter: 'deny', plan_exit: 'deny' })
    expect(agent[SUBAGENT_ASK]!.permission).toMatchObject({ '*_*': 'ask', litecode_present: 'deny', litecode_send_to_project: 'deny', litecode_read_project: 'deny', plan_enter: 'deny' })
  })

  it('빈 매처(전부): 모드마다 스냅숏 — 계획·기본·매번 묻기·전체 권한 + 하위 에이전트', () => {
    // 규칙은 뒤가 이긴다 — 순서가 보이게 줄로 편다
    const lines = Object.fromEntries(Object.entries(agents([''])).map(([name, def]) => [name, Object.entries(def!.permission).map(([rule, action]) => `${rule}: ${JSON.stringify(action)}`)]))
    expect(lines).toMatchSnapshot()
  })

  it('explore 는 원래 가진 도구(bash·glob·grep·read·webfetch)에만 얹는다 — task·skill·편집·할 일·MCP 가 되살아나지 않는다', () => {
    expect(agents([''])['explore']).toEqual({ permission: { bash: 'ask', glob: 'ask', grep: 'ask', read: 'ask', webfetch: 'ask' } })
    // 웹 가져오기를 껐으면 explore 의 내장 webfetch allow 는 전역 deny 에 진다 — 얹지 않는다
    expect(agents([''], { webTools: false })['explore']).toEqual({ permission: { bash: 'ask', glob: 'ask', grep: 'ask', read: 'ask' } })
  })
})

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

// 01y 함정 3 (2026-10-04): 모델 정의에 modalities.input 의 image 가 있어야 file 파트 이미지가 image_url 로 나간다 — 없으면 ERROR 글로 바뀐다
describe('engineConfig — 이미지 입력 (이슈 #44)', () => {
  it('"이미지 입력" 을 켠 모델만 modalities 를 싣는다', () => {
    const config = engineConfig(
      [
        {
          ...provider('a'),
          models: [
            { id: 'plain', displayName: 'Plain' },
            { id: 'vision', displayName: 'Vision', imageInput: true },
            { id: 'off', displayName: 'Off', imageInput: false, contextLength: 32_768 },
          ],
        },
      ],
      { token: 't', baseURLFor: (id: string) => `http://127.0.0.1:9/${id}` },
    )
    expect((config.provider as Record<string, { models: unknown }>)['a']!.models).toEqual({
      plain: { name: 'Plain' },
      vision: { name: 'Vision', modalities: { input: ['text', 'image'], output: ['text'] } },
      off: { name: 'Off', limit: { context: 32_768, output: 8_192 } },
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
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    })
  })

  // #75 (실측 2026-10-05): 프록시 변수만 있으면 opencode 가 키 프록시(127.0.0.1)로 가는 요청을 사내 프록시로 보낸다
  it('루프백을 프록시 예외에 덧붙인다 — 있던 예외는 남기고, 이름의 대소문자가 달라도 하나로 모은다', () => {
    const env = engineEnv({ HTTP_PROXY: 'http://proxy:8080', No_Proxy: '.corp.example, localhost' }, { configDir: '/c', db: '/d.db', password: 'pw' })
    expect(env['HTTP_PROXY']).toBe('http://proxy:8080')
    expect(env['NO_PROXY']).toBe('.corp.example,localhost,127.0.0.1')
    expect(env['no_proxy']).toBe(env['NO_PROXY'])
    expect(env).not.toHaveProperty('No_Proxy')
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
      ['HOME', 'HTTPS_PROXY', 'LITECODE_TEST_LANGUAGE', 'NO_PROXY', 'PATH', 'no_proxy'],
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
