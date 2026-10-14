import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import type { FileDiff } from '../shared/ipc.ts'
import { gitWebUrl, type GitAction, type GitBranch, type GitCommit, type GitFile, type GitLastCommit, type GitResult, type GitStash, type GitStatus } from '../shared/git.ts'
import { ago } from './ago.ts'
import { branchTrack, groupBranches, matchesQuery, popupShortcut, recentBranches, shortcutLabel, type PopupShortcut } from './branchPopup.ts'
import { focusComposerInput } from './composerFocus.ts'
import { splitPath } from './changedFiles.ts'
import { DiffCard } from './DiffCard.tsx'
import { useFeatures } from './featuresStore.ts'
import { openFilePreview, openGitTab, type PanelState } from './filePreviewStore.ts'
import { commitControls, commitNotice, commitThenPush } from './gitCommit.ts'
import { DANGER_ITEMS, entryPaths, FILE_MENU, isMenuKey, menuEnabled, menuShortcut, menuShortcutLabel, type FileMenuItem } from './gitMenu.ts'
import { changeCount, foldsOf, refreshGit, toggleAllGitFolds, toggleGitFold, useGitView } from './gitStore.ts'
import { buildTree, entryKind, entryStat, entryState, folderKey, groupState, isFoldOpen, SECTION_UNTRACKED, splitChanges, toggleAction, treeFolders, treeRows, type ChangeEntry, type CheckState, type TreeFolder } from './gitTree.ts'
import { reason } from './ipcError.ts'
import { useT, type Translate } from './settingsStore.ts'
import './git.css'

// Git 탭 (이슈 #290 — 시안 _workspace/mock-git/Git.dc.html 의 구조·문구·권한표). 모양은 지금 앱의 부품을 그대로 쓴다:
// 경로 줄(.file-preview__bar)·작은 글 버튼(.file-preview__toggle)·도구 버튼(.file-preview__tool), 변경 파일은 #388 부터 시안 ① 의 폴더 트리(.git-sec·.git-dir·.git-file, 규칙은 gitTree.ts),
// diff 는 DiffCard, 확인 카드는 승인 카드(.attention-card) 틀, 못 쓰는 상태는 빈 칸 글(.file-preview__empty) 자리. git.css 는 그 사이를 잇는 것만.
// 바로 하는 것(stage·커밋·브랜치 만들기)과 카드로 묻는 것(전환·올리기·가져오기, 되돌리기·삭제는 경고 카드)은 시안 7절 표 그대로.
// 상태는 메인(ctx.git)이 정본이다 — 작업마다 다시 읽는다(gitStore). 커밋 메시지 초안은 탭을 오가도 폴더마다 남는다

type Sub = 'changes' | 'log' | 'branches'
type Confirm =
  | { kind: 'switch'; name: string; via?: 'remote' | 'revision' }
  | { kind: 'push' }
  | { kind: 'pull' }
  | { kind: 'discard'; file: GitFile }
  | { kind: 'delete'; branch: GitBranch }
  | { kind: 'remote'; then?: 'push' | 'pull' }
  /** 변경 파일 우클릭 메뉴 (#389) — 이 파일만 커밋·보관은 메시지 칸, 삭제(휴지통)·보관 삭제는 경고 */
  | { kind: 'commitFile' | 'stash' | 'trash'; entry: ChangeEntry }
  | { kind: 'dropStash'; stash: GitStash }
type Notice = { tone: 'ok' | 'error'; text: string; detail?: string; undo?: boolean; remote?: boolean }

const drafts = new Map<string, string>()
const NOTICE_MS = 3_000

/** 오른쪽 패널 탭 줄의 Git 탭 이름 옆 숫자 */
export function GitTabCount({ directory }: { directory: string }) {
  const t = useT()
  const count = changeCount(useGitView(directory))
  if (count === 0) return null
  return (
    <span className="git-count" aria-label={t('git.tabCount', { count })}>
      {count}
    </span>
  )
}

/** 입력 카드의 브랜치 알약 — 누르면 위로 브랜치 팝업 (#386). 저장소가 아니거나 git 이 없으면 그리지 않는다 */
export function GitBranchPill({ directory }: { directory: string }) {
  const t = useT()
  const on = useFeatures().has('git')
  const view = useGitView(on ? directory : undefined)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // 바깥을 누르면 닫는다 (모드 칩·+ 메뉴와 같다)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) close()
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])

  // 프로젝트가 바뀌면 닫는다 — 팝업은 그 저장소의 것이다
  useEffect(() => setOpen(false), [directory])

  function close(): void {
    setOpen(false)
    if (!focusComposerInput()) triggerRef.current?.focus() // 닫히면 입력창으로 (#374) — 없으면 알약으로
  }

  if (!on || view?.state !== 'ok') return null
  const count = changeCount(view)
  const branch = view.branch ?? t('git.detached')
  return (
    <div className="git-pill-wrap" ref={wrapRef}>
      <button
        type="button"
        className="mode-chip git-pill"
        ref={triggerRef}
        title={t('git.pillTitle', { branch, count })}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <BranchIcon />
        <span className="git-pill__name">{branch}</span>
        {count > 0 && <span className="git-pill__dot" aria-hidden="true">●</span>}
      </button>
      {open && <BranchPopup directory={directory} view={view} onClose={close} />}
    </div>
  )
}

// ── 브랜치 팝업 (이슈 #386, 시안 Git 탭 재설계 ② Branch.dc.html) ──
// 알약 위로 뜬다(입력 카드 .composer__box 기준, + 메뉴와 같은 자리 잡기). 위에서부터 검색 칸 · 가져오기/올리기 · 새 브랜치/태그·커밋으로 전환 ·
// 최근 · 로컬 브랜치(앞부분 묶음) · 원격 브랜치. 바꾸는 동작은 Git 탭과 같은 흐름이다 — 전환·가져오기·올리기는 확인 카드(ConfirmCard)를
// 팝업 안에 띄워 묻고, 새 브랜치는 바로 만든다. 성공하면 닫고, 실패는 팝업 위쪽 한 줄(충돌은 Git 탭의 충돌 카드로 보낸다).
// 단축키 ⌘T(가져오기)·⌥⌘N(새 브랜치)는 팝업이 열려 있을 때만 (mac 밖은 Ctrl). 시안의 ⌘K 글자는 뺐다 — ⌘K 는 프로젝트 빠른 열기(#379)

type Editing = 'branch' | 'revision'

