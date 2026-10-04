import { createLowlight } from 'lowlight'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import type { DiffRow } from './diffRows.ts'

// 문법 색 (이슈 #81) — 답의 코드 블록·오른쪽 패널 파일 미리보기·diff 카드가 같이 쓰는 순수 로직. 화면(React·DOM)을 모른다.
// 엔진은 highlight.js(lowlight 가 HTML 문자열 대신 나무를 돌려준다 — dangerouslySetInnerHTML 없이 React 요소로 그린다).
// dsh 는 shiki(JS 정규식 엔진)를 쓰지만 같은 언어 묶음으로 재 보니(2026-10-05) 번들 2.2MB·1,200줄 TS 에 0.7초였고,
// 이쪽은 95KB·14ms 다 — 동기로 돌려도 되고 지연 chunk(설치본 file:// 에서 미확인)가 필요 없다. wasm·eval·런타임 내려받기 없음.
// 문법은 아래 목록만 번들에 싣는다. 모르는 언어·너무 큰 글·색칠 실패는 전부 undefined = 색 없는 글.
// 색은 highlight.css 의 --hl-* 토큰(라이트·다크)이 정한다 — 여기서 내는 kind 는 highlight.js 의 클래스 이름 그대로다.

const GRAMMARS = { bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, markdown, python, rust, sql, typescript, xml, yaml }

const lowlight = createLowlight(GRAMMARS)

/** 언어 표시·확장자 → 실은 문법 이름. tsx·jsx 는 highlight.js 의 typescript·javascript 가 JSX 까지 읽는다, toml 은 ini 문법 */
const ALIASES = new Map<string, string>([
  ...Object.keys(GRAMMARS).map((name) => [name, name] as const),
  ...Object.entries({
    typescript: ['ts', 'tsx', 'mts', 'cts'],
    javascript: ['js', 'jsx', 'mjs', 'cjs', 'node'],
    json: ['jsonc', 'json5'],
    xml: ['html', 'htm', 'xhtml', 'svg'],
    python: ['py', 'python3'],
    kotlin: ['kt', 'kts'],
    go: ['golang'],
    rust: ['rs'],
    c: ['h'],
    cpp: ['c++', 'cc', 'cxx', 'hpp', 'hh', 'hxx'],
    csharp: ['cs', 'c#'],
    bash: ['sh', 'shell', 'zsh'],
    yaml: ['yml'],
    ini: ['toml'],
    markdown: ['md'],
    diff: ['patch'],
    dockerfile: ['docker'],
  }).flatMap(([name, others]) => others.map((other) => [other, name] as const)),
])

/** 코드 블록의 언어 표시(```ts)를 실은 문법 이름으로. 모르면 undefined */
export function languageOf(name: string | undefined): string | undefined {
  return name ? ALIASES.get(name.trim().toLowerCase()) : undefined
}

/** 파일 경로 → 문법 이름 (확장자, Dockerfile 은 이름) */
export function languageOfPath(path: string): string | undefined {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'dockerfile'
  const dot = base.lastIndexOf('.')
  return dot > 0 ? ALIASES.get(base.slice(dot + 1)) : undefined
}

/** 색 하나짜리 글 조각. kind 는 CSS 클래스(예: `hljs-keyword`, `hljs-title function_`), 없으면 기본 글자색 */
export interface Token {
  text: string
  kind?: string
}

/** 이보다 큰 글은 색칠하지 않는다 — 5,000줄(dsh 검토 탭과 같은 수)·30만 자. 요소 수(줄당 ~10개)와 색칠 시간(1,200줄 ~14ms)의 상한 */
export const MAX_HIGHLIGHT_LINES = 5_000
export const MAX_HIGHLIGHT_CHARS = 300_000

export function tooLarge(code: string): boolean {
  if (code.length > MAX_HIGHLIGHT_CHARS) return true
  let lines = 1
  for (let at = code.indexOf('\n'); at !== -1; at = code.indexOf('\n', at + 1)) if (++lines > MAX_HIGHLIGHT_LINES) return true
  return false
}

// 같은 글을 다시 색칠하지 않는다 — 대화를 다시 열거나 탭을 오갈 때, 접힌 diff 를 다시 그릴 때. 큰 글(파일)은 담지 않는다
const CACHE_ENTRIES = 200
const CACHE_CHARS = 20_000
const cache = new Map<string, Token[] | undefined>()

const cacheKey = (code: string, language: string) => `${language}\n${code}`

