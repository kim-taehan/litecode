import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { FilePreview } from '../shared/ipc.ts'
import { CheckIcon, CopyIcon, Markdown } from './Markdown.tsx'
import { OpenInButton } from './OpenInButton.tsx'
import { closeFilePreview, usePreviewTarget, type PreviewTarget } from './filePreviewStore.ts'
import { useFeatures } from './featuresStore.ts'
import { useT } from './settingsStore.ts'
import './filePreview.css'

// 파일 미리보기 패널 (이슈 #17) — 답의 파일 칩을 누르면 채팅 오른쪽에 붙는 칸. dsh ui-sidebar-right·ui-sidebar-documentpreview 참조
// (모양·치수만, 코드는 새로 씀): 앱 틀의 오른쪽 열, 첫 폭 = 창의 45%, 끌어서 300 ~ 창의 70%(대화는 400 이상 남긴다), 머리 한 줄에 경로와
// 오른쪽 끝 28px 아이콘 버튼, 본문은 고정폭 13px·줄 높이 1.6, 못 그리는 경우는 가운데 한 줄. 글은 줄 번호, .md 는 마크다운(원문 전환).
// 읽기·판정은 메인(chat:preview-file) — 화면은 칩과 같은 (프로젝트, 답의 글자) 만 보낸다.

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

/** 지금 보는 대화의 프로젝트 파일일 때만 그린다 — 프로젝트를 옮기면 닫는다 */
export function FilePreviewPanel({ directory }: { directory?: string }) {
  const target = usePreviewTarget()
  const stale = !!target && target.directory !== directory
  useEffect(() => {
    if (stale) closeFilePreview()
  }, [stale])
  return target && !stale ? <Panel target={target} /> : null
}

function Panel({ target }: { target: PreviewTarget }) {
  const t = useT()
  const features = useFeatures()
  const [preview, setPreview] = useState<FilePreview | 'loading'>('loading')
  const [source, setSource] = useState(false)
  const [copied, setCopied] = useState(false)
  const [width, setWidth] = useState(readWidth)
  const root = useRef<HTMLElement>(null)
  const returnFocus = useRef<Element | null>(null)
  const drag = useRef<{ x: number; width: number; max: number }>(undefined)

  const { directory, token } = target
  useEffect(() => {
    let live = true
    setPreview('loading')
    setSource(false)
    window.litecode.previewFile(directory, token).then(
      (result) => live && setPreview(result),
      () => live && setPreview({ status: 'unavailable' }),
    )
    return () => {
      live = false
    }
  }, [directory, token])

  // 칩을 누를 때마다 패널이 포커스를 잡는다 — Esc 로 닫고, 닫으면 누른 자리(칩)로 돌아간다
  useLayoutEffect(() => {
    if (!root.current?.contains(document.activeElement)) returnFocus.current = document.activeElement
    root.current?.focus({ preventScroll: true })
  }, [target])

  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(width))
    } catch {
      // 저장 못 해도 이번 실행은 그 폭
    }
  }, [width])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])

  function close(): void {
    const back = returnFocus.current
    closeFilePreview()
    if (back instanceof HTMLElement && back.isConnected) back.focus()
    else document.querySelector<HTMLElement>('.composer__input')?.focus()
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return
    event.preventDefault()
    close()
  }

  const file = preview !== 'loading' && preview.status !== 'unavailable' ? preview : undefined
  const markdown = preview !== 'loading' && preview.status === 'text' && /\.(md|markdown)$/i.test(preview.path)
  const copyLabel = copied ? t('filePreview.copied') : t('filePreview.copyPath')

  return (
    <aside
      ref={root}
      className="file-preview"
      aria-label={t('filePreview.label')}
      tabIndex={-1}
      style={{ width }}
      onKeyDown={onKeyDown}
    >
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
      <div className="file-preview__head">
        <FileIcon />
        <span className="file-preview__path" title={file?.absolute ?? token}>
          {file?.path ?? token}
        </span>
        <span className="file-preview__tools">
          {markdown && (
            <button type="button" className="file-preview__toggle" aria-pressed={source} onClick={() => setSource((now) => !now)}>
              {source ? t('filePreview.showRendered') : t('filePreview.showSource')}
            </button>
          )}
          {file && features.has('openIn') && <OpenInButton directory={directory} file={token} />}
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
          <button type="button" className="file-preview__tool file-preview__close" aria-label={t('filePreview.close')} title={t('filePreview.close')} onClick={close}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
              <path d="M4 4L12 12M12 4L4 12" />
            </svg>
          </button>
        </span>
      </div>
      {preview !== 'loading' && preview.status === 'text' && preview.truncated && (
        <p className="file-preview__notice" role="note">
          {t('filePreview.truncated', { shown: formatBytes(new TextEncoder().encode(preview.text).length), size: formatBytes(preview.size) })}
        </p>
      )}
      <div className="file-preview__body">
        {preview === 'loading' ? (
          <p className="file-preview__empty">{t('filePreview.loading')}</p>
        ) : preview.status === 'unavailable' ? (
          <p className="file-preview__empty" role="alert">
            {t('filePreview.unavailable')}
          </p>
        ) : preview.status === 'binary' ? (
          <p className="file-preview__empty">{t('filePreview.binary', { size: formatBytes(preview.size) })}</p>
        ) : markdown && !source ? (
          <div className="file-preview__md">
            <Markdown text={preview.text} directory={directory} />
          </div>
        ) : (
          <CodeLines text={preview.text} />
        )}
      </div>
    </aside>
  )
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

function FileIcon() {
  return (
    <svg className="file-preview__icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 1.75H9.5L12.5 4.75V14.25H4Z" />
      <path d="M9.5 1.75V4.75H12.5" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.75 4.25C1.75 3.42 2.42 2.75 3.25 2.75H6.25L7.75 4.25H12.75C13.58 4.25 14.25 4.92 14.25 5.75V11.75C14.25 12.58 13.58 13.25 12.75 13.25H3.25C2.42 13.25 1.75 12.58 1.75 11.75Z" />
    </svg>
  )
}
