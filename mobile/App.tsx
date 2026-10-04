import { useEffect, useState } from 'react'
import { AppState, BackHandler, StatusBar, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { useLinkState } from './src/app/hooks.ts'
import { DesktopLink } from './src/app/link.ts'
import { defaultDeviceName, desktopStore, platform, transport } from './src/app/platform.ts'
import { ChatScreen } from './src/app/screens/ChatScreen.tsx'
import { ConnectScreen } from './src/app/screens/ConnectScreen.tsx'
import { ListScreen } from './src/app/screens/ListScreen.tsx'
import { SettingsScreen } from './src/app/screens/SettingsScreen.tsx'
import { C } from './src/app/theme.ts'

// 앱은 데스크탑 litecode 에 붙은 화면이다 (이슈 #62) — 대화의 정본은 데스크탑에 있고, 짝이 없으면 연결 화면뿐이다.
// 짝(DesktopLink): 불러오는 중 → 짝 없음(연결 화면) ⇄ 허용 대기 → 붙음(목록·대화·설정). 화면 넷은 상태 하나로 오간다.

type Route = { name: 'list' } | { name: 'chat'; cid: string } | { name: 'settings' }

/** 앱 하나에 짝 하나 — 저장소는 Keystore, 전송은 expo/fetch (platform.ts) */
const link = new DesktopLink({ store: desktopStore, transport, platform })
void link.restore()

export default function App() {
  const state = useLinkState(link)
  const [route, setRoute] = useState<Route>({ name: 'list' })
  const linked = state.phase === 'linked'
  const session = linked ? state.session : undefined
  const toList = (): void => setRoute({ name: 'list' })

  // 짝이 풀리면(해제·연결 해제) 다음에 붙었을 때 목록부터
  useEffect(() => {
    if (!linked) setRoute({ name: 'list' })
  }, [linked])

  // Android 뒤로 키 — 대화·설정에서는 목록으로, 그 밖(목록·연결)에서는 앱이 닫힌다(기본 동작)
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!linked || route.name === 'list') return false
      setRoute({ name: 'list' })
      return true
    })
    return () => subscription.remove()
  }, [linked, route.name])

  // 앱이 앞으로 돌아오면 기다리던 재연결을 바로 한다
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') session?.wake()
    })
    return () => subscription.remove()
  }, [session])

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" translucent backgroundColor="transparent" />
      {state.phase === 'loading' ? (
        <View style={{ flex: 1, backgroundColor: C.white }} />
      ) : state.phase !== 'linked' ? (
        <ConnectScreen state={state} defaultDeviceName={defaultDeviceName()} onPair={(input) => void link.pair(input)} />
      ) : route.name === 'chat' ? (
        <ChatScreen key={route.cid} session={state.session} cid={route.cid} onBack={toList} />
      ) : route.name === 'settings' ? (
        <SettingsScreen session={state.session} onBack={toList} onDisconnect={() => void link.disconnect()} />
      ) : (
        <ListScreen session={state.session} onOpen={(cid) => setRoute({ name: 'chat', cid })} onSettings={() => setRoute({ name: 'settings' })} />
      )}
    </SafeAreaProvider>
  )
}