function BranchPopup({ directory, view, onClose }: { directory: string; view: GitStatus; onClose(): void }) {
  const t = useT()
  const mac = navigator.platform.startsWith('Mac')
  const [branches, setBranches] = useState<GitBranch[]>()
  const [remotes, setRemotes] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<Confirm>()
  const [error, setError] = useState<{ text: string; detail?: string }>()
  const [editing, setEditing] = useState<Editing>()
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    window.litecode.gitBranches(directory).then(
      (list) => live && setBranches(list),
      () => live && setBranches([]),
    )
    window.litecode.gitRemoteBranches(directory).then(
      (list) => live && setRemotes(list),
      () => live && setRemotes([]),
    )
    return () => {
      live = false
    }
  }, [directory, view])

  const askRemote = (kind: 'push' | 'pull'): void => {
    setError(undefined)
    setConfirm(view.remote ? { kind } : { kind: 'remote', then: kind })
  }

  // 누른 줄이 사라지면 포커스가 팝업 밖(body)으로 빠져 Esc·화살표가 안 닿는다 — 확인 카드는 주 버튼으로, 입력 칸을 접으면 검색 칸으로
  useEffect(() => {
    if (confirm && confirm.kind !== 'remote') popRef.current?.querySelector<HTMLElement>('.attention-card__button--primary, .attention-card__button--danger')?.focus()
  }, [confirm])
  const edit = (next: Editing | undefined): void => {
    setEditing(next)
    if (!next) popRef.current?.querySelector<HTMLElement>('.branch-pop__search input')?.focus()
  }

  const shortcutRef = useRef<(shortcut: PopupShortcut) => void>(() => {})
  shortcutRef.current = (shortcut) => {
    if (busy || confirm) return
    if (shortcut === 'pull' && view.branch && !view.merging) askRemote('pull')
    if (shortcut === 'newBranch' && view.hasCommits) setEditing('branch')
  }
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.isComposing) return
      const shortcut = popupShortcut(event, mac)
      if (!shortcut) return
      event.preventDefault()
      event.stopPropagation()
      shortcutRef.current(shortcut)
    }
    window.addEventListener('keydown', onKey, true) // 터미널 ⌘T(useTerminalKeys)보다 먼저 — 그쪽은 팝업이 열려 있으면 물러난다
    return () => window.removeEventListener('keydown', onKey, true)
  }, [mac])

  async function run(action: GitAction): Promise<boolean> {
    setBusy(true)
    setError(undefined)
    try {
      const result = await window.litecode.gitRun(directory, action)
      if (result.ok) return true
      if (result.reason === 'no-remote') setConfirm({ kind: 'remote', then: action.kind === 'pull' ? 'pull' : 'push' })
      else if (result.reason === 'conflict') {
        onClose()
        openGitTab(directory, 'changes') // 충돌 카드(파일·가져오기 취소)는 Git 탭에 있다
      } else setError({ text: t(`git.error.${result.reason}`), detail: result.message })
      return false
    } catch (failure) {
      setError({ text: t('git.error.failed'), detail: reason(failure) })
      return false
    } finally {
      setBusy(false)
      void refreshGit(directory)
    }
  }

  async function accept(value?: string): Promise<void> {
    const current = confirm
    if (!current) return
    if (current.kind === 'remote') {
      if (await run({ kind: 'addRemote', url: value ?? '' })) setConfirm(current.then ? { kind: current.then } : undefined)
      return
    }
    if (current.kind !== 'switch' && current.kind !== 'push' && current.kind !== 'pull') return
    setConfirm(undefined)
    const action: GitAction =
      current.kind === 'switch'
        ? { kind: current.via === 'remote' ? 'switchRemote' : current.via === 'revision' ? 'switchRevision' : 'switchBranch', name: current.name }
        : { kind: current.kind }
    if (await run(action)) onClose()
  }

  function onKeyDown(event: ReactKeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault() // 입력창의 Esc 두 번(답변 중지)은 이미 쓰인 Esc 를 세지 않는다
      event.stopPropagation()
      if (confirm) setConfirm(undefined)
      else if (editing) edit(undefined)
      else onClose()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const list = [...(popRef.current?.querySelectorAll<HTMLElement>('.branch-pop__search input, button.branch-pop__item:not(:disabled)') ?? [])]
    if (list.length === 0) return
    event.preventDefault()
    const at = list.indexOf(document.activeElement as HTMLElement)
    list[(at + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus()
  }

  return (
    <div className="branch-pop" role="dialog" aria-label={t('git.branches')} ref={popRef} onKeyDown={onKeyDown}>
      {error && (
        <p className="branch-pop__error" role="alert" title={error.detail}>
          {error.text}
        </p>
      )}
      {confirm ? (
        <ConfirmCard confirm={confirm} view={view} busy={busy} onCancel={() => setConfirm(undefined)} onAccept={accept} />
      ) : (
        <BranchList
          onOpenTab={() => {
            openGitTab(directory)
            onClose()
          }}
          view={view}
          branches={branches}
          remotes={remotes}
          busy={busy}
          mac={mac}
          editing={editing}
          onEdit={edit}
          onPull={() => askRemote('pull')}
          onPush={() => askRemote('push')}
          onCreate={async (name) => {
            if (await run({ kind: 'createBranch', name })) onClose()
          }}
          onRevision={(name) => {
            setEditing(undefined)
            setConfirm({ kind: 'switch', name, via: 'revision' })
          }}
          onSwitch={(name) => setConfirm({ kind: 'switch', name })}
          onSwitchRemote={(name) => setConfirm({ kind: 'switch', name, via: 'remote' })}
        />
      )}
    </div>
  )
}

/** 팝업의 목록 — 검색 칸부터 원격 브랜치까지 (시안 ② 의 줄 그대로). 검색하면 동작·브랜치를 이름으로 거르고 묶음·원격을 편다 */
export function BranchList({
  view,
  branches,
  remotes,
  busy,
  mac,
  editing,
  onEdit = () => {},
  onOpenTab = () => {},
  onPull,
  onPush,
  onCreate,
  onRevision,
  onSwitch,
  onSwitchRemote,
}: {
  view: GitStatus
  branches: GitBranch[] | undefined
  remotes: string[]
  busy: boolean
  mac: boolean
  editing?: Editing
  onEdit?(editing: Editing | undefined): void
  /** 검색 줄 오른쪽 — 오른쪽 패널의 Git 탭을 연다 */
  onOpenTab?(): void
  onPull(): void
  onPush(): void
  onCreate(name: string): void
  onRevision(name: string): void
  onSwitch(name: string): void
  onSwitchRemote(name: string): void
}) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [opened, setOpened] = useState<Map<string, boolean>>(new Map())
  const searching = query.trim() !== ''
  const shown = (branches ?? []).filter((branch) => matchesQuery(branch.name, query))
  const shownRemotes = remotes.filter((name) => matchesQuery(name, query))
  /** 묶음·원격이 펼쳐졌나 — 누르기 전엔 지금 브랜치가 든 묶음만 펼침, 검색 중엔 모두 */
  const isOpen = (key: string, initially: boolean): boolean => searching || (opened.get(key) ?? initially)
  const toggle = (key: string, initially: boolean): void => setOpened((now) => new Map(now).set(key, !(now.get(key) ?? initially)))

  const branchRow = (branch: GitBranch, lead: ReactNode, child = false) => {
    const track = branchTrack(branch)
    return (
      <button
        key={branch.name}
        type="button"
        className={`branch-pop__item${child ? ' branch-pop__item--child' : ''}`}
        disabled={branch.current || busy}
        aria-current={branch.current || undefined}
        onClick={() => onSwitch(branch.name)}
      >
        {lead}
        <span className="branch-pop__name git-mono" title={branch.name}>
          {branch.name}
        </span>
        {branch.current && (
          <span className="branch-pop__dot" aria-label={t('git.pop.current')}>
            ●
          </span>
        )}
        {track ? <span className="branch-pop__tr">{track}</span> : branch.upstream && <span className="branch-pop__up">{branch.upstream}</span>}
      </button>
    )
  }

  const pullLabel = t('git.pop.pull')
  const pushLabel = t('git.push')
  const newLabel = t('git.pop.newBranch')
  const revisionLabel = t('git.pop.revision')
  const remoteOff = busy || view.merging || !view.branch

  const sync: ReactNode[] = []
  if (matchesQuery(pullLabel, query))
    sync.push(
      <button key="pull" type="button" className="branch-pop__item" disabled={remoteOff} onClick={onPull}>
        <span className="branch-pop__name">{pullLabel}</span>
        <span className="branch-pop__sc">{shortcutLabel('pull', mac)}</span>
      </button>,
    )
  if (matchesQuery(pushLabel, query))
    sync.push(
      <button key="push" type="button" className="branch-pop__item" disabled={remoteOff || !view.hasCommits} onClick={onPush}>
        <span className="branch-pop__name">{pushLabel}</span>
        {view.ahead > 0 && <span className="branch-pop__tr">{`↑${view.ahead}`}</span>}
      </button>,
    )

  const make: ReactNode[] = []
  if (editing === 'branch')
    make.push(<InlineField key="new" icon={<PlusIcon />} label={t('git.newBranchLabel')} busy={busy} onSubmit={onCreate} onCancel={() => onEdit(undefined)} />)
  else if (matchesQuery(newLabel, query))
    make.push(
      <button key="new" type="button" className="branch-pop__item" disabled={busy || !view.hasCommits} onClick={() => onEdit('branch')}>
        <PlusIcon />
        <span className="branch-pop__name">{newLabel}</span>
        <span className="branch-pop__sc">{shortcutLabel('newBranch', mac)}</span>
      </button>,
    )
  if (editing === 'revision')
    make.push(<InlineField key="revision" icon={<span className="branch-pop__lead" />} label={t('git.pop.revisionLabel')} busy={busy} onSubmit={onRevision} onCancel={() => onEdit(undefined)} />)
  else if (matchesQuery(revisionLabel, query))
    make.push(
      <button key="revision" type="button" className="branch-pop__item" disabled={busy || !view.hasCommits} onClick={() => onEdit('revision')}>
        <span className="branch-pop__lead" />
        <span className="branch-pop__name">{revisionLabel}</span>
      </button>,
    )

  const blocks: ReactNode[] = [sync, make].filter((block) => block.length > 0)
  if (branches === undefined) blocks.push(<p key="loading" className="branch-pop__empty">{t('filePreview.loading')}</p>)
  else {
    const recent = recentBranches(shown)
    if (recent.length > 0)
      blocks.push([
        <div key="recent-label" className="branch-pop__label">
          {t('git.pop.recent')}
        </div>,
        ...recent.map((branch) => (
          <Fragment key={`recent-${branch.name}`}>
            {branchRow(branch, branch.current ? <PopBranchIcon /> : branch.upstream && !branchTrack(branch) ? <CheckIcon /> : <span className="branch-pop__lead" />)}
          </Fragment>
        )),
      ])
    const entries = groupBranches(shown)
    if (entries.length > 0)
      blocks.push([
        <div key="local-label" className="branch-pop__label">
          {t('git.pop.local')}
        </div>,
        ...entries.map((entry) => {
          if (entry.kind === 'branch') return branchRow(entry.branch, <span className="branch-pop__lead branch-pop__lead--wide" />)
          const initially = entry.branches.some((branch) => branch.current)
          const open = isOpen(`group:${entry.prefix}`, initially)
          return (
            <Fragment key={`group:${entry.prefix}`}>
              <button type="button" className="branch-pop__item" aria-expanded={open} onClick={() => toggle(`group:${entry.prefix}`, initially)}>
                <ChevronIcon open={open} />
                <FolderIcon />
                <span className="branch-pop__name">{entry.prefix}</span>
                <span className="branch-pop__tr">{t('git.pop.count', { count: entry.branches.length })}</span>
              </button>
              {open && entry.branches.map((branch) => branchRow(branch, null, true))}
            </Fragment>
          )
        }),
      ])
    if (shownRemotes.length > 0) {
      const open = isOpen('remote', false)
      blocks.push([
        <button key="remote" type="button" className="branch-pop__item branch-pop__item--muted" aria-expanded={open} onClick={() => toggle('remote', false)}>
          <ChevronIcon open={open} />
          <span className="branch-pop__name">{t('git.pop.remote')}</span>
          <span className="branch-pop__tr">{t('git.pop.count', { count: shownRemotes.length })}</span>
        </button>,
        ...(open
          ? shownRemotes.map((name) => (
              <button key={`remote:${name}`} type="button" className="branch-pop__item branch-pop__item--child" disabled={busy || name.slice(name.indexOf('/') + 1) === view.branch} onClick={() => onSwitchRemote(name)}>
                <span className="branch-pop__name git-mono" title={name}>
                  {name}
                </span>
              </button>
            ))
          : []),
      ])
    }
    if (blocks.length === 0) blocks.push(<p key="empty" className="branch-pop__empty">{t('git.pop.empty')}</p>)
  }

  return (
    <>
      <label className="branch-pop__search">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5L14 14" />
        </svg>
        <input aria-label={t('git.pop.search')} placeholder={t('git.pop.search')} value={query} autoFocus={!editing} onChange={(event) => setQuery(event.target.value)} />
        <button
          type="button"
          className="branch-pop__tab"
          aria-label={t('git.pop.openTab')}
          title={t('git.pop.openTab')}
          onClick={onOpenTab}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <rect x="2" y="3" width="12" height="10" rx="2" />
            <path d="M10 3v10" />
          </svg>
        </button>
      </label>
      {blocks.map((block, index) => (
        <Fragment key={index}>
          {index > 0 && <div className="branch-pop__sep" />}
          {block}
        </Fragment>
      ))}
    </>
  )
}

