import { useSyncExternalStore } from 'react'

// 오른쪽 패널(파일 미리보기) 상태 — 답의 파일 칩(Markdown.tsx)·대화 머리 버튼·Files 탭이 열고, 패널(FilePreview.tsx)이 그린다. 서로 멀리
// 떨어져 있어(칩은 답 깊숙이, 패널은 앱 틀 오른쪽) props 로 잇지 않고 작은 저장소 하나로 잇는다. 경로가 아니라 칩과 같은 (프로젝트, 답의
// 글자) 만 쥔다 — 읽기·판정은 메인. 이슈 #29 부터 탭: 고정 "Files" 탭(active undefined) + 연 파일 탭들(dsh ui-sidebar-right 탭 줄).
// 패널을 닫아도 탭은 남는다(머리 버튼으로 다시 열면 그대로 — dsh 처럼). 다른 프로젝트의 파일을 열면 새로 시작한다.

export interface PanelState {
  directory: string
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
  /** 마지막으로 연 것이 AI 다(open(파일)) — 패널이 포커스를 잡지 않는다. 치던 입력창의 글이 끊기지 않게 (터미널 칸의 quiet 와 같다) */
  quiet?: boolean
  /** 줄 이동 (이슈 #51 — AI 의 open(파일) 이 줄을 줬다): 그 탭을 그 줄로 스크롤하고 강조한다. seq 는 줄을 줄 때마다 오른다 — 같은 줄을 다시 열어도 다시 간다.
   *  줄 없이 그 탭을 다시 열면 지워진다 */
  jump?: { key: string; line: number; seq: number }
  /** Git 탭을 열며 고르라고 한 하위 탭 (이슈 #290) — seq 가 오를 때마다 그 하위 탭으로 */
  gitSub?: { sub: 'changes' | 'log'; seq: number }
  /** 비교 보기 (이슈 #424) — 파일 탭 두 개를 위아래 50/50. 하나를 닫거나 다른 탭을 고르면 지워진다 */
  compare?: { a: string; b: string }
}

let current: PanelState | undefined
let jumps = 0
const listeners = new Set<() => void>()

function set(next: PanelState | undefined): void {
  current = next
  for (const listener of listeners) listener()
}

/** 같은 프로젝트면 지금 상태, 아니면 새 상태 */
function base(directory: string): PanelState {
  return current?.directory === directory ? current : { directory, open: false, tabs: [], fullscreen: false, focus: 0 }
}

/** 파일 탭인가 — 터미널·작업·턴·확장 탭과 Git 은 아님 (비교 보기는 파일 탭만) */
export function isFileTab(key: string): boolean {
  return key !== GIT_TAB && !isTerminalTab(key) && !isTaskTab(key) && !isTurnTab(key) && !isExtensionTab(key)
}

/** 비교 보기 후보 — 같은 패널의 다른 연 파일 탭 (현재 탭 제외) */
export function compareCandidates(tabs: readonly string[], current: string | undefined): string[] {
  return tabs.filter((key) => key !== current && isFileTab(key))
}

/** 비교 보기 시작 — 둘 다 이 패널의 연 파일 탭이고 서로 다르면 { a: 고른 것(위), b: 후보(아래) } 로. 아니면 아무 일도 없다 */
export function startCompare(directory: string, a: string, b: string): void {
  const state = current
  if (!state || state.directory !== directory) return
  if (a === b || !isFileTab(a) || !isFileTab(b)) return
  if (!state.tabs.includes(a) || !state.tabs.includes(b)) return
  set({ ...state, compare: { a, b }, active: a })
}

/** 비교 보기 종료 — 위 탭(a) 을 고른 채로 남는다 */
export function exitCompare(): void {
  if (current?.compare) set({ ...current, compare: undefined })
}

