import { defineConfig } from 'vitest/config'

// 연결 코어의 단위 테스트 — React Native 없이 Node 에서 돈다. 가짜 데스크탑(dev/fake-desktop.mts)을 127.0.0.1 빈 포트에 띄워 붙는다.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
