import { Context, Service } from 'cordis'
import type { TerminalHandle } from './opencodePty.ts'
import './llm.ts'

// (프로젝트, id)마다 터미널 하나 (ctx.terminals) — 오른쪽 패널의 터미널 탭 (이슈 #303). `!명령` 은 여기가 아니라 ctx.shell 로
// 따로 돈다 (사용자 결정 2026-10-02). 셸은 엔진이 띄운다(ctx.llm.openTerminal). 여기는 (폴더, id)별 셸·지금까지의 출력·화면으로 내보낼
// 이벤트만 쥔다. id 는 폴더별로 1 부터 — 화면의 탭 이름(터미널 1·2·…).
// 출력은 메인이 쌓아 둔다 — 탭을 오가거나 패널을 숨겨도 화면이 이어 그릴 수 있게. 셸이 끝나면(exit·엔진 재시작) 지운다.

declare module 'cordis' {
  interface Context {
    terminals: TerminalsService
  }
  interface Events {
    /** end: 이 조각까지 그 터미널이 낸 글자 수 — attach 의 end 이하인 조각은 화면이 이미 받았다 */
    'terminal/data'(directory: string, id: number, chunk: string, end: number): void
    'terminal/exit'(directory: string, id: number): void
  }
}

/** 화면이 다시 그릴 때 받는 출력 상한 (글자) */
const MAX_OUTPUT = 256 * 1024

interface Terminal {
  id: number
  handle: Promise<TerminalHandle>
  output: string
  end: number
}

export class TerminalsService extends Service {
  static readonly inject = ['llm']

  private terminals = new Map<string, Terminal>()
  /** 폴더별로 마지막으로 연 id — 새 터미널의 번호 (탭 이름) */
  private ids = new Map<string, number>()

  constructor(ctx: Context) {
    super(ctx, 'terminals')
    ctx.effect(() => () => {
      for (const terminal of this.terminals.values()) void terminal.handle.then((handle) => handle.close(), () => {})
      this.terminals.clear()
      this.ids.clear()
    })
  }

  private key(directory: string, id: number): string {
    return `${directory}\0${id}`
  }

  /** 그 폴더의 새 터미널 — id 는 폴더에서 1 부터. 지금까지의 출력과 그 끝 위치 */
  async open(directory: string): Promise<{ id: number; output: string; end: number }> {
    const id = (this.ids.get(directory) ?? 0) + 1
    this.ids.set(directory, id)
    return this.ensure(directory, id)
  }

  /** 그 터미널 — 끝났거나 없으면(undefined) undefined (exit·엔진 재시작) */
  async attach(directory: string, id: number): Promise<{ output: string; end: number } | undefined> {
    const terminal = this.terminals.get(this.key(directory, id))
    if (!terminal) return undefined
    await terminal.handle
    return { output: terminal.output, end: terminal.end }
  }

  /** 그 폴더에서 아직 끝내지 않은 id — 연 순서 */
  list(directory: string): number[] {
    const prefix = `${directory}\0`
    return [...this.terminals.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => Number(key.slice(prefix.length)))
      .sort((a, b) => a - b)
  }

  /** 앱 MCP open(터미널) — 켜져 있는 것이 있으면 마지막 연 것을 쓰고, 없으면 새로 연다 */
  async openOrReuse(directory: string): Promise<number> {
    const open = this.list(directory)
    if (open.length > 0) return open[open.length - 1]
    return (await this.open(directory)).id
  }

  /** 키 입력 그대로 — 끝난 터미널이면 하지 않는다 */
  async write(directory: string, id: number, data: string): Promise<void> {
    const terminal = this.terminals.get(this.key(directory, id))
    if (!terminal) return
    ;(await terminal.handle).write(data)
  }

  async resize(directory: string, id: number, rows: number, cols: number): Promise<void> {
    const terminal = this.terminals.get(this.key(directory, id))
    if (terminal) await (await terminal.handle).resize(rows, cols)
  }

  /** 탭 닫기 — 셸을 끝낸다 */
  async close(directory: string, id: number): Promise<void> {
    const terminal = this.terminals.get(this.key(directory, id))
    if (!terminal) return
    this.forget(directory, id, terminal)
    await terminal.handle.then((handle) => handle.close(), () => {})
  }

  private async ensure(directory: string, id: number): Promise<{ id: number; output: string; end: number }> {
    const key = this.key(directory, id)
    const existing = this.terminals.get(key)
    if (existing) {
      await existing.handle
      return { id, output: existing.output, end: existing.end }
    }
    const terminal: Terminal = { id, output: '', end: 0, handle: Promise.resolve(undefined!) }
    terminal.handle = this.ctx.llm.openTerminal(directory, {
      data: (chunk) => {
        terminal.output = (terminal.output + chunk).slice(-MAX_OUTPUT)
        terminal.end += chunk.length
        this.ctx.emit('terminal/data', directory, id, chunk, terminal.end)
      },
      exit: () => {
        this.forget(directory, id, terminal)
        this.ctx.emit('terminal/exit', directory, id)
      },
    })
    terminal.handle.catch(() => this.forget(directory, id, terminal))
    this.terminals.set(key, terminal)
    await terminal.handle
    return { id, output: terminal.output, end: terminal.end }
  }

  private forget(directory: string, id: number, terminal: Terminal): void {
    if (this.terminals.get(this.key(directory, id)) === terminal) this.terminals.delete(this.key(directory, id))
  }
}