/** 팝업 안의 한 줄 입력 (새 브랜치 이름·태그/커밋) — Enter 로 보내고 Esc 로 접는다 */
function InlineField({ icon, label, busy, onSubmit, onCancel }: { icon: ReactNode; label: string; busy: boolean; onSubmit(value: string): void; onCancel(): void }) {
  const [value, setValue] = useState('')
  return (
    <form
      className="branch-pop__edit"
      onSubmit={(event) => {
        event.preventDefault()
        if (value.trim() && !busy) onSubmit(value.trim())
      }}
    >
      {icon}
      <input
        className="git-mono"
        aria-label={label}
        placeholder={label}
        value={value}
        autoFocus
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          onCancel()
        }}
      />
    </form>
  )
}

// 시안의 그림 (13px·12px) — 지금 브랜치(가지)·올려 둔 브랜치(✓)·+·접기 화살표·폴더
function PopBranchIcon() {
  return (
    <svg className="branch-pop__icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="4" cy="3.5" r="1.7" />
      <circle cx="4" cy="12.5" r="1.7" />
      <circle cx="12" cy="6" r="1.7" />
      <path d="M4 5.2v5.6M12 7.7c0 2.5-2 2.8-8 3.3" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg className="branch-pop__icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M2.5 8.5l3 3 8-8" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg className="branch-pop__icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M8 3v10M3 8h10" />
    </svg>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg className="branch-pop__icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d={open ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'} />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg className="branch-pop__icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M2 4.5h4l1.5 1.5H14v6.5H2z" />
    </svg>
  )
}

