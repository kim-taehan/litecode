import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Keyboard, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { groupCode, normalizePairCode, PAIR_CODE_LENGTH, PAIR_DEVICE_NAME_MAX } from '../../../../shared/remotePairing.ts'
import { DEFAULT_ADDRESS } from '../address.ts'
import { ChevronDown, ChevronRight, QrFrame } from '../icons.tsx'
import type { LinkState, PairInput } from '../link.ts'
import { S } from '../strings.ts'
import { C, MONO } from '../theme.ts'

// 1 연결 (시안 Main). 짝이 없으면 이 화면뿐이다 — 앱은 데스크탑 없이 대화를 쥐지 않는다.
// "주소와 코드 직접 입력" 을 누르면 입력 폼이 펼쳐진다(시안에 폼 배치는 없다 — 같은 카드 모양으로 넣었다). [연결] → 데스크탑의 [허용] 을
// 기다리는 동안 "데스크탑에서 허용을 눌러 주세요" 상자에 확인 코드가 뜬다(데스크탑 창의 것과 같아야 한다). QR 스캔은 아직 없다(카메라).
export function ConnectScreen({ state, defaultDeviceName, onPair }: { state: Extract<LinkState, { phase: 'unpaired' | 'pairing' }>; defaultDeviceName: string; onPair(input: PairInput): void }) {
  const insets = useSafeAreaInsets()
  const [open, setOpen] = useState(false)
  const [address, setAddress] = useState(DEFAULT_ADDRESS)
  const [code, setCode] = useState('')
  const [deviceName, setDeviceName] = useState(defaultDeviceName)
  const pairing = state.phase === 'pairing'
  const failure = state.phase === 'unpaired' ? state.failure : undefined
  const revoked = state.phase === 'unpaired' && state.revoked === true
  const scroll = useRef<ScrollView>(null)

  // 허용 대기 상자(확인 코드)는 폼 아래에 생긴다 — 보이게 내린다
  useEffect(() => {
    if (!pairing) return
    const timer = setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 100)
    return () => clearTimeout(timer)
  }, [pairing])

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="padding">
      <ScrollView ref={scroll} contentContainerStyle={[styles.content, { paddingTop: insets.top + 28, paddingBottom: insets.bottom + 32 }]} keyboardShouldPersistTaps="handled">
        <View style={styles.intro}>
          <Text style={styles.title}>{S.appName}</Text>
          <Text style={styles.lead}>{S.connectIntro}</Text>
        </View>

        {revoked && (
          <View style={styles.revoked}>
            <Text style={styles.revokedText}>{S.revokedOnDesktop}</Text>
          </View>
        )}

        <View style={styles.qrCard}>
          <View style={styles.qrBox}>
            <QrFrame />
          </View>
          <View accessibilityRole="button" accessibilityState={{ disabled: true }} style={[styles.primary, styles.disabled]}>
            <Text style={styles.primaryText}>{S.scanQrSoon}</Text>
          </View>
        </View>

        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} style={styles.manual} onPress={() => setOpen(!open)}>
          <Text style={styles.body}>{S.enterManually}</Text>
          {open ? <ChevronDown /> : <ChevronRight />}
        </Pressable>

        {open && (
          <View style={styles.form}>
            <Field label={S.addressLabel}>
              <TextInput
                accessibilityLabel={S.addressLabel}
                style={[styles.input, styles.mono]}
                value={address}
                onChangeText={setAddress}
                editable={!pairing}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
            </Field>
            <Field label={S.codeLabel} hint={S.codeHint}>
              <TextInput
                accessibilityLabel={S.codeLabel}
                style={[styles.input, styles.mono, styles.code]}
                value={code}
                // 치는 대로 데스크탑 화면의 모양으로: 대문자, O→0 · I/L→1, 네 글자씩
                onChangeText={(text) => setCode(groupCode(normalizePairCode(text).slice(0, PAIR_CODE_LENGTH)))}
                editable={!pairing}
                placeholder="XXXX-XXXX-XXXX"
                placeholderTextColor={C.faint}
                autoCapitalize="characters"
                autoCorrect={false}
                keyboardType="visible-password"
              />
            </Field>
            <Field label={S.deviceNameLabel}>
              <TextInput accessibilityLabel={S.deviceNameLabel} style={styles.input} value={deviceName} onChangeText={setDeviceName} editable={!pairing} maxLength={PAIR_DEVICE_NAME_MAX} autoCorrect={false} />
            </Field>

            {failure !== undefined && (
              <Text accessibilityRole="alert" style={styles.failure}>
                {S.pairFailure[failure]}
              </Text>
            )}

            <Pressable accessibilityRole="button" accessibilityState={{ disabled: pairing }} disabled={pairing} style={[styles.primary, pairing && styles.disabled]} onPress={() => (Keyboard.dismiss(), onPair({ address, code, deviceName }))}>
              <Text style={styles.primaryText}>{pairing ? S.waitingForAllow : S.connect}</Text>
            </Pressable>
          </View>
        )}

        {state.phase === 'pairing' && (
          <View style={styles.allow}>
            <Text style={styles.allowTitle}>{S.allowOnDesktop}</Text>
            <Text style={styles.allowHint}>{S.checkCode}</Text>
            <Text style={styles.confirm}>{state.confirm}</Text>
          </View>
        )}

        <View style={styles.grow} />
        <Text style={styles.footnote}>{S.connectFootnote}</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {hint !== undefined && <Text style={styles.hint}>{hint}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.white },
  content: { flexGrow: 1, paddingHorizontal: 24 },
  intro: { gap: 8 },
  title: { fontSize: 26, fontWeight: '700', color: C.text },
  lead: { fontSize: 15, lineHeight: 22, color: C.sub },
  revoked: { marginTop: 20, borderRadius: 10, backgroundColor: C.amberBg, borderWidth: 1, borderColor: C.amberBorder, paddingVertical: 10, paddingHorizontal: 12 },
  revokedText: { fontSize: 13, lineHeight: 20, color: C.amberText },
  qrCard: { marginTop: 36, borderWidth: 1, borderColor: C.border, borderRadius: 20, padding: 24, alignItems: 'center', gap: 20, backgroundColor: C.surface },
  qrBox: { width: 168, height: 168, borderRadius: 16, borderWidth: 2, borderStyle: 'dashed', borderColor: C.faint, alignItems: 'center', justifyContent: 'center', backgroundColor: C.white },
  primary: { alignSelf: 'stretch', height: 48, borderRadius: 12, backgroundColor: C.text, alignItems: 'center', justifyContent: 'center' },
  disabled: { backgroundColor: C.faint },
  primaryText: { color: C.white, fontSize: 15, fontWeight: '600' },
  manual: { marginTop: 16, height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, borderRadius: 12, borderWidth: 1, borderColor: C.border },
  body: { fontSize: 15, color: C.text },
  form: { marginTop: 12, borderWidth: 1, borderColor: C.border, borderRadius: 16, padding: 16, gap: 14, backgroundColor: C.surface },
  field: { gap: 6 },
  label: { fontSize: 12, fontWeight: '600', color: C.sub },
  hint: { fontSize: 12, lineHeight: 18, color: C.sub },
  input: { height: 48, borderRadius: 10, borderWidth: 1, borderColor: C.borderStrong, backgroundColor: C.white, paddingHorizontal: 12, fontSize: 15, color: C.text },
  mono: { fontFamily: MONO },
  code: { fontSize: 18, letterSpacing: 2 },
  failure: { fontSize: 13, lineHeight: 20, color: C.red },
  allow: { marginTop: 16, borderRadius: 14, backgroundColor: C.blueBg, paddingVertical: 14, paddingHorizontal: 16, gap: 6 },
  allowTitle: { fontSize: 15, fontWeight: '600', color: C.blueDark },
  allowHint: { fontSize: 13, lineHeight: 20, color: C.text2 },
  confirm: { fontFamily: MONO, fontSize: 22, letterSpacing: 4, fontWeight: '500', color: C.text },
  grow: { flexGrow: 1, minHeight: 24 },
  footnote: { fontSize: 13, lineHeight: 20, color: C.sub },
})
