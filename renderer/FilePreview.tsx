import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { DirectoryListing, FilePreview, HtmlAsset } from '../shared/ipc.ts'
import { CheckIcon, CopyIcon, Markdown } from './Markdown.tsx'
import { OpenInButton } from './OpenInButton.tsx'
import {
  closeFilePreview,
  closeTab,
  openFilePreview,
  openFilesTab,
  revealPanel,
  selectTab,
  toggleFullscreen,
  usePanelState,
  type PanelState,
} from './filePreviewStore.ts'
import { buildHtmlDocument, collectReferences } from './htmlPreview.ts'
import { useFeatures } from './featuresStore.ts'
import { useT } from './settingsStore.ts'
import './filePreview.css'

// 오른쪽 패널 (이슈 #17 파일 미리보기 → #29 탭·폴더 탐색·HTML 실행). dsh ui-sidebar-right·ui-sidebar-files·ui-sidebar-documentpreview 참조
// (모양·치수·동작만, 코드는 새로 씀): 앱 틀의 오른쪽 열, 첫 폭 = 창의 45%, 끌어서 300 ~ 창의 70%(대화는 400 이상 남긴다).
// 맨 위 탭 줄(대화 머리와 같은 52px, 창 끌기 영역) — 고정 "파일" 탭 + 연 파일 탭(28px 칩, 고른 칩과 hover 에 ×) + "+"(파일 탭으로), 오른쪽 끝에
// 전체 화면·닫기. 그 아래 38px 경로 줄 — 경로(폴더는 옅게, 파일 이름 굵게, 길면 앞이 잘리며 흐려짐)·종류·보기 전환·다시 읽기·Finder·복사.
// 파일 탭 본문은 고정폭 줄 번호, .md 는 마크다운, .html 은 격리된 iframe 에서 실제로 렌더링(htmlPreview.ts). 읽기·판정은 메인.
// dsh 와 다른 점: 분할 보기(두 창)는 없다, "파일" 탭은 닫을 수 없다, "+" 는 안내 탭 대신 파일 탭으로.

const WIDTH_KEY = 'litecode.filePreview.width'
const MIN_WIDTH = 300
const MAX_RATIO = 0.7
const DEFAULT_RATIO = 0.45
/** 패널을 넓혀도 대화 칸에 남기는 폭 (dsh CENTER_MIN) */
const CHAT_MIN = 400
const COPIED_MS = 1_500

function readWidth(): number {
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY))
    if (saved > 0) return saved
  } catch {
    // 못 읽으면 기본값
  }
  return Math.round(window.innerWidth * DEFAULT_RATIO)
}

/** 지금 보는 대화의 프로젝트 패널일 때만 그린다 — 프로젝트를 옮기면 숨긴다 */
export function FilePreviewPanel({ directory }: { directory?: string }) {
  const state = usePanelState()
  const stale = !!state?.open && state.directory !== directory
  useEffect(() => {
    if (stale) closeFilePreview()
  }, [stale])
  return state?.open && !stale ? <Panel state={state} /> : null
}

/** 대화 머리 오른쪽 끝 — 패널이 숨어 있을 때만 보이는 "오른쪽 패널 열기" (dsh ui-sidebar-right 의 펼침 버튼, 왼쪽 사이드바 접기 그림을 뒤집은 것) */
export function RightPanelButton({ directory }: { directory: string }) {
  const t = useT()
  const state = usePanelState()
  if (state?.open && state.directory === directory) return null
  return (
    <button
      type="button"
      className="right-panel-open"
      aria-label={t('filePreview.openPanel')}
      title={t('filePreview.openPanel')}
      onClick={() => revealPanel(directory)}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
        <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
        <path d="M10 2.75V13.25" />
      </svg>
    </button>
  )
}

