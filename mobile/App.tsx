import { useCallback, useEffect, useState } from 'react'
import { BackHandler, StatusBar } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { ChatScreen } from './src/app/screens/ChatScreen.tsx'
import { ConnectScreen } from './src/app/screens/ConnectScreen.tsx'
import { ListScreen } from './src/app/screens/ListScreen.tsx'
import { SettingsScreen } from './src/app/screens/SettingsScreen.tsx'
import type { AppSession } from './src/app/session.ts'
import { createDemoSession } from './src/demo/demoSession.ts'

// 화면 껍데기 (이슈 #47) — 화면 넷을 상태 하나로 오간다(내비게이션 라이브러리 없음).
// 세션은 견본이다: 데스크탑 없이 켜진다. 진짜 연결은 createDemoSession 자리에 Connection 을 감싼 AppSession 을 넣으면 된다.

type Route = { name: 'list' } | { name: 'chat'; cid: string } | { name: 'settings' }

export default function App() {
  // 세션이 없으면 연결 화면이다
  const [session, setSession] = useState<AppSession>()
  const [route, setRoute] = useState<Route>({ name: 'list' })

  const connect = useCallback(() => {
    setRoute({ name: 'list' })
    setSession(createDemoSession())
  }, [])
  const disconnect = (): void => {
    session?.dispose()
    setSession(undefined)
  }
  const toList = (): void => setRoute({ name: 'list' })

  // Android 뒤로 키 — 대화·설정에서는 목록으로, 그 밖(목록·연결)에서는 앱이 닫힌다(기본 동작)
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!session || route.name === 'list') return false
      setRoute({ name: 'list' })
      return true
    })
    return () => subscription.remove()
  }, [session, route.name])

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" translucent backgroundColor="transparent" />
      {!session ? (
        <ConnectScreen onConnected={connect} />
      ) : route.name === 'chat' ? (
        <ChatScreen key={route.cid} session={session} cid={route.cid} onBack={toList} />
      ) : route.name === 'settings' ? (
        <SettingsScreen session={session} onBack={toList} onDisconnect={disconnect} />
      ) : (
        <ListScreen session={session} onOpen={(cid) => setRoute({ name: 'chat', cid })} onSettings={() => setRoute({ name: 'settings' })} />
      )}
    </SafeAreaProvider>
  )
}
