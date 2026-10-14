import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import type { FileDiff } from '../shared/ipc.ts'
import { gitWebUrl, type GitAction, type GitBranch, type GitCommit, type GitFile, type GitLastCommit, type GitResult, type GitStatus } from '../shared/git.ts'
import { ago } from './ago.ts'
import { branchTrack, groupBranches, matchesQuery, popupShortcut, recentBranches, shortcutLabel, type PopupShortcut } from './branchPopup.ts'
import { focusComposerInput } from './composerFocus.ts'
import { splitPath } from './changedFiles.ts'
import { DiffCard } from './DiffCard.tsx'
import { useFeatures } from './featuresStore.ts'
import { openFilePreview, openGitTab, type PanelState } from './filePreviewStore.ts'
import { commitControls, commitNotice, commitThenPush } from './gitCommit.ts'
import { changeCount, refreshGit, useGitView } from './gitStore.ts'
import { reason } from './ipcError.ts'
import { useT, type Translate } from './settingsStore.ts'
import './git.css'

// Git 탭 (이슈 #290 — 시안 _workspace/mock-git/Git.dc.html 의 구조·문구·권한표). 모양은 지금 앱의 부품을 그대로 쓴다:
// 경로 줄(.file-preview__bar)·작은 글 버튼(.file-preview__toggle)·도구 버튼(.file-preview__tool), 파일 줄은 "AI 가 고친 파일" 카드(.changed-files__*),
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
  const draftBeforeAmend = useRef('')
  const hasCommits = view?.state === 'ok' && view.hasCommits

  useEffect(() => void refreshGit(directory), [directory])
  useEffect(() => {
    setAmend(false)
    setLast(undefined)
  }, [directory])
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
      <div className="git-sub" role="tablist" aria-label={t('git.tab')}>
        {(['changes', 'log', 'branches'] as const).map((id) => (
          <button key={id} type="button" role="tab" className="git-sub__tab" aria-selected={sub === id} onClick={() => setSub(id)}>
            {t(`git.${id}`)}
          </button>
        ))}
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

// ── 변경 ──

