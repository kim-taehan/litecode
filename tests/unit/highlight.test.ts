import { describe, expect, it } from 'vitest'
import { diffRows } from '../../renderer/diffRows.ts'
import {
  MAX_HIGHLIGHT_CHARS,
  MAX_HIGHLIGHT_LINES,
  extendTokens,
  highlight,
  highlightDiff,
  languageOf,
  languageOfPath,
  tokenLines,
  tooLarge,
  type Token,
} from '../../renderer/highlight.ts'

// 문법 색 (이슈 #81) — 화면을 모르는 순수 로직: 언어 이름 정규화, 토큰 내기, 줄 나누기, 상한, diff 줄에 색 맞추기.
// 실패·모르는 언어·너무 큰 글은 전부 undefined(= 색 없는 글)로 떨어진다.

const text = (tokens: readonly Token[]) => tokens.map((token) => token.text).join('')

describe('languageOf — 코드 블록의 언어 표시', () => {
  it('흔한 줄임말·대소문자·다른 이름을 싣고 있는 문법 이름으로 맞춘다', () => {
    expect(languageOf('ts')).toBe('typescript')
    expect(languageOf('TSX')).toBe('typescript')
    expect(languageOf('jsx')).toBe('javascript')
    expect(languageOf('JavaScript')).toBe('javascript')
    expect(languageOf('py')).toBe('python')
    expect(languageOf('sh')).toBe('bash')
    expect(languageOf('shell')).toBe('bash')
    expect(languageOf('zsh')).toBe('bash')
    expect(languageOf('yml')).toBe('yaml')
    expect(languageOf('toml')).toBe('ini')
    expect(languageOf('html')).toBe('xml')
    expect(languageOf('c++')).toBe('cpp')
    expect(languageOf('c#')).toBe('csharp')
    expect(languageOf('cs')).toBe('csharp')
    expect(languageOf('kt')).toBe('kotlin')
    expect(languageOf('golang')).toBe('go')
    expect(languageOf('rs')).toBe('rust')
    expect(languageOf('md')).toBe('markdown')
    expect(languageOf('patch')).toBe('diff')
    expect(languageOf('docker')).toBe('dockerfile')
    expect(languageOf('jsonc')).toBe('json')
  })

  it('요청된 언어가 모두 실려 있다', () => {
    for (const name of ['ts', 'tsx', 'js', 'jsx', 'json', 'html', 'css', 'python', 'java', 'kotlin', 'go', 'rust', 'c', 'cpp', 'csharp', 'bash', 'sh', 'yaml', 'toml', 'sql', 'markdown', 'diff', 'xml', 'dockerfile']) {
      const language = languageOf(name)
      expect(language, name).toBeDefined()
      expect(highlight('x', language), name).toBeDefined()
    }
  })

  it('모르는 언어·빈 표시는 없음 — 객체 기본 속성 이름에도 속지 않는다', () => {
    expect(languageOf(undefined)).toBeUndefined()
    expect(languageOf('')).toBeUndefined()
    expect(languageOf('brainfuck')).toBeUndefined()
    expect(languageOf('text')).toBeUndefined()
    expect(languageOf('constructor')).toBeUndefined()
    expect(languageOf('__proto__')).toBeUndefined()
  })
})

describe('languageOfPath — 파일 미리보기·diff 의 언어', () => {
  it('확장자로 고른다 (대소문자 무시, 폴더의 점은 안 본다)', () => {
    expect(languageOfPath('src/services/llm.ts')).toBe('typescript')
    expect(languageOfPath('renderer/App.TSX')).toBe('typescript')
    expect(languageOfPath('a/b.mjs')).toBe('javascript')
    expect(languageOfPath('/abs/Main.java')).toBe('java')
    expect(languageOfPath('build.gradle.kts')).toBe('kotlin')
    expect(languageOfPath('x.h')).toBe('c')
    expect(languageOfPath('x.hpp')).toBe('cpp')
    expect(languageOfPath('index.htm')).toBe('xml')
    expect(languageOfPath('Cargo.toml')).toBe('ini')
    expect(languageOfPath('v1.2/notes')).toBeUndefined()
    expect(languageOfPath('README')).toBeUndefined()
    expect(languageOfPath('photo.png')).toBeUndefined()
  })

  it('Dockerfile 은 이름으로 안다', () => {
    expect(languageOfPath('Dockerfile')).toBe('dockerfile')
    expect(languageOfPath('docker/Dockerfile.dev')).toBe('dockerfile')
    expect(languageOfPath('api.dockerfile')).toBe('dockerfile')
  })
})

