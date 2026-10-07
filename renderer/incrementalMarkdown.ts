import type * as Md from 'mdast'

// 스트리밍 중인 답의 증분 마크다운 파싱 (이슈 #175 — dsh ui-primitives markdown/incremental.ts 의 설계를 참조해 새로 썼다).
//
// 조각마다 쌓인 답 전체를 다시 파싱하면 답 길이의 제곱으로 느려진다. 블록 파싱은 줄 단위이고 덧붙은 글이 바꿀 수 있는 것은
// 마지막 블록(문단이 표·setext 제목이 되거나, 빈 줄 뒤에 목록이 이어지거나)뿐이라, 끝 UNSTABLE_TAIL_BLOCKS 개만 남기고
// 앞 블록은 얼려 그대로 재사용하고 그 뒤 원문만 다시 파싱한다. 자르는 자리는 파서가 준 `position` 의 **얼린 마지막 블록의 끝**
// (다음 블록의 시작이 아니라) — 블록 사이 빈 줄이 꼬리에 남아 꼬리 원문이 원문 그대로다.
//
// 맨 위의 닫히지 않은 코드 펜스(들여쓰기 없는 것만)는 블록으로 얼릴 수 없어 둘째 경계를 둔다: 펜스 앞 블록은 모두 얼리고,
// 새로 온 줄이 닫는 줄일 수 없는 동안은 파서를 부르지 않고 본문만 늘린다. 닫는 줄(일 수 있는 줄)·CR·NUL 이 보이면 보통 꼬리 파싱으로 돌아간다.
//
// 알려진 어긋남(접두 얼리기는 다 같다): micromark 는 참조 링크·각주를 파싱할 때 문서 전체에서 풀기 때문에, 정의와 참조가
// 얼린 경계 양쪽에 갈리면 그 참조는 스트리밍 중엔 글자로 보인다. 턴이 끝나면 화면이 전체를 한 번 다시 파싱해 바로잡는다(Markdown.tsx).

/** 덧붙는 글이 다시 빚을 수 있는 끝 블록 수 — 바뀌는 건 마지막 하나지만 하나를 더 여유로 둔다 */
const UNSTABLE_TAIL_BLOCKS = 2

interface OpenFence {
  readonly marker: string
  readonly size: number
  readonly lang: string | null | undefined
  readonly meta: string | null | undefined
  /** 본문이 시작하는 원문 오프셋(여는 줄 다음) */
  readonly contentStart: number
  /** 아직 완성되지 않은 줄의 시작 — 여기 앞의 줄은 본문으로 확인됐다 */
  scanned: number
}

/** 덧붙기만 하는 글을 받아 매번 전체 파싱과 같은 블록을 돌려준다 (위 "알려진 어긋남" 은 빼고). 앞이 바뀐 글이 오면 처음부터 다시 */
export class IncrementalMarkdown {
  private source = ''
  private frozen: Md.RootContent[] = []
  /** 꼬리(다시 파싱하는 원문)가 시작하는 오프셋 = 얼린 마지막 블록의 끝 */
  private cut = 0
  private fence: OpenFence | undefined

  constructor(private readonly parse: (text: string) => Md.Root) {}

  update(text: string): Md.Root {
    if (!text.startsWith(this.source)) {
      this.frozen = []
      this.cut = 0
      this.fence = undefined
    }
    this.source = text
    const code = this.fence && growFence(this.fence, text)
    if (code) return root([...this.frozen, code])
    this.fence = undefined

    const base = this.cut
    const tail = text.slice(base)
    const blocks = this.parse(tail).children
    const fence = openFence(blocks.at(-1), tail, base)
    const settle = fence ? blocks.length - 1 : blocks.length - UNSTABLE_TAIL_BLOCKS
    let kept = 0
    if (settle > 0) {
      const end = blocks[settle - 1]!.position?.end.offset
      if (end !== undefined) {
        this.frozen.push(...blocks.slice(0, settle))
        this.cut = base + end
        kept = settle
      }
    }
    // 펜스 앞 블록을 얼렸을 때만 빠른 길을 탄다 — 빠른 길은 얼린 것 + 펜스만 돌려준다
    if (fence && kept === blocks.length - 1) this.fence = fence
    return root([...this.frozen, ...blocks.slice(kept)])
  }
}

function root(children: Md.RootContent[]): Md.Root {
  return { type: 'root', children }
}

const OPENING = /(`{3,}|~{3,})[^\n]*\n/y
const CLOSING = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

/** 이 줄을 펜스 본문으로 그대로 붙여도 되나 — 닫는 줄(일 수 있는 줄)이나 파서가 바꾸는 글자(CR 줄 끝·NUL)가 있으면 아니다 */
function plainLine(line: string, fence: { marker: string; size: number }): boolean {
  if (/[\r\0]/.test(line)) return false
  const close = CLOSING.exec(line)?.[1]
  return !close || close[0] !== fence.marker || close.length < fence.size
}

/** 꼬리의 마지막 블록이 들여쓰기 없는 맨 위의 닫히지 않은 펜스 코드면 그 상태. 여는 줄이 아직 덜 왔거나 닫혔으면 undefined */
function openFence(node: Md.RootContent | undefined, tail: string, base: number): OpenFence | undefined {
  if (node?.type !== 'code' || node.position?.end.offset !== tail.length || node.position.start.column !== 1) return undefined
  OPENING.lastIndex = node.position.start.offset ?? -1
  const open = OPENING.exec(tail)
  if (!open) return undefined
  const fence = { marker: open[1]![0]!, size: open[1]!.length }
  const contentStart = OPENING.lastIndex
  const scanned = scanLines(tail, contentStart, fence)
  if (scanned === undefined) return undefined
  return { ...fence, lang: node.lang, meta: node.meta, contentStart: base + contentStart, scanned: base + scanned }
}

/** 열린 펜스에 새로 온 줄을 붙인 코드 노드. 닫힐 수 있는 줄이 왔으면 undefined (보통 파싱으로 돌아간다) */
function growFence(fence: OpenFence, text: string): Md.Code | undefined {
  const scanned = scanLines(text, fence.scanned, fence)
  if (scanned === undefined) return undefined
  fence.scanned = scanned
  const content = text.slice(fence.contentStart)
  // 닫히지 않은 펜스의 본문 = 여는 줄 뒤 원문에서 끝 줄바꿈 하나를 뗀 것 (micromark 실측: "a\n" → "a", "a\n\n" → "a\n")
  return { type: 'code', lang: fence.lang, meta: fence.meta, value: content.endsWith('\n') ? content.slice(0, -1) : content }
}

/** from 부터 줄마다 본문인지 보고, 덜 온 마지막 줄의 시작을 돌려준다. 본문이 아닌 줄이 있으면(덜 온 줄 포함) undefined */
function scanLines(text: string, from: number, fence: { marker: string; size: number }): number | undefined {
  let start = from
  for (let end = text.indexOf('\n', start); end >= 0; end = text.indexOf('\n', start)) {
    if (!plainLine(text.slice(start, end), fence)) return undefined
    start = end + 1
  }
  return plainLine(text.slice(start), fence) ? start : undefined
}
