import { useSyncExternalStore } from 'react'

// 오른쪽 패널(파일 미리보기) 상태 — 대화(conversation)마다 독립적, Git 탭만 프로젝트(directory)마다 (이슈 #579).
// 파일·터미널·턴·확장 탭은 각 대화에 속한다: 같은 프로젝트의 다른 대화에서 각각의 탭 묶음을 가진다.
// Git 탭은 대화와 무관: 한 프로젝트에 하나, 그 프로젝트의 모든 대화에서 보인다.
// 칩(Markdown.tsx)·대화 머리 버튼·Files 탭이 열고, 패널(FilePreview.tsx)이 그린다. 서로 멀리
// 떨어져 있어(칩은 답 깊숙이, 패널은 앱 틀 오른쪽) props 로 잇지 않고 작은 저장소 하나로 잇는다.

export interface PanelState {
  directory: string
  conversationId?: string
  /** 보이는가 — 닫아도 탭은 남는다 */
  open: boolean
  /** 연 파일들 (프로젝트 기준 정규화 경로) — 같은 파일은 한 탭 */
  tabs: string[]
  /** 고른 파일 탭. undefined 면 Files 탭, GIT_TAB 이면 Git 탭 */
  active?: string
  /** 패널이 창을 채운다 */
  fullscreen: boolean
  /** 열 때마다 오른다 — 같은 칩을 다시 눌러도 패널이 포커스를 잡는다(Esc 로 닫히게) */
  focus: number
  /** 마지막으로 연 것이 AI 다(open(파일)) — 패널이 포커스를 잡지 않는다*/
  quiet?: boolean
  /** 줄 이동 (이슈 #51): 그 탭을 그 줄로 스크롤하고 강조한다 */
  jump?: { key: string; line: number; seq: number }
  /** 비교 보기 (이슈 #424) — 파일 탭 두 개를 위아래 50/50 */
  compare?: { a: string; b: string }
}

export interface GitSub {
  sub: 'changes' | 'log'
  seq: number
}

// ── 저장소 상태 ─────────────────────────────────────────────────────────────

const panels = new Map<string, PanelState>()
const gitSubs = new Map<string, GitSub>()

let jumps = 0
let version = 0

const listeners = new Set<() => void>()
let filesSearchListeners = new Set<() => void>()

