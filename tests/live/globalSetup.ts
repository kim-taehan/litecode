import type { TestProject } from 'vitest/node'
import { startFakeLlm } from './support/fakeLlm.ts'

// 실물 테스트 전체가 공유하는 것: 가짜 LLM 하나. opencode 는 공유하지 않는다 — 제품처럼 ctx.engine(서비스 테스트)이나
// 앱(앱 테스트)이 스스로 띄운다 (2a: 앱이 opencode 를 직접 띄운다).

declare module 'vitest' {
  export interface ProvidedContext {
    /** 가짜 LLM 주소 — `GET /requests` 로 요청 수·받은 Authorization 을 읽는다. provider baseURL 은 `${fakeLlmUrl}/v1` */
    fakeLlmUrl: string
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const llm = await startFakeLlm()
  project.provide('fakeLlmUrl', llm.url)
  return () => llm.stop()
}
