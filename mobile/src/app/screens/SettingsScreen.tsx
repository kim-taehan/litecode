import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { expo } from '../../../app.json'
import { useConnectionStatus } from '../hooks.ts'
import { BackArrow } from '../icons.tsx'
import type { NotificationPermission } from '../notifications.ts'
import type { Prefs } from '../prefs.ts'
import type { AppSession, Carrier } from '../session.ts'
import { S } from '../strings.ts'
import { C, MONO } from '../theme.ts'

// 4 설정 (시안 Settings). 언어·테마 줄은 모양만. "알림"(시안에 없는 줄)과 "연결 유지" 스위치는 저장되는 설정이다 —
// 연결 유지를 켜면 포그라운드 서비스(상시 알림)가 앱이 뒤로 가도 연결을 붙든다. 알림 권한이 꺼져 있으면 그 아래에 안내와 설정 열기.
// "연결 해제" 는 저장된 짝(토큰)을 지우고 연결 화면으로 간다.
export function SettingsScreen({
  session,
  prefs,
  permission,
  onPrefs,
  onOpenSystemSettings,
  onBack,
  onDisconnect,
  onCarrier,
}: {
  session: AppSession
  prefs: Prefs
  permission: NotificationPermission
  onPrefs(change: Partial<Prefs>): void
  onOpenSystemSettings(): void
  onBack(): void
  onDisconnect(): void
  /** 연결 방법 바꾸기 — 지금 연결을 끊고 그 길로 새로 붙는다 */
  onCarrier(carrier: Carrier): void
}) {
  const insets = useSafeAreaInsets()
  const status = useConnectionStatus(session)
  const connected = status.kind === 'connected'

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel={S.back} style={styles.back} onPress={onBack}>
          <BackArrow />
        </Pressable>
        <Text style={styles.headerTitle}>{S.settings}</Text>
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        <View style={styles.group}>
          <Text style={styles.groupTitle}>{S.connectedDesktop}</Text>
          <View style={[styles.card, styles.desktop]}>
            <View style={styles.desktopHead}>
              <View style={[styles.dot, { backgroundColor: connected ? C.green : C.faint }]} />
              <Text style={styles.desktopName}>{session.desktop.name}</Text>
              <View style={styles.grow} />
              <Text style={[styles.desktopState, { color: connected ? C.green : C.sub }]}>{connected ? S.connected : S.disconnected}</Text>
            </View>
            <View style={styles.facts}>
              <Fact label={S.address} value={session.desktop.address} mono />
              <Fact label={S.fingerprint} value={session.desktop.fingerprint ?? S.fingerprintNone} mono={session.desktop.fingerprint !== undefined} />
              <Fact label={S.lastConnected} value={S.justNow} />
              <Fact label={S.connectMethod} value={S.carrierShort[session.carrier]} />
            </View>
            {session.carrier === 'wifi' && (
              <Pressable accessibilityRole="button" style={styles.disconnect} onPress={() => onCarrier('bluetooth')}>
                <Text style={styles.carrierText}>{S.switchTo.bluetooth}</Text>
              </Pressable>
            )}
            <Pressable accessibilityRole="button" style={styles.disconnect} onPress={onDisconnect}>
              <Text style={styles.disconnectText}>{S.disconnect}</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.group}>
          <Text style={styles.groupTitle}>{S.general}</Text>
          <View style={styles.card}>
            <Pressable accessibilityRole="button" style={styles.row}>
              <Text style={styles.rowLabel}>{S.language}</Text>
              <Text style={styles.rowValue}>{S.korean}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" style={[styles.row, styles.rowBorder]}>
              <Text style={styles.rowLabel}>{S.theme}</Text>
              <Text style={styles.rowValue}>{S.system}</Text>
            </Pressable>
            <SwitchRow label={S.notifications} hint={S.notificationsHint} value={prefs.notifications} onChange={(notifications) => onPrefs({ notifications })} />
            {(prefs.notifications || prefs.keepAlive) && permission === 'denied' && (
              <View style={[styles.permission, styles.rowBorder]}>
                <Text style={styles.permissionText}>{S.permissionOff}</Text>
                <Pressable accessibilityRole="button" style={styles.permissionButton} onPress={onOpenSystemSettings}>
                  <Text style={styles.permissionButtonText}>{S.openSystemSettings}</Text>
                </Pressable>
              </View>
            )}
            <SwitchRow label={S.keepAlive} hint={`${S.keepAliveHint}\n${S.keepAliveLimit}`} value={prefs.keepAlive} onChange={(keepAlive) => onPrefs({ keepAlive })} />
          </View>
        </View>

        <Text style={styles.about}>{S.about(expo.version)}</Text>
      </ScrollView>
    </View>
  )
}

