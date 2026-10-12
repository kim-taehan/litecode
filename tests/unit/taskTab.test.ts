import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { translate, type MessageKey } from '../../shared/i18n/index.ts'
import { addTaskItem, capTaskItem, TASK_ITEM_TEXT_MAX, TASK_ITEMS_MAX, TASK_TOOL_TEXT_MAX } from '../../shared/tasks.ts'
import type { Subtask, TurnItem } from '../../shared/contract.ts'
import { closeTab, getPanelState, isTaskTab, openFilePreview, openTaskTab, taskIdOf, taskTabKey } from '../../renderer/filePreviewStore.ts'
import { fold, FOLD_LINES, prettyInput, RESULT_HEAD_LINES, taskTitle, transcript } from '../../renderer/taskTabView.ts'
import { peekLine } from '../../renderer/jobsView.ts'
import { BackgroundTasks, type TaskHost } from '../../src/services/backgroundTasks.ts'
import type { ChatOptions, ChatResult } from '../../src/services/llm.ts'
import { setMainLanguage } from '../../src/i18n.ts'

// 작업 탭 (이슈 #325) — 백그라운드 작업의 전체 기록을 오른쪽 패널 탭으로. 탭 열기·중복 방지, 전문 → 블록 변환, 메인 쪽 상한, 탭 그림

let taskMap: Record<string, Subtask[]> = {}
vi.mock('../../renderer/settingsStore.ts', () => ({ useT: () => (key: MessageKey, vars?: Record<string, string | number>) => translate('ko', key, vars) }))
vi.mock('../../renderer/tasksStore.ts', async (original) => ({ ...(await original<object>()), useTaskMap: () => taskMap }))
const { TaskTab } = await import('../../renderer/TaskTab.tsx')

const task = (patch: Partial<Subtask> = {}): Subtask => ({
  kind: 'subtask',
  id: 'bgtask:c1:2',
  agent: 'explore',
  description: '#2 VSCode 조사',
  status: 'running',
  startedAt: Date.now() - 5_000,
  items: [],
  ...patch,
})

describe('작업 탭 열기', () => {
  it('열쇠는 \\0task/<작업 id>, 같은 작업은 한 탭 — 다시 열면 그 탭을 고른다. 닫을 수 있다', () => {
    expect(taskIdOf(taskTabKey('bgtask:c1:2'))).toBe('bgtask:c1:2')
    expect(isTaskTab('src/a.ts')).toBe(false)
    openTaskTab('/p', 'bgtask:c1:1')
    openFilePreview('/p', 'a.ts')
    openTaskTab('/p', 'bgtask:c1:1')
    expect(getPanelState()).toMatchObject({ open: true, tabs: [taskTabKey('bgtask:c1:1'), 'a.ts'], active: taskTabKey('bgtask:c1:1') })
    closeTab(taskTabKey('bgtask:c1:1'))
    expect(getPanelState()?.tabs).toEqual(['a.ts'])
  })

  it('다른 프로젝트면 터미널 탭처럼 새로 시작한다', () => {
    openTaskTab('/p', 'bgtask:c1:1')
    openTaskTab('/q', 'bgtask:c2:1')
    expect(getPanelState()).toMatchObject({ directory: '/q', tabs: [taskTabKey('bgtask:c2:1')] })
  })
})