export function GitPanel({ directory, gitSub }: { directory: string; gitSub?: PanelState['gitSub'] }) {
  const t = useT()
  const view = useGitView(directory)
  const [sub, setSub] = useState<Sub>(gitSub?.sub ?? 'changes')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<Confirm>()
  const [notice, setNotice] = useState<Notice>()
  const [remoteFail, setRemoteFail] = useState<'push' | 'pull'>()
  const [message, setMessageState] = useState(() => drafts.get(directory) ?? '')
  const setMessage = (text: string): void => {
    drafts.set(directory, text)
    setMessageState(text)
  }
  // 마지막 커밋 고치기 (#387) — 체크하면 마지막 커밋 메시지를 채우고, 풀면 체크 전 초안으로 돌린다
  const [amend, setAmend] = useState(false)
  const [last, setLast] = useState<GitLastCommit>()
  const [stashes, setStashes] = useState<GitStash[]>()
  const draftBeforeAmend = useRef('')
  const hasCommits = view?.state === 'ok' && view.hasCommits

  useEffect(() => void refreshGit(directory), [directory])
  useEffect(() => {
    setAmend(false)
    setLast(undefined)
    setStashes(undefined)
  }, [directory])
  // 보관함 (#389) — 변경 탭에서 상태가 바뀔 때마다 다시 읽는다 (보관은 AI·터미널에서도 바뀐다)
  useEffect(() => {
    if (sub !== 'changes' || view?.state !== 'ok') return
    let live = true
    window.litecode.gitStashes(directory).then(
      (list) => live && setStashes(list),
      () => {},
    )
    return () => {
      live = false
    }
  }, [directory, view, sub])
  useEffect(() => {
    // 다시 읽는 동안 옛 값을 둔다 — 지우면 체크·버튼 글이 깜빡인다
    if (!hasCommits) setLast(undefined)
    if (sub !== 'changes' || !hasCommits) return
    let live = true
    window.litecode.gitLastCommit(directory).then(
      (commit) => live && setLast(commit),
      () => {},
    )
    return () => {
      live = false
    }
  }, [directory, view, sub, hasCommits])
  useEffect(() => {
    if (gitSub) setSub(gitSub.sub)
  }, [gitSub?.seq])

  /** 작업 하나 — 끝나면 다시 읽는다. 실패는 사유별로: 원격 실패는 상태 카드, 원격 없음은 주소 칸, 그 밖은 한 줄 */
  async function run<T extends object>(action: GitAction): Promise<GitResult<T> | undefined> {
    setBusy(true)
    setNotice(undefined)
    try {
      const result = (await window.litecode.gitRun(directory, action)) as GitResult<T>
      if (!result.ok) {
        if (result.reason === 'auth' || result.reason === 'network') setRemoteFail(action.kind === 'pull' ? 'pull' : 'push')
        else if (result.reason === 'no-remote') setConfirm({ kind: 'remote', then: action.kind === 'pull' ? 'pull' : 'push' })
        else if (result.reason !== 'conflict') setNotice({ tone: 'error', text: t(`git.error.${result.reason}`), detail: result.message })
      } else if (action.kind === 'push' || action.kind === 'pull') setRemoteFail(undefined)
      return result
    } catch (error) {
      setNotice({ tone: 'error', text: t('git.error.failed'), detail: reason(error) })
      return undefined
    } finally {
      setBusy(false)
      void refreshGit(directory)
    }
  }

  if (view === undefined) return <p className="file-preview__empty">{t('filePreview.loading')}</p>
  if (view.state === 'missing')
    return (
      <State title={t('git.missingTitle')} body={t('git.missingBody')}>
        <button type="button" className="file-preview__toggle" onClick={() => void refreshGit(directory)}>
          {t('git.recheck')}
        </button>
      </State>
    )
  if (view.state === 'not-repo')
    return (
      <State title={t('git.notRepoTitle')} body={t('git.notRepoBody')}>
        <button type="button" className="attention-card__button attention-card__button--primary git-mono" disabled={busy} onClick={() => void run({ kind: 'init' })}>
          {t('git.init')}
        </button>
      </State>
    )

  const branch = view.branch ?? t('git.detached')
  const remoteUrl = gitWebUrl(view.remote)
  const askRemote = (kind: 'push' | 'pull'): void => {
    setNotice(undefined)
    setConfirm(view.remote ? { kind } : { kind: 'remote', then: kind })
  }

  return (
    <div className="git">
      <div className="file-preview__bar git-bar">
        <button type="button" className="file-preview__toggle git-branch" title={branch} onClick={() => setSub('branches')}>
          <BranchIcon />
          <span className="git-branch__name">{branch}</span>
        </button>
        {(view.ahead > 0 || view.behind > 0) && <span className="git-bar__track">{`↑${view.ahead} ↓${view.behind}`}</span>}
        <span className="git-bar__spacer" />
        <span className="file-preview__tools">
          <button type="button" className="file-preview__toggle" disabled={busy || view.merging} onClick={() => askRemote('pull')}>
            {t('git.pull')}
          </button>
          <button type="button" className="file-preview__toggle" disabled={busy || view.merging || !view.hasCommits} onClick={() => askRemote('push')}>
            {t('git.push')}
          </button>
          <ReloadButton onClick={() => void refreshGit(directory)} />
        </span>
      </div>
      <div className="git-sub">
        <div className="git-sub__tabs" role="tablist" aria-label={t('git.tab')}>
          {(['changes', 'log', 'branches'] as const).map((id) => (
            <button key={id} type="button" role="tab" className="git-sub__tab" aria-selected={sub === id} onClick={() => setSub(id)}>
              {t(`git.${id}`)}
            </button>
          ))}
        </div>
        {sub === 'changes' && <FoldAllButton directory={directory} view={view} />}
        {sub === 'changes' && <StashButton directory={directory} view={view} stashes={stashes ?? []} onNotice={setNotice} />}
      </div>
      {notice && (
        <NoticeLine notice={notice} onClose={() => setNotice(undefined)}>
          {notice.undo && (
            <button
              type="button"
              className="git-link"
              disabled={busy}
              onClick={async () => {
                const undone = await run<{ short: string }>({ kind: 'undoCommit' })
                if (undone?.ok) setNotice({ tone: 'ok', text: t('git.undone', { hash: undone.short }) })
              }}
            >
              {t('git.undo')}
            </button>
          )}
          {notice.remote && remoteUrl && (
            <button type="button" className="git-link" onClick={() => void window.litecode.openGitRemote(directory)}>
              {t('git.openRemote')}
            </button>
          )}
        </NoticeLine>
      )}
      <div className="file-preview__body git-body">
        {remoteFail && (
          <div className="git-cards">
            <div className="git-state git-state--card" role="alert">
              <span className="git-state__title">{t('git.remoteFailTitle')}</span>
              <span className="git-state__body">{t('git.remoteFailBody')}</span>
              <span className="git-state__row">
                <button type="button" className="file-preview__toggle" disabled={busy} onClick={() => void remote(remoteFail)}>
                  {t('git.retry')}
                </button>
                <button type="button" className="file-preview__toggle" onClick={() => setRemoteFail(undefined)}>
                  {t('git.cancel')}
                </button>
              </span>
            </div>
          </div>
        )}
        {confirm && (
          <div className="git-cards">
            <ConfirmCard confirm={confirm} view={view} busy={busy} onCancel={() => setConfirm(undefined)} onAccept={accept} />
          </div>
        )}
        {sub === 'changes' && (
          <ChangesView
            directory={directory}
            view={view}
            busy={busy}
            onRun={run}
            onDiscard={(file) => setConfirm({ kind: 'discard', file })}
            onFileAction={fileAction}
          />
        )}
        {sub === 'log' && <LogView directory={directory} view={view} />}
        {sub === 'branches' && <BranchesView directory={directory} view={view} busy={busy} onRun={run} onSwitch={(name) => setConfirm({ kind: 'switch', name })} onDelete={(branch) => setConfirm({ kind: 'delete', branch })} />}
      </div>
      {sub === 'changes' && (
        <CommitBox
          view={view}
          last={last}
          message={message}
          amend={amend}
          busy={busy}
          mac={navigator.platform.startsWith('Mac')}
          onMessage={setMessage}
          onAmend={(checked) => {
            setAmend(checked)
            if (checked) {
              draftBeforeAmend.current = message
              if (last) setMessage(last.message)
            } else setMessage(draftBeforeAmend.current)
          }}
          onCommit={(push) => void commit(push)}
        />
      )}
    </div>
  )

  /** 커밋(고치기) — push 면 이어서 올린다 (#387). 올리기가 실패해도 커밋은 남고, 한 줄이 그 사실과 이유를 말한다 */
  async function commit(push: boolean): Promise<void> {
    if (view?.state !== 'ok') return
    const controls = commitControls(view, last, amend, message, busy)
    if (!(push ? controls.canPush : controls.canCommit)) return
    const outcome = await commitThenPush((action) => run(action), message, controls.amending, push)
    if (!outcome) return
    setMessage('')
    setAmend(false)
    setNotice(commitNotice(t, outcome))
  }

  /** 우클릭 메뉴의 항목 (#389) — 변경 보기는 ChangesView 가 직접 편다. 커밋·보관·삭제·되돌리기는 확인 카드부터 */
  function fileAction(item: FileMenuItem, entry: ChangeEntry): void {
    setNotice(undefined)
    if (item === 'commitFile' || item === 'stash' || item === 'trash') setConfirm({ kind: item, entry })
    else if (item === 'discard' && entry.changed) setConfirm({ kind: 'discard', file: entry.changed })
    else if (item === 'preview') openFilePreview(directory, entry.path)
    else if (item === 'copyPatch') void copyPatch(entry)
  }

  /** 패치로 복사 — HEAD 대비(stage 된 것 + 안 된 것, 새 파일은 통째) diff 를 클립보드에 */
  async function copyPatch(entry: ChangeEntry): Promise<void> {
    try {
      const patch = await window.litecode.gitDiff(directory, entry.path, 'head')
      if (!patch) return setNotice({ tone: 'error', text: t('git.patchEmpty') })
      await navigator.clipboard.writeText(patch)
      setNotice({ tone: 'ok', text: t('git.patchCopied') })
    } catch (error) {
      setNotice({ tone: 'error', text: t('git.error.failed'), detail: reason(error) })
    }
  }

  /** 파일 삭제 — 휴지통으로 (메인 shell.trashItem, 프로젝트 안 파일만) */
  async function trash(file: string): Promise<void> {
    setBusy(true)
    try {
      const result = await window.litecode.gitTrash(directory, file)
      setNotice(result.ok ? { tone: 'ok', text: t('git.trashed', { file }) } : { tone: 'error', text: t(`git.error.${result.reason}`), detail: result.message })
    } catch (error) {
      setNotice({ tone: 'error', text: t('git.error.failed'), detail: reason(error) })
    } finally {
      setBusy(false)
      void refreshGit(directory)
    }
  }

  async function remote(kind: 'push' | 'pull'): Promise<void> {
    const result = await run<{ branch?: string }>({ kind })
    if (!result?.ok) return
    setNotice(kind === 'push' ? { tone: 'ok', text: t('git.pushedNote', { branch: result.branch ?? '' }), remote: true } : { tone: 'ok', text: t('git.pulledNote') })
  }

  async function accept(value?: string): Promise<void> {
    const current = confirm
    if (!current) return
    if (current.kind === 'remote') {
      const added = await run({ kind: 'addRemote', url: value ?? '' })
      if (!added?.ok) return
      setConfirm(current.then ? { kind: current.then } : undefined)
      return
    }
    setConfirm(undefined)
    if (current.kind === 'push' || current.kind === 'pull') return remote(current.kind)
    if (current.kind === 'switch') return void (await run({ kind: 'switchBranch', name: current.name }))
    if (current.kind === 'discard') return void (await run({ kind: 'discard', paths: [current.file.path] }))
    if (current.kind === 'delete') return void (await run({ kind: 'deleteBranch', name: current.branch.name }))
    if (current.kind === 'commitFile') {
      const done = await run<{ short: string; files: number }>({ kind: 'commitPaths', paths: entryPaths(current.entry), message: value ?? '' })
      if (done?.ok) setNotice({ tone: 'ok', text: t('git.committed', { hash: done.short, count: done.files }), undo: true })
      return
    }
    if (current.kind === 'stash') {
      const done = await run({ kind: 'stash', paths: entryPaths(current.entry), message: value ?? '' })
      if (done?.ok) setNotice({ tone: 'ok', text: t('git.stashed', { file: current.entry.path }) })
      return
    }
    if (current.kind === 'trash') return trash(current.entry.path)
  }
}

/** 커밋 영역 (#387, 시안 ① 맨 아래) — 메시지 칸(제목 줄 + 둘째 줄 자리 표시) · 마지막 커밋 고치기 체크(올리기 전만)와 ⌘↵ · 두 버튼(주: 커밋, 커밋하고 올리기).
 *  막힌 체크·버튼은 이유를 title 로 (시안의 체크 줄도 title). ⌘/Ctrl+Enter = 주 버튼 */
