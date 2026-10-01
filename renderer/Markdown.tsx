import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type * as Md from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { isWebUrl } from '../shared/webUrl.ts'
import { cjkStrong } from './cjkStrong.ts'
import './markdown.css'

// 답 말풍선 마크다운 (dsh ui-primitives markdown/MarkdownText·render·CodeBlock 참조 — 모양·규칙만 가져와 새로 썼다).
// 원문 → mdast(GFM: 표·체크박스·취소선·자동 링크 + 한글 굵게 보정) → React 요소. HTML 문자열을 DOM 에 끼우지 않는다:
// 원문 HTML(<script>·<img onerror> 등)은 글자로 보이고, 링크는 http(s) 만 앱 밖 브라우저로, 이미지는 불러오지 않는다
// (폐쇄망에서 원격 이미지는 어차피 안 오고, 열려 있으면 답을 본 순간 밖으로 요청이 나간다 — 추적·유출 통로).
// 문법 색은 없다 — dsh 의 shiki 는 문법 파일만 수 MB 라 동봉 크기에 비해 얻는 게 적다.

/** 답 원문 하나를 그린다. 빈 줄이 몇 개든 문단 사이는 CSS 간격 하나다 */
export function Markdown({ text }: { text: string }) {
  const root = useMemo(() => parse(text), [text])
  const definitions = useMemo(() => collectDefinitions(root), [root])
  return <div className="md">{renderBlocks(root.children, definitions)}</div>
}

function parse(text: string): Md.Root {
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
      return <code key={key}>{node.value}</code>
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
  return <span className="md-image" title={url ? `이미지는 표시하지 않습니다: ${url}` : undefined}>{alt || '이미지'}</span>
}

const COPIED_MS = 1_500

/** 코드 블록 — 머리(언어 + 복사) + 고정폭 본문 (dsh CodeBlock 의 banner·copy) */
function CodeBlock({ lang, code }: { lang?: string; code: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <div className="md-code">
      <div className="md-code__head">
        <span className="md-code__lang">{lang || 'text'}</span>
        <button
          type="button"
          className="md-code__copy"
          onClick={() => {
            navigator.clipboard.writeText(code).then(
              () => setCopied(true),
              () => {}, // 창에 포커스가 없으면 거절된다 — 버튼을 누른 직후라 실사용에선 안 일어난다
            )
          }}
        >
          {copied ? '복사됨' : '복사'}
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  )
}
