import { describe, expect, it, vi } from 'vitest'
import { IncrementalMarkdown } from '../../renderer/incrementalMarkdown.ts'
import { parseMarkdown } from '../../renderer/Markdown.tsx'

vi.mock('../../renderer/settingsStore.ts', () => ({ useT: () => (key: string) => key }))

// 스트리밍 답의 증분 파싱 (이슈 #175) — 기준: 어느 조각에서 끊어 받아도 증분 결과 == 그 시점 원문의 전체 파싱 결과.
// 위치(position)는 꼬리 조각 기준이라 비교에서 뺀다 — 화면은 위치를 쓰지 않는다.

const strip = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, v) => (key === 'position' ? undefined : v)))

/** 결정적 난수 (mulberry32) — 실패가 재현되게 */
function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 원문을 조각내 차례로 넣으며 매번 전체 파싱과 대조한다. 넣은 조각 수(= parse 대조 횟수)를 돌려준다 */
function streamAndCompare(text: string, chunks: number[]): number {
  const incremental = new IncrementalMarkdown(parseMarkdown)
  let at = 0
  let count = 0
  for (const size of chunks) {
    if (at >= text.length) break
    at = Math.min(text.length, at + size)
    const prefix = text.slice(0, at)
    expect(strip(incremental.update(prefix)), JSON.stringify(prefix)).toEqual(strip(parseMarkdown(prefix)))
    count++
  }
  return count
}

const everyChar = (text: string) => Array.from({ length: text.length }, () => 1)
const randomChunks = (text: string, seed: number) => {
  const next = random(seed)
  return Array.from({ length: text.length }, () => (next() < 0.1 ? 1 + Math.floor(next() * 80) : 1 + Math.floor(next() * 8)))
}

const DOCS: Record<string, string> = {
  문단과제목: '# 제목\n\n첫 문단은 **굵게** 와 `code` 를 담는다.\n둘째 줄\n\n둘째 문단\n===\n\n셋째 문단\n---\n\n> 인용\n> 이어짐\n>\n\n끝 문단',
  목록: '- 하나\n- 둘\n\n- 빈 줄 뒤 셋 (느슨한 목록이 된다)\n  - 중첩\n\n    들여 쓴 문단\n\n1. 첫째\n2. 둘째\n\n3) 다른 목록\n\n- [x] 끝\n- [ ] 남음\n\n본문',
  표: '머리 문단\n\n| 이름 | 값 |\n|:--|--:|\n| a | 1 |\n| b | `2` |\n\n표 뒤 문단\n| 머리 | 줄 |\n| --- | --- |\n| 셀 | 셀 |\n\n끝',
  열린펜스: '설명\n\n```ts\nconst a = 1\nfunction f() {\n  return `x`\n}\n``\n  ```js\n~~~\n\n\n\tindented\n',
  닫힌펜스: '앞\n```python\nprint(1)\n```\n뒤 문단\n\n~~~~\n```\n~~~\n~~~~~\n\n````md\n```\nnested\n```\n````\n\n```\n',
  들여쓴펜스: '  ```js\n  a\n b\nc\n  ```\n\n    indented code\n\n    more\n\n끝',
  섞음: '## 단계\n\n1. 설치\n\n   ```bash\n   npm i\n   ```\n\n2. 실행\n\n> ```\n> 인용 속 코드\n\n<div>\n원문 html\n</div>\n\n---\n***\n\n각주[^1]\n\n[^1]: 각주 본문\n    이어짐\n\n마지막 https://example.com 자동 링크',
}

