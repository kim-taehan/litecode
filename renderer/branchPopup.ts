import type { GitBranch } from '../shared/git.ts'

// 브랜치 팝업의 순수 규칙 (이슈 #386, 시안 Git 탭 재설계 ② Branch.dc.html) — 최근 고르기·앞부분 묶기·검색·단축키.
// 화면은 Git.tsx 의 BranchList 가 그린다

/** '최근' 에 보일 수 */
export const RECENT_COUNT = 3

/** 최근에 쓴 브랜치 — 지금 브랜치 먼저, 그다음 마지막 커밋 시각(GitBranch.time) 순. 따로 기록하지 않는다(서비스·저장소 변경 없음) */
export function recentBranches(branches: readonly GitBranch[], count = RECENT_COUNT): GitBranch[] {
  return [...branches].sort((a, b) => Number(b.current) - Number(a.current) || b.time - a.time).slice(0, count)
}

/** 이름 앞부분 (`feat_`·`fix_`·`feat/`) — 첫 `_` 또는 `/` 까지. 구분자가 없거나 맨 앞·맨 끝이면 없다 */
export function branchPrefix(name: string): string | undefined {
  const match = /^[^_/]+[_/]/.exec(name)
  return match && match[0].length < name.length ? match[0] : undefined
}

export type BranchEntry = { kind: 'group'; prefix: string; branches: GitBranch[] } | { kind: 'branch'; branch: GitBranch }

const byName = (a: GitBranch, b: GitBranch): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

/** '로컬 브랜치' 줄 — 같은 앞부분이 둘 이상이면 묶음(앞부분 이름 순), 하나뿐이면 낱개. 묶음이 먼저, 낱개는 이름 순 (시안) */
export function groupBranches(branches: readonly GitBranch[]): BranchEntry[] {
  const groups = new Map<string, GitBranch[]>()
  const singles: GitBranch[] = []
  for (const branch of branches) {
    const prefix = branchPrefix(branch.name)
    if (prefix === undefined) singles.push(branch)
    else groups.set(prefix, [...(groups.get(prefix) ?? []), branch])
  }
  const entries: BranchEntry[] = []
  for (const prefix of [...groups.keys()].sort()) {
    const members = groups.get(prefix)!
    if (members.length > 1) entries.push({ kind: 'group', prefix, branches: members.sort(byName) })
    else singles.push(members[0]!)
  }
  return [...entries, ...singles.sort(byName).map((branch): BranchEntry => ({ kind: 'branch', branch }))]
}

/** 검색 — 대소문자·앞뒤 공백 무시, 빈 검색은 모두 */
export function matchesQuery(text: string, query: string): boolean {
  const needle = query.trim().toLowerCase()
  return !needle || text.toLowerCase().includes(needle)
}

/** ↑↓ 수 — 있는 쪽만 (`↑3`·`↑1 ↓2`), 없으면 '' */
export function branchTrack(branch: Pick<GitBranch, 'ahead' | 'behind'>): string {
  return [branch.ahead > 0 && `↑${branch.ahead}`, branch.behind > 0 && `↓${branch.behind}`].filter(Boolean).join(' ')
}

export type PopupShortcut = 'pull' | 'newBranch'

/** 팝업이 열려 있을 때만 쓰는 단축키 — ⌘T 가져오기 · ⌥⌘N 새 브랜치 (mac 밖은 Ctrl). 물리 키(code)로 본다 — 한글 입력 체계에서 key 가 'ㅅ'·'ㅜ' 로 온다 */
export function popupShortcut(event: { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }, mac: boolean): PopupShortcut | undefined {
  const command = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!command || event.shiftKey) return undefined
  if (event.code === 'KeyT' && !event.altKey) return 'pull'
  if (event.code === 'KeyN' && event.altKey) return 'newBranch'
  return undefined
}

export function shortcutLabel(shortcut: PopupShortcut, mac: boolean): string {
  if (shortcut === 'pull') return mac ? '⌘T' : 'Ctrl+T'
  return mac ? '⌥⌘N' : 'Ctrl+Alt+N'
}
