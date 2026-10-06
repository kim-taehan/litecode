import { describe, expect, it } from 'vitest'
import { MODES, modePermission, type Mode, type ModeRule } from '../../shared/modes.ts'
import { engineConfig, MODE_AGENT, SUBAGENT_ASK } from '../../src/services/engine.ts'

// 모드 판정 표 (이슈 #102 2단계, 01af §6-1 의 3) — "그 모드가 원래 묻는가". 도구 실행 전 게이트 때문에 온 승인 요청과 모드가 원래 묻는
// 요청을 이 함수로 가른다: 훅이 통과시킨 요청이 allow 면 묻지 않고 실행하고, ask 면 승인 카드가 그대로 뜬다

const row = (permission: string, opts?: Parameters<typeof modePermission>[2]): Record<Mode, ModeRule> =>
  Object.fromEntries(MODES.map((mode) => [mode, modePermission(mode, permission, opts)])) as Record<Mode, ModeRule>

describe('modePermission — 메인 대화', () => {
  it('편집·명령·웹: 계획은 막고, 기본·전체 권한은 허용, 매번 묻기는 묻는다', () => {
    for (const permission of ['edit', 'bash', 'webfetch', 'websearch']) {
      expect(row(permission), permission).toEqual({ plan: 'deny', build: 'allow', ask: 'ask', full: 'allow' })
    }
  })

  it('읽기·검색·스킬·할 일: 네 모드 모두 허용', () => {
    for (const permission of ['read', 'glob', 'grep', 'skill', 'todowrite']) {
      expect(row(permission, { resources: ['src/a.ts'] }), permission).toEqual({ plan: 'allow', build: 'allow', ask: 'allow', full: 'allow' })
    }
  })

  it('검색(glob·grep)은 대상이 무엇이든 묻지 않는다 — .env 를 가리키는 패턴도 (엔진의 .env 규칙은 read 에만 있다)', () => {
    for (const permission of ['glob', 'grep']) {
      for (const resources of [['*.txt'], ['.env'], ['needle'], []]) expect(row(permission, { resources }), `${permission} ${resources}`).toEqual({ plan: 'allow', build: 'allow', ask: 'allow', full: 'allow' })
    }
  })

  it('.env 읽기는 전체 권한만 묻지 않는다 — .env.example 은 아니다', () => {
    for (const file of ['.env', 'config/.env', '.env.local', '/abs/app/.env.production']) {
      expect(row('read', { resources: [file] }), file).toEqual({ plan: 'ask', build: 'ask', ask: 'ask', full: 'allow' })
    }
    expect(row('read', { resources: ['.env.example'] })).toEqual({ plan: 'allow', build: 'allow', ask: 'allow', full: 'allow' })
    expect(row('read', { resources: ['src/environment.ts'] }).build).toBe('allow')
  })

  it('폴더 밖·반복 감지: 전체 권한만 묻지 않는다', () => {
    for (const permission of ['external_directory', 'doom_loop']) expect(row(permission), permission).toEqual({ plan: 'ask', build: 'ask', ask: 'ask', full: 'allow' })
  })

  it('하위 작업(task): 계획은 막고, 매번 묻기는 묻는 하위 에이전트만, 그 밖의 모드는 그 하위 에이전트만 빼고 허용', () => {
    expect(row('task', { resources: ['general'] })).toEqual({ plan: 'deny', build: 'allow', ask: 'deny', full: 'allow' })
    expect(row('task', { resources: ['explore'] })).toEqual({ plan: 'deny', build: 'allow', ask: 'deny', full: 'allow' })
    expect(row('task', { resources: ['general-ask'] })).toEqual({ plan: 'deny', build: 'deny', ask: 'allow', full: 'deny' })
  })

  it('MCP 도구(<서버>_<도구>): 계획은 막고, 매번 묻기는 묻고, 기본·전체 권한은 허용', () => {
    expect(row('github_create_issue')).toEqual({ plan: 'deny', build: 'allow', ask: 'ask', full: 'allow' })
  })

  it('앱 MCP 도구: 다른 프로젝트에 보내기는 늘 묻는다(계획엔 없다), 읽기도 늘 묻는다(계획 포함, #137), 목록·결과물·열기(파일·터미널 한 도구)는 묻지 않는다 — 옛 이름은 보통의 MCP 도구', () => {
    expect(row('litecode_send_to_project')).toEqual({ plan: 'deny', build: 'ask', ask: 'ask', full: 'ask' })
    expect(row('litecode_read_project')).toEqual({ plan: 'allow', build: 'allow', ask: 'ask', full: 'allow' })
    // 없앤 도구 이름은 보통의 MCP 도구로 본다 (특별 규칙 없음)
    expect(row('litecode_start_session')).toEqual(row('github_create_issue'))
    for (const permission of ['litecode_list_projects', 'litecode_present', 'litecode_open']) {
      expect(row(permission), permission).toEqual({ plan: 'allow', build: 'allow', ask: 'allow', full: 'allow' })
    }
    for (const old of ['litecode_open_file', 'litecode_open_terminal', 'litecode_create_skill', 'litecode_add_mcp_server', 'litecode_add_hook']) expect(row(old), old).toEqual(row('github_create_issue'))
  })

  it('모르는 권한 이름은 묻는다 — 카드를 띄우는 쪽이 안전하다', () => {
    for (const permission of ['lsp', 'question', 'somethingnew', 'plan_enter', 'plan_exit']) expect(row(permission), permission).toEqual({ plan: 'ask', build: 'ask', ask: 'ask', full: 'ask' })
  })
})

