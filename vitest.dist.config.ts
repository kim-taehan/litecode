import { defineConfig } from 'vitest/config'

// 설치본 스모크 테스트(npm run test:dist): `npm run dist:mac` 이 만든 .app 을 Finder 로 연 것처럼(빈 PATH·격리 HOME) 띄워
// 동봉 opencode·rg 로 대화가 되는지 본다. 빌드가 1분 가까이 걸려 매번 도는 test:live 와 가른다. 가짜 LLM 은 실물 테스트의 것을 쓴다.
export default defineConfig({
  test: {
    include: ['tests/dist/**/*.dist.test.ts'],
    globalSetup: ['tests/live/globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
