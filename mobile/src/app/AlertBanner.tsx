import { useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { AlertCenter } from './alerts.ts'
import { C } from './theme.ts'

/**
 * 앱이 앞에 있을 때의 알림 띠 — 다른 대화에서 답이 필요해졌거나 턴이 끝났다. 화면 맨 위에 몇 초 떠 있다 사라지고, 누르면 그 대화로 간다.
 * (시안에 없는 화면 조각이다 — 색은 목록의 상태 점과 맞췄다: 답 필요 주황, 완료 파랑, 실패 빨강)
 */
export function AlertBanner({ center, onOpen }: { center: AlertCenter; onOpen(cid: string): void }) {
  const insets = useSafeAreaInsets()
  const banner = useSyncExternalStore(
    (listener) => center.subscribe(listener),
    () => center.banner,
  )
  if (!banner) return null
  const tone = banner.kind === 'attention' ? styles.attention : null
  return (
    <View pointerEvents="box-none" style={[styles.layer, { top: insets.top + 8 }]}>
      <Pressable
        accessibilityRole="alert"
        style={[styles.banner, tone]}
        onPress={() => {
          center.closeBanner()
          onOpen(banner.cid)
        }}
      >
        <View style={[styles.dot, { backgroundColor: banner.kind === 'attention' ? C.amber : banner.kind === 'failed' ? C.red : C.blue }]} />
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={1}>
            {banner.title}
          </Text>
          <Text style={[styles.body, banner.kind === 'attention' && { color: C.amberText }]} numberOfLines={2}>
            {banner.body}
          </Text>
        </View>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  layer: { position: 'absolute', left: 12, right: 12, zIndex: 10 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 14, backgroundColor: C.white, borderWidth: 1, borderColor: C.border, elevation: 6 },
  attention: { backgroundColor: C.amberBg, borderColor: C.amberBorder },
  dot: { width: 10, height: 10, borderRadius: 5 },
  text: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontSize: 15, fontWeight: '600', color: C.text },
  body: { fontSize: 13, lineHeight: 18, color: C.sub },
})
