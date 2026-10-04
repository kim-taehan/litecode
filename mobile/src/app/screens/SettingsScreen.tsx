import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { expo } from '../../../app.json'
import { useConnectionStatus } from '../hooks.ts'
import { BackArrow } from '../icons.tsx'
import type { AppSession } from '../session.ts'
import { S } from '../strings.ts'
import { C, MONO } from '../theme.ts'

// 4 설정 (시안 Settings). 언어·테마 줄은 모양만, 연결 유지 스위치는 값만 바뀐다(포그라운드 서비스는 다음 라운드).
// "연결 해제" 는 저장된 짝(토큰)을 지우고 연결 화면으로 간다.
export function SettingsScreen({ session, onBack, onDisconnect }: { session: AppSession; onBack(): void; onDisconnect(): void }) {
  const insets = useSafeAreaInsets()
  const status = useConnectionStatus(session)
  const [keepAlive, setKeepAlive] = useState(true)
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
            </View>
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
            <View style={[styles.switchRow, styles.rowBorder]}>
              <View style={styles.switchText}>
                <Text style={styles.rowLabelPlain}>{S.keepAlive}</Text>
                <Text style={styles.hint}>{S.keepAliveHint}</Text>
              </View>
              <Pressable
                accessibilityRole="switch"
                accessibilityLabel={S.keepAlive}
                accessibilityState={{ checked: keepAlive }}
                hitSlop={10}
                style={[styles.switch, { backgroundColor: keepAlive ? C.blue : C.faint, alignItems: keepAlive ? 'flex-end' : 'flex-start' }]}
                onPress={() => setKeepAlive(!keepAlive)}
              >
                <View style={styles.knob} />
              </Pressable>
            </View>
          </View>
        </View>

        <Text style={styles.about}>{S.about(expo.version)}</Text>
      </ScrollView>
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
  about: { fontSize: 12, lineHeight: 18, color: C.sub, paddingHorizontal: 4 },
})
