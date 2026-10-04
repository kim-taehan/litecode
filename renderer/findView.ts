// 대화 안 찾기 (이슈 #79) 의 순수 부분 — DOM 을 모른다. 화면(ChatFind.tsx)이 한 문단의 글자 노드들을 조각으로 넘기면 일치 자리를 준다.
// 조각을 이어 붙여 찾으므로 굵게·코드로 글자 노드가 갈라진 문단에서도 걸린다. 문단을 넘는 일치는 없다 (화면이 문단마다 따로 부른다)

export interface ChunkPoint {
  /** 조각 순번 */
  chunk: number
  /** 그 조각 안의 글자 자리 */
  offset: number
}

export interface ChunkMatch {
  start: ChunkPoint
  /** 끝(그 글자 앞까지) — 일치의 마지막 글자가 있는 조각 안의 자리다 */
  end: ChunkPoint
}

/** 한 대화에서 칠할 일치의 상한 — 한 글자로 긴 대화를 찾아도 화면이 버티게 */
export const FIND_LIMIT = 2_000

/** 대소문자를 가리지 않고, 겹치지 않게 앞에서부터. 빈(공백뿐인) 찾는 말은 일치 없음 */
export function findInChunks(chunks: readonly string[], query: string): ChunkMatch[] {
  if (!query.trim()) return []
  const text = chunks.join('')
  const lower = text.toLowerCase()
  const needleLower = query.toLowerCase()
  // 소문자로 바꾸면 길이가 달라지는 글자(İ 등)가 있으면 자리가 어긋난다 — 그 문단은 대소문자를 가려 찾는다
  const folded = lower.length === text.length && needleLower.length === query.length
  const haystack = folded ? lower : text
  const needle = folded ? needleLower : query

  const matches: ChunkMatch[] = []
  let chunk = 0
  let chunkStart = 0
  /** 이어 붙인 글의 자리 → 조각 안의 자리. at 은 늘 앞으로만 간다. inclusiveEnd: 조각 끝과 같은 자리를 그 조각에 둔다 (일치의 끝) */
  const locate = (at: number, inclusiveEnd: boolean): ChunkPoint => {
    while (chunk < chunks.length - 1 && (inclusiveEnd ? at > chunkStart + chunks[chunk]!.length : at >= chunkStart + chunks[chunk]!.length)) {
      chunkStart += chunks[chunk]!.length
      chunk++
    }
    return { chunk, offset: at - chunkStart }
  }
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    const start = locate(at, false)
    matches.push({ start, end: locate(at + needle.length, true) })
  }
  return matches
}

/** 다음(+1)·이전(-1) 순번 — 끝에서 처음으로 돈다 */
export function stepIndex(index: number, total: number, delta: number): number {
  return total === 0 ? 0 : (((index + delta) % total) + total) % total
}

/** 찾기 줄의 개수 글 — "3/12". capped: 상한에 닿아 더 있을 수 있다 */
export function findCount(index: number, total: number, capped: boolean): string {
  return total === 0 ? '0/0' : `${index + 1}/${total}${capped ? '+' : ''}`
}
