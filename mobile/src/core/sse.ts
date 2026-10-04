// SSE(text/event-stream) 풀기 — 조각이 줄 중간에서 잘려 와도 된다. 빈 줄이 메시지의 끝이다.
// 주석 줄(`: ping`)은 메시지를 만들지 않는다 (살아 있다는 신호는 "바이트가 왔다" 로 위층이 따로 본다).

export interface SseMessage {
  id?: string
  event?: string
  data: string
}

export class SseParser {
  private rest = ''
  private id: string | undefined
  private event: string | undefined
  private data: string[] = []

  /** 조각을 넣고, 그것으로 완성된 메시지들을 받는다 */
  feed(chunk: string): SseMessage[] {
    const lines = (this.rest + chunk).split(/\r\n|\n|\r/)
    this.rest = lines.pop() ?? ''
    const messages: SseMessage[] = []
    for (const line of lines) {
      if (line === '') {
        if (this.event !== undefined || this.data.length > 0) messages.push({ id: this.id, event: this.event, data: this.data.join('\n') })
        this.id = undefined
        this.event = undefined
        this.data = []
        continue
      }
      if (line.startsWith(':')) continue
      const cut = line.indexOf(':')
      const field = cut === -1 ? line : line.slice(0, cut)
      const value = cut === -1 ? '' : line.slice(cut + 1).replace(/^ /, '')
      if (field === 'id') this.id = value
      else if (field === 'event') this.event = value
      else if (field === 'data') this.data.push(value)
    }
    return messages
  }
}
