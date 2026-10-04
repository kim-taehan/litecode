import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronRight, QrFrame } from '../icons.tsx'
import { S } from '../strings.ts'
import { C, MONO } from '../theme.ts'

/** 견본 확인 코드 (시안) */
const DEMO_CODE = 'ABCD-4821'
/** "데스크탑에서 허용" 상자를 보여 준 뒤 넘어가기까지 */
const PAIRING_MS = 1_200

// 1 연결 (시안 Main). 이번 라운드는 껍데기다: 카메라를 열지 않고, 두 버튼 모두 "데스크탑 허용 대기" 상자를 잠깐 보인 뒤 견본 연결로 넘어간다.
export function ConnectScreen({ onConnected }: { onConnected(): void }) {
  const insets = useSafeAreaInsets()
  const [pairing, setPairing] = useState(false)

  useEffect(() => {
    if (!pairing) return
    const timer = setTimeout(onConnected, PAIRING_MS)
    return () => clearTimeout(timer)
  }, [pairing, onConnected])

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 28, paddingBottom: insets.bottom + 32 }]}>
      <View style={styles.intro}>
        <Text style={styles.title}>{S.appName}</Text>
        <Text style={styles.lead}>{S.connectIntro}</Text>
      </View>

      <View style={styles.qrCard}>
        <View style={styles.qrBox}>
          <QrFrame />
        </View>
        <Pressable accessibilityRole="button" style={styles.primary} onPress={() => setPairing(true)}>
          <Text style={styles.primaryText}>{S.scanQr}</Text>
        </Pressable>
      </View>

      <Pressable accessibilityRole="button" style={styles.manual} onPress={() => setPairing(true)}>
        <Text style={styles.body}>{S.enterManually}</Text>
        <ChevronRight />
      </Pressable>

      {pairing && (
        <View style={styles.allow}>
          <Text style={styles.allowTitle}>{S.allowOnDesktop}</Text>
          <Text style={styles.allowHint}>{S.checkCode}</Text>
          <Text style={styles.code}>{DEMO_CODE}</Text>
        </View>
      )}

      <View style={styles.grow} />
      <Text style={styles.footnote}>{S.connectFootnote}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.white, paddingHorizontal: 24 },
  intro: { gap: 8 },
  title: { fontSize: 26, fontWeight: '700', color: C.text },
  lead: { fontSize: 15, lineHeight: 22, color: C.sub },
  qrCard: { marginTop: 36, borderWidth: 1, borderColor: C.border, borderRadius: 20, padding: 24, alignItems: 'center', gap: 20, backgroundColor: C.surface },
  qrBox: { width: 168, height: 168, borderRadius: 16, borderWidth: 2, borderStyle: 'dashed', borderColor: C.faint, alignItems: 'center', justifyContent: 'center', backgroundColor: C.white },
  primary: { alignSelf: 'stretch', height: 48, borderRadius: 12, backgroundColor: C.text, alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: C.white, fontSize: 15, fontWeight: '600' },
  manual: { marginTop: 16, height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, borderRadius: 12, borderWidth: 1, borderColor: C.border },
  body: { fontSize: 15, color: C.text },
  allow: { marginTop: 24, borderRadius: 14, backgroundColor: C.blueBg, paddingVertical: 14, paddingHorizontal: 16, gap: 6 },
  allowTitle: { fontSize: 15, fontWeight: '600', color: C.blueDark },
  allowHint: { fontSize: 13, lineHeight: 20, color: C.text2 },
  code: { fontFamily: MONO, fontSize: 22, letterSpacing: 4, fontWeight: '500', color: C.text },
  grow: { flexGrow: 1 },
  footnote: { fontSize: 13, lineHeight: 20, color: C.sub },
})
