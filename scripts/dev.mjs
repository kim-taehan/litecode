// 개발용 실행기: vite 개발 서버 + electron 을 함께 띄운다.
// electron 은 NODE_OPTIONS=--import tsx 로 electron/main.ts 를 컴파일 없이 바로 돈다.

import { spawn } from 'node:child_process'
import net from 'node:net'

const START_PORT = 5174
const PORT_SCAN = 50
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

/** 포트 하나를 잠깐 묶어 본다 — 다른 인스턴스가 듣고 있으면 안 된다 (vite.config 의 strictPort 대로) */
function isFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => void probe.close(() => resolve(true)))
    probe.listen(port, '127.0.0.1')
  })
}

/** 5174 부터 빈 포트를 고른다 — 설치본·다른 dev 인스턴스가 5174 를 쓰고 있으면 strictPort 로 통째로 안 떴던
 *  충돌(피드백 #2, 이슈 #332)을 다음 빈 포트로 피한다 */
async function pickPort() {
  for (let port = START_PORT; port < START_PORT + PORT_SCAN; port++) {
    if (await isFree(port)) return port
  }
  throw new Error(`${START_PORT}~${START_PORT + PORT_SCAN - 1} 범위에서 빈 포트를 찾지 못했다 — 포트를 쓰고 있는 프로세스를 닫고 다시 실행하라`)
}

async function waitForServer(url) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok || res.status < 500) return
    } catch {
      // 아직 안 떴다
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error('vite 개발 서버가 제시간에 안 떴다')
}

const devPort = await pickPort()
const DEV_SERVER_URL = `http://localhost:${devPort}`
if (devPort !== START_PORT) console.log(`[dev] ${START_PORT} 가 이미 사용 중 — 개발 서버는 ${devPort} 로 뜬다`)

console.log('[dev] electron 컴파일 중…')
await new Promise((resolve, reject) => {
  const build = spawn('npx', ['tsc', '-p', 'tsconfig.electron.json'], { stdio: 'inherit', shell: false })
  build.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`electron 컴파일 실패 (exit ${code})`))))
})

console.log(`[dev] vite 개발 서버 시작… (${DEV_SERVER_URL})`)
track(spawn('npx', ['vite', `--port=${devPort}`], { stdio: 'inherit', shell: false }))

await waitForServer(DEV_SERVER_URL)
console.log(`[dev] electron 시작 (${DEV_SERVER_URL})`)
track(
  spawn('npx', ['electron', '.'], {
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, LITECODE_DEV_SERVER_URL: DEV_SERVER_URL },
  }),
).on('exit', () => killAll())