describe('highlight', () => {
  it('토큰을 이으면 원문 그대로다 — 글자를 더하거나 빼지 않는다', () => {
    const code = 'const a: number = 1 // 주석 <b>&amp;\n\nfunction f(x) {\n  return `${x}!`\n}\n'
    const tokens = highlight(code, 'typescript')!
    expect(text(tokens)).toBe(code)
    expect(tokens.find((token) => token.text === 'const')?.kind).toBe('hljs-keyword')
    expect(tokens.find((token) => token.text.startsWith('// 주석'))?.kind).toBe('hljs-comment')
    expect(tokens.some((token) => token.kind === 'hljs-number' && token.text === '1')).toBe(true)
  })

  it('겹친 범위는 가장 안쪽 것이 이긴다', () => {
    const tokens = highlight('function hello() {}', 'javascript')!
    expect(tokens.find((token) => token.text === 'hello')?.kind).toBe('hljs-title function_')
  })

  it('언어가 없으면 색 없음', () => {
    expect(highlight('const a = 1', undefined)).toBeUndefined()
    expect(highlight('const a = 1', 'nope')).toBeUndefined()
  })

  it('너무 큰 글은 색 없음 — 5000줄·30만 자', () => {
    expect(tooLarge('a\n'.repeat(MAX_HIGHLIGHT_LINES - 1) + 'a')).toBe(false)
    expect(tooLarge('a\n'.repeat(MAX_HIGHLIGHT_LINES) + 'a')).toBe(true)
    expect(tooLarge('a'.repeat(MAX_HIGHLIGHT_CHARS))).toBe(false)
    expect(tooLarge('a'.repeat(MAX_HIGHLIGHT_CHARS + 1))).toBe(true)
    expect(highlight('let a\n'.repeat(MAX_HIGHLIGHT_LINES + 1), 'typescript')).toBeUndefined()
  })

  it('같은 글을 다시 물으면 같은 결과를 돌려준다 (다시 색칠하지 않는다)', () => {
    const first = highlight('let cached = 1', 'typescript')
    expect(highlight('let cached = 1', 'typescript')).toBe(first)
  })
})

describe('tokenLines — 토큰을 줄로', () => {
  it('줄바꿈을 품은 토큰을 줄마다 나누고 종류를 지킨다', () => {
    const lines = tokenLines([{ text: 'a ' }, { text: '/* x\ny */', kind: 'hljs-comment' }, { text: '\n\nb' }])
    expect(lines).toEqual([
      [{ text: 'a ' }, { text: '/* x', kind: 'hljs-comment' }],
      [{ text: 'y */', kind: 'hljs-comment' }],
      [],
      [{ text: 'b' }],
    ])
  })

  it('줄 수는 원문을 줄바꿈으로 나눈 수와 같다', () => {
    const code = '/**\n * 여러 줄\n */\nexport const s = `a\nb`\n'
    expect(tokenLines(highlight(code, 'typescript')!)).toHaveLength(code.split('\n').length)
  })
})

describe('extendTokens — 스트리밍 중 뒤에 붙은 글', () => {
  const shown = { code: 'const a', language: 'typescript', tokens: [{ text: 'const', kind: 'hljs-keyword' }, { text: ' a' }] }

  it('같은 글이면 그대로', () => {
    expect(extendTokens(shown, 'const a', 'typescript')).toBe(shown.tokens)
  })

  it('뒤에 붙었으면 앞은 색을 지키고 붙은 글만 색 없이', () => {
    expect(extendTokens(shown, 'const a = 1', 'typescript')).toEqual([...shown.tokens, { text: ' = 1' }])
  })

  it('앞이 바뀌었거나 언어가 바뀌었거나 색이 없었으면 색 없음', () => {
    expect(extendTokens(shown, 'let a', 'typescript')).toBeUndefined()
    expect(extendTokens(shown, 'const a = 1', 'javascript')).toBeUndefined()
    expect(extendTokens({ ...shown, tokens: undefined }, 'const a = 1', 'typescript')).toBeUndefined()
    expect(extendTokens(undefined, 'const a', 'typescript')).toBeUndefined()
  })
})

describe('highlightDiff — diff 줄마다 토큰', () => {
  const patch = '@@ -1,4 +1,4 @@\n /* 머리\n-   옛 주석 */\n+   새 주석 */\n const a = 1\n-const b = 2\n+const b = 3\n@@ -10,1 +10,1 @@\n-return a\n+return b\n'
  const rows = diffRows(patch)

  it('줄마다 그 줄 글과 같은 토큰을 낸다. 구분 줄(⋯)은 없음', () => {
    const tokens = highlightDiff(rows, 'typescript')!
    expect(tokens).toHaveLength(rows.length)
    rows.forEach((row, index) => {
      if (row.kind === 'gap') expect(tokens[index]).toBeUndefined()
      else expect(text(tokens[index]!), row.text).toBe(row.text)
    })
  })

  it('삭제 줄은 옛 쪽, 추가 줄은 새 쪽의 문맥으로 색칠한다 — 여러 줄 주석 안의 줄도 주석 색', () => {
    const tokens = highlightDiff(rows, 'typescript')!
    const at = (kind: string, value: string) => tokens[rows.findIndex((row) => row.kind === kind && row.text === value)]!
    expect(at('del', '   옛 주석 */')).toEqual([{ text: '   옛 주석 */', kind: 'hljs-comment' }])
    expect(at('add', '   새 주석 */')).toEqual([{ text: '   새 주석 */', kind: 'hljs-comment' }])
    expect(at('add', 'const b = 3').find((token) => token.text === '3')?.kind).toBe('hljs-number')
    expect(at('del', 'return a')[0]).toEqual({ text: 'return', kind: 'hljs-keyword' })
  })

  it('언어를 모르거나 줄이 없으면 색 없음', () => {
    expect(highlightDiff(rows, undefined)).toBeUndefined()
    expect(highlightDiff([], 'typescript')).toBeUndefined()
  })

  it('너무 큰 diff 는 색 없음', () => {
    const big = Array.from({ length: MAX_HIGHLIGHT_LINES + 1 }, () => ({ kind: 'add' as const, text: 'let a' }))
    expect(highlightDiff(big, 'typescript')).toBeUndefined()
  })
})
