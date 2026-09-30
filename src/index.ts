import { Context } from 'cordis'
import { ProviderRegistry } from './services/providers.ts'
import { LlmService } from './services/llm.ts'
import { EngineService } from './services/engine.ts'
import os from 'node:os'
import path from 'node:path'

// 진입점. 지금은 서비스 배선만 한다 — UI·세션 계층은 아직 없다.

const ctx = new Context()

ctx.plugin(ProviderRegistry)
// opencode 는 첫 대화 때 ctx.engine 이 띄운다 — 배선만 하는 여기서는 안 뜬다
const state = path.join(os.tmpdir(), 'litecode-spike')
ctx.plugin(EngineService, { configDir: path.join(state, 'opencode'), db: path.join(state, 'opencode.db'), pidFile: path.join(state, 'opencode-server.json') })
ctx.plugin(LlmService)

console.log('litecode: providers + engine + llm 서비스 배선 완료. 다음은 세션 계층과 화면.')
