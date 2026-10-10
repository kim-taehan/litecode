// 연결 유지 — Android 포그라운드 서비스를 올리고 내린다 (이슈 #71). 네이티브는 android/ 의 KeepAliveService·KeepAliveModule.
// 공식 푸시가 없으니(폐쇄망) 알림은 데스크탑과의 연결이 살아 있어야 온다. 이 서비스가 떠 있는 동안 앱이 뒤로 가도 프로세스와 JS 타이머가
// 살아 있어 연결이 유지되고, 끊기면 다시 붙는다. 대가는 상시 알림 하나와 배터리다 — 그래서 설정의 스위치(기본 꺼짐)로만 켠다.

import { requireOptionalNativeModule } from 'expo'

interface KeepAliveNative {
  start(title: string, text: string, channel: string): void
  stop(): void
  /** Settings.Secure.ANDROID_ID — 연결 유지와 상관없지만 새 모듈을 들이지 않으려고 여기에 둔다 (이슈 #275). 옛 빌드에는 없다 */
  androidId?(): string
}

const native = requireOptionalNativeModule<KeepAliveNative>('LitecodeKeepAlive')

/** 서비스가 돌리는 JS 작업의 이름 — index.ts 가 AppRegistry.registerHeadlessTask 로 등록한다 (KeepAliveService.TASK_NAME 과 같아야 한다) */
export const KEEP_ALIVE_TASK = 'LitecodeKeepAlive'

let finish: (() => void) | undefined

/** 서비스가 떠 있는 동안 끝나지 않는 작업 — 이것이 도는 동안 React Native 가 뒤에서도 타이머를 돌린다. stopKeepAlive 가 끝낸다 */
export function keepAliveTask(): Promise<void> {
  return new Promise((resolve) => {
    finish = resolve
  })
}

/** 올린다(이미 떠 있으면 상시 알림의 글만 바뀐다). 앱이 앞에 있을 때 불러야 한다. channel 은 알림 채널의 보이는 이름 */
export function startKeepAlive(title: string, text: string, channel: string): void {
  native?.start(title, text, channel)
}

/** 이 폰의 Android ID (재설치에도 같다) — 없거나 못 읽으면 undefined. 그대로 보내지 않는다: src/app/deviceKey.ts 가 해시한다 */
export function androidId(): string | undefined {
  try {
    return native?.androidId?.() || undefined
  } catch {
    return undefined
  }
}

export function stopKeepAlive(): void {
  finish?.()
  finish = undefined
  native?.stop()
}
