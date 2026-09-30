import { defineConfig } from 'vitest/config'

// 실물 테스트(npm run test:live): 격리된 진짜 opencode + 가짜 LLM 을 한 번 띄우고
// 서비스 계층과 Electron 앱을 그 위에서 끝까지 돌린다. 스택은 globalSetup 이 띄우고 끈다.
export default defineConfig({
  test: {
    include: ['tests/live/**/*.live.test.ts'],
    globalSetup: ['tests/live/globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
})