function SwitchRow({ label, hint, value, onChange }: { label: string; hint: string; value: boolean; onChange(value: boolean): void }) {
  return (
    <View style={[styles.switchRow, styles.rowBorder]}>
      <View style={styles.switchText}>
        <Text style={styles.rowLabelPlain}>{label}</Text>
        <Text style={styles.hint}>{hint}</Text>
      </View>
      <Pressable
        accessibilityRole="switch"
        accessibilityLabel={label}
        accessibilityState={{ checked: value }}
        hitSlop={10}
        style={[styles.switch, { backgroundColor: value ? C.blue : C.faint, alignItems: value ? 'flex-end' : 'flex-start' }]}
        onPress={() => onChange(!value)}
      >
        <View style={styles.knob} />
      </Pressable>
    </View>
  )
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={[styles.factValue, mono && { fontFamily: MONO }]}>{value}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.surface2 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingBottom: 8 },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 17, fontWeight: '600', color: C.text },
  content: { gap: 20, paddingVertical: 8, paddingHorizontal: 16 },
  group: { gap: 8 },
  groupTitle: { fontSize: 12, color: C.sub, fontWeight: '600', paddingHorizontal: 4 },
  card: { backgroundColor: C.white, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(0,0,0,0.08)' },
  desktop: { paddingVertical: 14, paddingHorizontal: 16, gap: 10 },
  desktopHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  desktopName: { fontSize: 15, fontWeight: '600', color: C.text },
  grow: { flex: 1 },
  desktopState: { fontSize: 13 },
  facts: { gap: 6 },
  fact: { flexDirection: 'row' },
  factLabel: { width: 72, fontSize: 13, color: C.sub },
  factValue: { flex: 1, fontSize: 13, color: C.text },
  disconnect: { height: 44, borderRadius: 10, borderWidth: 1, borderColor: C.borderStrong, backgroundColor: C.white, alignItems: 'center', justifyContent: 'center' },
  disconnectText: { fontSize: 15, fontWeight: '500', color: C.red },
  carrierText: { fontSize: 15, fontWeight: '500', color: C.text },
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 },
  rowBorder: { borderTopWidth: 1, borderTopColor: C.hair },
  rowLabel: { flex: 1, fontSize: 15, color: C.text },
  rowLabelPlain: { fontSize: 15, color: C.text },
  rowValue: { fontSize: 14, color: C.sub },
  switchRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, paddingHorizontal: 16 },
  switchText: { flex: 1, gap: 2 },
  hint: { fontSize: 12, lineHeight: 18, color: C.sub },
  switch: { width: 48, height: 28, borderRadius: 14, padding: 3, justifyContent: 'center' },
  knob: { width: 22, height: 22, borderRadius: 11, backgroundColor: C.white },
  permission: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 16, backgroundColor: C.amberBg },
  permissionText: { flex: 1, fontSize: 12, lineHeight: 18, color: C.amberText },
  permissionButton: { height: 36, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: C.borderStrong, backgroundColor: C.white, justifyContent: 'center' },
  permissionButtonText: { fontSize: 13, fontWeight: '500', color: C.text },
  about: { fontSize: 12, lineHeight: 18, color: C.sub, paddingHorizontal: 4 },
})
