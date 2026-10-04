import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { PresentedFile, TurnItem } from '../../shared/contract.ts'
import { AssistantTurn } from '../../renderer/ChatTurn.tsx'
import { isPresentTool, presentedFiles } from '../../renderer/presented.ts'
import { translate } from '../../shared/i18n/index.ts'

// 화면 설정 저장소는 메인에서 값을 받아야 해서 여기선 한국어 사전으로 바로 번역한다
vi.mock('../../renderer/settingsStore.ts', () => ({ useT: () => (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('ko', key, vars) }))

// 턴 끝 "결과물" 카드 (이슈 #91) — AI 가 앱 MCP 의 present 로 선언한 파일. 데이터는 성공한 선언 줄의 presented 를 턴 단위로 모은 것

const mcp = { server: 'litecode', tool: 'present' }
const present = (id: string, presented?: PresentedFile[], status: 'done' | 'error' | 'running' = 'done'): TurnItem => ({ kind: 'tool', id, name: 'litecode_present', status, mcp, ...(presented && { presented }) })
const text = (id: string): TurnItem => ({ kind: 'text', id, text: '끝', done: true })

describe('presentedFiles — 턴의 줄에서 결과물 모으기', () => {
  it('선언이 없으면 undefined', () => {
    expect(presentedFiles([text('t'), { kind: 'tool', id: 'a', name: 'bash', status: 'done' }, present('p', undefined, 'error')])).toBeUndefined()
    expect(presentedFiles([present('p', [])])).toBeUndefined()
  })

  it('여러 번 선언한 것을 처음 나온 순서로 잇는다', () => {
    expect(presentedFiles([present('1', [{ path: 'a.md' }, { path: 'src/b.ts', title: 'B' }]), text('t'), present('2', [{ path: 'c.html' }])])).toEqual([
      { path: 'a.md' },
      { path: 'src/b.ts', title: 'B' },
      { path: 'c.html' },
    ])
  })

  it('같은 파일을 여러 번 선언하면 한 줄 — 자리는 처음, 제목은 마지막에 준 것(안 주면 앞의 것 그대로)', () => {
    expect(presentedFiles([present('1', [{ path: 'a.md', title: '초안' }, { path: 'b.md', title: 'B' }, { path: 'a.md' }]), present('2', [{ path: 'a.md', title: '최종' }, { path: 'b.md' }])])).toEqual([
      { path: 'a.md', title: '최종' },
      { path: 'b.md', title: 'B' },
    ])
  })

  it('하위 작업 안의 선언은 세지 않는다 — 결과물은 메인 대화가 선언한다', () => {
    const subtask: TurnItem = { kind: 'subtask', id: 's', agent: 'general', description: 'd', status: 'done', items: [present('c', [{ path: 'child.md' }])] }
    expect(presentedFiles([subtask])).toBeUndefined()
  })
})

describe('isPresentTool — 결과물 선언 줄인가', () => {
  it('앱 MCP 서버의 present 만 (도는 중·실패도), 다른 서버의 present 는 아니다', () => {
    expect(isPresentTool(present('p', undefined, 'running'))).toBe(true)
    expect(isPresentTool({ kind: 'tool', id: 'x', name: 'other_present', status: 'done', mcp: { server: 'other', tool: 'present' } })).toBe(false)
    expect(isPresentTool({ kind: 'tool', id: 'x', name: 'litecode_open_file', status: 'done', mcp: { server: 'litecode', tool: 'open_file' } })).toBe(false)
    expect(isPresentTool(text('t'))).toBe(false)
  })
})

describe('AssistantTurn 의 결과물 카드', () => {
  const render = (items: TurnItem[], props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(AssistantTurn, { items, text: '끝', directory: '/p', ...props }))
  const items = [present('1', [{ path: 'docs/report.md', title: '분석 보고서' }, { path: 'out/index.html' }]), text('t')]

  it('끝난 턴 — 머리에 개수, 제목이 있으면 제목 + 흐린 경로, 없으면 이름 + 흐린 폴더', () => {
    const out = render(items)
    expect(out).toContain('class="presented"')
    expect(out).toContain('결과물 2')
    expect(out).toContain('<span class="presented__name">분석 보고서</span><span class="presented__path">docs/report.md</span>')
    expect(out).toContain('<span class="presented__name">index.html</span><span class="presented__path">out</span>')
  })

  it('도는 중엔 카드가 없다, 실패·중단으로 끝난 턴에도 선언한 것은 보인다', () => {
    expect(render(items, { running: true })).not.toContain('class="presented"')
    expect(render(items, { failed: true })).toContain('class="presented"')
    expect(render(items, { interrupted: true })).toContain('class="presented"')
  })

  it('고친 파일 카드가 같이 있으면 결과물 카드가 위다', () => {
    const edit: TurnItem = { kind: 'tool', id: 'e', name: 'edit', status: 'done', diffs: [{ path: 'a.ts', status: 'modified', added: 1, removed: 0, patch: '@@\n' }] }
    const out = render([edit, ...items])
    expect(out.indexOf('class="presented"')).toBeGreaterThan(out.indexOf('bubble--assistant'))
    expect(out.indexOf('class="changed-files"')).toBeGreaterThan(out.indexOf('class="presented"'))
  })

  it('선언 줄은 "MCP · litecode · present" 대신 "결과물 · 파일 N"', () => {
    const out = render(items, { failed: true }) // 실패한 턴은 작업 줄이 펼쳐져 있다
    expect(out).not.toContain('MCP · litecode · present')
    expect(out).toContain('<span class="turn-row__title">결과물</span>')
    expect(out).toContain('<span class="turn-row__summary">파일 2</span>')
    // 거절된 선언도 같은 이름이다 (개수는 없다)
    const rejected = render([present('1', undefined, 'error'), text('t')], { failed: true })
    expect(rejected).toContain('<span class="turn-row__title">결과물</span>')
    expect(rejected).not.toContain('MCP · litecode · present')
  })
})