/** 칩·트리의 글자를 탭 열쇠로 — `./a.ts`·`src/../a.ts`·프로젝트 안 절대 경로가 `a.ts` 와 한 탭이 되게. 메인이 풀어도 같은 파일이다
 *  (path.resolve(root, token) 와 같은 정리). 프로젝트 밖으로 나가는 글자는 그대로 둔다 — 메인이 거부한다 */
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

/** 파일 탭을 열고(이미 있으면 그 탭을) 고른다. line(1부터)을 주면 그 줄로 간다.
 *  quiet — 사용자가 누른 것이 아니다(AI 의 open(파일)): 탭만 열고 고른다. focus 를 올리지 않아 패널이 포커스를 가져가지 않는다 */
export function openFilePreview(directory: string, token: string, line?: number, { quiet = false }: { quiet?: boolean } = {}): void {
  const state = base(directory)
  const key = tabKey(directory, token)
  const focus = quiet ? state.focus : state.focus + 1
  const jump = line !== undefined ? { key, line, seq: ++jumps } : state.jump?.key === key ? undefined : state.jump
  // 비교 보기 중 다른 파일을 열면 비교를 끝낸다 (위 탭 a 를 다시 여는 것만 예외)
  const compare = state.compare && key !== state.compare.a ? undefined : state.compare
  set({ ...state, open: true, tabs: state.tabs.includes(key) ? state.tabs : [...state.tabs, key], active: key, focus, quiet, jump, compare })
}

/** Git 탭의 열쇠 (이슈 #290) — 파일 탭 열쇠(프로젝트 기준 경로)와 겹치지 않는 글자. 고정 탭이라 tabs 에는 없다 */
export const GIT_TAB = '\0git'

/** 터미널 탭의 열쇠 (이슈 #303) — `\0term/<id>`, id 는 메인(ctx.terminals)이 주는 폴더별 번호(탭 이름 터미널 1·2·…).
 *  파일 탭 열쇠(경로)와 겹치지 않는다 */
export const TERM_PREFIX = '\0term/'
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

/** 터미널 탭으로 연다 — id 는 메인에서 새로 연(또는 재사용한) 터미널. quiet — 사용자가 누른 것이 아니다(AI 의 open(터미널)): 탭만 열고 고른다.
 *  focus 를 올리지 않아 패널·터미널이 포커스를 가져가지 않는다 */
export function openTerminalTab(directory: string, id: number, { quiet = false }: { quiet?: boolean } = {}): void {
  const state = base(directory)
  const key = terminalTabKey(id)
  const focus = quiet ? state.focus : state.focus + 1
  set({ ...state, open: true, tabs: state.tabs.includes(key) ? state.tabs : [...state.tabs, key], active: key, focus, quiet })
}

/** 백그라운드 작업 탭의 열쇠 (이슈 #325) — `\0task/<작업 id>`, 작업 id 는 메인(BackgroundTasks)이 주는 `bgtask:<대화>:<번호>`.
 *  탭은 작업이 끝나도 남고 사용자가 닫는다. 프로젝트를 옮기면 터미널 탭처럼 새로 시작한다(base) */
export const TASK_PREFIX = '\0task/'
export function taskTabKey(taskId: string): string {
  return TASK_PREFIX + taskId
}
export function taskIdOf(key: string | undefined): string | undefined {
  return key?.startsWith(TASK_PREFIX) && key.length > TASK_PREFIX.length ? key.slice(TASK_PREFIX.length) : undefined
}
export function isTaskTab(key: string | undefined): key is string {
  return taskIdOf(key) !== undefined
}

/** 작업 탭을 연다 — 이미 열려 있으면 그 탭을 고른다 (작업 줄의 ›) */
export function openTaskTab(directory: string, taskId: string): void {
  const state = base(directory)
  const key = taskTabKey(taskId)
  set({ ...state, open: true, tabs: state.tabs.includes(key) ? state.tabs : [...state.tabs, key], active: key, focus: state.focus + 1, quiet: false })
}

