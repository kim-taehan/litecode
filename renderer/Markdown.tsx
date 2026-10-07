import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type * as Md from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { isWebUrl } from '../shared/webUrl.ts'
import { cjkStrong } from './cjkStrong.ts'
import { openFilePreview } from './filePreviewStore.ts'
import { Tokens, useHighlight, useSeen } from './Highlighted.tsx'
import { languageOf } from './highlight.ts'
import { IncrementalMarkdown } from './incrementalMarkdown.ts'
import { useT } from './settingsStore.ts'
import { looksLikePath } from './turnView.ts'
import './markdown.css'

// 답 말풍선 마크다운 (dsh ui-primitives markdown/MarkdownText·render·CodeBlock 참조 — 모양·규칙만 가져와 새로 썼다).
// 원문 → mdast(GFM: 표·체크박스·취소선·자동 링크 + 한글 굵게 보정) → React 요소. HTML 문자열을 DOM 에 끼우지 않는다:
// 원문 HTML(<script>·<img onerror> 등)은 글자로 보이고, 링크는 http(s) 만 앱 밖 브라우저로, 이미지는 불러오지 않는다
// (폐쇄망에서 원격 이미지는 어차피 안 오고, 열려 있으면 답을 본 순간 밖으로 요청이 나간다 — 추적·유출 통로).
// 코드 블록의 문법 색은 highlight.ts(번들에 실은 highlight.js 문법만, 이슈 #81) — 토큰도 React 요소로 그린다.

/** 파일 언급 칩 — 그 답의 프로젝트와, 그 안의 실제 파일로 확인된 인라인 코드 */
const FileMentions = createContext<{ directory: string; files: ReadonlySet<string> } | undefined>(undefined)

/** 답 원문 하나를 그린다. 빈 줄이 몇 개든 문단 사이는 CSS 간격 하나다.
 *  directory 를 주면 인라인 코드 중 그 프로젝트의 실제 파일을 칩으로 그린다 (판정은 메인 — dsh fileMentions 처럼 추측하지 않는다).
 *  streaming: 글이 뒤로 자라는 중(답이 오는 중) — 끝 블록만 다시 파싱하고 앞 블록은 얼려 다시 그리지 않는다 (이슈 #175) */
export function Markdown({ text, directory, streaming = false }: { text: string; directory?: string; streaming?: boolean }) {
  const root = useMarkdownRoot(text, streaming)
  const definitions = useDefinitions(root)
  const files = useFileMentions(root, directory)
  const body = (
    <div className="md">
      {root.children.flatMap((node, index) => {
        const block = <Block key={index} node={node} defs={definitions} />
        return index === 0 ? [block] : ['\n', block] // renderBlocks 와 같은 블록 사이 줄바꿈
      })}
    </div>
  )
  return directory && files.size > 0 ? <FileMentions.Provider value={{ directory, files }}>{body}</FileMentions.Provider> : body
}

/** 스트리밍 중엔 증분 파서, 끝나면(streaming 이 꺼지면) 전체를 한 번 다시 — 증분이 놓친 참조 링크 같은 어긋남을 바로잡는다 */
function useMarkdownRoot(text: string, streaming: boolean): Md.Root {
  const incremental = useRef<IncrementalMarkdown>(undefined)
  return useMemo(() => {
    if (!streaming) {
      incremental.current = undefined
      return parseMarkdown(text)
    }
    incremental.current ??= new IncrementalMarkdown(parseMarkdown)
    return incremental.current.update(text)
  }, [text, streaming])
}

/** 맨 위 블록 하나 — 얼린 블록은 같은 노드라 다시 그리지 않는다 */
const Block = memo(function Block({ node, defs }: { node: Md.RootContent; defs: Definitions }) {
  return render(node, 0, defs)
})

/** 참조 링크 정의 — 내용(id → 주소)이 같으면 같은 Map 을 지킨다. 조각마다 새 Map 이면 얼린 블록도 다시 그려진다 */
function useDefinitions(root: Md.Root): Definitions {
  const last = useRef<Definitions>(undefined)
  return useMemo(() => {
    const found = collectDefinitions(root)
    const previous = last.current
    if (previous && previous.size === found.size && [...found].every(([id, node]) => previous.get(id)?.url === node.url)) return previous
    return (last.current = found)
  }, [root])
}

const NO_FILES: ReadonlySet<string> = new Set()

function useFileMentions(root: Md.Root, directory: string | undefined): ReadonlySet<string> {
  const candidates = useMemo(() => (directory ? [...new Set(inlineCodes(root))].filter(looksLikePath) : []), [root, directory])
  const key = candidates.join('\n')
  const [files, setFiles] = useState(NO_FILES)
  useEffect(() => {
    if (!directory || candidates.length === 0) return setFiles(NO_FILES)
    let live = true
    void window.litecode.resolveFiles(directory, candidates).then(
      (found) => live && setFiles(new Set(found)),
      () => {},
    )
    return () => {
      live = false
    }
  }, [directory, key])
  return files
}

