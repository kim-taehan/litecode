import { Context } from 'cordis'
import { ProviderRegistry } from './services/providers.ts'
import { LlmService } from './services/llm.ts'

// 진입점. 지금은 서비스 배선만 한다 — UI·세션 계층은 아직 없다.

const ctx = new Context()

ctx.plugin(ProviderRegistry)
ctx.plugin(LlmService, { opencodeUrl: process.env.OPENCODE_URL ?? 'http://127.0.0.1:4096' })

console.log('litecode: providers + llm 서비스 배선 완료. 다음은 세션 계층과 화면.')
