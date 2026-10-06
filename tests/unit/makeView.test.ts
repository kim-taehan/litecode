import { describe, expect, it, vi } from 'vitest'
import { translate } from '../../shared/i18n/index.ts'
import { makeCard, PREVIEW_LINES } from '../../renderer/makeView.ts'

vi.mock('../../renderer/settingsStore.ts', () => ({ useT: () => (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('ko', key, vars) }))

import { CREATE_TOOL, SECRET_MASK } from '../../shared/make.ts'
import type { Attention } from '../../shared/contract.ts'

// 만들기 도구의 승인 카드 내용 (이슈 #145, 시안 _workspace/mock-make) — 승인 요청(도구 인자 JSON) → 카드가 그릴 것. 순수 함수

type Permission = Extract<Attention, { kind: 'permission' }>

const request = (tool: string, input: unknown, server = 'litecode'): Permission => ({
  kind: 'permission',
  id: 'per_1',
  sessionId: 'ses_1',
  action: `${server}_${tool}`,
  resources: ['*'],
  mcp: { server, tool },
  ...(input !== undefined && { input: JSON.stringify(input) }),
})

describe('makeCard', () => {
  it('스킬: 이름·설명·본문 처음 몇 줄(+ 남은 줄 수)·저장할 자리, AI 가 준 scope 가 먼저 선택', () => {
    const body = ['1. typecheck', '2. test', '3. diff', '4. summary', '5. done'].join('\n')
    expect(makeCard(request(CREATE_TOOL, { kind: 'skill', name: 'pr-check', description: 'Check before a PR.', body, scope: 'all' }))).toEqual({
      kind: 'skill',
      scope: 'all',
      name: 'pr-check',
      description: 'Check before a PR.',
      body,
      preview: '1. typecheck\n2. test\n3. diff',
      more: 5 - PREVIEW_LINES,
      file: '.opencode/skills/pr-check/SKILL.md',
    })
    expect(makeCard(request(CREATE_TOOL, { kind: 'skill', name: 'x', description: 'd', body: 'one' }))).toMatchObject({ scope: 'project', preview: 'one', more: 0 })
  })

  it('MCP 원격: 주소와 헤더 — 가려진 값은 비밀 표시, 비밀이 있으면 프로젝트 파일이 아니라 앱에 둔다', () => {
    const card = makeCard(request(CREATE_TOOL, { kind: 'mcp_server', name: 'wiki', type: 'remote', url: 'http://wiki.internal/mcp', headers: { Authorization: SECRET_MASK } }))
    expect(card).toEqual({
      kind: 'mcp',
      scope: 'project',
      name: 'wiki',
      type: 'remote',
      target: 'http://wiki.internal/mcp',
      vars: [{ name: 'Authorization', secret: true }],
      inApp: true,
    })
  })

  it('MCP 로컬: 명령 줄과 env — 비밀이 아닌 값은 보이고, 비밀이 없으면 .mcp.json 에 쓴다', () => {
    const card = makeCard(request(CREATE_TOOL, { kind: 'mcp_server', name: 'files', type: 'local', command: ['npx', '-y', 'files-mcp'], env: { ROOT: '/data' }, scope: 'all' }))
    expect(card).toEqual({ kind: 'mcp', scope: 'all', name: 'files', type: 'local', target: 'npx -y files-mcp', vars: [{ name: 'ROOT', value: '/data', secret: false }], inApp: false })
  })

  it('훅: 이벤트·매처(도구 이벤트만)·명령', () => {
    expect(makeCard(request(CREATE_TOOL, { kind: 'hook', event: 'PostToolUse', matcher: 'edit|write', hook_command: 'npm run format' }))).toEqual({
      kind: 'hook',
      scope: 'project',
      event: 'PostToolUse',
      matcher: 'edit|write',
      command: 'npm run format',
    })
    expect(makeCard(request(CREATE_TOOL, { kind: 'hook', event: 'Stop', matcher: 'bash', hook_command: 'say done', scope: 'all' }))).toEqual({ kind: 'hook', scope: 'all', event: 'Stop', matcher: '', command: 'say done' })
  })

  it('다른 서버·다른 도구·인자를 못 이었거나 못 읽는 요청은 undefined — 보통의 승인 카드로 그린다 (그 허용은 도구가 받지 않는다)', () => {
    expect(makeCard(request(CREATE_TOOL, { kind: 'skill', name: 'x', description: 'd', body: 'b' }, 'github'))).toBeUndefined()
    expect(makeCard(request('send_to_project', { project: 'p-1', message: 'hi' }))).toBeUndefined()
    expect(makeCard(request(CREATE_TOOL, undefined))).toBeUndefined()
    expect(makeCard(request(CREATE_TOOL, { kind: 'skill', name: 'Bad Name', description: 'd', body: 'b' }))).toBeUndefined()
    expect(makeCard({ kind: 'permission', id: 'p', sessionId: 's', action: 'bash', resources: ['ls'] })).toBeUndefined()
    // kind 가 없거나 틀렸다·옛 도구 이름(별칭 없음)
    expect(makeCard(request(CREATE_TOOL, { name: 'x', description: 'd', body: 'b' }))).toBeUndefined()
    expect(makeCard(request(CREATE_TOOL, { kind: 'agent', name: 'x', description: 'd', body: 'b' }))).toBeUndefined()
    expect(makeCard(request('create_skill', { name: 'x', description: 'd', body: 'b' }))).toBeUndefined()
    expect(makeCard(request('add_hook', { event: 'Stop', command: 'say done' }))).toBeUndefined()
  })
})

// 카드를 한 번 그려 본다 (정적 마크업) — 틀은 보통의 승인 카드, 내용·라디오·버튼 글이 종류마다 맞는지. 눌러 보는 것은 단위로 하지 않는다
describe('승인 카드 그리기 (AttentionCard)', async () => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { AttentionCard } = await import('../../renderer/Attention.tsx')
  const render = (input: unknown): string => renderToStaticMarkup(createElement(AttentionCard, { request: request(CREATE_TOOL, input), onAnswer: async () => {} }))

  it('스킬: 이름·설명·본문 미리보기 + "본문 전체 보기", 라디오 둘(AI 가 준 곳이 선택), 버튼 "스킬 만들기"', () => {
    const html = render({ kind: 'skill', name: 'pr-check', description: 'PR 전 점검', body: 'a\nb\nc\nd\ne' })
    expect(html).toContain('data-make="skill"')
    expect(html).toContain('pr-check')
    expect(html).toContain('… 2줄 더')
    expect(html).toContain('본문 전체 보기')
    expect(html).toMatch(/aria-checked="true" data-scope="project"/)
    expect(html).toMatch(/aria-checked="false" data-scope="all"/)
    expect(html).toContain('.opencode/skills/pr-check/SKILL.md')
    expect(html).toContain('>스킬 만들기</button>')
    expect(html).not.toContain('한 번 허용')
  })

  it('MCP: 비밀 값은 가려져 보이고, 로컬이면 "이 PC 에서 실행" 경고가 붙는다', () => {
    const remote = render({ kind: 'mcp_server', name: 'wiki', type: 'remote', url: 'http://wiki.internal/mcp', headers: { Authorization: SECRET_MASK }, scope: 'all' })
    expect(remote).toContain(`${SECRET_MASK} (비밀로 저장)`)
    expect(remote).toMatch(/aria-checked="true" data-scope="all"/)
    expect(remote).toContain('다음 턴부터')
    expect(remote).not.toContain('이 명령이 이 PC 에서 실행됩니다')
    expect(remote).toContain('>서버 추가</button>')
    const local = render({ kind: 'mcp_server', name: 'files', type: 'local', command: ['npx', 'files-mcp'] })
    expect(local).toContain('npx files-mcp')
    expect(local).toContain('이 명령이 이 PC 에서 실행됩니다')
    expect(local).toContain('.mcp.json')
  })

  it('훅: 사람 말 + 원래 이름, 매처, 명령, 경고 상자, 버튼 "훅 추가"', () => {
    const html = render({ kind: 'hook', event: 'PostToolUse', matcher: 'edit|write', hook_command: 'npm run format' })
    expect(html).toContain('도구 실행 후')
    expect(html).toContain('(PostToolUse)')
    expect(html).toContain('edit|write')
    expect(html).toContain('npm run format')
    expect(html).toContain('묻지 않고 이 PC 에서 실행됩니다')
    expect(html).toContain('>훅 추가</button>')
  })
})
