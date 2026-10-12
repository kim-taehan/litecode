import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useT, type Translate } from './settingsStore.ts'

// 터미널 탭 본문 (이슈 #303) — 그 터미널의 xterm. 셸은 메인(ctx.terminals → 엔진)이 쥐고 출력도 쌓아 둔다: 탭이(다시) 실리면
// 쌓인 출력을 받아 다시 그리고, 그 뒤 온 조각만 이어 쓴다 (end — 그린 출력의 끝 위치 — 이하인 조각은 이미 그렸다).
// 셸이 끝났거나 메인에 없으면(exit·엔진 재시작) attach 가 비어 "[끝남]" 표시가 그 자리에 남는다 — 그 탭은 거기까지다.
// quiet — AI 가 조용히 연 것(open(터미널)): 펼 때 키(포커스)를 가져오지 않는다. 그 뒤 focus 가 바뀌면(⌘↓·⌘[·⌘]·탭 클릭) 키를 가져온다.

const ended = (t: Translate) => `\r\n\x1b[2m[${t('terminal.ended')}]\x1b[0m\r\n`

/** xterm 은 CSS 를 따르지 않는다 — 테마 토큰(--bg 등)을 읽어 넘기고, 테마가 바뀌면(prefers-color-scheme) 다시 넘긴다 */
function terminalTheme() {
  const css = getComputedStyle(document.documentElement)
  const token = (name: string) => css.getPropertyValue(name).trim()
  return { background: token('--bg'), foreground: token('--text'), cursor: token('--accent'), selectionBackground: token('--accent-soft') }
}

export function TerminalView({ directory, terminalId, focus, quiet }: { directory: string; terminalId: number; focus: number; quiet: boolean }) {
  const t = useT()
  /** 셸 안 문구는 이미 그린 출력이라 다시 그리지 않는다 — 효과는 마운트 때만 다시 돈다 */
  const tRef = useRef(t)
  tRef.current = t
  const host = useRef<HTMLDivElement>(null)
  const screen = useRef<Terminal>(undefined)
  /** 처음 실린 때의 값만 본다 — 그 뒤 focus 가 바뀌면(⌘↓·탭 이동) 늘 키를 가져온다 */
  const quietOpen = useRef(quiet)
  const openedAt = useRef(focus)

  useEffect(() => {
    if (quietOpen.current && openedAt.current === focus) return
    screen.current?.focus()
  }, [focus])

  useEffect(() => {
    const terminal = new Terminal({
      fontFamily: 'Menlo, Monaco, monospace',
      fontSize: 12,
      cursorBlink: true,
      theme: terminalTheme(),
    })
    const scheme = window.matchMedia('(prefers-color-scheme: dark)')
    const onScheme = (): void => {
      terminal.options.theme = terminalTheme()
    }
    scheme.addEventListener('change', onScheme)
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host.current!)
    screen.current = terminal
    if (!quietOpen.current) terminal.focus()

    /** 화면에 그린 출력의 끝 — 붙기 전에는 모른다 (그동안 온 조각은 모아 둔다) */
    let drawn: number | undefined
    const early: [string, number][] = []
    const offData = window.litecode.onTerminalData((from, fromId, chunk, end) => {
      if (from !== directory || fromId !== terminalId) return
      if (drawn === undefined) early.push([chunk, end])
      else if (end > drawn) {
        terminal.write(chunk)
        drawn = end
      }
    })
    const offExit = window.litecode.onTerminalExit((from, fromId) => {
      if (from !== directory || fromId !== terminalId) return
      terminal.write(ended(tRef.current))
      drawn = 0
    })
    const resize = (): void => {
      try {
        fit.fit()
      } catch {
        return // 크기가 없다(패널이 닫혀 있다)
      }
      void window.litecode.resizeTerminal(directory, terminalId, terminal.rows, terminal.cols).catch(() => {})
    }
    void window.litecode
      .attachTerminal(directory, terminalId)
      .then(
        (state) => {
          if (state) {
            terminal.write(state.output)
            drawn = state.end
          } else {
            terminal.write(ended(tRef.current)) // 메인에 없다 — 끝났거나 엔진이 재시작했다
            drawn = 0
          }
          for (const [chunk, chunkEnd] of early) {
            if (chunkEnd <= (drawn ?? 0)) continue
            terminal.write(chunk)
            drawn = chunkEnd
          }
          resize()
        },
        (error: Error) => terminal.write(`${tRef.current('terminal.openFailed', { message: error.message })}\r\n`),
      )
    const input = terminal.onData((data) => void window.litecode.writeTerminal(directory, terminalId, data).catch(() => {}))
    const observer = new ResizeObserver(resize)
    observer.observe(host.current!)
    return () => {
      offData()
      offExit()
      input.dispose()
      observer.disconnect()
      scheme.removeEventListener('change', onScheme)
      terminal.dispose()
    }
  }, [directory, terminalId])

  return (
    <div className="terminal-view">
      <div className="terminal-view__screen" ref={host} />
    </div>
  )
}
