import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './triggers.css'

// 본문 아래 터미널 칸 (closed-code 셸 서랍) — 그 프로젝트 폴더의 셸 하나. ⌘↓ 로 펴서 내려오고 ⌘↑ 로 접는다(App). `!명령` 은 여기가
// 아니라 대화 카드로 돈다. 대화 맥락에는 안 들어간다.
// 셸은 메인(ctx.terminals → 엔진)이 쥐고 출력도 쌓아 둔다: 칸을 접었다 펴면 쌓인 출력을 받아 다시 그리고, 그 뒤 조각만 이어 쓴다
// (end — 받은 출력의 끝 위치 — 이하인 조각은 이미 그렸다). 키는 그대로 셸로 보낸다.

const ENDED = '\r\n\x1b[2m[셸이 끝났습니다 — 키를 누르면 새로 엽니다]\x1b[0m\r\n'

/** focusSignal 이 바뀌면(⌘↓) 키를 칸으로 가져온다 */
export function ShellDrawer({ directory, focusSignal, onClose }: { directory: string; focusSignal: number; onClose(): void }) {
  const host = useRef<HTMLDivElement>(null)
  const screen = useRef<Terminal>(undefined)

  useEffect(() => {
    screen.current?.focus()
  }, [focusSignal])

  useEffect(() => {
    const terminal = new Terminal({
      fontFamily: 'Menlo, Monaco, monospace',
      fontSize: 12,
      cursorBlink: true,
      theme: { background: '#ffffff', foreground: '#0f1115', cursor: '#4176e6', selectionBackground: '#e4edfd' },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host.current!)
    screen.current = terminal
    terminal.focus()

    /** 화면에 그린 출력의 끝 — 붙기 전에는 모른다 (그동안 온 조각은 모아 둔다) */
    let drawn: number | undefined
    const early: [string, number][] = []
    const offData = window.litecode.onTerminalData((from, chunk, end) => {
      if (from !== directory) return
      if (drawn === undefined) early.push([chunk, end])
      else if (end > drawn) {
        terminal.write(chunk)
        drawn = end
      }
    })
    const offExit = window.litecode.onTerminalExit((from) => {
      if (from !== directory) return
      terminal.write(ENDED)
      drawn = 0 // 새 셸은 0 부터 센다
    })
    const resize = (): void => {
      try {
        fit.fit()
      } catch {
        return // 접혀 크기가 없다
      }
      void window.litecode.resizeTerminal(directory, terminal.rows, terminal.cols).catch(() => {})
    }
    void window.litecode.openTerminal(directory).then(
      ({ output, end }) => {
        terminal.write(output)
        drawn = end
        for (const [chunk, chunkEnd] of early) {
          if (chunkEnd <= drawn) continue
          terminal.write(chunk)
          drawn = chunkEnd
        }
        resize()
      },
      (error: Error) => terminal.write(`터미널을 열지 못했습니다: ${error.message}\r\n`),
    )
    const input = terminal.onData((data) => void window.litecode.writeTerminal(directory, data).catch(() => {}))
    const observer = new ResizeObserver(resize)
    observer.observe(host.current!)
    return () => {
      offData()
      offExit()
      input.dispose()
      observer.disconnect()
      terminal.dispose()
    }
  }, [directory])

  return (
    <section className="shell-drawer" aria-label="터미널">
      <div className="shell-drawer__bar">
        <span className="shell-drawer__title">터미널</span>
        <span className="shell-drawer__path">{directory}</span>
        <button type="button" className="shell-drawer__close" aria-label="터미널 접기" title="터미널 접기 (⌘↑)" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="shell-drawer__screen" ref={host} />
    </section>
  )
}