function ChangesView({
  directory,
  view,
  busy,
  onRun,
  onDiscard,
}: {
  directory: string
  view: GitStatus
  busy: boolean
  onRun(action: GitAction): Promise<unknown>
  onDiscard(file: GitFile): void
}) {
  const t = useT()
  const conflicts = view.conflicts
  return (
    <>
      {(view.merging || conflicts.length > 0) && (
        <div className="git-cards">
          <div className="attention-card git-confirm" data-tone="danger" role="alert">
            <div className="attention-card__strip">
              <span className="attention-card__dot" aria-hidden="true" />
              {t('git.conflictTitle', { count: conflicts.length })}
            </div>
            <div className="attention-card__body">
              {conflicts.map((file) => (
                <button key={file.path} type="button" className="attention-card__command git-conflict" onClick={() => openFilePreview(directory, file.path)}>
                  {`U ${file.path}`}
                </button>
              ))}
              <span className="git-card__note">{t('git.conflictNote')}</span>
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
      <Group
        label={t('git.staged', { count: view.staged.length })}
        action={view.staged.length > 0 ? { label: t('git.unstageAll'), run: () => void onRun({ kind: 'unstage', paths: view.staged.map((file) => file.path) }) } : undefined}
        busy={busy}
      />
      {view.staged.length === 0 ? (
        <p className="git-empty">{t('git.stagedEmpty')}</p>
      ) : (
        <ul className="changed-files__list git-list">
          {view.staged.map((file) => (
            <FileRow key={file.path} directory={directory} file={file} staged busy={busy} onToggle={() => void onRun({ kind: 'unstage', paths: [file.path] })} />
          ))}
        </ul>
      )}
      <Group
        label={t('git.changed', { count: view.changed.length })}
        action={view.changed.length > 0 ? { label: t('git.stageAll'), run: () => void onRun({ kind: 'stage', paths: view.changed.map((file) => file.path) }) } : undefined}
        busy={busy}
      />
      {view.changed.length === 0 ? (
        <p className="git-empty">{t('git.clean')}</p>
      ) : (
        <ul className="changed-files__list git-list">
          {view.changed.map((file) => (
            <FileRow
              key={file.path}
              directory={directory}
              file={file}
              staged={false}
              busy={busy}
              onToggle={() => void onRun({ kind: 'stage', paths: [file.path] })}
              onDiscard={() => onDiscard(file)}
            />
          ))}
        </ul>
      )}
    </>
  )
}

function Group({ label, action, busy }: { label: string; action?: { label: string; run(): void }; busy: boolean }) {
  return (
    <div className="git-group">
      <span>{label}</span>
      {action && (
        <button type="button" className="git-link" disabled={busy} onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  )
}

/** 파일 한 줄 — 체크(stage)·상태 글자·이름(폴더는 흐리게)·줄 수, 누르면 그 아래에 diff. 변경 쪽은 되돌리기 버튼 */
function FileRow({ directory, file, staged, busy, onToggle, onDiscard }: { directory: string; file: GitFile; staged: boolean; busy: boolean; onToggle(): void; onDiscard?(): void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [patch, setPatch] = useState<string>()
  const { name, folder } = splitPath(file.path)
  const stat = file.kind === 'U' ? t('git.newFile') : file.added !== undefined ? `+${file.added} −${file.removed ?? 0}` : ''
  useEffect(() => {
    if (!open) return
    let live = true
    window.litecode.gitDiff(directory, file.path, staged).then(
      (text) => live && setPatch(text),
      () => live && setPatch(''),
    )
    return () => {
      live = false
    }
  }, [open, directory, file.path, staged, file.added, file.removed])
  const diffs = useMemo<FileDiff[]>(
    () => (patch ? [{ path: file.path, status: file.kind === 'D' ? 'deleted' : file.kind === 'U' || file.kind === 'A' ? 'added' : 'modified', added: file.added ?? 0, removed: file.removed ?? 0, patch }] : []),
    [patch, file],
  )
  return (
    <li className="changed-files__item" data-git-kind={file.kind}>
      <div className="changed-files__row">
        <input type="checkbox" className="git-check" checked={staged} disabled={busy} aria-label={t('git.stageFile', { file: file.path })} onChange={onToggle} />
        <button type="button" className="changed-files__toggle" aria-expanded={open} title={file.from ? `${file.from} → ${file.path}` : file.path} onClick={() => setOpen((now) => !now)}>
          <span className="git-kind" data-kind={file.kind} aria-hidden="true">
            {file.kind}
          </span>
          <span className="changed-files__name">{name}</span>
          {folder && <span className="changed-files__folder">{folder}</span>}
          <span className="changed-files__spacer" />
          {stat && <span className="changed-files__stat">{stat}</span>}
        </button>
        {onDiscard && (
          <button type="button" className="changed-files__open" disabled={busy} aria-label={t('git.discardFile', { file: file.path })} title={t('git.discardFile', { file: file.path })} onClick={onDiscard}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5.5 3.5L2.75 6.25L5.5 9" />
              <path d="M2.75 6.25H9.5C11.6 6.25 13.25 7.9 13.25 10S11.6 13.75 9.5 13.75H7" />
            </svg>
          </button>
        )}
      </div>
      {open && <div className="changed-files__diff git-diff">{patch === undefined ? null : diffs.length > 0 ? <DiffCard diffs={diffs} /> : <p className="git-empty">—</p>}</div>}
    </li>
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

function ConfirmCard({ confirm, view, busy, onCancel, onAccept }: { confirm: Confirm; view: GitStatus; busy: boolean; onCancel(): void; onAccept(value?: string): Promise<void> }) {
  const t = useT()
  const [url, setUrl] = useState('')
  const danger = confirm.kind === 'discard' || (confirm.kind === 'delete' && confirm.branch.unmerged > 0)
  const changed = view.staged.length + view.changed.length
  const title =
    confirm.kind === 'switch'
      ? t('git.switchTitle')
      : confirm.kind === 'push'
        ? t('git.pushTitle')
        : confirm.kind === 'pull'
          ? t('git.pullTitle')
          : confirm.kind === 'discard'
            ? t('git.discardTitle')
            : confirm.kind === 'delete'
              ? t('git.deleteTitle')
              : t('git.noRemoteTitle')
  const action =
    confirm.kind === 'switch'
      ? t('git.switch')
      : confirm.kind === 'push'
        ? t('git.push')
        : confirm.kind === 'pull'
          ? t('git.pull')
          : confirm.kind === 'discard'
            ? t('git.discard')
            : confirm.kind === 'delete'
              ? t('git.delete')
              : t('git.addRemote')
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
  else
    body = (
      <>
        <span>{t('git.noRemoteBody')}</span>
        <input
          className="git-input git-mono"
          aria-label={t('git.remoteLabel')}
          placeholder="https://…/repo.git"
          value={url}
          autoFocus
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && url.trim() && void onAccept(url)}
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
          disabled={busy || (confirm.kind === 'remote' && !url.trim())}
          onClick={() => void onAccept(confirm.kind === 'remote' ? url : undefined)}
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
