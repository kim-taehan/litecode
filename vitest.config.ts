import { defineConfig } from 'vitest/config'

// vite.config.ts 는 root 가 renderer/ 라서 테스트 설정을 따로 둔다.
// 단위 테스트(npm test)는 네트워크·외부 프로세스 없이 돈다. 실물 테스트는 vitest.live.config.ts.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
  },
})