export function CommitBox({
  view,
  last,
  message,
  amend,
  busy,
  mac,
  onMessage,
  onAmend,
  onCommit,
}: {
  view: GitStatus
  last: GitLastCommit | undefined
  message: string
  amend: boolean
  busy: boolean
  mac: boolean
  onMessage(text: string): void
  onAmend(checked: boolean): void
  onCommit(push: boolean): void
}) {
  const t = useT()
  const controls = commitControls(view, last, amend, message, busy)
  return (
    <div className="git-commit">
      <div className="git-commit__box">
        <textarea
          className="git-commit__input"
          aria-label={t('git.commitLabel')}
          placeholder={t('git.commitPlaceholder')}
          value={message}
          rows={3}
          onChange={(event) => onMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
              event.preventDefault()
              onCommit(false)
            }
          }}
        />
        {!message.includes('\n') && (
          <span className="git-commit__more" aria-hidden="true">
            {t('git.commitMore')}
          </span>
        )}
      </div>
      <div className="git-commit__row">
        <label className="git-commit__amend" title={controls.amendBlock ? t(`git.amendBlock.${controls.amendBlock}`) : t('git.amendTitle')}>
          <input type="checkbox" className="git-check" checked={controls.amending} disabled={busy || !controls.amendable} onChange={(event) => onAmend(event.target.checked)} />
          {t('git.amend')} <span className="git-commit__note">{t('git.amendNote')}</span>
        </label>
        <span className="git-commit__key">{mac ? '⌘↵' : 'Ctrl+↵'}</span>
      </div>
      <div className="git-commit__buttons">
        <button type="button" className="attention-card__button attention-card__button--primary" disabled={!controls.canCommit} onClick={() => onCommit(false)}>
          {controls.amending ? t('git.amendCommit') : t('git.commit', { count: view.staged.length })}
        </button>
        <button
          type="button"
          className="attention-card__button"
          disabled={!controls.canPush}
          title={controls.pushBlock ? t(`git.pushBlock.${controls.pushBlock}`) : undefined}
          onClick={() => onCommit(true)}
        >
          {controls.amending ? t('git.amendPush') : t('git.commitPush')}
        </button>
      </div>
    </div>
  )
}