function bump(): void {
  version++
  for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

function panelKey(directory: string, conversationId?: string): string {
  return `${directory}\u0000${conversationId ?? ''}`
}

function base(directory: string, conversationId?: string): PanelState {
  return { directory, conversationId, open: false, tabs: [], fullscreen: false, focus: 0 }
}

function getOrCreate(directory: string, conversationId?: string): PanelState {
  const key = panelKey(directory, conversationId)
  let state = panels.get(key)
  if (!state) {
    state = base(directory, conversationId)
    panels.set(key, state)
  }
  return state
}

// ── 탭 열쇠 (불변 — 대화와 무관) ────────────────────────────────────────────

export const GIT_TAB = '\0git'
export const TERM_PREFIX = '\0term/'
export const TASK_PREFIX = '\0task/'
export const TURN_PREFIX = '\0turn/'
export const EXT_PREFIX = '\0ext/'

export function terminalTabKey(id: number): string {
  return TERM_PREFIX + id
}
export function terminalIdOf(key: string): number | undefined {
  if (!key.startsWith(TERM_PREFIX)) return undefined
  const id = Number(key.slice(TERM_PREFIX.length))
  return Number.isInteger(id) && id > 0 ? id : undefined
}
export function isTerminalTab(key: string | undefined): key is string {
  return !!key && terminalIdOf(key) !== undefined
}

export function taskTabKey(taskId: string): string {
  return TASK_PREFIX + taskId
}
export function taskIdOf(key: string | undefined): string | undefined {
  return key?.startsWith(TASK_PREFIX) && key.length > TASK_PREFIX.length ? key.slice(TASK_PREFIX.length) : undefined
}
export function isTaskTab(key: string | undefined): key is string {
  return taskIdOf(key) !== undefined
}

export function turnTabKey(conversationId: string, startedAt: number): string {
  return `${TURN_PREFIX}${conversationId}:${startedAt}`
}
export function turnRefOf(key: string | undefined): { conversationId: string; startedAt: number } | undefined {
  if (!key?.startsWith(TURN_PREFIX)) return undefined
  const rest = key.slice(TURN_PREFIX.length)
  const at = rest.lastIndexOf(':')
  if (at <= 0) return undefined
  const startedAt = Number(rest.slice(at + 1))
  const conversationId = rest.slice(0, at)
  return Number.isInteger(startedAt) && startedAt > 0 ? { conversationId, startedAt } : undefined
}
export function isTurnTab(key: string | undefined): key is string {
  return turnRefOf(key) !== undefined
}

export function extensionTabKey(id: string): string {
  return EXT_PREFIX + id
}
export function extensionIdOf(key: string | undefined): string | undefined {
  return key?.startsWith(EXT_PREFIX) && key.length > EXT_PREFIX.length ? key.slice(EXT_PREFIX.length) : undefined
}
export function isExtensionTab(key: string | undefined): key is string {
  return extensionIdOf(key) !== undefined
}

export function extensionFrameKey(id: string, version: string | undefined): string {
  return `${id}@${version ?? ''}`
}

export function isFileTab(key: string): boolean {
  return key !== GIT_TAB && !isTerminalTab(key) && !isTaskTab(key) && !isTurnTab(key) && !isExtensionTab(key)
}

export function compareCandidates(tabs: readonly string[], current: string | undefined): string[] {
  return tabs.filter((key) => key !== current && isFileTab(key))
}

// ── 대화 단위 함수 ──────────────────────────────────────────────────────────

export function openFilePreview(directory: string, token: string, line?: number, { quiet = false }: { quiet?: boolean } = {}, conversationId?: string): void {
  const state = getOrCreate(directory, conversationId)
  const key = tabKey(directory, token)
  const focus = quiet ? state.focus : state.focus + 1
  const jump = line !== undefined ? { key, line, seq: ++jumps } : state.jump?.key === key ? undefined : state.jump
  const compare = state.compare && key !== state.compare.a ? undefined : state.compare
  state.open = true
  state.tabs = state.tabs.includes(key) ? state.tabs : [...state.tabs, key]
  state.active = key
  state.focus = focus
  state.quiet = quiet
  state.jump = jump ?? state.jump
  state.compare = compare
  bump()
}

export function openFilesTab(directory: string, conversationId?: string): void {
  const state = getOrCreate(directory, conversationId)
  state.open = true
  state.active = undefined
  state.focus++
  state.quiet = false
  bump()
}

export function openTerminalTab(directory: string, id: number, { quiet = false }: { quiet?: boolean } = {}, conversationId?: string): void {
  const state = getOrCreate(directory, conversationId)
  const key = terminalTabKey(id)
  state.open = true
  state.tabs = state.tabs.includes(key) ? state.tabs : [...state.tabs, key]
  state.active = key
  state.focus = quiet ? state.focus : state.focus + 1
  state.quiet = quiet
  bump()
}

export function openTaskTab(directory: string, taskId: string, conversationId?: string): void {
  const state = getOrCreate(directory, conversationId)
  const key = taskTabKey(taskId)
  state.open = true
  state.tabs = state.tabs.includes(key) ? state.tabs : [...state.tabs, key]
  state.active = key
  state.focus++
  state.quiet = false
  bump()
}

export function openTurnTab(directory: string, conversationId: string, startedAt: number): void {
  const state = getOrCreate(directory, conversationId)
  const key = turnTabKey(conversationId, startedAt)
  const index = state.tabs.findIndex((tab) => isTurnTab(tab))
  const tabs = state.tabs.filter((tab) => turnRefOf(tab) === undefined && tab !== key)
  tabs.splice(index < 0 ? tabs.length : index, 0, key)
  state.open = true
  state.tabs = tabs
  state.active = key
  state.focus++
  state.quiet = false
  bump()
}

export function openExtensionTab(directory: string | undefined, id: string, conversationId?: string): boolean {
  if (directory === undefined) return false
  const state = getOrCreate(directory, conversationId)
  const key = extensionTabKey(id)
  state.open = true
  state.tabs = state.tabs.includes(key) ? state.tabs : [...state.tabs, key]
  state.active = key
  state.focus++
  state.quiet = false
  bump()
  return true
}

// ── 프로젝트 단위 (Git) ─────────────────────────────────────────────────────

export function openGitTab(directory: string, sub?: 'changes' | 'log'): void {
  for (const [, state] of panels) {
    if (state.directory === directory) {
      state.open = true
      state.active = GIT_TAB
      state.focus++
      state.quiet = false
    }
  }
  if (sub) gitSubs.set(directory, { sub, seq: ++jumps })
  bump()
}

export function getGitSub(directory: string): GitSub | undefined {
  return gitSubs.get(directory)
}

export function useGitSub(directory: string): GitSub | undefined {
  return useSyncExternalStore(subscribe, () => gitSubs.get(directory))
}

/** Git 탭을 고르지 않는다 (닫기 버튼 없음 — 활성 탭만 Files 로 되돌린다) */
export function closeGitTab(directory: string): void {
  for (const [, state] of panels) {
    if (state.directory === directory && state.active === GIT_TAB) {
      state.active = undefined
    }
  }
  bump()
}

// ── 공통 ─────────────────────────────────────────────────────────────────────

export function selectTab(key: string | undefined, directory: string, conversationId?: string): void {
  const state = getOrCreate(directory, conversationId)
  if (key === GIT_TAB) {
    // Git 탭을 고른 경우 — Git 은 프로젝트 단위라 모든 대화에 적용
    for (const [, s] of panels) {
      if (s.directory === directory) s.active = GIT_TAB
    }
    bump()
    return
  }
  const compare = state.compare && key === state.compare.a ? state.compare : undefined
  if (state.active === key && (compare ?? null) === (state.compare ?? null) && !state.quiet) return
  state.active = key
  state.quiet = false
  state.compare = compare
  bump()
}

export function closeTab(key: string, directory: string, conversationId?: string): void {
  // Git 탭을 닫는 경우
  if (key === GIT_TAB) {
    closeGitTab(directory)
    return
  }
  const state = getOrCreate(directory, conversationId)
  const index = state.tabs.indexOf(key)
  if (index < 0) return
  const tabs = state.tabs.filter((tab) => tab !== key)
  const active = state.active === key ? (tabs[index] ?? tabs[index - 1]) : state.active
  const compare = state.compare && (key === state.compare.a || key === state.compare.b) ? undefined : state.compare
  state.tabs = tabs
  state.active = active
  state.compare = compare
  bump()
}

export function startCompare(directory: string, a: string, b: string, conversationId?: string): void {
  const state = getOrCreate(directory, conversationId)
  if (a === b || !isFileTab(a) || !isFileTab(b)) return
  if (!state.tabs.includes(a) || !state.tabs.includes(b)) return
  state.compare = { a, b }
  state.active = a
  bump()
}

export function exitCompare(directory: string, conversationId?: string): void {
  const state = getOrCreate(directory, conversationId)
  if (state.compare) {
    state.compare = undefined
    bump()
  }
}

/** 확장 목록이 바뀌었다 — 모든 대화의 패널에서 꺼진 확장 탭을 닫는다 */
export function closeExtensionTabs(extensions: readonly { id: string; state: string }[]): void {
  const on = new Set(extensions.filter((extension) => extension.state === 'on').map((extension) => extension.id))
  let changed = false
  for (const [, state] of panels) {
    for (const key of state.tabs) {
      const id = extensionIdOf(key)
      if (id !== undefined && !on.has(id)) {
        closeTab(key, state.directory, state.conversationId)
        changed = true
      }
    }
  }
  if (changed) bump()
}

export function revealPanel(directory: string, conversationId?: string): void {
  const state = getOrCreate(directory, conversationId)
  state.open = true
  state.focus++
  state.quiet = false
  bump()
}

export function closeFilePreview(directory: string, conversationId?: string): void {
  const state = getOrCreate(directory, conversationId)
  if (state.open) {
    state.open = false
    state.fullscreen = false
    bump()
  }
}

export function toggleFullscreen(directory: string, conversationId?: string): void {
  const state = getOrCreate(directory, conversationId)
  state.fullscreen = !state.fullscreen
  bump()
}

export function cycleTerminalTab(directory: string, delta: 1 | -1, conversationId?: string): boolean {
  const state = getOrCreate(directory, conversationId)
  if (!state.tabs.length) return false
  const termTabs = state.tabs.filter((key) => isTerminalTab(key))
  if (termTabs.length === 0) return false
  const index = termTabs.indexOf(state.active ?? '')
  const next = index < 0 ? termTabs[termTabs.length - 1] : termTabs[(index + delta + termTabs.length) % termTabs.length]
  state.open = true
  state.active = next
  state.focus++
  state.quiet = false
  bump()
  return true
}

export function panelTakesFocus(state: PanelState): boolean {
  return !state.quiet
}

// ── 파일 찾기 (이슈 #528) ──

export function requestFilesSearch(directory: string, conversationId?: string): void {
  openFilesTab(directory, conversationId)
  for (const listener of filesSearchListeners) listener()
}

export function onFilesSearch(callback: () => void): () => void {
  filesSearchListeners.add(callback)
  return () => {
    filesSearchListeners.delete(callback)
  }
}

// ── 읽기 ─────────────────────────────────────────────────────────────────────

/** 현재 대화의 패널 상태 — conversationId 로 대화별로, 없으면 directory 만으로 */
export function getPanelState(conversationId?: string, directory?: string): PanelState | undefined {
  if (directory === undefined) return undefined
  return panels.get(panelKey(directory, conversationId))
}

/** 한 프로젝트(directory)에 속하는 모든 대화의 패널 상태 — 프로젝트 전환 시 터미널 셸 정리 등 (이슈 #579) */
export function allPanelsForProject(directory: string): PanelState[] {
  const result: PanelState[] = []
  for (const [, state] of panels) {
    if (state.directory === directory) result.push(state)
  }
  return result
}

export function usePanelState(conversationId?: string, directory?: string): PanelState | undefined {
  const dir = directory ?? ''
  return useSyncExternalStore(subscribe, () => panels.get(panelKey(dir, conversationId)))
}

/** 파일 탭의 열쇠 — `./a.ts`·`src/../a.ts`·프로젝트 안 절대 경로가 `a.ts` 와 한 탭이 되게 */
export function tabKey(directory: string, token: string): string {
  let rest = token
  const root = directory.replace(/\/+$/, '')
  if (rest.startsWith(root + '/')) rest = rest.slice(root.length + 1)
  if (rest.startsWith('/')) return token
  const parts: string[] = []
  for (const part of rest.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return token
      parts.pop()
    } else parts.push(part)
  }
  return parts.length > 0 ? parts.join('/') : token
}
