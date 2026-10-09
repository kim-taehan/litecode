import { useEffect, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useConnectionStatus, useFailure } from '../hooks.ts'
import { BluetoothIcon, ErrorCircle, WifiIcon } from '../icons.tsx'
import type { AppSession, Carrier } from '../session.ts'
import { S } from '../strings.ts'
import { C, MONO } from '../theme.ts'
import { gateView } from '../view.ts'

const CARRIERS: readonly Carrier[] = ['wifi', 'bluetooth']
const other = (carrier: Carrier): Carrier => (carrier === 'wifi' ? 'bluetooth' : 'wifi')

// 연결 화면 — 짝은 있지만 아직 붙지 못했을 때 (시안 _workspace/mock-ble ① Main · ③ Fail). 이슈 #211.
// ① 수단 고르기: Wi-Fi / 블루투스 카드 중 사용자가 고른다 → [X 로 연결]. 고른 길로만 붙고, 마지막 선택은 기억한다(prefs).
// ③ 안 될 때: 사유 + [다시 시도] + [다른 길로 시도]. 다른 길은 버튼으로만 권한다 — 누르기 전에는 블루투스를 켜거나 스캔하지 않는다.
// 한 번 붙은 뒤의 끊김은 목록·대화 위의 상태 띠(StatusBanner)가 맡는다. 사람이 손써야 하는 멈춤(needs-action)이면 이 화면으로 돌아온다.
export function CarrierScreen({ session, desktopName, onCarrier }: { session: AppSession; desktopName: string; onCarrier(carrier: Carrier): void }) {
  const insets = useSafeAreaInsets()
  const status = useConnectionStatus(session)
  const failure = useFailure(session)
  const view = gateView(status, failure, session.carrier, session.desktop.address)
  const [picked, setPicked] = useState<Carrier>(session.carrier)
  // 길을 바꿔 새 세션이 오면 고른 카드도 그 길로
  useEffect(() => setPicked(session.carrier), [session])

  if (view.kind === 'failed') {
    const alternative = other(session.carrier)
    return (
      <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingTop: insets.top + 36, paddingBottom: insets.bottom + 24 }]}>
        <View style={styles.intro}>
          <Text style={styles.title}>{S.connectTitle}</Text>
          <Text style={styles.lead}>{desktopName}</Text>
        </View>
        <View accessibilityRole="alert" style={styles.failCard}>
          <View style={styles.failHead}>
            <ErrorCircle color={C.redTitle} />
            <Text style={styles.failTitle}>{view.title}</Text>
          </View>
          <Text style={styles.failBody}>{view.body}</Text>
          <Text style={styles.detail}>{view.detail}</Text>
        </View>
        <View style={styles.buttons}>
          <Pressable accessibilityRole="button" style={styles.primary} onPress={() => session.retry()}>
            <Text style={styles.primaryText}>{S.retry}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" style={styles.secondary} onPress={() => onCarrier(alternative)}>
            {alternative === 'bluetooth' ? <BluetoothIcon size={16} strokeWidth={2} /> : <WifiIcon size={16} />}
            <Text style={styles.secondaryText}>{S.tryVia[alternative]}</Text>
          </Pressable>
        </View>
        {alternative === 'bluetooth' && (
          <View style={styles.note}>
            <Text style={styles.noteText}>{S.bluetoothNotYet}</Text>
          </View>
        )}
      </ScrollView>
    )
  }

  // 지금 길로 붙는 중이면 버튼은 멈춰 있다. 다른 카드를 골랐으면 그 길로 붙는다
  const busy = view.connecting && picked === session.carrier
  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingTop: insets.top + 36, paddingBottom: insets.bottom + 24 }]}>
      <View style={styles.intro}>
        <Text style={styles.title}>{S.connectTitle}</Text>
        <Text style={styles.lead}>{S.connectChooseIntro}</Text>
      </View>
      <View style={styles.desktop}>
        <Text style={styles.desktopName}>{desktopName}</Text>
        <Text style={styles.desktopSub}>{S.pairedDevice}</Text>
      </View>
      <View style={styles.choices}>
        <Text style={styles.label}>{S.connectMethod}</Text>
        {CARRIERS.map((carrier) => {
          const selected = carrier === picked
          const color = selected ? C.link : C.sub
          return (
            <Pressable key={carrier} accessibilityRole="button" accessibilityState={{ selected }} style={[styles.choice, selected && styles.choiceSelected]} onPress={() => setPicked(carrier)}>
              {carrier === 'wifi' ? <WifiIcon color={color} /> : <BluetoothIcon color={color} />}
              <View style={styles.choiceText}>
                <Text style={styles.choiceName}>{S.carrierName[carrier]}</Text>
                <Text style={styles.choiceHint}>{S.carrierHint[carrier]}</Text>
              </View>
            </Pressable>
          )
        })}
      </View>
      <View style={styles.state}>
        <View style={[styles.dot, busy && { backgroundColor: C.amber }]} />
        <Text style={styles.stateText}>{busy ? S.connectingNow : S.notConnected}</Text>
      </View>
      <View style={styles.grow} />
      <View style={styles.buttons}>
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} style={[styles.primary, busy && styles.disabled]} onPress={() => onCarrier(picked)}>
          <Text style={styles.primaryText}>{busy ? S.connectingNow : S.connectVia[picked]}</Text>
        </Pressable>
        <Text style={styles.footnote}>{S.connectRemember}</Text>
      </View>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.white },
  content: { flexGrow: 1, paddingHorizontal: 20, gap: 18 },
  intro: { gap: 4 },
  title: { fontSize: 22, fontWeight: '700', color: C.text },
  lead: { fontSize: 13, lineHeight: 19, color: C.sub },
  desktop: { borderWidth: 1, borderColor: C.border, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 14, gap: 2 },
  desktopName: { fontSize: 15, fontWeight: '600', color: C.text },
  desktopSub: { fontSize: 12.5, color: C.sub },
  choices: { gap: 10 },
  label: { fontSize: 12.5, fontWeight: '600', color: C.sub },
  choice: { minHeight: 88, flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 14, borderWidth: 1, borderColor: C.borderStrong, borderRadius: 14, backgroundColor: C.white },
  choiceSelected: { borderWidth: 2, borderColor: C.link, backgroundColor: C.blueBg, padding: 13 },
  choiceText: { flex: 1, gap: 3 },
  choiceName: { fontSize: 16, fontWeight: '600', color: C.text },
  choiceHint: { fontSize: 13, lineHeight: 19, color: C.text2 },
  state: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.faint },
  stateText: { fontSize: 13, color: C.text2 },
  grow: { flexGrow: 1 },
  buttons: { gap: 10 },
  primary: { height: 52, borderRadius: 12, backgroundColor: C.text, alignItems: 'center', justifyContent: 'center' },
  disabled: { backgroundColor: C.faint },
  primaryText: { color: C.white, fontSize: 16, fontWeight: '600' },
  secondary: { minHeight: 52, borderRadius: 12, borderWidth: 1, borderColor: C.borderStrong, backgroundColor: C.white, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  secondaryText: { fontSize: 15, fontWeight: '500', color: C.text },
  footnote: { fontSize: 12, lineHeight: 18, color: C.sub, textAlign: 'center' },
  failCard: { borderWidth: 1, borderColor: C.redBorder, backgroundColor: C.redBg, borderRadius: 14, padding: 14, gap: 6 },
  failHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  failTitle: { fontSize: 15, fontWeight: '600', color: C.redTitle },
  failBody: { fontSize: 13.5, lineHeight: 21, color: C.redText },
  detail: { fontFamily: MONO, fontSize: 11, lineHeight: 16, color: C.sub },
  note: { backgroundColor: C.surface, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14 },
  noteText: { fontSize: 12.5, lineHeight: 19, color: C.text2 },
})
