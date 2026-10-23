import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { translate, type MessageKey } from '../../shared/i18n/index.ts'
import type { Subtask } from '../../shared/contract.ts'

// 대화 머리의 작업 트리거 (이슈 #610, dsh ui-jobs 모양 — #32 머리 버튼·#295 입력 카드 위 줄을 대신한다).
// 도는 것(턴 하위 작업 + 백그라운드 작업)이 있으면 "작업 N 진행 중"(스피너), 다 끝나면 "끝난 작업 N"(체크).
// 메뉴 열기·펼침은 상태(useState)라 정적 그림에선 트리거만 보인다

vi.mock('../../renderer/settingsStore.ts', () => ({ useT: () => (key: MessageKey, vars?: Record<string, string | number>) => translate('ko', key, vars) }))
const { JobsHeader } = await import('../../renderer/Jobs.tsx')

const task = (patch: Partial<Subtask> = {}): Subtask => ({ kind: 'subtask', id: 'bgtask:c1:1', agent: 'explore', description: '#1 파일 조사', status: 'running', startedAt: Date.now() - 5_000, items: [], ...patch })

describe('JobsHeader — 대화 머리 트리거 (#610)', () => {
  it('턴이 안 돌아도 도는 작업이 있으면 "작업 N 진행 중" (메인을 세지 않는다, 스피너·닫힌 트리거)', () => {
    const html = renderToStaticMarkup(createElement(JobsHeader, { items: undefined, pending: false, background: [task()] }))
    expect(html).toContain(translate('ko', 'jobs.triggerLive', { count: 1 }))
    expect(html).toContain('jobs__spinner')
    expect(html).toContain('aria-expanded="false"')
  })

  it('턴의 하위 작업 + 백그라운드까지 모두 센다 — "메인" 줄도 포함이면 3', () => {
    const inTurn: Subtask = { ...task({ id: 'prt_1', agent: 'general', description: 'turn job' }) }
    const html = renderToStaticMarkup(createElement(JobsHeader, { items: [inTurn], pending: true, startedAt: Date.now(), background: [task()] }))
    expect(html).toContain(translate('ko', 'jobs.triggerLive', { count: 3 }))
  })

  it('다 끝났으면 "끝난 작업 N"(체크, 스피너 없음). 아무것도 없으면 그리지 않는다', () => {
    const html = renderToStaticMarkup(createElement(JobsHeader, { items: undefined, pending: false, background: [task({ status: 'done', endedAt: Date.now() })] }))
    expect(html).toContain(translate('ko', 'jobs.finished', { count: 1 }))
    expect(html).toContain('jobs-trigger__done')
    expect(html).not.toContain('jobs__spinner')
    expect(renderToStaticMarkup(createElement(JobsHeader, { items: undefined, pending: false, background: [] }))).toBe('')
  })
})
