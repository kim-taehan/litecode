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
  /** 고른 파일 탭. undefined 면 Files 탭 */
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
  set({ ...state, open: true, tabs: state.tabs.includes(key) ? state.tabs : [...state.tabs, key], active: key, focus, quiet, jump })
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

/** 닫았던 패널을 그대로 다시 연다 — 처음이면 Files 탭 */
export function revealPanel(directory: string): void {
  const state = base(directory)
  set({ ...state, open: true, focus: state.focus + 1, quiet: false })
}

export function selectTab(key: string | undefined): void {
  if (current && current.active !== key) set({ ...current, active: key })
}

/** 탭 닫기 — 고른 탭이면 오른쪽 이웃, 없으면 왼쪽, 없으면 Files 탭 */
export function closeTab(key: string): void {
  if (!current) return
  const index = current.tabs.indexOf(key)
  if (index < 0) return
  const tabs = current.tabs.filter((tab) => tab !== key)
  const active = current.active === key ? (tabs[index] ?? tabs[index - 1]) : current.active
  set({ ...current, tabs, active })
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
