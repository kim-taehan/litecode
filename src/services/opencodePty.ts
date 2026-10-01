import WebSocket from 'ws'
import type { EngineConnection } from './engine.ts'

// opencode 서버의 pty 에 붙는다 (ctx.llm.openTerminal 만 쓴다). 셸은 opencode 가 띄운다 — node-pty 같은 네이티브 모듈이 없다
// (closed-code electron/pty 와 같은 길). 실측 2026-10-01, opencode 1.18.18 (closed-code 의 1.17.18 실측과 같았다):
// - `POST /api/pty?location[directory]=<dir>` {cwd, title} → {id, command:"/bin/zsh", args:["-l"], cwd, status, pid}. args 는 안 준다
//   (서버가 -l 을 붙인다). 인증은 다른 요청과 같은 Basic — 없으면 401
// - `GET /api/pty/{id}/connect?location[directory]=<dir>&cursor=0` 웹소켓, **Authorization 헤더 그대로**. 보낼 것은 키 바이트 그대로
//   (JSON 봉투 아님). 터미널 출력은 텍스트 프레임, 바이너리 프레임은 0x00 + JSON 제어(`{"cursor":N}`)라 버린다.
//   cursor=0 이면 지금까지의 출력을 다시 준다. 다른 폴더로 붙으면 열리지도 닫히지도 않고 멈춘다 → 여는 데 기한을 둔다
// - 크기는 `PUT /api/pty/{id}` {size:{rows,cols}} (0 이면 400)
// - opencode 가 끝나면 그 pty 셸도 같이 끝난다 (재시작 = 터미널 끝)

const OPEN_TIMEOUT_MS = 10_000

export interface TerminalHandle {
  write(data: string): void
  resize(rows: number, cols: number): Promise<void>
  close(): void
}

export interface TerminalEvents {
  data(chunk: string): void
  /** 셸이 끝났거나 opencode 가 끝났다 */
  exit(): void
}

export async function openPty(conn: EngineConnection, directory: string, on: TerminalEvents): Promise<TerminalHandle> {
  const location = { 'location[directory]': directory }
  const created = await fetch(`${conn.url}/api/pty?${new URLSearchParams(location)}`, {
    method: 'POST',
    headers: { ...conn.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: directory, title: 'litecode' }),
  })
  if (!created.ok) throw new Error(`터미널 생성 실패 (${created.status})`)
  const { id } = ((await created.json()) as { data: { id: string } }).data

  const socket = new WebSocket(`${conn.url.replace(/^http/, 'ws')}/api/pty/${id}/connect?${new URLSearchParams({ ...location, cursor: '0' })}`, {
    headers: conn.headers,
  })
  socket.on('error', () => {}) // 끊김은 close 로 알린다
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => (socket.terminate(), reject(new Error('터미널 연결 시간 초과'))), OPEN_TIMEOUT_MS)
    socket.once('open', () => (clearTimeout(timer), resolve()))
    socket.once('error', (error) => (clearTimeout(timer), reject(new Error(`터미널 연결 실패: ${error.message}`))))
  })
  socket.on('message', (data, binary) => {
    if (!binary) on.data(data.toString())
  })
  socket.on('close', () => on.exit())

  return {
    write(data) {
      if (socket.readyState === WebSocket.OPEN) socket.send(data)
    },
    async resize(rows, cols) {
      if (!(Number.isInteger(rows) && Number.isInteger(cols) && rows > 0 && cols > 0)) return
      await fetch(`${conn.url}/api/pty/${id}?${new URLSearchParams(location)}`, {
        method: 'PUT',
        headers: { ...conn.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ size: { rows, cols } }),
      })
    },
    close() {
      socket.close()
      void fetch(`${conn.url}/api/pty/${id}?${new URLSearchParams(location)}`, { method: 'DELETE', headers: conn.headers }).catch(() => {})
    },
  }
}
