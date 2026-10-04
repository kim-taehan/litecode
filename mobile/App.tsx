import { StyleSheet, Text, View } from 'react-native'
import { REMOTE_API_VERSION } from '../shared/remote.ts'
import { initialState } from './src/core/index.ts'

// 자리 화면 — 화면(연결·목록·대화·설정)은 시안 승인 뒤 다음 라운드에 만든다 (이슈 #42 는 뼈대 + 연결 코어까지).
// 계약(../shared)과 연결 코어를 여기서 한 번 물어, 번들에 실리는지(Metro 가 ../shared 를 읽는지)가 빌드에서 드러나게 한다.
const wiring = `remote api v${REMOTE_API_VERSION} · seq ${initialState.seq}`

export default function App() {
  return (
    <View style={styles.screen}>
      <Text style={styles.title} accessibilityHint={wiring}>
        litecode
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 28, fontWeight: '600' },
})
