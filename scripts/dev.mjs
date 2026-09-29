// 개발용 실행기: vite 개발 서버 + electron 을 함께 띄운다.
// electron 은 NODE_OPTIONS=--import tsx 로 띄워 electron/main.ts 를 컴파일 없이 바로 돈다.

import { spawn } from 'node:child_process'

const DEV_SERVER_URL = 'http://localhost:5174'
const READY_TIMEOUT_MS = 15_000
const POLL_INTERVAL_MS = 200

const children = []
function track(child) {
  children.push(child)
  return child
}
function killAll() {
  for (const child of children) if (!child.killed) child.kill('SIGTERM')
}
process.on('SIGINT', () => {
  killAll()
  process.exit(0)
})

async function waitForServer() {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const res = await fetch(DEV_SERVER_URL)
      if (res.ok || res.status < 500) return
    } catch {
      // 아직 안 떴다
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error('vite 개발 서버가 제시간에 안 떴다')
}

console.log('[dev] electron 컴파일 중…')
await new Promise((resolve, reject) => {
  const build = spawn('npx', ['tsc', '-p', 'tsconfig.electron.json'], { stdio: 'inherit', shell: false })
  build.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`electron 컴파일 실패 (exit ${code})`))))
})

console.log('[dev] vite 개발 서버 시작…')
track(spawn('npx', ['vite'], { stdio: 'inherit', shell: false }))

await waitForServer()
console.log(`[dev] electron 시작 (${DEV_SERVER_URL})`)
track(
  spawn('npx', ['electron', '.'], {
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, LITECODE_DEV_SERVER_URL: DEV_SERVER_URL },
  }),
).on('exit', () => killAll())
