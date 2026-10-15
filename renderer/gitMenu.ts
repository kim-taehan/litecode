import type { GitStatus } from '../shared/git.ts'
import { entryKind, type ChangeEntry } from './gitTree.ts'

// Git 탭 변경 파일의 우클릭 메뉴 (#389, 시안 Git 탭 재설계 ① Main.dc.html 의 .menu) — 화면과 떨어진 순수 규칙.
// 항목 순서·구분선은 시안 그대로: [이 파일만 커밋… · 되돌리기…] | [변경 보기 · 파일 미리보기로 열기] | [패치로 복사 · 보관(stash)… · .gitignore 에 추가 · .git/info/exclude 에 추가] | [삭제…]
// 무시 두 항목(#390)은 IntelliJ 그대로 — 새 파일에서만 보이고, 누르면 바로 한 줄 덧붙인다(팝업 없음)

export type FileMenuItem = 'commitFile' | 'discard' | 'showDiff' | 'preview' | 'copyPatch' | 'stash' | 'ignore' | 'exclude' | 'trash'

/** 묶음 사이에 구분선. ignore = .gitignore 에 추가 · exclude = .git/info/exclude 에 추가 (#390) */
export const FILE_MENU: readonly (readonly FileMenuItem[])[] = [['commitFile', 'discard'], ['showDiff', 'preview'], ['copyPatch', 'stash', 'ignore', 'exclude'], ['trash']]

/** 위험한 항목 (시안 .mi.dg — 빨간 글) */
export const DANGER_ITEMS: ReadonlySet<FileMenuItem> = new Set(['trash'])

/** 오른쪽 단축키 글자 — 시안은 mac 글자, 그 밖은 Ctrl */
export function menuShortcutLabel(item: FileMenuItem, mac: boolean): string | undefined {
  if (item === 'discard') return mac ? '⌥⌘Z' : 'Ctrl+Alt+Z'
  if (item === 'showDiff') return mac ? '⌘D' : 'Ctrl+D'
  if (item === 'preview') return mac ? '⌘↓' : 'Ctrl+↓'
  return undefined
}

/** 고른 파일 줄에서 누른 키 → 항목 (물리 키 code — 한글 입력 체계에서도). 메뉴를 여는 키는 isMenuKey */
export function menuShortcut(event: { code: string; key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }, mac: boolean): FileMenuItem | undefined {
  const command = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!command || event.shiftKey) return undefined
  if (event.code === 'KeyZ' && event.altKey) return 'discard'
  if (event.code === 'KeyD' && !event.altKey) return 'showDiff'
  if (event.key === 'ArrowDown' && !event.altKey) return 'preview'
  return undefined
}

/** 메뉴를 여는 키 — ContextMenu 키·Shift+F10 */
export function isMenuKey(event: { key: string; shiftKey: boolean }): boolean {
  return event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')
}

/** 그 줄에서 누를 수 있나 — 되돌리기는 작업 트리 쪽 변경이 있을 때(줄의 되돌리기 버튼과 같음), 미리보기·삭제는 파일이 있을 때,
 *  커밋·보관은 병합이 멈춘 동안 못 하고(git 이 부분 커밋을 막는다) 보관은 첫 커밋 뒤에만(git 이 못 한다) */
export function menuEnabled(item: FileMenuItem, entry: ChangeEntry, view: Pick<GitStatus, 'merging' | 'hasCommits'>): boolean {
  const kind = entryKind(entry)
  if (item === 'commitFile') return !view.merging
  if (item === 'discard') return entry.changed !== undefined
  if (item === 'preview' || item === 'trash') return kind !== 'D'
  if (item === 'stash') return view.hasCommits && !view.merging
  return true
}

/** 그 줄에 보이나 — 무시에 추가는 새 파일(U)에만 (IntelliJ: git 에 더한 파일은 무시해도 계속 추적된다 — 되돌리기부터). 나머지는 늘 보이고 menuEnabled 로 끈다 */
export function menuVisible(item: FileMenuItem, entry: ChangeEntry): boolean {
  return item === 'ignore' || item === 'exclude' ? entryKind(entry) === 'U' : true
}

/** 그 줄의 git 경로 — 이름 바꾼 파일은 옛 경로도 (커밋·보관이 지운 쪽을 같이 가져가게) */
export function entryPaths(entry: ChangeEntry): string[] {
  const from = entry.staged?.from
  return from ? [entry.path, from] : [entry.path]
}
