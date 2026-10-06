import { useEffect, useRef, useState } from 'react'
import { AppState, BackHandler, Linking, StatusBar, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { startKeepAlive, stopKeepAlive } from './modules/litecode-keepalive/index.ts'
import { AlertBanner } from './src/app/AlertBanner.tsx'
import { AlertCenter } from './src/app/alerts.ts'
import { useLinkState, usePrefs } from './src/app/hooks.ts'
import { DesktopLink, lanUnsupported } from './src/app/link.ts'
import { alertHost, notificationPermission, onNotificationOpen, requestNotificationPermission, setUpNotificationChannels, type NotificationPermission } from './src/app/notifications.ts'
import { apiLevel, defaultDeviceName, desktopStore, pinnedNet, platform, prefsStore, transport } from './src/app/platform.ts'
import { Preferences } from './src/app/prefs.ts'
import { ChatScreen } from './src/app/screens/ChatScreen.tsx'
import { ConnectScreen } from './src/app/screens/ConnectScreen.tsx'
import { ListScreen } from './src/app/screens/ListScreen.tsx'
import { SettingsScreen } from './src/app/screens/SettingsScreen.tsx'
import { S } from './src/app/strings.ts'
import { C } from './src/app/theme.ts'

// 앱은 데스크탑 litecode 에 붙은 화면이다 (이슈 #62) — 대화의 정본은 데스크탑에 있고, 짝이 없으면 연결 화면뿐이다.
// 짝(DesktopLink): 불러오는 중 → 짝 없음(연결 화면) ⇄ 허용 대기 → 붙음(목록·대화·설정). 화면 넷은 상태 하나로 오간다.
// 알림(이슈 #71): 세션의 이벤트를 AlertCenter 가 받아 앞이면 띠, 뒤면 시스템 로컬 알림으로. 연결 유지를 켜면 포그라운드 서비스가 뒤에서도 연결을 붙든다.

type Route = { name: 'list' } | { name: 'chat'; cid: string } | { name: 'settings' }

/** 앱 하나에 짝 하나 — 저장소는 Keystore, 전송은 지문 고정 모듈(https)·expo/fetch(이 컴퓨터 안 평문) (platform.ts) */
const link = new DesktopLink({ store: desktopStore, transport, pinned: pinnedNet, platform, apiLevel })
void link.restore()

const preferences = new Preferences(prefsStore)
void preferences.restore()

const alerts = new AlertCenter({ host: alertHost, prefs: () => preferences.value, foreground: () => AppState.currentState === 'active' })
void setUpNotificationChannels().catch(() => undefined)

export default function App() {
  const state = useLinkState(link)
  const prefs = usePrefs(preferences)
  const [route, setRoute] = useState<Route>({ name: 'list' })
  const [permission, setPermission] = useState<NotificationPermission>('undetermined')
  /** 알림을 눌러 열 대화 — 아직 붙기 전(앱이 그 알림으로 켜졌다)이면 붙은 뒤에 연다 */
  const pendingOpen = useRef<string | undefined>(undefined)
  const linked = state.phase === 'linked'
  const session = linked ? state.session : undefined
  const desktopName = linked ? state.desktop.desktopName : undefined
  const toList = (): void => setRoute({ name: 'list' })

  // 짝이 풀리면(해제·연결 해제) 다음에 붙었을 때 목록부터. 붙었는데 알림으로 열 대화가 있으면 그리로
  useEffect(() => {
    if (!linked) return setRoute({ name: 'list' })
    if (pendingOpen.current !== undefined) setRoute({ name: 'chat', cid: pendingOpen.current })
    pendingOpen.current = undefined
  }, [linked])

  // 시스템 알림을 눌렀다 → 그 대화로 (앱이 그 알림으로 켜진 경우 포함)
  useEffect(
    () =>
      onNotificationOpen((cid) => {
        if (link.state.phase === 'linked') setRoute({ name: 'chat', cid })
        else pendingOpen.current = cid
      }),
    [],
  )

  // Android 뒤로 키 — 대화·설정에서는 목록으로, 그 밖(목록·연결)에서는 앱이 닫힌다(기본 동작)
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!linked || route.name === 'list') return false
      setRoute({ name: 'list' })
      return true
    })
    return () => subscription.remove()
  }, [linked, route.name])

  // 앱이 앞으로 돌아오면 기다리던 재연결을 바로 하고, 알림 권한을 다시 본다(시스템 설정에서 바꾸고 왔을 수 있다)
  useEffect(() => {
    // 이번 실행에서 물어서 거절된 것(denied)은 "아직 안 물음" 으로 되돌리지 않는다 — Android 는 한 번 거절해도 다시 물을 수 있다고 답한다
    const check = (): void => void notificationPermission().then((now) => setPermission((before) => (now === 'undetermined' && before === 'denied' ? before : now)), () => undefined)
    check()
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return
      session?.wake()
      check()
    })
    return () => subscription.remove()
  }, [session])

  // 알림: 붙은 세션의 이벤트를 듣는다. 지금 보고 있는 대화는 알리지 않고, 열면 그 대화의 알림을 지운다
  useEffect(() => {
    if (!session) return
    alerts.attach(session)
    return () => alerts.dispose()
  }, [session])
  const viewing = linked && route.name === 'chat' ? route.cid : undefined
  useEffect(() => alerts.view(viewing), [viewing])

  // 알림 권한(Android 13+)은 처음 필요할 때 묻는다 — 붙어 있고 알림이나 연결 유지가 켜져 있을 때 한 번
  const wantsPermission = linked && (prefs.notifications || prefs.keepAlive)
  useEffect(() => {
    // 물었는데 허용하지 않았으면 이번 실행에서는 다시 묻지 않는다(denied) — 설정 화면이 "권한이 꺼져 있습니다" 와 설정 열기를 보인다
    if (wantsPermission && permission === 'undetermined') void requestNotificationPermission().then((answer) => setPermission(answer === 'granted' ? 'granted' : 'denied'), () => undefined)
  }, [wantsPermission, permission])

  // 연결 유지: 붙어 있고 스위치가 켜져 있는 동안만 서비스가 떠 있다 — 끄거나 연결 해제·기기 해제되면 내려간다
  useEffect(() => {
    if (desktopName === undefined || !prefs.keepAlive) return
    startKeepAlive(S.keepAliveTitle, S.keepAliveText(desktopName), S.channelKeepAlive)
    return () => stopKeepAlive()
  }, [desktopName, prefs.keepAlive])

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" translucent backgroundColor="transparent" />
      {state.phase === 'loading' ? (
        <View style={{ flex: 1, backgroundColor: C.white }} />
      ) : state.phase !== 'linked' ? (
        <ConnectScreen state={state} defaultDeviceName={defaultDeviceName()} lanBlockedApi={lanUnsupported(platform, apiLevel) ? apiLevel : undefined} onPair={(input) => void link.pair(input)} onPairQr={(text, deviceName) => void link.pairQr(text, deviceName)} />
      ) : route.name === 'chat' ? (
        <ChatScreen key={route.cid} session={state.session} cid={route.cid} onBack={toList} />
      ) : route.name === 'settings' ? (
        <SettingsScreen
          session={state.session}
          prefs={prefs}
          permission={permission}
          onPrefs={(change) => preferences.set(change)}
          onOpenSystemSettings={() => void Linking.openSettings()}
          onBack={toList}
          onDisconnect={() => void link.disconnect()}
        />
      ) : (
        <ListScreen session={state.session} onOpen={(cid) => setRoute({ name: 'chat', cid })} onSettings={() => setRoute({ name: 'settings' })} />
      )}
      {linked && <AlertBanner center={alerts} onOpen={(cid) => setRoute({ name: 'chat', cid })} />}
    </SafeAreaProvider>
  )
}
