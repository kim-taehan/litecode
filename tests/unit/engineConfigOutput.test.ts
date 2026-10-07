import { describe, expect, it } from 'vitest'
import { engineConfig, hiddenEnvNames, toolGate, withBrowserRules } from '../../src/services/engine.ts'
import type { ProviderConfig } from '../../src/services/providers.ts'

// 이슈 #183: 규칙 표·설정 생성을 engineConfig.ts 로 옮긴 순수 이동 리팩터링을 지킨다. ctx.engine 이 쓰는 그대로
// (withBrowserRules(engineConfig(...)) → JSON.stringify(config, null, 2)) 생성한 opencode.json 전체를 대표 입력마다 스냅숏으로 고정한다.
// 스냅숏은 이동 전 코드로 만들었다 — 규칙을 일부러 바꿀 때만 갱신한다

const proxy = { token: 'proxy-token', baseURLFor: (id: string) => `http://127.0.0.1:9/${id}` }

const providers: ProviderConfig[] = [
  { id: 'empty', displayName: 'Empty', baseURL: 'http://empty.local/v1', protocol: 'openai-chat-completions', models: [] },
  {
    id: 'gw',
    displayName: 'Gateway',
    baseURL: 'http://gw.local/v1',
    protocol: 'openai-chat-completions',
    models: [
      { id: 'org/big', displayName: 'Big', contextLength: 128_000, imageInput: true },
      { id: 'small', displayName: 'Small', contextLength: 8_000, maxOutput: 1_000 },
      { id: 'plain', displayName: 'Plain' },
    ],
  },
]

const childEnv = { PATH: '/bin', OPENCODE_SERVER_PASSWORD: 'pw', LITECODE_X: '1', GITHUB_TOKEN: 'ghp', HOME: '/home/u' }

const cases: Record<string, { gated: boolean; extra: Parameters<typeof engineConfig>[2] }> = {
  기본값: { gated: false, extra: undefined },
  '앱 기본 기동 — 스킬 켬·웹 끔·게이트 없음': { gated: false, extra: { childEnv, skills: { enabled: true, claude: false }, webTools: false, gate: toolGate([]) } },
  '웹 켬·Claude 스킬·MCP·내장 도구 게이트': {
    gated: false,
    extra: {
      childEnv,
      webTools: true,
      skills: { enabled: true, claude: true },
      gate: toolGate(['Bash', 'Edit|Write']),
      mcp: {
        local: { type: 'local', command: ['node', 'srv.js'], environment: { MODE: 'x' }, timeout: 5_000 },
        remote: { type: 'remote', url: 'http://mcp.local/', headers: { 'x-a': 'b' } },
      },
    },
  },
  '스킬 끔·전부 게이트(MCP 포함)': { gated: true, extra: { childEnv, webTools: false, skills: { enabled: false, claude: false }, gate: toolGate(['']) } },
}

describe('engineConfig — 생성한 opencode.json 전체 (#183 이동 전후 같음)', () => {
  for (const [name, { gated, extra }] of Object.entries(cases)) {
    it(name, () => {
      expect(JSON.stringify(withBrowserRules(engineConfig(providers, proxy, extra), gated), null, 2)).toMatchSnapshot()
    })
  }

  it('MCP 자식에 덮어 넘길 env 이름', () => {
    expect(hiddenEnvNames(childEnv)).toMatchSnapshot()
  })
})