function Panel({ state }: { state: PanelState }) {
  const t = useT()
  const [width, setWidth] = useState(readWidth)
  const root = useRef<HTMLElement>(null)
  const returnFocus = useRef<Element | null>(null)
  const drag = useRef<{ x: number; width: number; max: number }>(undefined)
  const { directory, tabs, active, fullscreen } = state
  // 파일 탭은 한 번 본 뒤부터 계속 마운트 — 다른 탭에 갔다 와도 펼친 폴더·스크롤이 그대로 (dsh keepMounted, 안 본 탭은 미리 안 그린다)
  const filesVisited = useRef(false)
  if (active === undefined) filesVisited.current = true

  // 열 때마다(칩·버튼) 패널이 포커스를 잡는다 — Esc 로 닫고, 닫으면 누른 자리(칩)로 돌아간다
  useLayoutEffect(() => {
    if (!root.current?.contains(document.activeElement)) returnFocus.current = document.activeElement
    root.current?.focus({ preventScroll: true })
  }, [state.focus])

  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(width))
    } catch {
      // 저장 못 해도 이번 실행은 그 폭
    }
  }, [width])

  function close(): void {
    const back = returnFocus.current
    closeFilePreview()
    if (back instanceof HTMLElement && back.isConnected) back.focus()
    else document.querySelector<HTMLElement>('.composer__input')?.focus()
  }

  // Esc — 전체 화면이면 먼저 풀고, 아니면 닫는다
  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (fullscreen) toggleFullscreen()
    else close()
  }

  return (
    <aside
      ref={root}
      className={fullscreen ? 'file-preview file-preview--full' : 'file-preview'}
      aria-label={t('filePreview.label')}
      tabIndex={-1}
      style={fullscreen ? undefined : { width }}
      onKeyDown={onKeyDown}
    >
      {!fullscreen && (
        <div
          className="file-preview__resize"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('filePreview.resize')}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            const panel = root.current!.getBoundingClientRect().width
            const chat = root.current!.previousElementSibling?.getBoundingClientRect().width ?? 0
            drag.current = { x: event.clientX, width: panel, max: Math.min(window.innerWidth * MAX_RATIO, panel + chat - CHAT_MIN) }
          }}
          onPointerMove={(event) => {
            const start = drag.current
            if (start) setWidth(Math.round(Math.max(MIN_WIDTH, Math.min(start.max, start.width - (event.clientX - start.x)))))
          }}
          onPointerUp={() => (drag.current = undefined)}
          onPointerCancel={() => (drag.current = undefined)}
        />
      )}
      {/* 탭 줄 — 빈 곳은 창 끌기(styles.css 의 .file-preview__head), 탭(role=tab)·버튼은 no-drag 규칙 하나로 빠진다 */}
      <div className="file-preview__head">
        <div className="file-preview__tabs" role="tablist" aria-label={t('filePreview.tabs')}>
          <div
            role="tab"
            tabIndex={0}
            className="file-preview__tab file-preview__tab--files"
            aria-selected={active === undefined}
            onClick={() => selectTab(undefined)}
            onKeyDown={(event) => activateOnKey(event, () => selectTab(undefined))}
          >
            <FolderIcon className="file-preview__tab-icon file-preview__tab-icon--folder" />
            <span className="file-preview__tab-title">{t('filePreview.files')}</span>
          </div>
          {tabs.map((key) => (
            <div
              key={key}
              role="tab"
              tabIndex={0}
              className="file-preview__tab"
              aria-selected={active === key}
              title={key}
              aria-label={baseName(key)}
              data-file={key}
              onClick={() => selectTab(key)}
              onKeyDown={(event) => activateOnKey(event, () => selectTab(key))}
              onAuxClick={(event) => event.button === 1 && closeTab(key)}
            >
              <FileIcon className="file-preview__tab-icon" />
              <span className="file-preview__tab-title">{baseName(key)}</span>
              <button
                type="button"
                className="file-preview__tab-close"
                aria-label={t('filePreview.closeTab', { name: baseName(key) })}
                title={t('filePreview.closeTab', { name: baseName(key) })}
                onClick={(event) => {
                  event.stopPropagation()
                  closeTab(key)
                }}
              >
                <CrossIcon size={12} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="file-preview__add"
            aria-label={t('filePreview.addTab')}
            title={t('filePreview.addTab')}
            onClick={() => openFilesTab(directory)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
              <path d="M8 3V13M3 8H13" />
            </svg>
          </button>
        </div>
        <span className="file-preview__chrome">
          <button
            type="button"
            className="file-preview__tool file-preview__fullscreen"
            aria-label={fullscreen ? t('filePreview.exitFullscreen') : t('filePreview.fullscreen')}
            title={fullscreen ? t('filePreview.exitFullscreen') : t('filePreview.fullscreen')}
            aria-pressed={fullscreen}
            onClick={toggleFullscreen}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {fullscreen ? (
                <path d="M6 2.5V6H2.5M10 2.5V6H13.5M6 13.5V10H2.5M10 13.5V10H13.5" />
              ) : (
                <path d="M2.5 6V2.5H6M13.5 6V2.5H10M2.5 10V13.5H6M13.5 10V13.5H10" />
              )}
            </svg>
          </button>
          <button type="button" className="file-preview__tool file-preview__close" aria-label={t('filePreview.close')} title={t('filePreview.close')} onClick={close}>
            <CrossIcon size={14} />
          </button>
        </span>
      </div>
      {filesVisited.current && <FilesView directory={directory} hidden={active !== undefined} />}
      {active !== undefined && <FileView key={active} directory={directory} token={active} />}
    </aside>
  )
}

function activateOnKey(event: KeyboardEvent<HTMLElement>, activate: () => void): void {
  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
  event.preventDefault()
  activate()
}

function baseName(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1) || key
}

// ── 파일 탭 (dsh ui-sidebar-files) — 루트 경로 줄 + 다시 읽기, 그 아래 한 단계씩 펼치는 나무. 폴더 먼저·이름 순서는 메인이 정한다 ──

type Level = 'loading' | Extract<DirectoryListing, { status: 'ok' }> | 'failed'

function FilesView({ directory, hidden }: { directory: string; hidden: boolean }) {
  const t = useT()
  const [levels, setLevels] = useState<Record<string, Level>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const epoch = useRef(0)

  function list(relative: string): void {
    const at = epoch.current
    setLevels((now) => (now[relative] && now[relative] !== 'failed' ? now : { ...now, [relative]: 'loading' }))
    window.litecode.listDirectory(directory, relative).then(
      (listing) => at === epoch.current && setLevels((now) => ({ ...now, [relative]: listing.status === 'ok' ? listing : 'failed' })),
      () => at === epoch.current && setLevels((now) => ({ ...now, [relative]: 'failed' })),
    )
  }

  useEffect(() => {
    epoch.current++
    setLevels({})
    setExpanded(new Set())
    list('')
  }, [directory])

  /** 다시 읽기 — 루트와 펼친 폴더를 보이는 목록은 둔 채 다시 묻는다 (dsh 처럼 나무를 비우지 않는다) */
  function reload(): void {
    for (const relative of ['', ...expanded]) list(relative)
  }

  function toggle(relative: string): void {
    const next = new Set(expanded)
    if (next.has(relative)) next.delete(relative)
    else {
      next.add(relative)
      list(relative) // 다시 펼치면 다시 읽는다 (dsh)
    }
    setExpanded(next)
  }

  const rootLevel = levels['']
  return (
    <div className="file-tree" hidden={hidden}>
      <div className="file-preview__bar">
        <PathLabel path={typeof rootLevel === 'object' ? rootLevel.absolute : directory} />
        <span className="file-preview__tools">
          <ReloadButton onClick={reload} />
        </span>
      </div>
      <div className="file-tree__body">
        <ul className="file-tree__level" role="tree" aria-label={t('filePreview.filesLabel')}>
          <TreeLevel relative="" levels={levels} expanded={expanded} onToggle={toggle} onOpen={(file) => openFilePreview(directory, file)} />
        </ul>
      </div>
    </div>
  )
}

function TreeLevel({
  relative,
  levels,
  expanded,
  onToggle,
  onOpen,
}: {
  relative: string
  levels: Record<string, Level>
  expanded: ReadonlySet<string>
  onToggle(relative: string): void
  onOpen(relative: string): void
}) {
  const t = useT()
  const level = levels[relative]
  if (level === undefined || level === 'loading') return <li className="file-tree__note">{t('filePreview.loading')}</li>
  if (level === 'failed') return <li className="file-tree__note" role="alert">{t('filePreview.folderUnavailable')}</li>
  return (
    <>
      {level.entries.length === 0 && <li className="file-tree__note">{t('filePreview.emptyFolder')}</li>}
      {level.entries.map((entry) => {
        const child = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.type === 'directory') {
          const open = expanded.has(child)
          return (
            <li key={entry.name} className="file-tree__item" role="treeitem" aria-expanded={open} data-path={child}>
              <button type="button" className="file-tree__row" onClick={() => onToggle(child)}>
                <FolderIcon className="file-tree__icon" open={open} />
                <span className="file-tree__name">{entry.name}</span>
              </button>
              {open && (
                <ul className="file-tree__level" role="group">
                  <TreeLevel relative={child} levels={levels} expanded={expanded} onToggle={onToggle} onOpen={onOpen} />
                </ul>
              )}
            </li>
          )
        }
        if (entry.type === 'file') {
          return (
            <li key={entry.name} className="file-tree__item" role="treeitem" data-path={child}>
              <button type="button" className="file-tree__row" onClick={() => onOpen(child)}>
                <FileIcon className="file-tree__icon" />
                <span className="file-tree__name">{entry.name}</span>
              </button>
            </li>
          )
        }
        return (
          <li key={entry.name} className="file-tree__item" role="treeitem" data-path={child}>
            <span className="file-tree__row file-tree__row--other" aria-disabled="true" title={t('filePreview.notAFile')}>
              <span className="file-tree__name">{entry.name}</span>
            </span>
          </li>
        )
      })}
      {level.truncated && <li className="file-tree__note">{t('filePreview.truncatedFolder')}</li>}
    </>
  )
}

