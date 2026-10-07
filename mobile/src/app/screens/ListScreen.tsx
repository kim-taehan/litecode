import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useConnectionStatus, useNow, useRemoteState } from '../hooks.ts'
import { ChevronDown, Gear } from '../icons.tsx'
import { BluetoothBadge } from '../BluetoothBits.tsx'
import type { AppSession } from '../session.ts'
import { StatusBanner } from '../StatusBanner.tsx'
import { S } from '../strings.ts'
import { C } from '../theme.ts'
import { ago, initials, rowView, type RowView } from '../view.ts'

// 2 대화 목록 (시안 List). 데스크탑의 첫 프로젝트(가장 최근에 연 것)의 대화를 보인다 — 프로젝트 바꾸기 버튼은 아직 모양만.
export function ListScreen({ session, onOpen, onSettings }: { session: AppSession; onOpen(cid: string): void; onSettings(): void }) {
  const insets = useSafeAreaInsets()
  const state = useRemoteState(session)
  const status = useConnectionStatus(session)
  const now = useNow()
  const project = state.projects[0]
  const conversations = project ? (state.conversations[project.path] ?? []) : []

  const create = async (): Promise<void> => {
    const cid = project ? await session.createConversation(project.path) : undefined
    if (cid !== undefined) onOpen(cid)
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <View style={styles.top}>
        <Pressable accessibilityRole="button" accessibilityLabel={S.switchProject} style={styles.project}>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{initials(project?.name ?? '')}</Text>
          </View>
          <View style={styles.projectText}>
            <Text style={styles.projectName} numberOfLines={1}>
              {project?.name}
            </Text>
            <Text style={styles.projectPath} numberOfLines={1}>
              {project?.displayPath}
            </Text>
          </View>
          <ChevronDown />
        </Pressable>
        <BluetoothBadge carrier={session.carrier} />
        <Pressable accessibilityRole="button" accessibilityLabel={S.settings} style={styles.gear} onPress={onSettings}>
          <Gear />
        </Pressable>
      </View>

      <StatusBanner session={session} />

      <Text style={styles.section}>{S.conversations}</Text>

      <ScrollView style={styles.list}>
        {project !== undefined && state.conversations[project.path] !== undefined && conversations.length === 0 && <Text style={styles.empty}>{S.noConversations}</Text>}
        {conversations.map((conversation, index) => {
          // 상태 점: 이벤트로 온 것(notices)이 먼저, 없으면 목록을 받을 때 실려 온 것 (앱을 다시 켠 직후엔 notices 이벤트가 아직 없다)
          const row = rowView(conversation, state.notices[conversation.id]?.status ?? conversation.status, state.views[conversation.id])
          return (
            <Pressable
              key={conversation.id}
              accessibilityRole="button"
              style={[styles.row, index > 0 && row.dot !== 'attention' && styles.rowBorder, row.dot === 'attention' && styles.rowAttention]}
              onPress={() => onOpen(conversation.id)}
            >
              <View style={styles.dotCell}>
                <Dot kind={row.dot} />
              </View>
              <View style={styles.rowText}>
                <Text style={[styles.rowTitle, titleWeight[row.dot]]} numberOfLines={1}>
                  {row.title}
                </Text>
                {row.subtitle !== '' && (
                  <Text style={[styles.rowSub, row.dot === 'attention' && { color: C.amberText }, row.dot === 'running' && { color: C.link }]} numberOfLines={1}>
                    {row.subtitle}
                  </Text>
                )}
              </View>
              <Text style={styles.rowTime}>{ago(conversation.updatedAt, now)}</Text>
            </Pressable>
          )
        })}
      </ScrollView>

      <View style={[styles.bottom, { paddingBottom: insets.bottom + 16 }]}>
        <Pressable accessibilityRole="button" style={styles.primary} onPress={() => void create()}>
          <Text style={styles.primaryText}>{S.newConversation}</Text>
        </Pressable>
        <View style={styles.desktop}>
          <View style={[styles.desktopDot, { backgroundColor: status.kind === 'connected' ? C.green : C.faint }]} />
          <Text style={styles.desktopText}>
            {session.desktop.name} · {session.desktop.address.split(':')[0]}
          </Text>
        </View>
      </View>
    </View>
  )
}

function Dot({ kind }: { kind: RowView['dot'] }) {
  if (kind === 'none') return null
  if (kind === 'running') return <View style={[styles.dot, { borderWidth: 2, borderColor: C.blue }]} />
  return <View style={[styles.dot, { backgroundColor: kind === 'attention' ? C.amber : kind === 'failed' ? C.red : C.blue }]} />
}

const titleWeight = {
  attention: { fontWeight: '600' },
  unread: { fontWeight: '600' },
  failed: { fontWeight: '600' },
  running: { fontWeight: '500' },
  none: { fontWeight: '400' },
} as const

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.white },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 12 },
  project: { flex: 1, height: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: C.border, backgroundColor: C.surface },
  badge: { width: 26, height: 26, borderRadius: 7, backgroundColor: C.blue, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: C.white, fontSize: 11, fontWeight: '700' },
  projectText: { flex: 1, minWidth: 0 },
  projectName: { fontSize: 14, fontWeight: '600', color: C.text },
  projectPath: { fontSize: 12, color: C.sub },
  gear: { width: 48, height: 48, borderRadius: 12, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  section: { paddingTop: 8, paddingHorizontal: 20, paddingBottom: 6, fontSize: 12, color: C.sub, fontWeight: '600' },
  list: { flex: 1 },
  empty: { paddingHorizontal: 20, paddingVertical: 16, fontSize: 13, color: C.sub },
  row: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20 },
  rowBorder: { borderTopWidth: 1, borderTopColor: C.hair },
  rowAttention: { backgroundColor: C.amberBg },
  dotCell: { width: 12, alignItems: 'center' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowTitle: { fontSize: 15, color: C.text },
  rowSub: { fontSize: 13, color: C.sub },
  rowTime: { fontSize: 12, color: C.sub },
  bottom: { paddingTop: 12, paddingHorizontal: 16, gap: 12, borderTopWidth: 1, borderTopColor: C.hair },
  primary: { height: 48, borderRadius: 12, backgroundColor: C.text, alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: C.white, fontSize: 15, fontWeight: '600' },
  desktop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  desktopDot: { width: 8, height: 8, borderRadius: 4 },
  desktopText: { fontSize: 12, color: C.sub },
})