function inlineCodes(node: Md.Parent, found: string[] = []): string[] {
  for (const child of node.children) {
    if (child.type === 'inlineCode') found.push(child.value)
    if ('children' in child) inlineCodes(child, found)
  }
  return found
}

/** 원문 전체를 한 번에 파싱한다 (증분 파서도 꼬리 조각을 이걸로 파싱한다) */
export function parseMarkdown(text: string): Md.Root {
  return fromMarkdown(text, { extensions: [gfm(), cjkStrong], mdastExtensions: [gfmFromMarkdown()] })
}

type Definitions = Map<string, Md.Definition>

/** `[글][id]` 참조 링크가 찾을 정의 — 같은 id 는 먼저 나온 것 (CommonMark) */
function collectDefinitions(node: Md.Parent, found: Definitions = new Map()): Definitions {
  for (const child of node.children) {
    if (child.type === 'definition' && !found.has(child.identifier)) found.set(child.identifier, child)
    if ('children' in child) collectDefinitions(child, found)
  }
  return found
}

function renderChildren(nodes: Md.Nodes[], defs: Definitions, tight = false): ReactNode[] {
  return nodes.map((node, index) => render(node, index, defs, tight))
}

/** 블록 사이에 줄바꿈 글자를 끼운다 — 화면에선 접히고(white-space: normal), textContent·복사에는 줄 구분이 남는다 (remark-rehype 와 같다) */
function renderBlocks(nodes: Md.Nodes[], defs: Definitions, tight = false): ReactNode[] {
  return renderChildren(nodes, defs, tight).flatMap((block, index) => (index === 0 ? [block] : ['\n', block]))
}

function render(node: Md.Nodes, key: number, defs: Definitions, tight = false): ReactNode {
  switch (node.type) {
    case 'text':
      return node.value
    case 'html':
      return <span key={key} className="md-html">{node.value}</span> // 원문 HTML 은 글자로 (블록 자리면 CSS 가 한 줄을 준다)
    case 'paragraph':
      // 붙은 목록(tight)의 항목 문단은 <p> 없이 — 항목 사이가 벌어지지 않게 (remark-rehype 와 같다)
      return tight ? renderChildren(node.children, defs) : <p key={key}>{renderChildren(node.children, defs)}</p>
    case 'heading': {
      const Tag = `h${node.depth}` as const
      return <Tag key={key}>{renderChildren(node.children, defs)}</Tag>
    }
    case 'thematicBreak':
      return <hr key={key} />
    case 'blockquote':
      return <blockquote key={key}>{renderBlocks(node.children, defs)}</blockquote>
    case 'list': {
      const loose = node.spread === true || node.children.some((item) => item.spread === true)
      const items = node.children.map((item, index) => renderListItem(item, index, defs, !loose))
      return node.ordered ? <ol key={key} start={node.start === 1 || node.start == null ? undefined : node.start}>{items}</ol> : <ul key={key}>{items}</ul>
    }
    case 'table':
      return renderTable(node, key, defs)
    case 'code':
      return <CodeBlock key={key} lang={node.lang ?? undefined} code={node.value} />
    case 'inlineCode':
      return <InlineCode key={key} value={node.value} />
    case 'strong':
      return <strong key={key}>{renderChildren(node.children, defs)}</strong>
    case 'emphasis':
      return <em key={key}>{renderChildren(node.children, defs)}</em>
    case 'delete':
      return <del key={key}>{renderChildren(node.children, defs)}</del>
    case 'break':
      return <br key={key} />
    case 'link':
      return <ExternalLink key={key} url={node.url}>{renderChildren(node.children, defs)}</ExternalLink>
    case 'linkReference': {
      const url = defs.get(node.identifier)?.url
      const children = renderChildren(node.children, defs)
      return url === undefined ? <span key={key}>{children}</span> : <ExternalLink key={key} url={url}>{children}</ExternalLink>
    }
    case 'image':
      return <BlockedImage key={key} alt={node.alt ?? ''} url={node.url} />
    case 'imageReference':
      return <BlockedImage key={key} alt={node.alt ?? ''} url={defs.get(node.identifier)?.url ?? ''} />
    case 'footnoteReference':
      return <sup key={key}>[{node.label ?? node.identifier}]</sup>
    case 'footnoteDefinition':
      return (
        <div key={key} className="md-footnote">
          <sup>[{node.label ?? node.identifier}]</sup> {renderChildren(node.children, defs, true)}
        </div>
      )
    default:
      return null // definition 은 참조가 쓰고, 그 밖의 확장 노드는 그리지 않는다
  }
}

function renderListItem(item: Md.ListItem, key: number, defs: Definitions, tight: boolean): ReactNode {
  return (
    <li key={key}>
      {typeof item.checked === 'boolean' && <input type="checkbox" disabled checked={item.checked} />}
      {renderBlocks(item.children, defs, tight)}
    </li>
  )
}

