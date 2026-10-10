// 시스템 알림 — expo-notifications 의 **로컬 알림만** 쓴다 (이슈 #71). 푸시 토큰·FCM 설정은 없다: 폐쇄망이라 폰이 연결로 받은 소식을 스스로 띄운다.
// 무엇을 언제 알릴지는 alerts.ts(순수)가 정한다 — 여기는 OS 에 내고 거두는 손(AlertHost)과 권한·눌렀을 때의 일뿐이다.

import * as Notifications from 'expo-notifications'
import type { AlertHost } from './alerts.ts'
import { S } from './strings.ts'

/** granted: 낼 수 있다 · undetermined: 아직 안 물었다(물을 수 있다) · denied: 거절됐다 — 시스템 설정에서만 켤 수 있다 */
export type NotificationPermission = 'granted' | 'undetermined' | 'denied'

// 앱이 살아 있는 동안 온 알림도 그대로 보인다 (우리는 앱이 뒤에 있을 때만 낸다 — 앞에서는 띠)
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
})

/** 채널 둘 — 답 필요(중요도 높음: 머리 위로 뜬다)와 완료·실패(기본). Android 13+ 는 채널이 있어야 권한을 물을 수 있다 */
export async function setUpNotificationChannels(): Promise<void> {
  await Notifications.setNotificationChannelAsync('attention', { name: S.channelAttention, importance: Notifications.AndroidImportance.HIGH })
  await Notifications.setNotificationChannelAsync('result', { name: S.channelResult, importance: Notifications.AndroidImportance.DEFAULT })
}

function permissionOf(status: Notifications.NotificationPermissionsStatus): NotificationPermission {
  if (status.granted) return 'granted'
  return status.canAskAgain ? 'undetermined' : 'denied'
}

export async function notificationPermission(): Promise<NotificationPermission> {
  return permissionOf(await Notifications.getPermissionsAsync())
}

/** 권한 창을 띄운다 (Android 13+ POST_NOTIFICATIONS). 이미 정해졌으면 그 값 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  return permissionOf(await Notifications.requestPermissionsAsync())
}

export const alertHost: AlertHost = {
  notify(key, channel, text, cid) {
    // identifier 가 같으면 앞의 알림을 바꾼다 — 대화마다 최신 하나
    void Notifications.scheduleNotificationAsync({ identifier: key, content: { title: text.title, body: text.body, data: cid !== undefined ? { cid } : {} }, trigger: { channelId: channel } }).catch(() => undefined)
  },
  dismiss(key) {
    void Notifications.dismissNotificationAsync(key).catch(() => undefined)
  },
}

function conversationOf(response: Notifications.NotificationResponse | null): string | undefined {
  const cid = response?.notification.request.content.data?.['cid']
  return typeof cid === 'string' ? cid : undefined
}

/** 알림을 눌렀다 — 그 대화 id 를 준다. 앱이 죽어 있다 그 알림으로 켜진 경우도 한 번 준다 */
export function onNotificationOpen(listener: (cid: string) => void): () => void {
  const first = conversationOf(Notifications.getLastNotificationResponse())
  if (first !== undefined) {
    Notifications.clearLastNotificationResponse()
    listener(first)
  }
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const cid = conversationOf(response)
    if (cid !== undefined) listener(cid)
  })
  return () => subscription.remove()
}