describe('전문 표시 변환', () => {
  it('생각·응답·도구만, 순서대로. 도구는 입력을 들여쓰고 결과 앞부분·줄 수를 준다', () => {
    const result = Array.from({ length: 10 }, (_, at) => `line ${at}`).join('\n')
    const items: TurnItem[] = [
      { kind: 'think', id: 't1', text: '  먼저 진입점을 본다  ', done: true },
      { kind: 'tool', id: 'g1', name: 'glob', status: 'done', summary: 'src/**/*.ts', input: '{"pattern":"src/**/*.ts"}', result },
      { kind: 'retry', id: 'r1', attempt: 1, message: 'x', status: 'done' },
      { kind: 'text', id: 'x1', text: '요약입니다', done: true },
      { kind: 'text', id: 'x2', text: '   ', done: true },
    ]
    const blocks = transcript(items)
    expect(blocks.map((block) => block.kind)).toEqual(['think', 'tool', 'text'])
    expect(blocks[0]).toEqual({ kind: 'think', id: 't1', text: '먼저 진입점을 본다' })
    expect(blocks[1]).toMatchObject({ name: 'glob', summary: 'src/**/*.ts', input: '{\n  "pattern": "src/**/*.ts"\n}', lines: 10, more: true })
    expect((blocks[1] as { head: string }).head.split('\n')).toHaveLength(RESULT_HEAD_LINES)
  })

  it('MCP 도구는 서버/도구, 입력 없고 결과가 짧으면 "전체 보기" 없음. JSON 이 아닌 입력은 그대로', () => {
    const [block] = transcript([{ kind: 'tool', id: 'm', name: 'x_y', status: 'error', mcp: { server: 'x', tool: 'y' }, result: 'ok\n', error: 'boom' }])
    expect(block).toMatchObject({ name: 'x/y', lines: 1, more: false, error: 'boom' })
    expect(prettyInput('{"cut')).toBe('{"cut')
  })

  it('긴 글은 앞부분만 접어 보인다', () => {
    expect(fold('짧다').preview).toBeUndefined()
    const many = Array.from({ length: FOLD_LINES + 3 }, (_, at) => `l${at}`).join('\n')
    expect(fold(many).preview).toBe(`${many.split('\n').slice(0, FOLD_LINES).join('\n')}…`)
    expect(fold('a'.repeat(5_000)).preview!.length).toBeLessThan(700)
  })

  it('탭 이름의 번호·설명 — "#N " 을 뗀다, 작업이 없어도 번호는 id 에서', () => {
    expect(taskTitle('bgtask:c1:2', task())).toEqual({ number: '2', description: 'VSCode 조사' })
    expect(taskTitle('bgtask:c1:7', undefined)).toEqual({ number: '7', description: '' })
  })

  it('훑어보기 한 줄 — 실패 사유가 먼저, 아니면 마지막 활동(응답 글이면 첫 줄)', () => {
    expect(peekLine(task({ status: 'error', error: 'gateway down' }))).toMatchObject({ text: 'gateway down', state: 'error' })
    expect(peekLine(task({ items: [{ kind: 'tool', id: 'a', name: 'read', summary: 'a.ts', status: 'done' }, { kind: 'text', id: 'b', text: '\n결과 요약\n둘째 줄', done: false }] }))).toMatchObject({ text: '결과 요약' })
    expect(peekLine(task())).toBeUndefined()
  })
})

describe('메인 쪽 상한', () => {
  it('생각·글은 TASK_ITEM_TEXT_MAX, 도구 입력·결과·오류는 TASK_TOOL_TEXT_MAX, diff 는 뺀다', () => {
    const think = capTaskItem({ kind: 'think', id: 't', text: 'a'.repeat(TASK_ITEM_TEXT_MAX + 10), done: false }) as { text: string }
    expect(think.text.startsWith('a'.repeat(TASK_ITEM_TEXT_MAX))).toBe(true)
    expect(think.text).toContain('[truncated 10 chars]')
    const tool = capTaskItem({ kind: 'tool', id: 'w', name: 'write', status: 'done', input: 'i'.repeat(TASK_TOOL_TEXT_MAX + 1), result: 'short', diffs: [{ path: 'a', status: 'added', added: 1, removed: 0, patch: 'x' }] })
    expect(tool).not.toHaveProperty('diffs')
    expect((tool as { input: string }).input).toContain('[truncated 1 chars]')
    expect((tool as { result: string }).result).toBe('short')
  })

  it('진행 줄은 TASK_ITEMS_MAX 개까지 — 넘으면 앞에서 버리고 수를 센다. 같은 id 는 바꾼다', () => {
    let state = { items: [] as TurnItem[], omitted: 0 }
    for (let at = 0; at < TASK_ITEMS_MAX + 5; at++) state = addTaskItem(state.items, state.omitted, { kind: 'text', id: `x${at}`, text: 't', done: true })
    expect(state.items).toHaveLength(TASK_ITEMS_MAX)
    expect(state.omitted).toBe(5)
    expect(state.items[0]!.id).toBe('x5')
    state = addTaskItem(state.items, state.omitted, { kind: 'text', id: 'x5', text: 'changed', done: true })
    expect(state.items).toHaveLength(TASK_ITEMS_MAX)
    expect(state.items[0]).toMatchObject({ text: 'changed' })
  })
})

