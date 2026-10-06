// 지문 고정 연결 — 데스크탑의 자체 서명 인증서를 지문(SPKI SHA-256)으로만 믿는 Android 모듈 (android/ 의 PinnedNetModule.kt).
// React Native 의 fetch·XHR 은 신뢰를 바꿀 수 없어 이 모듈이 OkHttp 로 요청과 스트림(SSE)을 직접 낸다. JS 쪽 다리·모양은 src/core/net.ts.

import { requireOptionalNativeModule } from 'expo'
import { createNativePinnedNet, NetError, type PinnedNet, type PinnedNetNative } from '../../src/core/net.ts'

const native = requireOptionalNativeModule<PinnedNetNative>('LitecodePinnedNet')

/** 모듈이 없는 빌드(Expo Go 등) — https 로는 어디에도 붙지 않는다 (평문으로 내려가지 않는다) */
const missing: PinnedNet = {
  probe: () => Promise.reject(new NetError('unreachable', 'LitecodePinnedNet native module is missing')),
  transport: () => ({
    request: () => Promise.reject(new NetError('unreachable', 'LitecodePinnedNet native module is missing')),
    stream: (_request, handlers) => {
      void Promise.resolve().then(() => handlers.onEnd(new NetError('unreachable', 'LitecodePinnedNet native module is missing')))
      return () => undefined
    },
  }),
}

export const pinnedNet: PinnedNet = native ? createNativePinnedNet(native) : missing
