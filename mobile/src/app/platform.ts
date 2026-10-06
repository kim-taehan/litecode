// 기기에 기대는 것 — 연결 코어·짝(link.ts)에 넘길 진짜 부품. React Native·Expo 를 아는 곳은 화면과 이 파일뿐이다.

import { fetch as expoFetch } from 'expo/fetch'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import { pinnedNet as nativePinnedNet } from '../../modules/litecode-pinned-net/index.ts'
import { createFetchTransport, isFingerprint, type FetchLike, type PinnedNet, type Transport } from '../core/index.ts'
import type { DesktopStore, SavedDesktop } from './link.ts'
import type { PrefsStore } from './prefs.ts'

/** React Native 기본 fetch 는 응답 본문을 스트림으로 주지 않는다 — 이벤트(SSE)를 받으려면 expo/fetch 여야 한다 */
export const transport: Transport = createFetchTransport(expoFetch as unknown as FetchLike)

/** https 는 전부 이것으로 — 데스크탑 인증서를 지문으로만 믿는다 (modules/litecode-pinned-net) */
export const pinnedNet: PinnedNet = nativePinnedNet

const KEY = 'litecode.desktop'

/** 짝지은 데스크탑(토큰 포함)을 Android Keystore 로 암호화해 둔다 (expo-secure-store) */
export const desktopStore: DesktopStore = {
  async load() {
    const raw = await SecureStore.getItemAsync(KEY)
    if (!raw) return undefined
    const value = JSON.parse(raw) as Partial<SavedDesktop>
    const complete = [value.address, value.baseUrl, value.deviceId, value.token, value.desktopName].every((field) => typeof field === 'string' && field !== '')
    const fingerprintOk = value.fingerprint === undefined || isFingerprint(value.fingerprint)
    const addressesOk = value.addresses === undefined || (Array.isArray(value.addresses) && value.addresses.every((address) => typeof address === 'string'))
    return complete && fingerprintOk && addressesOk ? (value as SavedDesktop) : undefined
  },
  save: (desktop) => SecureStore.setItemAsync(KEY, JSON.stringify(desktop)),
  clear: () => SecureStore.deleteItemAsync(KEY),
}

/** 설정 스위치(알림·연결 유지) — 비밀이 아니지만 저장소를 하나 더 들이지 않으려고 같은 expo-secure-store 에 둔다 */
export const prefsStore: PrefsStore = {
  load: () => SecureStore.getItemAsync('litecode.prefs'),
  save: (raw) => SecureStore.setItemAsync('litecode.prefs', raw),
}

/** 기기 이름 입력칸의 기본값 — 모델명 (예: "Pixel 7") */
export function defaultDeviceName(): string {
  const constants = Platform.constants as { Model?: string; Brand?: string }
  return constants.Model ?? constants.Brand ?? 'Android'
}

export const platform = Platform.OS === 'ios' ? 'ios' : 'android'

/** Android API 레벨 (Android 10 = 29) — 사내망 연결(TLS 1.3)을 쓸 수 있는지 가른다 (link.ts lanUnsupported) */
export const apiLevel: number | undefined = Platform.OS === 'android' ? Number(Platform.Version) : undefined