function renderTable(table: Md.Table, key: number, defs: Definitions): ReactNode {
  const [head, ...body] = table.children
  const cells = (row: Md.TableRow, Cell: 'th' | 'td') =>
    row.children.map((cell, index) => {
      const align = table.align?.[index]
      return <Cell key={index} style={align ? { textAlign: align } : undefined}>{renderChildren(cell.children, defs)}</Cell>
    })
  return (
    <div key={key} className="md-table">
      <table>
        {head && <thead><tr>{cells(head, 'th')}</tr></thead>}
        {body.length > 0 && <tbody>{body.map((row, index) => <tr key={index}>{cells(row, 'td')}</tr>)}</tbody>}
      </table>
    </div>
  )
}

/** 인라인 코드 — 그 프로젝트의 실제 파일이면 파일 아이콘 + 파란 이름 칩. 누르면 채팅 오른쪽 파일 미리보기 패널에 그 파일
 *  (dsh 처럼 오른쪽 사이드바 미리보기 — FilePreview.tsx, 이슈 #17) */
function InlineCode({ value }: { value: string }) {
  const mentions = useContext(FileMentions)
  const t = useT()
  if (!mentions?.files.has(value)) return <code>{value}</code>
  return (
    <button
      type="button"
      className="md-file"
      title={t('markdown.previewFile', { file: value })}
      onClick={() => openFilePreview(mentions.directory, value)}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 1.75H9.5L12.5 4.75V14.25H4Z" />
        <path d="M9.5 1.75V4.75H12.5" />
      </svg>
      {value}
    </button>
  )
}

/** http(s) 만 링크로 — 누르면 메인이 OS 기본 브라우저로 연다(앱 창은 이동하지 않는다). 그 밖의 주소는 글자만 */
function ExternalLink({ url, children }: { url: string; children: ReactNode }) {
  if (!isWebUrl(url)) return <span>{children}</span>
  return (
    <a
      href={url}
      title={url}
      onClick={(event) => {
        event.preventDefault()
        void window.litecode.openExternal(url)
      }}
    >
      {children}
    </a>
  )
}

/** 이미지는 불러오지 않고 대체 글자만 — 주소는 마우스를 올리면 보인다 */
function BlockedImage({ alt, url }: { alt: string; url: string }) {
  const t = useT()
  return <span className="md-image" title={url ? t('markdown.imageHidden', { url }) : undefined}>{alt || t('markdown.image')}</span>
}

const COPIED_MS = 1_500

/** 코드 블록 — 머리(언어, 없으면 "코드 블록") + 오른쪽 아이콘 버튼 둘(줄바꿈 토글·복사) + 고정폭 본문 (dsh CodeBlock·CodeToolbar).
 *  줄바꿈은 dsh 처럼 켠 채로 시작한다. 아는 언어면 글자에 문법 색 — 모르는 언어·언어 표시 없음·너무 큰 블록은 색 없이.
 *  색은 블록이 화면에 처음 들어올 때부터 칠한다 (이슈 #175 — 긴 대화의 화면 밖 블록은 칠하지 않는다) */
function CodeBlock({ lang, code }: { lang?: string; code: string }) {
  const box = useRef<HTMLDivElement>(null)
  const tokens = useHighlight(code, languageOf(lang), useSeen(box))
  const [copied, setCopied] = useState(false)
  const [wrap, setWrap] = useState(true)
  const t = useT()
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])
  const copyLabel = copied ? t('markdown.copied') : t('markdown.copy')
  return (
    <div ref={box} className="md-code" data-wrap={wrap}>
      <div className="md-code__head">
        <span className="md-code__lang">{lang || t('markdown.codeBlock')}</span>
        <span className="md-code__tools">
          <button
            type="button"
            className="md-code__tool md-code__wrap"
            aria-pressed={wrap}
            aria-label={wrap ? t('markdown.wrapOff') : t('markdown.wrapOn')}
            title={wrap ? t('markdown.wrapOff') : t('markdown.wrapOn')}
            onClick={() => setWrap((now) => !now)}
          >
            {/* |→| : 줄 끝까지 가서 접힌다 */}
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2 2.5V13.5M14 2.5V13.5M4.5 8H11.5M9.5 6L11.5 8L9.5 10" />
            </svg>
          </button>
          <button
            type="button"
            className="md-code__tool md-code__copy"
            aria-label={copyLabel}
            title={copyLabel}
            data-copied={copied}
            onClick={() => {
              navigator.clipboard.writeText(code).then(
                () => setCopied(true),
                () => {}, // 창에 포커스가 없으면 거절된다 — 버튼을 누른 직후라 실사용에선 안 일어난다
              )
            }}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
        </span>
      </div>
      <pre><code>{tokens ? <Tokens tokens={tokens} /> : code}</code></pre>
    </div>
  )
}

export function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.75" />
      <path d="M10.75 5.25V3.5C10.75 2.81 10.19 2.25 9.5 2.25H3.5C2.81 2.25 2.25 2.81 2.25 3.5V9.5C2.25 10.19 2.81 10.75 3.5 10.75H5.25" />
    </svg>
  )
}

export function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8.5L6.5 12L13 4.5" />
    </svg>
  )
}
