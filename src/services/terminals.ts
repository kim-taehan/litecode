import { Context, Service } from 'cordis'
import type { TerminalHandle } from './opencodePty.ts'
import './llm.ts'

// 프로젝트마다 터미널 하나 (ctx.terminals) — 본문 아래 터미널 칸(⌘↓)의 셸 (closed-code 셸 서랍). `!명령` 은 여기가 아니라 ctx.shell 로
// 따로 돈다 (사용자 결정 2026-10-02). 셸은 엔진이 띄운다(ctx.llm.openTerminal). 여기는 폴더별 셸·지금까지의 출력·화면으로 내보낼 이벤트만 쥔다.
// 출력은 메인이 쌓아 둔다 — 칸을 접었다 펴거나 대화를 옮겨도 화면이 이어 그릴 수 있게. 셸이 끝나면(exit·엔진 재시작) 비우고,
// 다음에 쓰면 새로 띄운다.

declare module 'cordis' {
  interface Context {
    terminals: TerminalsService
  }
  interface Events {
    /** end: 이 조각까지 그 터미널이 낸 글자 수 — attach 의 end 이하인 조각은 화면이 이미 받았다 */
    'terminal/data'(directory: string, chunk: string, end: number): void
    'terminal/exit'(directory: string): void
  }
}

/** 화면이 다시 그릴 때 받는 출력 상한 (글자) */
const MAX_OUTPUT = 256 * 1024

interface Terminal {
  handle: Promise<TerminalHandle>
  output: string
  end: number
}

export class TerminalsService extends Service {
  static readonly inject = ['llm']

  private terminals = new Map<string, Terminal>()

  constructor(ctx: Context) {
    super(ctx, 'terminals')
    ctx.effect(() => () => {
      for (const terminal of this.terminals.values()) void terminal.handle.then((handle) => handle.close(), () => {})
      this.terminals.clear()
    })
  }

  /** 그 폴더의 터미널 (없으면 띄운다) — 지금까지의 출력과 그 끝 위치 */
  async attach(directory: string): Promise<{ output: string; end: number }> {
    const terminal = this.ensure(directory)
    await terminal.handle
    return { output: terminal.output, end: terminal.end }
  }

  /** 키 입력 그대로 */
  async write(directory: string, data: string): Promise<void> {
    ;(await this.ensure(directory).handle).write(data)
  }

  async resize(directory: string, rows: number, cols: number): Promise<void> {
    const terminal = this.terminals.get(directory)
    if (terminal) await (await terminal.handle).resize(rows, cols)
  }

  private ensure(directory: string): Terminal {
    const existing = this.terminals.get(directory)
    if (existing) return existing
    const forget = (): void => {
      if (this.terminals.get(directory) === terminal) this.terminals.delete(directory)
    }
    const terminal: Terminal = { output: '', end: 0, handle: Promise.resolve(undefined!) }
    terminal.handle = this.ctx.llm.openTerminal(directory, {
      data: (chunk) => {
        terminal.output = (terminal.output + chunk).slice(-MAX_OUTPUT)
        terminal.end += chunk.length
        this.ctx.emit('terminal/data', directory, chunk, terminal.end)
      },
      exit: () => {
        forget()
        this.ctx.emit('terminal/exit', directory)
      },
    })
    terminal.handle.catch(forget)
    this.terminals.set(directory, terminal)
    return terminal
  }
}
