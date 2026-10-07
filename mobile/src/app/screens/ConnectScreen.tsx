import { CameraView, useCameraPermissions } from 'expo-camera'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Keyboard, KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { groupCode, normalizePairCode, PAIR_CODE_LENGTH, PAIR_DEVICE_NAME_MAX, PAIR_SHORT_CODE_LENGTH } from '../../../../shared/remotePairing.ts'
import { DEFAULT_ADDRESS } from '../address.ts'
import { ChevronDown, ChevronRight, QrFrame } from '../icons.tsx'
import type { LinkState, PairInput } from '../link.ts'
import { S } from '../strings.ts'
import { pairFailureText } from '../view.ts'
import { C, MONO } from '../theme.ts'

// 1 연결 (시안 Main). 짝이 없으면 이 화면뿐이다 — 앱은 데스크탑 없이 대화를 쥐지 않는다.
// [QR 스캔] → 카메라(전체 화면)로 데스크탑의 QR 을 읽어 바로 짝짓는다 — 지문은 QR 의 것으로 고정. 카메라 권한이 없으면 직접 입력으로 안내한다.
// "주소와 코드 직접 입력" 을 누르면 입력 폼이 펼쳐진다(시안에 폼 배치는 없다 — 같은 카드 모양으로 넣었다). 사내망 주소면 처음 본 인증서를 믿고(TOFU)
// 그 지문 앞 8자를 크게 띄운다. [허용] 을 기다리는 동안 "데스크탑에서 허용을 눌러 주세요" 상자에 그 8자(평문이면 확인 코드)가 뜬다 — 데스크탑 창의 것과 같아야 한다.
export function ConnectScreen({
  state,
  defaultDeviceName,
  onPair,
  onPairQr,
  lanBlockedApi,
}: {
  state: Extract<LinkState, { phase: 'unpaired' | 'pairing' }>
  defaultDeviceName: string
  /** 이 폰의 API 레벨 — 사내망(TLS 1.3) 연결을 못 하는 폰(Android 10 미만)일 때만 준다. 안내를 띄우고 QR 을 막는다(이 컴퓨터 안 평문 입력은 그대로) */
  lanBlockedApi?: number
  onPair(input: PairInput): void
  onPairQr(text: string, deviceName: string): void
}) {
  const insets = useSafeAreaInsets()
  const [open, setOpen] = useState(false)
  const [address, setAddress] = useState(DEFAULT_ADDRESS)
  const [code, setCode] = useState('')
  const [deviceName, setDeviceName] = useState(defaultDeviceName)
  const [scanning, setScanning] = useState(false)
  const [cameraDenied, setCameraDenied] = useState(false)
  const [, requestCamera] = useCameraPermissions()
  const pairing = state.phase === 'pairing'
  const failure = state.phase === 'unpaired' ? state.failure : undefined
  // 블루투스로 짝지으려다 못 붙은 사유(권한·꺼짐·못 찾음 — 연결 화면과 같은 문구, 이슈 #229)
  const bluetoothFailure = state.phase === 'unpaired' ? state.bluetooth : undefined
  // 진단 글 — 실제 폰에서 원인이 사유 글 하나로 뭉개지지 않게 늘 작은 글씨로 (link.ts failureDetail)
  const detail = state.phase === 'unpaired' ? state.detail : undefined
  const revoked = state.phase === 'unpaired' && state.revoked === true
  const fingerprintChanged = state.phase === 'unpaired' && state.fingerprintChanged === true
  const scroll = useRef<ScrollView>(null)

  // 권한을 물어 허용되면 카메라를, 아니면 직접 입력을 연다
  const scan = async (): Promise<void> => {
    const permission = await requestCamera().catch(() => undefined)
    if (permission?.granted) {
      setCameraDenied(false)
      setScanning(true)
    } else {
      setCameraDenied(true)
      setOpen(true)
    }
  }

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

        {(revoked || fingerprintChanged) && (
          <View style={styles.revoked}>
            <Text style={styles.revokedText}>{revoked ? S.revokedOnDesktop : S.fingerprintChanged}</Text>
          </View>
        )}

        {lanBlockedApi !== undefined && (
          <View style={styles.revoked}>
            <Text style={styles.revokedText}>{S.lanUnsupported(lanBlockedApi)}</Text>
          </View>
        )}

        <View style={styles.qrCard}>
          <View style={styles.qrBox}>
            <QrFrame />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: pairing || lanBlockedApi !== undefined }}
            disabled={pairing || lanBlockedApi !== undefined}
            style={[styles.primary, (pairing || lanBlockedApi !== undefined) && styles.disabled]}
            onPress={() => void scan()}
          >
            <Text style={styles.primaryText}>{S.scanQr}</Text>
          </Pressable>
        </View>

        {cameraDenied && <Text style={styles.failure}>{S.cameraDenied}</Text>}
        {failure !== undefined && !open && (
          <Text accessibilityRole="alert" style={[styles.failure, styles.failureAlone]}>
            {pairFailureText(failure, bluetoothFailure)}
            {detail !== undefined && <Text style={styles.detail}>{`\n${detail}`}</Text>}
          </Text>
        )}

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
                // 숫자 2자리(숫자 키패드). 옛 데스크탑의 12자를 붙여 넣으면 그 모양(대문자, O→0 · I/L→1, 네 글자씩)으로 받아 준다
                onChangeText={(text) => {
                  const typed = normalizePairCode(text)
                  setCode(/^[0-9]*$/.test(typed) ? typed.slice(0, PAIR_SHORT_CODE_LENGTH) : groupCode(typed.slice(0, PAIR_CODE_LENGTH)))
                }}
                editable={!pairing}
                placeholder="00"
                placeholderTextColor={C.faint}
                autoCapitalize="characters"
                autoCorrect={false}
                keyboardType="number-pad"
              />
            </Field>
            <Field label={S.deviceNameLabel}>
              <TextInput accessibilityLabel={S.deviceNameLabel} style={styles.input} value={deviceName} onChangeText={setDeviceName} editable={!pairing} maxLength={PAIR_DEVICE_NAME_MAX} autoCorrect={false} />
            </Field>

            {failure !== undefined && (
              <Text accessibilityRole="alert" style={styles.failure}>
                {pairFailureText(failure, bluetoothFailure)}
                {detail !== undefined && <Text style={styles.detail}>{`\n${detail}`}</Text>}
              </Text>
            )}

            <Pressable accessibilityRole="button" accessibilityState={{ disabled: pairing }} disabled={pairing} style={[styles.primary, pairing && styles.disabled]} onPress={() => (Keyboard.dismiss(), onPair({ address, code, deviceName }))}>
              <Text style={styles.primaryText}>{pairing ? S.waitingForAllow : S.connect}</Text>
            </Pressable>
          </View>
        )}

        {state.phase === 'pairing' &&
          (state.confirm === undefined ? (
            <View style={styles.allow}>
              <Text style={styles.allowHint}>{S.findingDesktop}</Text>
            </View>
          ) : (
            <View style={styles.allow}>
              <Text style={styles.allowTitle}>{S.allowOnDesktop}</Text>
              <Text style={styles.allowHint}>{state.confirmKind === 'fingerprint' ? S.checkFingerprint : S.checkCode}</Text>
              <Text style={[styles.confirm, state.confirmKind === 'fingerprint' && styles.confirmLarge]}>{state.confirm}</Text>
            </View>
          ))}

        <View style={styles.grow} />
        <Text style={styles.footnote}>{S.connectFootnote}</Text>
      </ScrollView>
      {scanning && (
        <QrScanner
          onClose={() => setScanning(false)}
          onScanned={(text) => {
            setScanning(false)
            onPairQr(text, deviceName)
          }}
        />
      )}
    </KeyboardAvoidingView>
  )
}

