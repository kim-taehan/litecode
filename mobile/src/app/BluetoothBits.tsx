import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useReceivedSince } from './hooks.ts'
import { BluetoothIcon } from './icons.tsx'
import type { AppSession, Carrier } from './session.ts'
import { S } from './strings.ts'
import { C } from './theme.ts'
import { receivingText } from './view.ts'

// 블루투스로 붙어 있을 때만 보이는 조각 (시안 _workspace/mock-ble ② Bt, 이슈 #211). Wi-Fi 면 아무것도 그리지 않는다.

/** 상단 배지 "블루투스 · 느림" */
export function BluetoothBadge({ carrier }: { carrier: Carrier }) {
  if (carrier !== 'bluetooth') return null
  return (
    <View style={styles.badge}>
      <BluetoothIcon size={12} color={C.amberText} strokeWidth={2.2} />
      <Text style={styles.badgeText}>{S.bluetoothBadge}</Text>
    </View>
  )
}

/** 머리 아래 안내 한 줄 */
export function BluetoothInfo({ carrier }: { carrier: Carrier }) {
  if (carrier !== 'bluetooth') return null
  return <Text style={styles.info}>{S.bluetoothInfo}</Text>
}

/** 긴 대화를 받는 진행 — 받은 KB (전체 크기는 미리 모른다 — 막대는 흐르는 모양) */
export function HistoryProgress({ session, loading }: { session: AppSession; loading: boolean }) {
  const active = loading && session.carrier === 'bluetooth'
  const bytes = useReceivedSince(session, active)
  if (!active) return null
  return (
    <View accessibilityRole="progressbar" style={styles.progress}>
      <Text style={styles.progressTitle}>{S.loadingHistory}</Text>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${20 + ((bytes / 1024) % 80)}%` as `${number}%` }]} />
      </View>
      <Text style={styles.progressText}>{receivingText(bytes)}</Text>
    </View>
  )
}

/** 입력창 위 "연결 방법: 블루투스 [Wi-Fi 로 바꾸기]" */
export function CarrierSwitch({ carrier, onCarrier }: { carrier: Carrier; onCarrier(carrier: Carrier): void }) {
  if (carrier !== 'bluetooth') return null
  return (
    <View style={styles.switchRow}>
      <Text style={styles.switchLabel}>{S.connectMethodValue(S.carrierShort.bluetooth)}</Text>
      <Pressable accessibilityRole="button" style={styles.switchButton} onPress={() => onCarrier('wifi')}>
        <Text style={styles.switchButtonText}>{S.switchTo.wifi}</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 28, paddingHorizontal: 10, borderRadius: 14, backgroundColor: C.amberBg, borderWidth: 1, borderColor: C.amberBorder },
  badgeText: { fontSize: 12, fontWeight: '600', color: C.amberText },
  info: { paddingVertical: 8, paddingHorizontal: 16, backgroundColor: C.surface, fontSize: 12.5, lineHeight: 19, color: C.text2 },
  progress: { borderWidth: 0.5, borderColor: C.borderStrong, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12, gap: 8 },
  progressTitle: { fontSize: 12.5, color: C.sub },
  track: { height: 6, borderRadius: 3, backgroundColor: '#ebecee', overflow: 'hidden' },
  fill: { height: 6, backgroundColor: C.blue },
  progressText: { fontSize: 12, color: C.sub },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 8 },
  switchLabel: { flex: 1, fontSize: 12.5, color: C.sub },
  switchButton: { height: 44, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: C.borderStrong, backgroundColor: C.white, justifyContent: 'center' },
  switchButtonText: { fontSize: 13.5, fontWeight: '500', color: C.text },
})