// ── 파일 탭 하나 — 경로 줄 + 본문 ──

function FileView({ directory, token }: { directory: string; token: string }) {
  const t = useT()
  const features = useFeatures()
  const [preview, setPreview] = useState<FilePreview | 'loading'>('loading')
  const [revision, setRevision] = useState(0)
  const [source, setSource] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let live = true
    window.litecode.previewFile(directory, token).then(
      (result) => live && setPreview(result),
      () => live && setPreview({ status: 'unavailable' }),
    )
    return () => {
      live = false
    }
  }, [directory, token, revision])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])

  const file = preview !== 'loading' && preview.status !== 'unavailable' ? preview : undefined
  const text = preview !== 'loading' && preview.status === 'text' ? preview : undefined
  const markdown = !!text && /\.(md|markdown)$/i.test(text.path)
  // 잘린 HTML(1MB 넘음)은 렌더링하지 않는다 — 반쪽 문서를 돌리지 않는다
  const html = !!text && /\.html?$/i.test(text.path) && !text.truncated
  const copyLabel = copied ? t('filePreview.copied') : t('filePreview.copyPath')

  return (
    <div className="file-view">
      <div className="file-preview__bar">
        <PathLabel path={file?.path ?? token} title={file?.absolute ?? token} />
        <span className="file-preview__tools">
          <span className="file-preview__kind">{kindOf(file?.path ?? token, t('filePreview.kindText'))}</span>
          {(markdown || html) && (
            <button type="button" className="file-preview__toggle" aria-pressed={source} onClick={() => setSource((now) => !now)}>
              {source ? (html ? t('filePreview.showRenderedHtml') : t('filePreview.showRendered')) : t('filePreview.showSource')}
            </button>
          )}
          {file && features.has('openIn') && <OpenInButton directory={directory} file={token} />}
          <ReloadButton onClick={() => setRevision((now) => now + 1)} />
          {file && (
            <button
              type="button"
              className="file-preview__tool file-preview__reveal"
              aria-label={t('filePreview.reveal')}
              title={t('filePreview.reveal')}
              onClick={() => void window.litecode.revealFile(directory, token)}
            >
              <FolderIcon />
            </button>
          )}
          {file && (
            <button
              type="button"
              className="file-preview__tool file-preview__copy"
              aria-label={copyLabel}
              title={copyLabel}
              data-copied={copied}
              onClick={() => {
                navigator.clipboard.writeText(file.absolute).then(
                  () => setCopied(true),
                  () => {},
                )
              }}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
            </button>
          )}
        </span>
      </div>
      {text?.truncated && (
        <p className="file-preview__notice" role="note">
          {t('filePreview.truncated', { shown: formatBytes(new TextEncoder().encode(text.text).length), size: formatBytes(text.size) })}
        </p>
      )}
      <div className={html && !source ? 'file-preview__body file-preview__body--frame' : 'file-preview__body'}>
        {preview === 'loading' ? (
          <p className="file-preview__empty">{t('filePreview.loading')}</p>
        ) : preview.status === 'unavailable' ? (
          <p className="file-preview__empty" role="alert">
            {t('filePreview.unavailable')}
          </p>
        ) : preview.status === 'binary' ? (
          <p className="file-preview__empty">{t('filePreview.binary', { size: formatBytes(preview.size) })}</p>
        ) : html && !source ? (
          <HtmlFrame key={revision} directory={directory} token={token} html={preview.text} />
        ) : markdown && !source ? (
          <div className="file-preview__md">
            <Markdown text={preview.text} directory={directory} />
          </div>
        ) : (
          <CodeLines text={preview.text} />
        )}
      </div>
    </div>
  )
}