/** 전체 화면 카메라 — 처음 읽은 QR 하나만 넘기고 닫힌다. 무엇이든(우리 QR 이 아니어도) 넘긴다: 읽은 뒤의 판단은 짝(link.ts)이 한다 */
function QrScanner({ onScanned, onClose }: { onScanned(text: string): void; onClose(): void }) {
  const insets = useSafeAreaInsets()
  const done = useRef(false)
  return (
    <Modal visible animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.scanner}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            if (done.current) return
            done.current = true
            onScanned(data)
          }}
        />
        <View style={styles.scanFrame} pointerEvents="none" />
        <Text style={[styles.scanHint, { top: insets.top + 24 }]}>{S.scanHint}</Text>
        <Pressable accessibilityRole="button" style={[styles.scanClose, { bottom: insets.bottom + 32 }]} onPress={onClose}>
          <Text style={styles.scanCloseText}>{S.closeScanner}</Text>
        </Pressable>
      </View>
    </Modal>
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
  failureAlone: { marginTop: 12 },
  detail: { fontFamily: MONO, fontSize: 11, lineHeight: 16, color: C.sub },
  allow: { marginTop: 16, borderRadius: 14, backgroundColor: C.blueBg, paddingVertical: 14, paddingHorizontal: 16, gap: 6 },
  allowTitle: { fontSize: 15, fontWeight: '600', color: C.blueDark },
  allowHint: { fontSize: 13, lineHeight: 20, color: C.text2 },
  confirm: { fontFamily: MONO, fontSize: 22, letterSpacing: 4, fontWeight: '500', color: C.text },
  confirmLarge: { fontSize: 32, lineHeight: 40, letterSpacing: 5, fontWeight: '600', textAlign: 'center', paddingVertical: 4 },
  scanner: { flex: 1, backgroundColor: '#000' },
  scanFrame: { position: 'absolute', alignSelf: 'center', top: '30%', width: 240, height: 240, borderRadius: 20, borderWidth: 3, borderColor: C.white },
  scanHint: { position: 'absolute', left: 24, right: 24, textAlign: 'center', fontSize: 15, color: C.white },
  scanClose: { position: 'absolute', alignSelf: 'center', minWidth: 120, height: 48, borderRadius: 24, paddingHorizontal: 24, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' },
  scanCloseText: { color: C.white, fontSize: 15, fontWeight: '600' },
  grow: { flexGrow: 1, minHeight: 24 },
  footnote: { fontSize: 13, lineHeight: 20, color: C.sub },
})