/** "턴 작업" 탭의 열쇠 (이슈 #416) — `\0turn/<대화 id>/<보낸 시각>`, 턴마다 다르다.
 *  같은 이름의 탭은 하나만 유지한다 — 새 턴이 오면 openTurnTab 이 열렸던 탭의 열쇠를 바꾼다 (이슈 #456).
 *  턴이 끝나도 탭은 남고 사용자가 닫는다 (작업 탭과 같은 길) */
export const TURN_PREFIX = '\0turn/'
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

/** 턴 탭을 연다 — 같은 이름의 탭은 하나뿐 (이슈 #456). 이미 열려 있으면 그 자리의 열쇠를 새 턴으로 바꾼다(위치 그대로, 새 탭 없음),
 *  없으면 마지막에 열고 그 탭을 고른다 (진행 중 턴의 한 줄) */
export function openTurnTab(directory: string, conversationId: string, startedAt: number): void {
  const state = base(directory)
  const key = turnTabKey(conversationId, startedAt)
  const index = state.tabs.findIndex((tab) => isTurnTab(tab))
  const tabs = state.tabs.filter((tab) => turnRefOf(tab) === undefined && tab !== key)
  tabs.splice(index < 0 ? tabs.length : index, 0, key)
  set({ ...state, open: true, tabs, active: key, focus: state.focus + 1, quiet: false })
}

/** 확장 탭의 열쇠 (이슈 #511) — `\0ext/<확장 id>`. 본문은 그 확장의 진입 HTML 을 격리된 iframe 에서 (FilePreview.tsx ExtensionTab) */
export const EXT_PREFIX = '\0ext/'
export function extensionTabKey(id: string): string {
  return EXT_PREFIX + id
}
export function extensionIdOf(key: string | undefined): string | undefined {
  return key?.startsWith(EXT_PREFIX) && key.length > EXT_PREFIX.length ? key.slice(EXT_PREFIX.length) : undefined
}
export function isExtensionTab(key: string | undefined): key is string {
  return extensionIdOf(key) !== undefined
}

/** 확장 탭 본문의 재마운트 열쇠 — 버전이 바뀌면(업그레이드) 새 HTML 을 읽어 iframe 을 새로 그린다 */
export function extensionFrameKey(id: string, version: string | undefined): string {
  return `${id}@${version ?? ''}`
}

/** 확장 탭을 연다 — 이미 있으면 그 탭을 고른다. 패널이 닫혀 있으면 연다(파일 칩과 같은 길). 프로젝트가 없으면(대화 없음) 열지 못한다 → false */
export function openExtensionTab(directory: string | undefined, id: string): boolean {
  if (directory === undefined) return false
  const state = base(directory)
  const key = extensionTabKey(id)
  set({ ...state, open: true, tabs: state.tabs.includes(key) ? state.tabs : [...state.tabs, key], active: key, focus: state.focus + 1, quiet: false })
  return true
}

/** 확장 목록이 바뀌었다(extensions:changed) — 꺼졌거나·삭제됐거나·상태가 정상(on)이 아닌 확장의 탭을 닫는다. 고른 탭이면 closeTab 처럼 이웃으로 */
export function closeExtensionTabs(extensions: readonly { id: string; state: string }[]): void {
  const on = new Set(extensions.filter((extension) => extension.state === 'on').map((extension) => extension.id))
  for (const key of current?.tabs ?? []) {
    const id = extensionIdOf(key)
    if (id !== undefined && !on.has(id)) closeTab(key)
  }
}

/** ⌘[·⌘] — 터미널 탭을 넘나든다 (이전·다음). 고른 것이 없으면 마지막 연 것으로. 하나 없으면 false */
export function cycleTerminalTab(directory: string, delta: 1 | -1): boolean {
  if (!current || current.directory !== directory) return false
  const termTabs = current.tabs.filter((key) => isTerminalTab(key))
  if (termTabs.length === 0) return false
  const index = termTabs.indexOf(current.active ?? '')
  const next = index < 0 ? termTabs[termTabs.length - 1] : termTabs[(index + delta + termTabs.length) % termTabs.length]
  set({ ...current, open: true, active: next, focus: current.focus + 1, quiet: false })
  return true
}