describe('modePermission — 하위 작업 (자식은 부모 모드 권한을 안 물려받는다, #31)', () => {
  const child = (permission: string, resources?: string[]) => row(permission, { child: true, resources })

  it('편집·명령·웹·MCP 도구: 매번 묻기의 하위 작업만 묻는다 — 전체 권한의 하위 작업도 엔진 기본 에이전트라 폴더 밖·.env 는 묻는다', () => {
    for (const permission of ['edit', 'bash', 'webfetch', 'github_search', 'litecode_open', 'litecode_list_projects']) {
      expect(child(permission), permission).toMatchObject({ build: 'allow', ask: 'ask', full: 'allow' })
    }
    expect(child('external_directory')).toMatchObject({ build: 'ask', ask: 'ask', full: 'ask' })
    expect(child('read', ['.env'])).toMatchObject({ build: 'ask', ask: 'ask', full: 'ask' })
    expect(child('read', ['a.ts'])).toMatchObject({ build: 'allow', ask: 'allow', full: 'allow' })
    for (const permission of ['glob', 'grep']) expect(child(permission, ['*.ts']), permission).toMatchObject({ build: 'allow', ask: 'allow', full: 'allow' })
  })

  it('만들기 도구(스킬·MCP 서버·훅, #145)는 전체 권한에서도 묻는다 — 계획엔 없다', () => {
    for (const permission of ['litecode_create']) {
      expect(row(permission), permission).toEqual({ plan: 'deny', build: 'ask', ask: 'ask', full: 'ask' })
    }
  })

  it('하위 작업은 보내기·읽기·결과물·만들기 도구와 task 를 못 쓴다', () => {
    for (const permission of ['litecode_send_to_project', 'litecode_read_project', 'litecode_present', 'litecode_create', 'task']) {
      expect(child(permission, ['general']), permission).toMatchObject({ build: 'deny', ask: 'deny', full: 'deny' })
    }
  })
})

// 표가 엔진 설정과 어긋나지 않게 — 에이전트 정의에 문자열로 적힌 규칙(패턴별 규칙·와일드카드 제외)은 이 함수와 같아야 한다
describe('modePermission — 엔진 설정(engine.ts)과 대조', () => {
  const config = engineConfig([], { token: 'T', baseURLFor: () => '' }, { webTools: true, skills: { enabled: true, claude: false } })
  const agents = config.agent as Record<string, { permission: Record<string, unknown> }>

  it('모드 에이전트에 이름으로 적은 규칙은 판정 표와 같다', () => {
    for (const mode of MODES) {
      for (const [name, rule] of Object.entries(agents[MODE_AGENT[mode]]!.permission)) {
        if (typeof rule !== 'string' || name.includes('*') || name === 'question' || name === 'plan_enter' || name === 'plan_exit') continue
        expect(modePermission(mode, name), `${mode} ${name}`).toBe(rule)
      }
    }
  })

  it('묻는 하위 에이전트에 이름으로 적은 규칙은 매번 묻기의 하위 작업 판정과 같다', () => {
    for (const [name, rule] of Object.entries(agents[SUBAGENT_ASK]!.permission)) {
      if (typeof rule !== 'string' || name.includes('*') || name === 'todowrite' || name === 'plan_enter' || name === 'plan_exit') continue
      expect(modePermission('ask', name, { child: true }), name).toBe(rule)
    }
  })
})
