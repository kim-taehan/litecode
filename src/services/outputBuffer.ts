import { StringDecoder } from 'node:string_decoder'

// 자식 프로세스 출력 모으기 — 조각마다 toString() 하면 조각 경계에 걸린 여러 바이트 글자(한글)가 깨지고, 앞에서부터 상한까지만
// 모으면 정작 사유가 적힌 끝(빌드 오류·기동 실패)이 잘린다 (참고 레포 검토 02x A·B·D). 길이는 글자(UTF-16 단위) 수다.

/** 스트림 하나의 바이트 조각 → 글. 스트림마다 하나씩 만든다 (stdout·stderr 는 바이트가 따로 흐른다) */
export function streamText(): { push(part: Buffer): string; end(): string } {
  const decoder = new StringDecoder('utf8')
  return { push: (part) => decoder.write(part), end: () => decoder.end() }
}

/** 대리쌍의 반쪽으로 시작·끝나지 않게 */
const LOW = /^[\udc00-\udfff]/
const HIGH = /[\ud800-\udbff]$/

/** 끝 limit 글자만 쥔다 */
export function keepTail(limit: number): { push(text: string): void; text(): string } {
  let kept = ''
  return {
    push(text) {
      kept = (kept + text).slice(-limit)
    },
    text: () => kept.replace(LOW, ''),
  }
}

/** 앞 head 글자와 끝 tail 글자를 쥔다 — 그 사이는 버리고 몇 글자를 버렸는지만 센다 */
export function keepEnds(head: number, tail: number): { push(text: string): void; head(): string; tail(): string; omitted(): number } {
  let first = ''
  let last = ''
  let omitted = 0
  return {
    push(text) {
      const room = head - first.length
      first += text.slice(0, room)
      last += text.slice(room)
      if (last.length > tail) {
        omitted += last.length - tail
        last = last.slice(-tail)
      }
    },
    head: () => (omitted ? first.replace(HIGH, '') : first),
    tail: () => (omitted ? last.replace(LOW, '') : last),
    omitted: () => omitted,
  }
}
