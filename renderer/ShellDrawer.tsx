import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './triggers.css'
import { useT, type Translate } from './settingsStore.ts'

// 본문 아래 터미널 칸 (closed-code 셸 서랍) — 그 프로젝트 폴더의 셸 하나. `!명령` 이 여기서 돈다. 대화 맥락에는 안 들어간다.
// 셸은 메인(ctx.terminals → 엔진)이 쥐고 출력도 쌓아 둔다: 칸을 접었다 펴면 쌓인 출력을 받아 다시 그리고, 그 뒤 조각만 이어 쓴다
// (end — 받은 출력의 끝 위치 — 이하인 조각은 이미 그렸다). 키는 그대로 셸로 보낸다.

const ended = (t: Translate) => `\r\n\x1b[2m[${t('shell.ended')}]\x1b[0m\r\n`

/** xterm 은 CSS 를 따르지 않는다 — 테마 토큰(--bg 등)을 읽어 넘기고, 테마가 바뀌면(prefers-color-scheme) 다시 넘긴다 */
function terminalTheme() {
  const css = getComputedStyle(document.documentElement)
  const token = (name: string) => css.getPropertyValue(name).trim()
  return { background: token('--bg'), foreground: token('--text'), cursor: token('--accent'), selectionBackground: token('--accent-soft') }
}

export function ShellDrawer({ directory, onClose }: { directory: string; onClose(): void }) {
  const t = useT()
  /** 셸 안 문구는 이미 그린 출력이라 다시 그리지 않는다 — 효과는 폴더가 바뀔 때만 다시 돈다 */
  const tRef = useRef(t)
  tRef.current = t
  const host = useRef<HTMLDivElement>(null)

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
      terminal.write(ended(tRef.current))
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
      (error: Error) => terminal.write(`${tRef.current('terminal.openFailed', { message: error.message })}\r\n`),
    )
    const input = terminal.onData((data) => void window.litecode.writeTerminal(directory, data).catch(() => {}))
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
  }, [directory])

  return (
    <section className="shell-drawer" aria-label={t('shell.title')}>
      <div className="shell-drawer__bar">
        <span className="shell-drawer__title">{t('shell.title')}</span>
        <span className="shell-drawer__path">{directory}</span>
        <button type="button" className="shell-drawer__close" aria-label={t('shell.close')} title={t('shell.close')} onClick={onClose}>
          ×
        </button>
      </div>
      <div className="shell-drawer__screen" ref={host} />
    </section>
  )
}