describe('IncrementalMarkdown', () => {
  for (const [name, text] of Object.entries(DOCS)) {
    it(`${name}: 한 글자씩 받아도 매번 전체 파싱과 같다`, () => {
      expect(streamAndCompare(text, everyChar(text))).toBe(text.length)
    })

    it(`${name}: 무작위 조각 크기로 받아도 매번 전체 파싱과 같다`, () => {
      for (const seed of [1, 7, 42, 2026]) streamAndCompare(text, randomChunks(text, seed))
    })
  }

  it('여러 문서를 이어 붙인 긴 답도 같다', () => {
    const text = Object.values(DOCS).join('\n\n')
    for (const seed of [3, 11]) streamAndCompare(text, randomChunks(text, seed))
  })

  it('앞 블록은 얼려 다시 파싱하지 않는다 — 파서가 받는 글은 꼬리뿐이다', () => {
    const seen: string[] = []
    const incremental = new IncrementalMarkdown((text) => (seen.push(text), parseMarkdown(text)))
    const blocks = Array.from({ length: 40 }, (_, index) => `문단 ${index} 의 글이다.`)
    let text = ''
    for (const block of blocks) {
      text += (text ? '\n\n' : '') + block
      incremental.update(text)
    }
    const first = incremental.update(text).children[0]
    // 마지막 파싱은 끝 블록 몇 개만 본다
    expect(seen.at(-1)!.length).toBeLessThan(60)
    expect(seen.at(-1)).not.toContain('문단 0 ')
    // 얼린 블록은 같은 노드를 그대로 돌려준다 (화면이 다시 그리지 않게)
    incremental.update(text + '\n\n더')
    expect(incremental.update(text + '\n\n더 붙음').children[0]).toBe(first)
  })

  it('닫히지 않은 코드 펜스는 줄이 늘어도 파서를 다시 부르지 않는다', () => {
    let calls = 0
    const incremental = new IncrementalMarkdown((text) => (calls++, parseMarkdown(text)))
    let text = '앞 문단\n\n```ts\n'
    incremental.update(text)
    const before = calls
    for (let line = 0; line < 200; line++) {
      text += `const v${line} = ${line}\n`
      const result = incremental.update(text)
      expect(result.children.at(-1)).toMatchObject({ type: 'code', lang: 'ts' })
    }
    expect(calls).toBe(before)
    expect(strip(incremental.update(text))).toEqual(strip(parseMarkdown(text)))
    // 닫는 줄이 오면 보통 파싱으로 돌아간다
    text += '```\n\n뒤'
    expect(strip(incremental.update(text))).toEqual(strip(parseMarkdown(text)))
    expect(calls).toBeGreaterThan(before)
  })

  it('앞이 바뀐 글(덧붙기가 아님)이 오면 처음부터 다시 파싱한다', () => {
    const incremental = new IncrementalMarkdown(parseMarkdown)
    incremental.update('하나\n\n둘\n\n셋\n\n넷')
    const changed = '다른\n\n글\n\n- 목록'
    expect(strip(incremental.update(changed))).toEqual(strip(parseMarkdown(changed)))
  })

  it('참조 링크: 정의가 얼린 경계 너머에 있으면 스트리밍 중엔 글자로 남을 수 있고, 전체 파싱(턴 끝)에서 바로잡힌다', () => {
    const text = '[문서]: https://example.com/doc\n\n문단 하나\n\n문단 둘\n\n문단 셋\n\n[문서] 와 [글][문서] 를 본다'
    const incremental = new IncrementalMarkdown(parseMarkdown)
    for (let at = 1; at <= text.length; at++) incremental.update(text.slice(0, at))
    const streamed = JSON.stringify(incremental.update(text))
    const settled = JSON.stringify(parseMarkdown(text))
    expect(settled).toContain('"linkReference"')
    expect(streamed).not.toContain('"linkReference"') // 알려진 어긋남 — Markdown 은 streaming 이 꺼지면 parseMarkdown 으로 다시 그린다
    // 정의가 참조와 같은 꼬리에 있으면 스트리밍 중에도 같다
    const near = '앞\n\n[문서] 를 본다\n\n[문서]: https://example.com/doc'
    for (const seed of [5, 9]) streamAndCompare(near, randomChunks(near, seed))
  })
})
