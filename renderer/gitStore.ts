import { useEffect, useSyncExternalStore } from 'react'
import type { GitIgnored, GitLogCommit, GitLogPage, GitLogPageQuery, GitView } from '../shared/git.ts'
import { isFoldOpen, SECTION_UNTRACKED, toggleAllFolds, toggleFold, type Folds } from './gitTree.ts'

// Git 상태의 화면 쪽 저장소 (이슈 #290) — 오른쪽 패널의 Git 탭(변경 수·목록)과 입력 카드의 브랜치 알약이 같은 값을 본다.
// 파일 워처는 없다: 다시 읽는 때는 ① 메인이 git:changed 를 알릴 때(화면·AI 도구의 작업 뒤) ② 턴이 끝날 때 ③ 창이 앞으로 올 때 ④ 패널을 열 때(Git.tsx).
// 같은 폴더를 겹쳐 읽으면 마지막 요청의 답만 쓴다

const views = new Map<string, GitView>()
const asked = new Map<string, number>()
const listeners = new Set<() => void>()
let version = 0

function notify(): void {
  version++
  for (const listener of listeners) listener()
}

/** 그 폴더를 다시 읽는다. 기능이 꺼졌거나(채널 없음) 실패하면 아무것도 안 바꾼다 */
export function refreshGit(directory: string, read: (directory: string) => Promise<GitView> = (dir) => window.litecode.gitView(dir)): Promise<void> {
  const seq = (asked.get(directory) ?? 0) + 1
  asked.set(directory, seq)
  return read(directory).then(
    (view) => {
      if (asked.get(directory) !== seq) return
      views.set(directory, view)
      notify()
    },
    () => {},
  )
}

export function gitViewOf(directory: string | undefined): GitView | undefined {
  return directory === undefined ? undefined : views.get(directory)
}

/** 변경 수 — 탭 이름 옆 숫자·알약의 점 */
export function changeCount(view: GitView | undefined): number {
  return view?.state === 'ok' ? view.staged.length + view.changed.length + view.conflicts.length : 0
}

// 변경 트리의 접힘 (#388) — 폴더(프로젝트)마다. 다시 읽기·하위 탭·패널 탭을 오가도 남는다 (앱을 다시 켜면 기본으로)
const folds = new Map<string, Folds>()

export function foldsOf(directory: string): Folds | undefined {
  return folds.get(directory)
}

/** 폴더·구역 하나를 접거나 편다 */
export function toggleGitFold(directory: string, key: string): void {
  folds.set(directory, toggleFold(folds.get(directory), key))
  notify()
}

/** 모두 접기·펴기 — keys 는 지금 보이는 폴더·구역 열쇠 */
export function toggleAllGitFolds(directory: string, keys: readonly string[]): void {
  folds.set(directory, toggleAllFolds(folds.get(directory), keys))
  notify()
}

// 무시된 파일 보기 (#390, IntelliJ 의 보기 옵션 Show Ignored Files) — 폴더(프로젝트)마다 켜고 끈다(꺼짐이 기본, 앱을 다시 켜면 꺼짐).
// 목록은 켜져 있을 때만 읽는다(ChangesView) — 늦게 온 옛 답은 버린다
const ignoredOn = new Set<string>()
const ignoredLists = new Map<string, GitIgnored[]>()
const ignoredAsked = new Map<string, number>()

export function ignoredShown(directory: string): boolean {
  return ignoredOn.has(directory)
}

/** 켜고 끈다 — 켤 때 새 파일 구역이 접혀 있으면 편다(무시된 줄은 그 구역 안에 보인다) */
export function toggleIgnoredShown(directory: string): void {
  if (ignoredOn.delete(directory)) return notify()
  ignoredOn.add(directory)
  const current = folds.get(directory)
  if (!isFoldOpen(current, SECTION_UNTRACKED)) folds.set(directory, toggleFold(current, SECTION_UNTRACKED))
  notify()
}

export function ignoredOf(directory: string): GitIgnored[] | undefined {
  return ignoredLists.get(directory)
}

