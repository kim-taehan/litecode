import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

// 실물 테스트용 opencode 를 격리해서 띄운다.
//
// 격리하는 이유 (실측 2026-09-30):
// - 사용자가 평소 쓰는 opencode 가 :4096 에 떠 있을 수 있다 → 빈 포트를 따로 잡는다
// - 전역 설정(~/.config/opencode)에는 진짜 게이트웨이 주소·키가 있다 → XDG_* 를 임시 폴더로 돌려
//   테스트가 그 설정을 읽지도, 세션 기록을 사용자 저장소에 남기지도 않게 한다
// - 끌 때는 **우리가 띄운 PID 만** 죽인다 (패턴으로 죽이면 사용자 opencode 까지 죽는다)
//
// provider 설정은 cwd 가 아니라 전역 위치($XDG_CONFIG_HOME/opencode/opencode.json)에 쓴다 — 세션을 다른 폴더
// (location.directory)에서 돌리면 서버 cwd 의 opencode.json provider 는 그 폴더 카탈로그에 안 보여 턴이 멈춘다
// (01_probe Q2, 2026-09-30 실측). 전역 설정은 모든 폴더 카탈로그에 합쳐진다.

export interface OpencodeServer {
  url: string
  /** opencode 가 cwd 로 쓰는 임시 폴더 (비어 있다) */
  projectDir: string
  stop(): Promise<void>
}

const READY_TIMEOUT_MS = 60_000 // 첫 실행은 opencode 가 provider 패키지를 캐시에 받느라 20초를 넘길 수 있다

export async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as net.AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function waitUntilReady(url: string, child: ChildProcess, log: () => string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let last = ''
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`opencode 가 바로 죽었다 (exit ${child.exitCode})\n${log()}`)
    try {
      const res = await fetch(`${url}/doc`, { signal: AbortSignal.timeout(2_000) })
      if (res.ok) return
      last = `HTTP ${res.status}`
    } catch (error) {
      last = String((error as Error).cause ?? error) // 아직 안 떴다
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`opencode 가 ${READY_TIMEOUT_MS}ms 안에 안 떴다 (마지막 응답: ${last})\n${log()}`)
}

export async function startOpencode(llmBaseURL: string, stateDir = process.env.LITECODE_LIVE_STATE): Promise<OpencodeServer> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'litecode-live-'))
  const xdg = stateDir ?? root
  const projectDir = path.join(root, 'project')
  await fs.mkdir(projectDir)
  const configDir = path.join(xdg, 'config', 'opencode')
  await fs.mkdir(configDir, { recursive: true })
  await fs.writeFile(
    path.join(configDir, 'opencode.json'),
    JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      provider: {
        fake: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Fake LLM',
          options: { baseURL: llmBaseURL, apiKey: 'fake' },
          models: { echo: { name: 'Echo' } },
        },
        // 앱(electron/main.ts)이 등록하는 provider/모델 id 와 같은 이름으로 가짜 LLM 을 한 번 더 건다.
        // ctx.llm 은 우리 provider/모델 id 를 opencode providerID/모델 id 로 그대로 넘기므로, 앱 테스트는
        // 이 이름이 있어야 가짜 LLM 에 닿는다 (없는 providerID 로도 세션 생성은 200 으로 성공한다 — 실측 2026-09-30).
        'gateway-local': {
          npm: '@ai-sdk/openai-compatible',
          name: 'Fake LLM (app id)',
          options: { baseURL: llmBaseURL, apiKey: 'fake' },
          models: { 'qwen3.8-27b': { name: 'Echo' } },
        },
      },
      model: 'fake/echo',
      // 외부 provider 를 끄려는 설정이지만 **막아 주지 않는다** (2026-09-30 실측): 이걸 넣어도
      // `{}` 로 만든 세션이 nano-gpt 로 갔고, /api/model 에도 opencode·nano-gpt 모델이 그대로 나온다.
      // 외부 유출을 실제로 막는 것은 ctx.llm 이 세션 생성 때 model 을 명시하는 것이다. 해가 없어 남겨 둔다.
      enabled_providers: ['fake', 'gateway-local'],
    }),
  )

  const port = await freePort()
  const bin = process.env.OPENCODE_BIN ?? 'opencode'
  let output = ''
  const child = spawn(bin, ['serve', '--port', String(port), '--pure'], {
    cwd: projectDir,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(xdg, 'config'),
      XDG_DATA_HOME: path.join(xdg, 'data'),
      XDG_STATE_HOME: path.join(xdg, 'state'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (part) => (output += part))
  child.stderr?.on('data', (part) => (output += part))
  const spawned = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', (error) => reject(new Error(`opencode 실행 실패 (${bin}) — OPENCODE_BIN 이나 PATH 를 확인: ${error.message}`)))
  })
  await spawned

  const url = `http://127.0.0.1:${port}`
  try {
    await waitUntilReady(url, child, () => output)
  } catch (error) {
    child.kill('SIGTERM')
    await fs.rm(root, { recursive: true, force: true })
    throw error
  }

  return {
    url,
    projectDir,
    async stop() {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve))
        child.kill('SIGTERM')
        await exited
      }
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}
