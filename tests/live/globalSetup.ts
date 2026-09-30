import type { TestProject } from 'vitest/node'
import { startFakeLlm } from './support/fakeLlm.ts'
import { startOpencode } from './support/opencodeServer.ts'

// 실물 테스트 전체가 공유하는 스택: 가짜 LLM ← 격리된 진짜 opencode.
// 테스트 파일마다 띄우면 opencode 기동(수 초)이 반복되므로 한 번만 띄운다.

declare module 'vitest' {
  export interface ProvidedContext {
    opencodeUrl: string
    /** 가짜 LLM 주소 — `GET /requests` 로 요청 수를 읽는다 */
    fakeLlmUrl: string
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const llm = await startFakeLlm()
  const opencode = await startOpencode(llm.baseURL).catch(async (error) => {
    await llm.stop()
    throw error
  })
  project.provide('opencodeUrl', opencode.url)
  project.provide('fakeLlmUrl', llm.url)

  return async () => {
    await opencode.stop()
    await llm.stop()
  }
}