function State({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  return (
    <div className="git-state">
      <span className="git-state__title">{title}</span>
      <span className="git-state__body">{body}</span>
      {children && <span className="git-state__row">{children}</span>}
    </div>
  )
}

function NoticeLine({ notice, onClose, children }: { notice: Notice; onClose(): void; children?: ReactNode }) {
  const [hover, setHover] = useState(false)
  // 성공 한 줄은 3초 뒤 사라진다 (시안) — 올려 둔 동안은 남는다(실행 취소를 누를 수 있게). 오류는 닫을 때까지
  useEffect(() => {
    if (notice.tone !== 'ok' || hover) return
    const timer = setTimeout(onClose, notice.undo || notice.remote ? NOTICE_MS * 2 : NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice, hover])
  return (
    <p className="file-preview__notice git-notice" data-tone={notice.tone} role={notice.tone === 'error' ? 'alert' : 'status'} title={notice.detail} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {notice.tone === 'ok' && <span className="git-notice__check">✓</span>}
      <span className="git-notice__text">{notice.text}</span>
      {children}
    </p>
  )
}

// ── 변경 (#388 시안 ① — 구역 머리 '변경 N개 파일' · 폴더 트리 · 접힌 '새 파일' 구역. 체크 = stage) ──

/** 들여쓰기 — 시안: 폴더 줄 26px, 그 안의 파일 46px (한 단계 20px) */
const indent = (depth: number): number => 26 + depth * 20

function ChangesView({
  directory,
  view,
  busy,
  onRun,
  onDiscard,
  onFileAction,
}: {
  directory: string
  view: GitStatus
  busy: boolean
  onRun(action: GitAction): Promise<unknown>
  onDiscard(file: GitFile): void
  onFileAction(item: FileMenuItem, entry: ChangeEntry): void
}) {
  const t = useT()
  const mac = navigator.platform.startsWith('Mac')
  // diff 를 펼친 파일·고른 줄(시안 .file.sel)·우클릭 메뉴 (#389) — 메뉴의 '변경 보기' 가 그 줄의 diff 를 편다
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set())
  const [selected, setSelected] = useState<string>()
  const [menu, setMenu] = useState<{ entry: ChangeEntry; at: { left: number; top: number }; trigger: HTMLElement | null }>()
  useEffect(() => {
    setOpened(new Set())
    setSelected(undefined)
    setMenu(undefined)
  }, [directory])
  const toggleOpen = (path: string, open?: boolean): void =>
    setOpened((now) => {
      const next = new Set(now)
      if (open ?? !now.has(path)) next.add(path)
      else next.delete(path)
      return next
    })
  const pick = (item: FileMenuItem, entry: ChangeEntry): void => {
    if (!menuEnabled(item, entry, view)) return
    if (item === 'showDiff') toggleOpen(entry.path, true)
    else onFileAction(item, entry)
  }
  const closeMenu = (): void => {
    menu?.trigger?.focus()
    setMenu(undefined)
  }
  const rows: FileRowControls = {
    mac,
    opened,
    selected,
    onToggleOpen: (path) => toggleOpen(path),
    onSelect: setSelected,
    onMenu: (entry, at, trigger) => {
      setSelected(entry.path)
      setMenu({ entry, at, trigger })
    },
    onPick: pick,
  }
  const conflicts = view.conflicts
  const { tracked, untracked } = useMemo(() => {
    const split = splitChanges(view)
    return { tracked: buildTree(split.tracked), untracked: buildTree(split.untracked) }
  }, [view])
  const folds = foldsOf(directory)
  const untrackedOpen = isFoldOpen(folds, SECTION_UNTRACKED)
  const stage = (entries: readonly ChangeEntry[]) => () => void onRun(toggleAction(entries))
  return (
    <>
      {(view.merging || conflicts.length > 0) && (
        <div className="git-cards">
          <div className="attention-card git-confirm" data-tone="danger" role="alert">
            <div className="attention-card__strip">
              <span className="attention-card__dot" aria-hidden="true" />
              {t(view.merging ? 'git.conflictTitle' : 'git.conflictFiles', { count: conflicts.length })}
            </div>
            <div className="attention-card__body">
              {conflicts.map((file) => (
                <button key={file.path} type="button" className="attention-card__command git-conflict" onClick={() => openFilePreview(directory, file.path)}>
                  {`U ${file.path}`}
                </button>
              ))}
              <span className="git-card__note">{t(view.merging ? 'git.conflictNote' : 'git.conflictNoteFiles')}</span>
            </div>
            <div className="attention-card__actions">
              {conflicts[0] && (
                <button type="button" className="attention-card__button" onClick={() => openFilePreview(directory, conflicts[0]!.path)}>
                  {t('git.openFile')}
                </button>
              )}
              {view.merging && (
                <button type="button" className="attention-card__button attention-card__button--danger" disabled={busy} onClick={() => void onRun({ kind: 'abortMerge' })}>
                  {t('git.abortMerge')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {tracked.all.length === 0 && untracked.all.length === 0 && <p className="git-empty">{t('git.clean')}</p>}
      {tracked.all.length > 0 && (
        <>
          <div className="git-sec">
            <Check state={groupState(tracked.all)} label={t('git.stageChanges')} busy={busy} onToggle={stage(tracked.all)} />
            {t('git.changes')} <span className="git-sec__n">{t('git.fileCount', { count: tracked.all.length })}</span>
          </div>
          <Tree directory={directory} section="c" root={tracked} busy={busy} onRun={onRun} onDiscard={onDiscard} rows={rows} />
        </>
      )}
      {untracked.all.length > 0 && (
        <>
          <div className="git-sec git-sec--untracked">
            <Check state={groupState(untracked.all)} label={t('git.stageUntracked')} busy={busy} onToggle={stage(untracked.all)} />
            <button type="button" className="git-sec__toggle" aria-expanded={untrackedOpen} onClick={() => toggleGitFold(directory, SECTION_UNTRACKED)}>
              <svg className="git-sec__chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                <path d="M3.5 2l3 3-3 3" />
              </svg>
              {t('git.untracked')} <span className="git-sec__n">{t('git.untrackedNote', { count: untracked.all.length })}</span>
            </button>
          </div>
          {untrackedOpen && <Tree directory={directory} section="u" root={untracked} busy={busy} onRun={onRun} onDiscard={onDiscard} rows={rows} />}
        </>
      )}
      {menu && (
        <FileMenu
          entry={menu.entry}
          view={view}
          mac={mac}
          at={menu.at}
          onClose={closeMenu}
          onPick={(item) => {
            closeMenu()
            pick(item, menu.entry)
          }}
        />
      )}
    </>
  )
}

/** 파일 줄이 ChangesView 와 나누는 것 (#389) — diff 펼침·고른 줄·우클릭 메뉴·단축키 */
interface FileRowControls {
  mac: boolean
  opened: ReadonlySet<string>
  selected: string | undefined
  onToggleOpen(path: string): void
  onSelect(path: string): void
  onMenu(entry: ChangeEntry, at: { left: number; top: number }, trigger: HTMLElement | null): void
  onPick(item: FileMenuItem, entry: ChangeEntry): void
}

/** 변경 파일 우클릭 메뉴 (#389, 시안 ① .menu — 236 폭·10 모서리·5 여백, 항목 26·구분선 .5px, 오른쪽 단축키 글자, 삭제는 빨강).
 *  마우스 자리(키보드로 열면 줄 아래)에 fixed 로 뜨고 창 밖으로 나가지 않게 당긴다. 동작은 + 메뉴(PlusMenu)와 같다:
 *  Esc·바깥 누르기·Tab 으로 닫히고(포커스는 그 줄로), 화살표로 이동. 열린 동안 단축키도 그 항목을 고른다 */
export function FileMenu({
  entry,
  view,
  mac,
  at,
  onPick,
  onClose,
}: {
  entry: ChangeEntry
  view: Pick<GitStatus, 'merging' | 'hasCommits'>
  mac: boolean
  at: { left: number; top: number }
  onPick(item: FileMenuItem): void
  onClose(): void
}) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState(at)
  const items = (): HTMLElement[] => [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])]
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    setPlace({ left: Math.max(4, Math.min(at.left, window.innerWidth - rect.width - 4)), top: Math.max(4, Math.min(at.top, window.innerHeight - rect.height - 4)) })
  }, [at.left, at.top])

  useEffect(() => {
    items()[0]?.focus()
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) closeRef.current()
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [])

  function onKeyDown(event: ReactKeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      onClose()
      return
    }
    const shortcut = event.nativeEvent.isComposing ? undefined : menuShortcut(event, mac)
    if (shortcut) {
      event.preventDefault()
      event.stopPropagation()
      if (menuEnabled(shortcut, entry, view)) onPick(shortcut)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const list = items()
    const index = list.indexOf(document.activeElement as HTMLElement)
    list[(index + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus()
  }

  return (
    <div className="git-menu" role="menu" aria-label={t('git.menu.label', { file: splitPath(entry.path).name })} style={{ left: place.left, top: place.top }} ref={ref} onKeyDown={onKeyDown}>
      {FILE_MENU.map((group, index) => (
        <Fragment key={index}>
          {index > 0 && <div className="git-menu__sep" role="separator" />}
          {group.map((item) => {
            const shortcut = menuShortcutLabel(item, mac)
            return (
              <button key={item} type="button" role="menuitem" className="git-menu__item" data-danger={DANGER_ITEMS.has(item) || undefined} disabled={!menuEnabled(item, entry, view)} onClick={() => onPick(item)}>
                {t(`git.menu.${item}`)}
                {shortcut && <span className="git-menu__sc">{shortcut}</span>}
              </button>
            )
          })}
        </Fragment>
      ))}
    </div>
  )
}

/** 모두 접기·펴기 (시안 하위 탭 줄 오른쪽) — 지금 보이는 폴더·새 파일 구역을 한꺼번에 */
function FoldAllButton({ directory, view }: { directory: string; view: GitStatus }) {
  const t = useT()
  const keys = useMemo(() => {
    const split = splitChanges(view)
    return [
      ...(split.untracked.length > 0 ? [SECTION_UNTRACKED] : []),
      ...treeFolders(buildTree(split.tracked)).map((folder) => folderKey('c', folder.path)),
      ...treeFolders(buildTree(split.untracked)).map((folder) => folderKey('u', folder.path)),
    ]
  }, [view])
  return (
    <button type="button" className="git-sub__tool" aria-label={t('git.foldAll')} title={t('git.foldAll')} disabled={keys.length === 0} onClick={() => toggleAllGitFolds(directory, keys)}>
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d="M4 6l4-3 4 3M4 10l4 3 4-3" />
      </svg>
    </button>
  )
}

/** 시안의 체크(.cb) — 14px·모서리 4px, 켜짐 ✓·일부 −. 진짜 체크 상자(키보드·스크린 리더 그대로), 일부는 indeterminate */
function Check({ state, label, busy, onToggle }: { state: CheckState; label: string; busy: boolean; onToggle(): void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'mix'
  }, [state])
  return <input ref={ref} type="checkbox" className="git-check" data-state={state} checked={state === 'on'} disabled={busy} aria-label={label} onChange={onToggle} />
}

function Tree({
  directory,
  section,
  root,
  busy,
  onRun,
  onDiscard,
  rows: controls,
}: {
  directory: string
  section: 'c' | 'u'
  root: TreeFolder
  busy: boolean
  onRun(action: GitAction): Promise<unknown>
  onDiscard(file: GitFile): void
  rows: FileRowControls
}) {
  const t = useT()
  const folds = foldsOf(directory)
  const rows = treeRows(root, (folder) => isFoldOpen(folds, folderKey(section, folder.path)))
  return (
    <ul className="git-tree">
      {rows.map((row) => {
        if (row.kind === 'file')
          return <FileRow key={row.entry.path} directory={directory} entry={row.entry} depth={row.depth} busy={busy} onRun={onRun} onDiscard={onDiscard} controls={controls} />
        const { folder } = row
        return (
          <li key={`dir:${folder.path}`} className="git-dir" style={{ paddingLeft: indent(row.depth) }}>
            <Check state={groupState(folder.all)} label={t('git.stageFolder', { folder: folder.path })} busy={busy} onToggle={() => void onRun(toggleAction(folder.all))} />
            <button type="button" className="git-dir__toggle" aria-expanded={row.open} title={folder.path} onClick={() => toggleGitFold(directory, folderKey(section, folder.path))}>
              <svg className="git-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                <path d="M2 4.5h4l1.5 1.5H14v6.5H2z" />
              </svg>
              <span className="git-dir__name">{folder.name}</span>
              <span className="git-dir__count">{t('git.fileCount', { count: folder.all.length })}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** 파일 한 줄 (시안 .file) — 체크(stage)·상태 글자·이름·+N −N, 누르면 그 아래에 diff. 작업 트리 쪽 변경이 있으면 되돌리기 버튼.
 *  일부만 stage 된 파일은 diff 를 두 쪽(stage 된 것·안 된 것) 다 보인다.
 *  #389: 누르거나 포커스가 들면 고른 줄(시안 .file.sel), 우클릭·ContextMenu 키·Shift+F10 → 메뉴, 고른 줄에서 메뉴의 단축키(⌥⌘Z·⌘D·⌘↓) */
function FileRow({
  directory,
  entry,
  depth,
  busy,
  onRun,
  onDiscard,
  controls,
}: {
  directory: string
  entry: ChangeEntry
  depth: number
  busy: boolean
  onRun(action: GitAction): Promise<unknown>
  onDiscard(file: GitFile): void
  controls: FileRowControls
}) {
  const t = useT()
  const open = controls.opened.has(entry.path)
  const [patches, setPatches] = useState<string[]>()
  const { name } = splitPath(entry.path)
  const kind = entryKind(entry)
  const stat = entryStat(entry)
  const sides = [...(entry.staged ? [true] : []), ...(entry.changed ? [false] : [])]
  useEffect(() => {
    if (!open) return
    let live = true
    Promise.all(sides.map((staged) => window.litecode.gitDiff(directory, entry.path, staged))).then(
      (texts) => live && setPatches(texts),
      () => live && setPatches([]),
    )
    return () => {
      live = false
    }
  }, [open, directory, entry.path, sides.join(), stat?.added, stat?.removed])
  const diffs = useMemo<FileDiff[]>(
    () =>
      (patches ?? [])
        .filter((patch) => patch)
        .map((patch) => ({ path: entry.path, status: kind === 'D' ? 'deleted' : kind === 'U' || kind === 'A' ? 'added' : 'modified', added: stat?.added ?? 0, removed: stat?.removed ?? 0, patch })),
    [patches, entry.path, kind, stat?.added, stat?.removed],
  )
  const from = entry.staged?.from
  return (
    <li className="git-file" data-git-kind={kind}>
      <div
        className="git-file__row"
        data-selected={controls.selected === entry.path || undefined}
        style={{ paddingLeft: indent(depth) }}
        onMouseDown={() => controls.onSelect(entry.path)}
        onFocus={() => controls.onSelect(entry.path)}
        onContextMenu={(event) => {
          event.preventDefault()
          controls.onMenu(entry, { left: event.clientX, top: event.clientY }, event.currentTarget.querySelector<HTMLElement>('.git-file__toggle'))
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (isMenuKey(event)) {
            event.preventDefault()
            const rect = event.currentTarget.getBoundingClientRect()
            controls.onMenu(entry, { left: rect.left + indent(depth), top: rect.bottom }, event.currentTarget.querySelector<HTMLElement>('.git-file__toggle'))
            return
          }
          const item = menuShortcut(event, controls.mac)
          if (!item) return
          event.preventDefault()
          event.stopPropagation()
          controls.onPick(item, entry)
        }}
      >
        <Check state={entryState(entry)} label={t('git.stageFile', { file: entry.path })} busy={busy} onToggle={() => void onRun(toggleAction([entry]))} />
        <button type="button" className="git-file__toggle" aria-expanded={open} title={from ? `${from} → ${entry.path}` : entry.path} onClick={() => controls.onToggleOpen(entry.path)}>
          <span className="git-kind" data-kind={kind} aria-hidden="true">
            {kind}
          </span>
          <span className="git-file__name">{name}</span>
          {stat && (
            <>
              <span className="git-add">{`+${stat.added}`}</span>
              <span className="git-del">{`−${stat.removed}`}</span>
            </>
          )}
        </button>
        {entry.changed && (
          <button type="button" className="changed-files__open" disabled={busy} aria-label={t('git.discardFile', { file: entry.path })} title={t('git.discardFile', { file: entry.path })} onClick={() => onDiscard(entry.changed!)}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5.5 3.5L2.75 6.25L5.5 9" />
              <path d="M2.75 6.25H9.5C11.6 6.25 13.25 7.9 13.25 10S11.6 13.75 9.5 13.75H7" />
            </svg>
          </button>
        )}
      </div>
      {open && (
        <div className="git-diff" style={{ paddingLeft: indent(depth) }}>
          {patches === undefined ? null : diffs.length > 0 ? <DiffCard diffs={diffs} /> : <p className="git-empty">—</p>}
        </div>
      )}
    </li>
  )
}

// ── 보관함 (#389, 시안 ① 하위 탭 줄의 `보관함 N`) ──
// 누르면 버튼 아래로 보관 목록 팝업. 시안에 팝업 모양이 없어 브랜치 팝업(#386 .branch-pop)의 틀을 따른다:
// 줄 = 메시지·브랜치·시각 + [적용]·[삭제]. 적용 = stash pop(충돌이면 멈춘 채 알리고 보관은 남는다), 삭제 = 확인 카드(팝업 안) → stash drop.
// 실패는 팝업 위 한 줄. Esc·바깥으로 닫히고 포커스는 버튼으로

function StashButton({ directory, view, stashes, onNotice }: { directory: string; view: GitStatus; stashes: GitStash[]; onNotice(notice: Notice): void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  useEffect(() => setOpen(false), [directory])

  function close(): void {
    setOpen(false)
    buttonRef.current?.focus()
  }

  return (
    <div className="git-stash" ref={wrapRef}>
      <button type="button" className="git-sub__tool git-stash__button" aria-label={t('git.stashList')} aria-haspopup="dialog" aria-expanded={open} ref={buttonRef} onClick={() => (open ? close() : setOpen(true))}>
        {t('git.stashButton', { count: stashes.length })}
      </button>
      {open && <StashPopup directory={directory} view={view} stashes={stashes} onClose={close} onNotice={onNotice} />}
    </div>
  )
}

function StashPopup({ directory, view, stashes, onClose, onNotice }: { directory: string; view: GitStatus; stashes: GitStash[]; onClose(): void; onNotice(notice: Notice): void }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; detail?: string }>()
  const [confirm, setConfirm] = useState<Confirm>()
  const popRef = useRef<HTMLDivElement>(null)

  // 열면 첫 [적용], 확인 카드면 삭제 버튼 — 누른 줄이 사라져도 Esc 가 팝업에 닿게
  useEffect(() => {
    popRef.current?.querySelector<HTMLElement>(confirm ? '.attention-card__button--danger' : '.git-stash__apply:not(:disabled)')?.focus()
  }, [confirm])

  async function run(action: GitAction): Promise<boolean> {
    setBusy(true)
    setError(undefined)
    try {
      const result = await window.litecode.gitRun(directory, action)
      if (!result.ok) setError({ text: result.reason === 'conflict' ? t('git.stashConflict') : t(`git.error.${result.reason}`), detail: result.message })
      return result.ok
    } catch (failure) {
      setError({ text: t('git.error.failed'), detail: reason(failure) })
      return false
    } finally {
      setBusy(false)
      void refreshGit(directory)
    }
  }

  async function apply(stash: GitStash): Promise<void> {
    if (!(await run({ kind: 'stashPop', index: stash.index, hash: stash.hash }))) return
    onNotice({ tone: 'ok', text: t('git.stashApplied') })
    onClose()
  }

  async function accept(): Promise<void> {
    if (confirm?.kind !== 'dropStash') return
    const { stash } = confirm
    setConfirm(undefined)
    await run({ kind: 'stashDrop', index: stash.index, hash: stash.hash })
  }

  function onKeyDown(event: ReactKeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    if (confirm) setConfirm(undefined)
    else onClose()
  }

  return (
    <div className="branch-pop git-stash__pop" role="dialog" aria-label={t('git.stashList')} ref={popRef} onKeyDown={onKeyDown}>
      {error && (
        <p className="branch-pop__error" role="alert" title={error.detail}>
          {error.text}
        </p>
      )}
      {confirm ? (
        <ConfirmCard confirm={confirm} view={view} busy={busy} onCancel={() => setConfirm(undefined)} onAccept={accept} />
      ) : (
        <StashList
          stashes={stashes}
          busy={busy}
          onApply={(stash) => void apply(stash)}
          onDrop={(stash) => {
            setError(undefined)
            setConfirm({ kind: 'dropStash', stash })
          }}
        />
      )}
    </div>
  )
}

/** 보관 목록 — 최근 먼저, 줄마다 메시지·브랜치·시각 + [적용]·[삭제] */
export function StashList({ stashes, busy, onApply, onDrop }: { stashes: GitStash[]; busy: boolean; onApply(stash: GitStash): void; onDrop(stash: GitStash): void }) {
  const t = useT()
  const now = Date.now()
  return (
    <>
      <div className="branch-pop__label">{t('git.stashList')}</div>
      {stashes.length === 0 ? (
        <p className="branch-pop__empty">{t('git.stashEmpty')}</p>
      ) : (
        stashes.map((stash) => (
          <div key={stash.hash} className="git-stash__row">
            <span className="git-stash__text">
              <span className="git-stash__message" title={stash.message}>
                {stash.message}
              </span>
              <span className="git-stash__meta">{[stash.branch, ago(stash.time, now)].filter(Boolean).join(' · ')}</span>
            </span>
            <button type="button" className="file-preview__toggle git-stash__apply" disabled={busy} onClick={() => onApply(stash)}>
              {t('git.stashApply')}
            </button>
            <button type="button" className="file-preview__toggle git-stash__drop" disabled={busy} onClick={() => onDrop(stash)}>
              {t('git.delete')}
            </button>
          </div>
        ))
      )}
    </>
  )
}

// ── 기록 ──

function LogView({ directory, view }: { directory: string; view: GitStatus }) {
  const t = useT()
  const [log, setLog] = useState<GitCommit[]>()
  useEffect(() => {
    let live = true
    window.litecode.gitLog(directory).then(
      (commits) => live && setLog(commits),
      () => live && setLog([]),
    )
    return () => {
      live = false
    }
  }, [directory, view])
  if (log === undefined) return <p className="git-empty">{t('filePreview.loading')}</p>
  if (log.length === 0) return <p className="git-empty">{t('git.logEmpty')}</p>
  const now = Date.now()
  return (
    <ol className="git-log">
      {log.map((commit, index) => (
        <li key={commit.hash} className="git-log__item" data-head={index === 0 || undefined}>
          <span className="git-log__graph" aria-hidden="true">
            <i />
            {index < log.length - 1 && <u />}
          </span>
          <span className="git-log__main">
            <span className="git-log__subject">{commit.subject}</span>
            <span className="git-log__meta">
              <code>{commit.short}</code>
              <span>{`${commit.author} · ${ago(commit.time, now)}`}</span>
              {index === 0 && <span className="git-tag">HEAD</span>}
              {!commit.pushed && <span className="git-tag git-tag--local">{t('git.notPushed')}</span>}
            </span>
          </span>
        </li>
      ))}
    </ol>
  )
}

// ── 브랜치 ──

function BranchesView({
  directory,
  view,
  busy,
  onRun,
  onSwitch,
  onDelete,
}: {
  directory: string
  view: GitStatus
  busy: boolean
  onRun(action: GitAction): Promise<unknown>
  onSwitch(name: string): void
  onDelete(branch: GitBranch): void
}) {
  const t = useT()
  const [branches, setBranches] = useState<GitBranch[]>()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    let live = true
    window.litecode.gitBranches(directory).then(
      (list) => live && setBranches(list),
      () => live && setBranches([]),
    )
    return () => {
      live = false
    }
  }, [directory, view])
  useEffect(() => {
    if (creating) input.current?.focus()
  }, [creating])
  const create = async (): Promise<void> => {
    if (!name.trim()) return
    await onRun({ kind: 'createBranch', name: name.trim() })
    setName('')
    setCreating(false)
  }
  if (branches === undefined) return <p className="git-empty">{t('filePreview.loading')}</p>
  const now = Date.now()
  return (
    <ul className="git-branches">
      {branches.map((branch) => (
        <li key={branch.name} className="git-branches__item" data-current={branch.current || undefined}>
          <button type="button" className="changed-files__toggle git-branches__row" disabled={branch.current || busy} onClick={() => onSwitch(branch.name)}>
            <span className="git-branches__check" aria-hidden="true">
              {branch.current ? '✓' : ''}
            </span>
            <span className="git-branches__name">{branch.name}</span>
            <span className="changed-files__spacer" />
            <span className="git-branches__meta">{branchMeta(branch, now, t)}</span>
          </button>
          {!branch.current && (
            <button type="button" className="changed-files__open" disabled={busy} aria-label={t('git.deleteBranch', { branch: branch.name })} title={t('git.deleteBranch', { branch: branch.name })} onClick={() => onDelete(branch)}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 4.5H13M6.5 4.5V3H9.5V4.5M4.5 4.5L5.2 13H10.8L11.5 4.5" />
              </svg>
            </button>
          )}
        </li>
      ))}
      <li className="git-branches__item">
        {creating ? (
          <form
            className="git-branches__new"
            onSubmit={(event) => {
              event.preventDefault()
              void create()
            }}
          >
            <input
              ref={input}
              className="git-input git-mono"
              aria-label={t('git.newBranchLabel')}
              placeholder={t('git.newBranchLabel')}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === 'Escape' && (event.stopPropagation(), setCreating(false))}
            />
            <button type="submit" className="file-preview__toggle" disabled={busy || !name.trim()}>
              {t('git.create')}
            </button>
          </form>
        ) : (
          <button type="button" className="changed-files__toggle git-branches__add" disabled={busy || !view.hasCommits} onClick={() => setCreating(true)}>
            {`＋ ${t('git.newBranch')}`}
          </button>
        )}
      </li>
    </ul>
  )
}

function branchMeta(branch: GitBranch, now: number, t: Translate): string {
  const parts = [branch.current ? t('git.current') : ago(branch.time, now)]
  if (branch.ahead || branch.behind) parts.push(`↑${branch.ahead} ↓${branch.behind}`)
  if (branch.unmerged > 0) parts.push(t('git.unmerged', { count: branch.unmerged }))
  return parts.join(' · ')
}

// ── 확인 카드 (승인 카드 틀) ──

export function ConfirmCard({ confirm, view, busy, onCancel, onAccept }: { confirm: Confirm; view: GitStatus; busy: boolean; onCancel(): void; onAccept(value?: string): Promise<void> }) {
  const t = useT()
  const [value, setValue] = useState('')
  const danger = confirm.kind === 'discard' || confirm.kind === 'trash' || confirm.kind === 'dropStash' || (confirm.kind === 'delete' && confirm.branch.unmerged > 0)
  /** 글 칸이 있는 카드 — 원격 주소·커밋 메시지는 비면 못 누른다, 보관 메시지는 없어도 된다 */
  const needsValue = confirm.kind === 'remote' || confirm.kind === 'commitFile'
  const hasInput = needsValue || confirm.kind === 'stash'
  const changed = view.staged.length + view.changed.length
  const title = t(
    (
      {
        switch: 'git.switchTitle',
        push: 'git.pushTitle',
        pull: 'git.pullTitle',
        discard: 'git.discardTitle',
        delete: 'git.deleteTitle',
        remote: 'git.noRemoteTitle',
        commitFile: 'git.commitFileTitle',
        stash: 'git.stashTitle',
        trash: 'git.trashTitle',
        dropStash: 'git.stashDropTitle',
      } as const
    )[confirm.kind],
  )
  const action = t(
    (
      {
        switch: 'git.switch',
        push: 'git.push',
        pull: 'git.pull',
        discard: 'git.discard',
        delete: 'git.delete',
        remote: 'git.addRemote',
        commitFile: 'git.commitFileAction',
        stash: 'git.stashAction',
        trash: 'git.delete',
        dropStash: 'git.delete',
      } as const
    )[confirm.kind],
  )
  const submit = (event: ReactKeyboardEvent): void => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing && !busy && (!needsValue || value.trim())) void onAccept(value)
  }
  let body: ReactNode
  if (confirm.kind === 'switch')
    body = (
      <>
        <span>{changed > 0 ? t('git.switchBody', { count: changed, branch: confirm.name }) : t('git.switchBodyClean', { branch: confirm.name })}</span>
        <dl className="git-kv">
          <dt>{t('git.now')}</dt>
          <dd>{view.branch ?? t('git.detached')}</dd>
          <dt>{t('git.to')}</dt>
          <dd>{confirm.name}</dd>
        </dl>
      </>
    )
  else if (confirm.kind === 'push')
    body = (
      <dl className="git-kv">
        <dt>{t('git.pushBranch')}</dt>
        <dd>{view.branch}</dd>
        <dt>{t('git.pushRemote')}</dt>
        <dd>{`origin (${hostOf(view.remote)})`}</dd>
        {view.upstream && (
          <>
            <dt>{t('git.pushCommits')}</dt>
            <dd>{t('git.pushCommitsValue', { count: view.ahead })}</dd>
          </>
        )}
      </dl>
    )
  else if (confirm.kind === 'pull')
    body = (
      <>
        <span>{t('git.pullBody')}</span>
        <dl className="git-kv">
          <dt>{t('git.pushBranch')}</dt>
          <dd>{view.branch}</dd>
          <dt>{t('git.pushRemote')}</dt>
          <dd>{`origin (${hostOf(view.remote)})`}</dd>
        </dl>
      </>
    )
  else if (confirm.kind === 'discard') body = <span>{t(confirm.file.kind === 'U' ? 'git.discardNew' : 'git.discardBody', { file: confirm.file.path })}</span>
  else if (confirm.kind === 'delete')
    body = <span>{confirm.branch.unmerged > 0 ? t('git.deleteUnmerged', { branch: confirm.branch.name, count: confirm.branch.unmerged }) : t('git.deleteMerged', { branch: confirm.branch.name })}</span>
  else if (confirm.kind === 'commitFile' || confirm.kind === 'stash') {
    const label = t(confirm.kind === 'commitFile' ? 'git.commitLabel' : 'git.stashLabel')
    body = (
      <>
        <span>{t(confirm.kind === 'commitFile' ? 'git.commitFileBody' : 'git.stashBody', { file: confirm.entry.path })}</span>
        <input className="git-input" aria-label={label} placeholder={confirm.kind === 'commitFile' ? t('git.commitPlaceholder') : label} value={value} autoFocus onChange={(event) => setValue(event.target.value)} onKeyDown={submit} />
      </>
    )
  } else if (confirm.kind === 'trash') body = <span>{t('git.trashBody', { file: confirm.entry.path })}</span>
  else if (confirm.kind === 'dropStash') body = <span>{t('git.stashDropBody', { message: confirm.stash.message })}</span>
  else
    body = (
      <>
        <span>{t('git.noRemoteBody')}</span>
        <input
          className="git-input git-mono"
          aria-label={t('git.remoteLabel')}
          placeholder="https://…/repo.git"
          value={value}
          autoFocus
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={submit}
        />
      </>
    )
  return (
    <div className="attention-card git-confirm" data-tone={danger ? 'danger' : undefined} data-confirm={confirm.kind} aria-busy={busy}>
      <div className="attention-card__strip">
        <span className="attention-card__dot" aria-hidden="true" />
        {title}
      </div>
      <div className="attention-card__body git-confirm__body">{body}</div>
      <div className="attention-card__actions">
        <button type="button" className="attention-card__button attention-card__button--reject" disabled={busy} onClick={onCancel}>
          {t('git.cancel')}
        </button>
        <button
          type="button"
          className={`attention-card__button ${danger ? 'attention-card__button--danger' : 'attention-card__button--primary'}`}
          disabled={busy || (needsValue && !value.trim())}
          onClick={() => void onAccept(hasInput ? value : undefined)}
        >
          {action}
        </button>
      </div>
    </div>
  )
}

function hostOf(remote: string | undefined): string {
  const web = gitWebUrl(remote)
  return web ? new URL(web).host : (remote ?? '')
}

function ReloadButton({ onClick }: { onClick(): void }) {
  const t = useT()
  return (
    <button type="button" className="file-preview__tool" aria-label={t('filePreview.reload')} title={t('filePreview.reload')} onClick={onClick}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M13.25 8A5.25 5.25 0 1 1 11.7 4.3" />
        <path d="M13.25 2.5V5H10.75" />
      </svg>
    </button>
  )
}

export function BranchIcon({ className = 'git-icon' }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5.5" r="1.5" />
      <path d="M4.5 5V11M11.5 7C11.5 9.5 4.5 8.5 4.5 11" />
    </svg>
  )
}
