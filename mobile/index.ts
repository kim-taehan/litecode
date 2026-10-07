// 맨 먼저 — Hermes 에 없는 crypto.getRandomValues 를 채운다 (블루투스 Noise 임시 키, src/app/randomValues.ts)
import './src/app/randomPolyfill.ts'
import { registerRootComponent } from 'expo'
import { AppRegistry } from 'react-native'
import App from './App'
import { KEEP_ALIVE_TASK, keepAliveTask } from './modules/litecode-keepalive/index.ts'

// 연결 유지 서비스가 돌리는 "끝나지 않는 작업" — 이것이 도는 동안 앱이 뒤에 있어도 JS 타이머가 돈다 (modules/litecode-keepalive)
AppRegistry.registerHeadlessTask(KEEP_ALIVE_TASK, () => keepAliveTask)

registerRootComponent(App)