/** Git 탭으로 연다 — sub 를 주면 그 하위 탭 (브랜치 탭은 #399 에서 없앴다 — 브랜치는 알약의 팝업에서) */
export function openGitTab(directory: string, sub?: 'changes' | 'log'): void {
  const state = base(directory)
  set({ ...state, open: true, active: GIT_TAB, focus: state.focus + 1, quiet: false, ...(sub && { gitSub: { sub, seq: ++jumps } }) })
}

/** 패널이 지금 포커스를 잡아도 되는가 — focus 가 오르거나 패널이 새로 뜰 때 묻는다. 조용히 연 것(AI)이 마지막이면 잡지 않는다 */
export function panelTakesFocus(state: PanelState): boolean {
  return !state.quiet
}

/** Files 탭으로 연다 ("+"·대화 머리 버튼) */
export function openFilesTab(directory: string): void {
  const state = base(directory)
  set({ ...state, open: true, active: undefined, focus: state.focus + 1, quiet: false })
}

// ── 파일 찾기 (이슈 #528) — ⌘P 신호 ──

let filesSearchListeners = new Set<() => void>()

/** 파일 찾기를 요청한다 — Files 탭을 열고, 검색 칸에 포커스를 준다 */
export function requestFilesSearch(directory: string): void {
  openFilesTab(directory)
  for (const listener of filesSearchListeners) listener()
}

/** ⌘P 신호를 듣는다 */
export function onFilesSearch(callback: () => void): () => void {
  filesSearchListeners.add(callback)
  return () => { filesSearchListeners.delete(callback) }
}

/** 닫았던 패널을 그대로 다시 연다 — 처음이면 Files 탭 */
export function revealPanel(directory: string): void {
  const state = base(directory)
  set({ ...state, open: true, focus: state.focus + 1, quiet: false })
}

/** 탭을 고른다(사용자가 누른 것) — quiet 를 푼다: AI 가 조용히 연 터미널 탭도 사용자가 직접 고르면 키를 가져간다.
 *  비교 보기 중이라면 위 탭(a) 말고 고른 것은 비교를 끝낸다 */
export function selectTab(key: string | undefined): void {
  if (!current) return
  const compare = current.compare && key === current.compare.a ? current.compare : undefined
  if (current.active === key && (compare ?? null) === (current.compare ?? null) && !current.quiet) return
  set({ ...current, active: key, quiet: false, compare })
}

/** 탭 닫기 — 고른 탭이면 오른쪽 이웃, 없으면 왼쪽, 없으면 Files 탭 */
export function closeTab(key: string): void {
  if (!current) return
  const index = current.tabs.indexOf(key)
  if (index < 0) return
  const tabs = current.tabs.filter((tab) => tab !== key)
  const active = current.active === key ? (tabs[index] ?? tabs[index - 1]) : current.active
  // 비교 보기 중 비교하는 탭을 닫으면 비교도 끝낸다
  const compare = current.compare && (key === current.compare.a || key === current.compare.b) ? undefined : current.compare
  set({ ...current, tabs, active, compare })
}

export function toggleFullscreen(): void {
  if (current) set({ ...current, fullscreen: !current.fullscreen })
}

/** 패널을 숨긴다 (탭은 남는다). 전체 화면은 푼다 */
export function closeFilePreview(): void {
  if (current?.open) set({ ...current, open: false, fullscreen: false })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getPanelState(): PanelState | undefined {
  return current
}

export function usePanelState(): PanelState | undefined {
  return useSyncExternalStore(subscribe, getPanelState)
}
