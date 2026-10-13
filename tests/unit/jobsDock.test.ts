import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { translate, type MessageKey } from '../../shared/i18n/index.ts'
import type { Subtask } from '../../shared/contract.ts'

// 작업 줄(JobsDock)에 백그라운드 하위 작업(이슈 #319)을 더한다 — 메인 턴이 끝난 뒤에도 돈다. 메인은 기다리지 않으므로 "메인" 줄·그 수가 없다.
// 접힌 줄의 경과는 그 작업의 시작부터. 펼친 목록은 상태(useState)라 정적 그림에선 접힌 줄만 본다

vi.mock('../../renderer/settingsStore.ts', () => ({ useT: () => (key: MessageKey, vars?: Record<string, string | number>) => translate('ko', key, vars) }))
const { JobsDock } = await import('../../renderer/Jobs.tsx')

const task = (patch: Partial<Subtask> = {}): Subtask => ({ kind: 'subtask', id: 'bgtask:c1:1', agent: 'explore', description: '#1 파일 조사', status: 'running', startedAt: Date.now() - 5_000, items: [], ...patch })

describe('JobsDock — 백그라운드 하위 작업 (#319)', () => {
  it('턴이 안 돌아도 도는 작업이 있으면 접힌 줄을 그린다 — 수는 작업만(메인을 세지 않는다), 대표 작업의 종류·설명, 경과는 그 작업의 시작부터', () => {
    const html = renderToStaticMarkup(createElement(JobsDock, { items: undefined, pending: false, background: [task()] }))
    expect(html).toContain(translate('ko', 'jobs.button', { count: 1 }))
    expect(html).toContain('explore · #1 파일 조사')
    expect(html).toMatch(/jobs-dock__time">[45]s</)
  })

  it('턴의 하위 작업과 함께면 메인 + 둘 다 센다', () => {
    const inTurn: Subtask = { ...task({ id: 'prt_1', agent: 'general', description: 'turn job' }) }
    const html = renderToStaticMarkup(createElement(JobsDock, { items: [inTurn], pending: true, startedAt: Date.now(), background: [task()] }))
    expect(html).toContain(translate('ko', 'jobs.button', { count: 3 }))
  })

  it('다 끝났으면 "끝난 작업 N", 작업이 없으면 그리지 않는다', () => {
    expect(renderToStaticMarkup(createElement(JobsDock, { items: undefined, pending: false, background: [task({ status: 'done', endedAt: Date.now() })] }))).toContain(
      translate('ko', 'jobs.finished', { count: 1 }),
    )
    expect(renderToStaticMarkup(createElement(JobsDock, { items: undefined, pending: false, background: [] }))).toBe('')
  })
})