describe('BackgroundTasks — 작업 줄에 전문·지시문·마지막 활동', () => {
  let runs: ChatOptions[]
  beforeEach(() => {
    setMainLanguage('ko')
    runs = []
    vi.useFakeTimers({ now: 1_000_000 })
  })
  afterEach(() => void vi.useRealTimers())

  it('지시문을 싣고, 진행 줄은 상한을 건 전문으로, 활동이 오면 lastActivityAt 이 오른다', async () => {
    const host: TaskHost = {
      run: (options) => new Promise<ChatResult>(() => void runs.push(options)),
      reject: async () => {},
      report: async () => {},
      changed: () => {},
      limit: () => 2,
    }
    const tasks = new BackgroundTasks(host)
    tasks.start({ id: 'c1', project: '/p', title: 't', updatedAt: 0, engineSessionId: 's', model: { providerId: 'gw', modelId: 'm' }, mode: 'build' }, { agent: 'explore', description: 'd', prompt: '조사해' })
    await vi.advanceTimersByTimeAsync(0)
    expect(tasks.list('c1')[0]).toMatchObject({ prompt: '조사해', lastActivityAt: 1_000_000 })
    vi.setSystemTime(1_005_000)
    runs[0]!.onProgress!({ kind: 'tool', id: 'r', name: 'read', status: 'done', result: 'r'.repeat(TASK_TOOL_TEXT_MAX + 3) })
    const view = tasks.list('c1')[0]!
    expect(view.lastActivityAt).toBe(1_005_000)
    expect((view.items[0] as { result: string }).result).toContain('[truncated 3 chars]')
  })
})

describe('TaskTab 그림', () => {
  it('머리(#번호 설명·종류·중지)·지시·생각·도구·응답·작업 중', () => {
    taskMap = {
      c1: [
        task({
          prompt: '아키텍처를 조사해',
          lastActivityAt: Date.now() - 4_000,
          items: [
            { kind: 'think', id: 't', text: '진입점을 본다', done: true },
            { kind: 'tool', id: 'g', name: 'glob', status: 'done', summary: 'src/**/*.ts', result: 'a.ts\nb.ts' },
            { kind: 'text', id: 'x', text: '요약 **끝**', done: true },
          ],
        }),
      ],
    }
    const html = renderToStaticMarkup(createElement(TaskTab, { taskId: 'bgtask:c1:2', directory: '/p' }))
    expect(html).toContain('#2 VSCode 조사')
    expect(html).toContain('explore')
    expect(html).toContain(translate('ko', 'jobs.stopShort'))
    expect(html).toContain('아키텍처를 조사해')
    expect(html).toContain('진입점을 본다')
    expect(html).toContain('glob')
    expect(html).toContain('a.ts\nb.ts')
    expect(html).toContain('<strong>끝</strong>')
    expect(html).toContain(translate('ko', 'taskTab.lastActivity', { time: '4s' }))
  })

  it('끝난 작업은 중지 없이 상태·실패 사유, 기록이 없으면 안내', () => {
    taskMap = { c1: [task({ status: 'error', endedAt: Date.now(), error: 'gateway down' })] }
    const html = renderToStaticMarkup(createElement(TaskTab, { taskId: 'bgtask:c1:2', directory: '/p' }))
    expect(html).not.toContain(translate('ko', 'jobs.stopShort'))
    expect(html).toContain(translate('ko', 'chat.subtaskFailed'))
    expect(html).toContain('gateway down')
    taskMap = {}
    expect(renderToStaticMarkup(createElement(TaskTab, { taskId: 'bgtask:c1:9', directory: '/p' }))).toContain(translate('ko', 'taskTab.gone'))
  })
})