/** HTML 을 실제로 돌린다 — 격리는 htmlPreview.ts 머리 주석. 같은 폴더 리소스를 메인에서 받은 뒤에 문서를 싣는다 */
function HtmlFrame({ directory, token, html }: { directory: string; token: string; html: string }) {
  const t = useT()
  const [doc, setDoc] = useState<string>()
  useEffect(() => {
    let live = true
    const references = collectReferences(html)
    const assets: Promise<HtmlAsset[]> = references.length > 0 ? window.litecode.previewAssets(directory, token, references) : Promise.resolve([])
    assets.then(
      (found) => live && setDoc(buildHtmlDocument(html, found)),
      () => live && setDoc(buildHtmlDocument(html, [])),
    )
    return () => {
      live = false
    }
  }, [directory, token, html])
  if (doc === undefined) return <p className="file-preview__empty">{t('filePreview.loading')}</p>
  return <iframe className="file-preview__frame" sandbox="allow-scripts" srcDoc={doc} title={t('filePreview.frame')} referrerPolicy="no-referrer" />
}

/** 경로 — 폴더는 옅게, 마지막 이름은 굵게. 넘치면 앞(왼쪽)이 잘리고 흐려진다 — 파일 이름이 끝까지 보이게 (dsh PathLabel) */
function PathLabel({ path, title }: { path: string; title?: string }) {
  const outer = useRef<HTMLSpanElement>(null)
  const inner = useRef<HTMLSpanElement>(null)
  const [clipped, setClipped] = useState(false)
  useLayoutEffect(() => {
    const measure = () => setClipped(!!outer.current && !!inner.current && inner.current.offsetWidth > outer.current.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(outer.current!)
    return () => observer.disconnect()
  }, [path])
  const cut = path.lastIndexOf('/') + 1
  return (
    <span ref={outer} className="file-preview__path" title={title ?? path} data-clipped={clipped || undefined}>
      <span ref={inner} className="file-preview__path-inner">
        {cut > 0 && <span className="file-preview__path-dir">{path.slice(0, cut)}</span>}
        <strong className="file-preview__path-name">{path.slice(cut)}</strong>
      </span>
    </span>
  )
}

function ReloadButton({ onClick }: { onClick(): void }) {
  const t = useT()
  return (
    <button type="button" className="file-preview__tool file-preview__reload" aria-label={t('filePreview.reload')} title={t('filePreview.reload')} onClick={onClick}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M13.25 8A5.25 5.25 0 1 1 11.7 4.3" />
        <path d="M13.25 2.5V5H10.75" />
      </svg>
    </button>
  )
}

/** 경로 줄의 종류 — 확장자로 (dsh 는 고른 렌더러 이름) */
export function kindOf(file: string, text: string): string {
  const ext = /\.([^./]+)$/.exec(file)?.[1]?.toLowerCase()
  if (!ext) return text
  const known: Record<string, string> = {
    html: 'HTML', htm: 'HTML', md: 'Markdown', markdown: 'Markdown', ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
    js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', json: 'JSON', css: 'CSS', py: 'Python', sh: 'Shell',
    yml: 'YAML', yaml: 'YAML', txt: text,
  }
  return known[ext] ?? ext.toUpperCase()
}

/** 줄 번호 + 글 — 두 열을 줄 단위 요소로 쪼개지 않는다(1MB 파일도 요소 두 개). 줄바꿈 없이(white-space: pre) 같은 줄 높이라 줄이 맞는다 */
function CodeLines({ text }: { text: string }) {
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
  const numbers = lines.map((_, index) => index + 1).join('\n')
  return (
    <div className="file-preview__code">
      <pre className="file-preview__gutter" aria-hidden="true">
        {numbers}
      </pre>
      <pre className="file-preview__text">
        <code>{lines.join('\n')}</code>
      </pre>
    </div>
  )
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function FileIcon({ className = 'file-preview__icon' }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 1.75H9.5L12.5 4.75V14.25H4Z" />
      <path d="M9.5 1.75V4.75H12.5" />
    </svg>
  )
}

function FolderIcon({ className, open }: { className?: string; open?: boolean }) {
  return (
    <svg className={className} width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true">
      {open ? (
        <path d="M1.75 12.25V4.25C1.75 3.42 2.42 2.75 3.25 2.75H6.25L7.75 4.25H12C12.83 4.25 13.5 4.92 13.5 5.75V6.75M1.75 12.25L3.4 7.6C3.6 7.06 4.1 6.75 4.66 6.75H14.1C14.62 6.75 14.98 7.27 14.8 7.76L13.3 12.25C13.1 12.8 12.6 13.25 12 13.25H2.75C2.2 13.25 1.75 12.8 1.75 12.25Z" />
      ) : (
        <path d="M1.75 4.25C1.75 3.42 2.42 2.75 3.25 2.75H6.25L7.75 4.25H12.75C13.58 4.25 14.25 4.92 14.25 5.75V11.75C14.25 12.58 13.58 13.25 12.75 13.25H3.25C2.42 13.25 1.75 12.58 1.75 11.75Z" />
      )}
    </svg>
  )
}

function CrossIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <path d="M4 4L12 12M12 4L4 12" />
    </svg>
  )
}