/** 이미 색칠해 둔 결과만 — 없으면(색칠한 적 없으면) undefined. 색칠하지 않는다 */
export function highlighted(code: string, language: string | undefined): Token[] | undefined {
  return language ? cache.get(cacheKey(code, language)) : undefined
}

/** 글 전체를 색칠해 토큰으로. 토큰을 이으면 원문 그대로다. 언어 없음·모름·너무 큼·실패는 undefined */
export function highlight(code: string, language: string | undefined): Token[] | undefined {
  if (!language || !lowlight.registered(language) || tooLarge(code)) return undefined
  const key = cacheKey(code, language)
  if (cache.has(key)) return cache.get(key)
  let tokens: Token[] | undefined
  try {
    tokens = []
    flatten(lowlight.highlight(language, code).children, undefined, tokens)
  } catch {
    tokens = undefined
  }
  if (code.length <= CACHE_CHARS) {
    if (cache.size >= CACHE_ENTRIES) cache.delete(cache.keys().next().value!)
    cache.set(key, tokens)
  }
  return tokens
}

interface TreeNode {
  type: string
  value?: string
  properties?: { className?: unknown }
  children?: TreeNode[]
}

/** 겹친 범위는 가장 안쪽 것의 클래스만 — 화면에서도 글자색은 가장 안쪽 요소가 정한다. 같은 종류가 이어지면 합친다 */
function flatten(nodes: readonly TreeNode[], kind: string | undefined, out: Token[]): void {
  for (const node of nodes) {
    if (node.type === 'text') {
      if (!node.value) continue
      const last = out[out.length - 1]
      if (last && last.kind === kind) last.text += node.value
      else out.push(kind ? { text: node.value, kind } : { text: node.value })
    } else if (node.children) {
      const names = node.properties?.className
      flatten(node.children, Array.isArray(names) && names.length > 0 ? names.join(' ') : kind, out)
    }
  }
}

/** 토큰을 줄 단위로 — 줄바꿈을 품은 토큰(여러 줄 주석·문자열)은 줄마다 나눈다. 줄 수 = 원문을 \n 으로 나눈 수 */
export function tokenLines(tokens: readonly Token[]): Token[][] {
  const lines: Token[][] = [[]]
  for (const token of tokens) {
    const parts = token.text.split('\n')
    parts.forEach((part, index) => {
      if (index > 0) lines.push([])
      if (part) lines[lines.length - 1]!.push(token.kind ? { text: part, kind: token.kind } : { text: part })
    })
  }
  return lines
}

/** 화면에 색칠해 둔 글 — 스트리밍 중엔 글이 이보다 앞서 있다 */
export interface Shown {
  code: string
  language: string | undefined
  tokens: Token[] | undefined
}

/** 색칠해 둔 글 뒤에 글이 더 붙었으면(답이 오는 중) 앞은 그 색 그대로, 붙은 글만 색 없이. 앞이 달라졌으면 undefined */
export function extendTokens(shown: Shown | undefined, code: string, language: string | undefined): Token[] | undefined {
  if (!shown?.tokens || shown.language !== language) return undefined
  if (shown.code === code) return shown.tokens
  return code.startsWith(shown.code) ? [...shown.tokens, { text: code.slice(shown.code.length) }] : undefined
}

/** diff 줄마다 토큰 (rows 와 같은 길이, 경로·구분 줄은 undefined). 삭제 줄은 옛 쪽(문맥+삭제), 그 밖은 새 쪽(문맥+추가)을
 *  이어 붙여 색칠한 결과에서 가져온다 — 줄 하나씩 색칠하면 여러 줄 주석·문자열 안의 줄이 틀린다. 색칠 못 하면 undefined */
export function highlightDiff(rows: readonly DiffRow[], language: string | undefined): (Token[] | undefined)[] | undefined {
  const side = (kinds: readonly DiffRow['kind'][]) => {
    const picked = rows.flatMap((row, index) => (kinds.includes(row.kind) ? [index] : []))
    if (picked.length === 0) return new Map<number, Token[]>()
    const tokens = highlight(picked.map((index) => rows[index]!.text).join('\n'), language)
    if (!tokens) return undefined
    const lines = tokenLines(tokens)
    return lines.length === picked.length ? new Map(picked.map((index, at) => [index, lines[at]!])) : undefined
  }
  const fresh = side(['context', 'add'])
  const old = side(['context', 'del'])
  if (!fresh || !old || fresh.size + old.size === 0) return undefined
  return rows.map((row, index) => (row.kind === 'del' ? old.get(index) : fresh.get(index)))
}