export function refreshIgnored(directory: string, read: (directory: string) => Promise<GitIgnored[]> = (dir) => window.litecode.gitIgnored(dir)): Promise<void> {
  const seq = (ignoredAsked.get(directory) ?? 0) + 1
  ignoredAsked.set(directory, seq)
  return read(directory).then(
    (list) => {
      if (ignoredAsked.get(directory) !== seq) return
      ignoredLists.set(directory, list)
      notify()
    },
    () => {},
  )
}

// 기록 탭 페이징 (#400 #405) — 폴더(프로젝트)마다: 첫 페이지를 쓰고 내려가며 다음 페이지를 덧붙인다.
// 다시 읽기(refreshLogGit)는 맨 처음부터 다시(레이인 상태는 GitLog 가 commits 처음부터 다시 계산한다)
export interface GitLogView {
  commits: GitLogCommit[]
  hasMore: boolean
  /** 다음 페이지를 읽고 있다 — 이어서 읽기는 한 번에 하나 */
  reading: boolean
}

const logPages = new Map<string, GitLogPage>()
const logAsked = new Map<string, number>()
const logReading = new Set<string>()

export function logGitOf(directory: string | undefined): GitLogView | undefined {
  if (directory === undefined) return undefined
  const page = logPages.get(directory)
  if (!page) return undefined // 아직 읽기 시작한 적 없음
  return { commits: page.commits, hasMore: page.hasMore, reading: logReading.has(directory) }
}

/** 첫 페이지를 안고 다시 읽는다 — 같은 폴더의 읽기는 마지막 요청의 답만 쓴다(그 사이 다시 읽으면 그 전 답은 버림) */
export function refreshLogGit(directory: string, read: (directory: string, query?: GitLogPageQuery) => Promise<GitLogPage> = (d, q) => window.litecode.gitLogPage(d, q)): Promise<void> {
  const seq = (logAsked.get(directory) ?? 0) + 1
  logAsked.set(directory, seq)
  logPages.set(directory, { commits: [], hasMore: false })
  logReading.add(directory)
  notify()
  return read(directory).then(
    (page) => {
      if (logAsked.get(directory) !== seq) return
      logPages.set(directory, page)
      logReading.delete(directory)
      notify()
    },
    () => {
      if (logAsked.get(directory) !== seq) return
      logReading.delete(directory)
      notify()
    },
  )
}

/** 읽힌 것 뒤에 다음 페이지를 덧붙인다 — 이미 읽고 있거나 마감이면 아무것도 안 한다 */
export function appendLogGit(directory: string, read: (directory: string, query?: GitLogPageQuery) => Promise<GitLogPage> = (d, q) => window.litecode.gitLogPage(d, q)): Promise<void> {
  const page = logPages.get(directory)
  if (!page || !page.hasMore || logReading.has(directory)) return Promise.resolve()
  const skip = page.commits.length
  const seq = logAsked.get(directory) ?? 0
  logReading.add(directory)
  notify()
  return read(directory, { skip }).then(
    (next) => {
      if (logAsked.get(directory) !== seq) {
        logReading.delete(directory)
        return
      }
      logPages.set(directory, { commits: [...page.commits, ...next.commits], hasMore: next.hasMore })
      logReading.delete(directory)
      notify()
    },
    () => {
      if (logAsked.get(directory) !== seq) return
      logReading.delete(directory)
      notify()
    },
  )
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useGitView(directory: string | undefined): GitView | undefined {
  useSyncExternalStore(subscribe, () => version, () => version)
  return gitViewOf(directory)
}

export function useLogGit(directory: string | undefined): GitLogView | undefined {
  useSyncExternalStore(subscribe, () => version, () => version)
  return logGitOf(directory)
}

/** App 이 한 번 건다 — 기능이 켜져 있고 프로젝트를 보고 있을 때 다시 읽는 때를 잇는다 */
export function useGitWatch(enabled: boolean, directory: string | undefined): void {
  useEffect(() => {
    if (!enabled || !directory) return
    const reread = (): void => void refreshGit(directory)
    reread()
    const offChanged = window.litecode.onGitChanged((changed) => changed === directory && reread())
    const offTurn = window.litecode.onTurnEnded(reread)
    window.addEventListener('focus', reread)
    return () => {
      offChanged()
      offTurn()
      window.removeEventListener('focus', reread)
    }
  }, [enabled, directory])
}
