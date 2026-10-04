import { useEffect, useRef } from 'react'
import { openFilePreview } from './filePreviewStore.ts'

// 앱 MCP 서버의 화면 쪽 (이슈 #51) — AI 가 부른 open_file·open_terminal 을 받는다. 오른쪽 패널·터미널 칸은 보고 있는 프로젝트 하나의 것이라
// ① 지금 보는 프로젝트를 메인에 알리고(메인이 다른 프로젝트의 호출을 "사용자가 다른 프로젝트를 보고 있다" 로 돌려준다)
// ② 온 요청도 한 번 더 프로젝트로 거른다(알린 직후 프로젝트를 옮긴 틈)

/** enabled 는 데스크탑 MCP 기능(appMcp)이 켜져 있는가. directory 는 지금 보는 대화의 프로젝트. onTerminal 은 그 프로젝트의 터미널 칸을 편다 (키는 가져가지 않는다) */
export function useAppMcp(enabled: boolean, directory: string | undefined, onTerminal: (directory: string) => void): void {
  const viewed = useRef(directory)
  viewed.current = directory
  const terminal = useRef(onTerminal)
  terminal.current = onTerminal

  useEffect(() => {
    if (enabled) void window.litecode.viewProject(directory).catch(() => {}) // 기능이 꺼져 있으면 메인에 핸들러가 없다 (이슈 #99)
  }, [enabled, directory])

  useEffect(() => {
    const offFile = window.litecode.onAppMcpOpenFile((from, path, line) => {
      if (from === viewed.current) openFilePreview(from, path, line)
    })
    const offTerminal = window.litecode.onAppMcpOpenTerminal((from) => {
      if (from === viewed.current) terminal.current(from)
    })
    return () => {
      offFile()
      offTerminal()
    }
  }, [])
}
