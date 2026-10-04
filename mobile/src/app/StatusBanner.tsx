import { StyleSheet, Text, View } from 'react-native'
import { useConnectionStatus, useNow } from './hooks.ts'
import type { AppSession } from './session.ts'
import { C } from './theme.ts'
import { statusBanner } from './view.ts'

/** 연결 상태 띠 (시안 List 의 "다시 연결 중 · 3초") — 붙어 있으면 아무것도 그리지 않는다. 목록과 대화 화면 위에 둔다 */
export function StatusBanner({ session }: { session: AppSession }) {
  const status = useConnectionStatus(session)
  const now = useNow(status.kind !== 'connected')
  const text = statusBanner(status, now)
  if (text === undefined) return null
  return (
    <View accessibilityRole="alert" style={styles.banner}>
      <View style={styles.dot} />
      <Text style={styles.text}>{text}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  banner: { marginHorizontal: 16, marginBottom: 8, height: 36, borderRadius: 10, backgroundColor: C.amberBg, borderWidth: 1, borderColor: C.amberBorder, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.amber },
  text: { fontSize: 13, color: C.amberText },
})
