import { useEffect, useRef, useState } from 'react'
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { Attention, AttentionAnswer, HistoryMessage, ShellCard, TurnItem } from '../../../../shared/contract.ts'
import type { ModelChoice, RemoteModel } from '../../../../shared/remote.ts'
import { useKeyboardVisible, useModelOf, useNotice, useNow, useRemoteState } from '../hooks.ts'
import { ArrowUp, BackArrow, Check, ChevronDown, ChevronRight, Warning } from '../icons.tsx'
import { BluetoothInfo, HistoryProgress } from '../BluetoothBits.tsx'
import type { AppSession, Carrier } from '../session.ts'
import { StatusBanner } from '../StatusBanner.tsx'
import { S } from '../strings.ts'
import { C, MONO } from '../theme.ts'
import type { QuestionView } from '../view.ts'
import { attentionTitle, chatRows, composerBottomMargin, outcomeLabel, questionView, runningSubtasks, SHELL_COLLAPSE_LINES, shellCardView, turnHead, turnLines, turnStartedAt, turnTexts, userMessageView } from '../view.ts'

// 3 대화 (시안 Chat). 리듀서의 ConversationView 하나를 그린다: 끝난 말풍선(messages, 사이사이 데스크탑 `!` 카드 — 읽기 전용) → 도는 턴(progress) → 승인 카드(attention) → 대기(queue).
// 답은 글자 그대로 그린다 — 마크다운은 다음 라운드. 모드 칩·"작업 N" 은 모양만.
// 명령(보내기·중지·되돌리기·답)은 전부 데스크탑으로 간다. 안 된 것은 입력창 위 안내 띠(notice)로 — 누르면 닫힌다.
// 블루투스로 붙어 있으면(시안 mock-ble ②): 머리 아래 안내 한 줄(배지는 뺐다 — 사용자 2026-10-09), 대화를 받는 동안 받은 KB, 입력창 위 [Wi-Fi 로 바꾸기].
export function ChatScreen({ session, cid, onBack, onCarrier }: { session: AppSession; cid: string; onBack(): void; onCarrier(carrier: Carrier): void }) {
  const insets = useSafeAreaInsets()
  const keyboardVisible = useKeyboardVisible()
  const state = useRemoteState(session)
  const view = state.views[cid]
  const conversation = Object.values(state.conversations)
    .flat()
    .find((candidate) => candidate.id === cid)
  const now = useNow(view?.running ?? false)
  const [draft, setDraft] = useState('')
  const scroll = useRef<ScrollView>(null)
  const notice = useNotice(session)
  const chosenModel = useModelOf(session, cid)
  const [picking, setPicking] = useState(false)

  // 이 대화를 받아 두고 이벤트를 따라간다 — 나가면 놓는다
  useEffect(() => {
    session.openConversation(cid)
    return () => {
      session.closeConversation(cid)
      session.clearNotice()
    }
  }, [session, cid])

  // 목록에 있던 이 대화가 다시 받은 목록에서 빠졌다(데스크탑에서 지웠다·프로젝트를 뺐다) — 빈 화면에 두지 않고 목록으로 (#187).
  // 막 만든 대화는 목록에 오기 전이라 한 번 보인 뒤에만 본다
  const listed = useRef(false)
  useEffect(() => {
    if (conversation) listed.current = true
    else if (listed.current) onBack()
  }, [conversation, onBack])

  const project = state.projects.find((candidate) => candidate.path === conversation?.project)
  const model = session.models.find((candidate) => candidate.providerId === chosenModel?.providerId && candidate.modelId === chosenModel?.modelId)
  const jobs = runningSubtasks(view?.progress ?? [])
  const startedAt = view ? turnStartedAt(view) : undefined
  const mode = S.mode[conversation?.mode ?? 'build']

  const send = (): void => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    // 못 보냈으면(안내가 선다) 친 글을 돌려놓는다 — 그사이 새로 친 것이 있으면 건드리지 않는다
    void session.send(cid, text).then((sent) => {
      if (!sent) setDraft((current) => current || text)
    })
  }
  const takeBack = async (): Promise<void> => {
    const text = await session.takeQueue(cid)
    if (text) setDraft((current) => (current ? `${current}\n${text}` : text))
  }
  // 턴이 도는 중이고 입력이 비었으면 중지, 아니면 보내기(턴 중이면 데스크탑이 그 턴에 끼워 넣는다 — 이슈 #250)
  const stopping = (view?.running ?? false) && !draft.trim()

  return (
    <KeyboardAvoidingView style={[styles.screen, { paddingTop: insets.top + 8 }]} behavior="padding">
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel={S.backToList} style={styles.back} onPress={onBack}>
          <BackArrow />
        </Pressable>
        {/* 머리를 누르면 모델 고르기 (#269) */}
        <Pressable accessibilityRole="button" accessibilityLabel={S.modelLabel(model?.displayName ?? chosenModel?.modelId ?? '')} style={styles.headerText} onPress={() => setPicking(true)}>
          <Text style={styles.title} numberOfLines={1}>
            {conversation?.title || S.untitled}
          </Text>
          <View style={styles.subtitleRow}>
            <Text style={styles.subtitle} numberOfLines={1}>
              {[model?.displayName ?? chosenModel?.modelId, project?.name].filter(Boolean).join(' · ')}
            </Text>
            <ChevronDown size={12} />
          </View>
        </Pressable>
        {jobs > 0 && (
          <Pressable accessibilityRole="button" accessibilityLabel={S.runningJobs(jobs)} style={styles.jobs}>
            <View style={styles.jobsRing} />
            <Text style={styles.jobsText}>{S.jobs(jobs)}</Text>
          </Pressable>
        )}
      </View>

      {picking && (
        <ModelSheet
          models={session.models}
          current={chosenModel}
          busy={view?.running ?? false}
          onPick={(picked) => {
            if (session.chooseModel(cid, picked)) setPicking(false)
          }}
          onClose={() => setPicking(false)}
        />
      )}

      <BluetoothInfo carrier={session.carrier} />

      <View style={styles.status}>
        <StatusBanner session={session} />
      </View>

      <ScrollView ref={scroll} style={styles.body} contentContainerStyle={styles.bodyContent} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}>
        {view &&
          chatRows(view.messages, view.shells).map((row) =>
            row.kind === 'shell' ? <ShellCardBox key={row.key} card={row.card} /> : row.message.role === 'user' ? <UserMessage key={row.key} message={row.message} /> : <Answer key={row.key} message={row.message} />,
          )}
        {view?.running && (
          <Turn head={turnHead(S.running, startedAt === undefined ? undefined : now - startedAt, view.progress)} items={view.progress} initiallyOpen />
        )}
        {view?.attention.map((request) => (
          <AttentionCard key={request.id} request={request} onAnswer={(answer) => session.reply(request, answer)} />
        ))}
        <HistoryProgress session={session} loading={cid in state.loading} />
      </ScrollView>

      {view !== undefined && view.queue.length > 0 && (
        <View style={styles.queue}>
          <Text style={styles.queueText} numberOfLines={1}>
            {S.queued(view.queue.length, view.queue.join(' '))}
          </Text>
          <Pressable accessibilityRole="button" style={styles.takeBack} onPress={() => void takeBack()}>
            <Text style={styles.takeBackText}>{S.takeBack}</Text>
          </Pressable>
        </View>
      )}

      {notice !== undefined && (
        <Pressable accessibilityRole="alert" style={styles.notice} onPress={() => session.clearNotice()}>
          <Text style={styles.noticeText}>{S.notice[notice]}</Text>
        </Pressable>
      )}


      <View style={[styles.composer, { marginBottom: composerBottomMargin(insets.bottom, keyboardVisible) }]}>
        <TextInput
          accessibilityLabel={S.message}
          style={styles.input}
          placeholder={S.messagePlaceholder}
          placeholderTextColor={C.sub}
          value={draft}
          onChangeText={setDraft}
          multiline
        />
        <View style={styles.composerRow}>
          <Pressable accessibilityRole="button" accessibilityLabel={S.modeLabel(mode)} style={styles.mode}>
            <Text style={styles.modeText}>{mode}</Text>
            <ChevronDown size={12} />
          </Pressable>
          <View style={styles.grow} />
          {stopping ? (
            <Pressable accessibilityRole="button" accessibilityLabel={S.stop} style={styles.action} onPress={() => session.stop(cid)}>
              <View style={styles.stopSquare} />
            </Pressable>
          ) : (
            <Pressable accessibilityRole="button" accessibilityLabel={S.send} style={[styles.action, !draft.trim() && styles.actionIdle]} onPress={send}>
              <ArrowUp />
            </Pressable>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  )
}

/** 모델 고르기 바텀시트 (#269) — 지금 것에 체크. 턴이 도는 중이면 고를 수 없다(다음 메시지부터 쓰이므로 끝난 뒤에) */
function ModelSheet({ models, current, busy, onPick, onClose }: { models: readonly RemoteModel[]; current: ModelChoice | undefined; busy: boolean; onPick(model: RemoteModel): void; onClose(): void }) {
  const insets = useSafeAreaInsets()
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable accessibilityRole="button" accessibilityLabel={S.close} style={styles.sheetBackdrop} onPress={onClose} />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
        <Text style={styles.sheetTitle}>{S.modelSheetTitle}</Text>
        {models.length === 0 ? (
          <Text style={styles.sheetHint}>{S.noModels}</Text>
        ) : (
          <>
            <Text style={styles.sheetHint}>{busy ? S.modelBusy : S.modelNextTurn}</Text>
            <ScrollView style={styles.sheetList}>
              {models.map((option) => {
                const selected = option.providerId === current?.providerId && option.modelId === current?.modelId
                return (
                  <Pressable
                    key={`${option.providerId}/${option.modelId}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected, disabled: busy }}
                    disabled={busy}
                    style={[styles.sheetRow, busy && styles.sheetRowBusy]}
                    onPress={() => onPick(option)}
                  >
                    <View style={styles.sheetRowText}>
                      <Text style={styles.sheetRowName} numberOfLines={1}>
                        {option.displayName}
                      </Text>
                      <Text style={styles.sheetRowSub} numberOfLines={1}>
                        {option.providerName}
                      </Text>
                    </View>
                    {selected && <Check />}
                  </Pressable>
                )
              })}
            </ScrollView>
          </>
        )}
      </View>
    </Modal>
  )
}

/** 내 말 — 모양은 view.ts userMessageView 가 정한다: 훅이 이어 보낸 글은 줄로, 첨부만 보냈으면 이름만, 다른 대화의 지시는 딱지 */
function UserMessage({ message }: { message: HistoryMessage }) {
  const shape = userMessageView(message)
  if (shape.kind === 'hook')
    return (
      <View style={styles.hook}>
        <Text style={styles.hookHead}>{S.hookFollowUp}</Text>
        {shape.reason !== '' && <Text style={styles.hookReason}>{shape.reason}</Text>}
      </View>
    )
  return (
    <View style={styles.userTurn}>
      {shape.attachments.length > 0 && <Text style={styles.userMeta}>{shape.attachments.join(' · ')}</Text>}
      {shape.origin !== undefined && (
        <Text style={styles.userMeta}>{shape.originProject ? S.delegatedFromProject(shape.originProject, shape.origin) : S.delegatedFrom(shape.origin)}</Text>
      )}
      {shape.text !== '' && (
        <View style={styles.bubble}>
          <Text style={styles.bubbleText}>{shape.text}</Text>
        </View>
      )}
      {shape.unanswered && <Text style={styles.userMeta}>{S.unanswered}</Text>}
    </View>
  )
}

/** 끝난 답 — 머리("완료 · 12초 · 생각 1 · 도구 3", 누르면 줄이 펼쳐진다) + 글 */
function Answer({ message }: { message: HistoryMessage }) {
  const items = message.items ?? []
  const fallback: TurnItem[] = items.some((item) => item.kind === 'text') || !message.text ? [] : [{ kind: 'text', id: 'text', text: message.text, done: true }]
  return <Turn head={turnHead(outcomeLabel(message), message.duration, items)} items={[...items, ...fallback]} error={message.interrupted || message.declined ? undefined : message.error} />
}

function Turn({ head, items, initiallyOpen = false, error }: { head: string; items: readonly TurnItem[]; initiallyOpen?: boolean; error?: string }) {
  const [open, setOpen] = useState(initiallyOpen)
  const lines = turnLines(items)
  return (
    <View style={styles.turn}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} style={styles.turnHead} onPress={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Text style={styles.turnHeadText}>{head}</Text>
      </Pressable>
      {open && lines.length > 0 && (
        <View style={styles.lines}>
          {lines.map((line) => (
            <Text key={line.id} style={line.mono ? styles.lineMono : styles.line} numberOfLines={2}>
              {line.text}
            </Text>
          ))}
        </View>
      )}
      {turnTexts(items).map((text) => (
        <Text key={text.id} style={styles.answer} selectable>
          {text.text}
        </Text>
      ))}
      {error !== undefined && <Text style={styles.error}>{error}</Text>}
    </View>
  )
}

/** 데스크탑 `!명령` 결과 카드 (#265) — 읽기 전용: 실행·멈춤·"AI 에게 보내기" 는 데스크탑에만 있다. 모양은 view.ts shellCardView 가 정한다 */
function ShellCardBox({ card }: { card: ShellCard }) {
  const [expanded, setExpanded] = useState(false)
  const shape = shellCardView(card)
  return (
    <View style={styles.shell}>
      <View style={styles.shellHead}>
        <Text style={styles.shellCommand} numberOfLines={2}>
          $ {shape.command}
        </Text>
        <Text style={[styles.shellBadge, shape.tone === 'ok' ? styles.shellOk : shape.tone === 'failed' ? styles.shellFailed : undefined]}>{shape.badge}</Text>
      </View>
      <Text style={styles.shellOutput} numberOfLines={shape.long && !expanded ? SHELL_COLLAPSE_LINES : undefined} selectable>
        {shape.output}
      </Text>
      {shape.long && (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded }} style={styles.shellMore} onPress={() => setExpanded(!expanded)}>
          <Text style={styles.shellMoreText}>{expanded ? S.shellCollapse : S.shellExpand}</Text>
        </Pressable>
      )}
      {shape.truncated && <Text style={styles.shellNote}>{S.shellTruncated}</Text>}
      {shape.shared && <Text style={styles.shellNote}>{S.shellShared}</Text>}
    </View>
  )
}

function AttentionCard({ request, onAnswer }: { request: Attention; onAnswer(answer: AttentionAnswer): void }) {
  return (
    <View style={styles.card}>
      <View style={styles.cardTitle}>
        <Warning />
        <Text style={styles.cardTitleText}>{attentionTitle(request)}</Text>
      </View>
      {request.kind === 'permission' ? (
        <>
          <Text style={styles.command}>{request.resources.join('\n')}</Text>
          <View style={styles.cardButtons}>
            <Pressable accessibilityRole="button" style={[styles.cardButton, styles.reject]} onPress={() => onAnswer('reject')}>
              <Text style={styles.rejectText}>{S.reject}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" style={[styles.cardButton, styles.allow]} onPress={() => onAnswer('once')}>
              <Text style={styles.allowText}>{S.allowOnce}</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <QuestionBody shape={questionView(request)} onAnswer={onAnswer} />
      )}
    </View>
  )
}

/** 질문 카드의 몸 — 폰에서 답할 수 있는 것(pick)만 보기를 그린다. 거절은 언제나 된다 (턴이 폰 앞에서 마냥 기다리지 않게) */
function QuestionBody({ shape, onAnswer }: { shape: QuestionView; onAnswer(answer: AttentionAnswer): void }) {
  return (
    <>
      {(shape.kind === 'pick' ? [shape.question] : shape.questions).map((question, index) => (
        <Text key={index} style={styles.answer}>
          {question}
        </Text>
      ))}
      {shape.kind === 'pick' ? (
        shape.options.map((label) => (
          <Pressable key={label} accessibilityRole="button" style={[styles.cardButton, styles.reject]} onPress={() => onAnswer([[label]])}>
            <Text style={styles.rejectText}>{label}</Text>
          </Pressable>
        ))
      ) : (
        <Text style={styles.cardHint}>{S.answerOnDesktop}</Text>
      )}
      <Pressable accessibilityRole="button" style={styles.questionReject} onPress={() => onAnswer('reject')}>
        <Text style={styles.questionRejectText}>{S.reject}</Text>
      </Pressable>
    </>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.white },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.hair },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerText: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, fontWeight: '600', color: C.text },
  subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  subtitle: { flexShrink: 1, fontSize: 12, color: C.sub },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.32)' },
  sheet: { backgroundColor: C.white, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 16, paddingHorizontal: 16, gap: 8, maxHeight: '70%' },
  sheetTitle: { fontSize: 15, fontWeight: '600', color: C.text },
  sheetHint: { fontSize: 13, lineHeight: 18, color: C.sub },
  sheetList: { flexGrow: 0 },
  sheetRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.hair },
  sheetRowBusy: { opacity: 0.45 },
  sheetRowText: { flex: 1, minWidth: 0 },
  sheetRowName: { fontSize: 15, color: C.text },
  sheetRowSub: { fontSize: 12, color: C.sub },
  jobs: { height: 36, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: C.blueBorder, backgroundColor: C.blueBg, marginRight: 8 },
  jobsRing: { width: 8, height: 8, borderRadius: 4, borderWidth: 2, borderColor: C.link },
  jobsText: { fontSize: 13, fontWeight: '500', color: C.blueDark },
  status: { paddingTop: 8 },
  body: { flex: 1 },
  bodyContent: { padding: 16, gap: 14 },
  userTurn: { alignItems: 'flex-end', gap: 4 },
  userMeta: { fontSize: 12, color: C.sub },
  hook: { gap: 2, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: 'rgba(0,0,0,0.08)' },
  hookHead: { fontSize: 13, color: C.sub },
  hookReason: { fontSize: 13, color: C.text2 },
  bubble: { maxWidth: 290, backgroundColor: C.surface2, borderRadius: 16, paddingVertical: 10, paddingHorizontal: 14 },
  bubbleText: { fontSize: 15, lineHeight: 22, color: C.text },
  turn: { gap: 8 },
  turnHead: { alignSelf: 'flex-start', minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 6, paddingRight: 10 },
  turnHeadText: { fontSize: 13, color: C.sub },
  lines: { gap: 6, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: 'rgba(0,0,0,0.08)' },
  line: { fontSize: 13, color: C.text2 },
  lineMono: { fontFamily: MONO, fontSize: 12, color: C.text2 },
  answer: { fontSize: 15, lineHeight: 24, color: C.text },
  error: { fontSize: 13, color: C.red },
  shell: { borderWidth: 1, borderColor: C.border, backgroundColor: C.surface, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12, gap: 8 },
  shellHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  shellCommand: { flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 13, fontWeight: '600', color: C.text },
  shellBadge: { fontSize: 12, color: C.sub },
  shellOk: { color: C.green },
  shellFailed: { color: C.red },
  shellOutput: { fontFamily: MONO, fontSize: 12, lineHeight: 17, color: C.text2 },
  shellMore: { alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' },
  shellMoreText: { fontSize: 13, fontWeight: '500', color: C.link },
  shellNote: { fontSize: 12, color: C.sub },
  card: { borderWidth: 1, borderColor: C.amberBorder, backgroundColor: C.amberBg, borderRadius: 16, padding: 14, gap: 12 },
  cardTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardTitleText: { fontSize: 15, fontWeight: '600', color: C.amberText },
  command: { fontFamily: MONO, fontSize: 13, color: C.text, backgroundColor: C.white, borderWidth: 1, borderColor: C.border, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12 },
  cardButtons: { flexDirection: 'row', gap: 8 },
  cardButton: { flex: 1, minHeight: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  cardHint: { fontSize: 13, lineHeight: 18, color: C.amberText },
  questionReject: { alignSelf: 'flex-end', minHeight: 44, paddingHorizontal: 12, justifyContent: 'center' },
  questionRejectText: { fontSize: 15, fontWeight: '500', color: C.amberText },
  reject: { borderWidth: 1, borderColor: C.borderStrong, backgroundColor: C.white },
  rejectText: { fontSize: 15, fontWeight: '500', color: C.text },
  allow: { backgroundColor: C.text },
  allowText: { fontSize: 15, fontWeight: '600', color: C.white },
  queue: { paddingHorizontal: 16, paddingBottom: 6, flexDirection: 'row', alignItems: 'center', gap: 8 },
  queueText: { flex: 1, minWidth: 0, fontSize: 13, color: C.sub },
  takeBack: { height: 44, paddingHorizontal: 10, justifyContent: 'center' },
  takeBackText: { fontSize: 13, fontWeight: '500', color: C.link },
  notice: { marginHorizontal: 16, marginBottom: 8, borderRadius: 10, backgroundColor: C.amberBg, borderWidth: 1, borderColor: C.amberBorder, paddingVertical: 8, paddingHorizontal: 12 },
  noticeText: { fontSize: 13, lineHeight: 18, color: C.amberText },
  composer: { marginHorizontal: 12, borderWidth: 1, borderColor: 'rgba(0,0,0,0.12)', borderRadius: 20, paddingVertical: 10, paddingHorizontal: 12, gap: 8, backgroundColor: C.white, elevation: 2 },
  input: { fontSize: 15, color: C.text, paddingVertical: 6, paddingHorizontal: 4, maxHeight: 120 },
  composerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mode: { height: 44, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, borderRadius: 22, borderWidth: 1, borderColor: C.border, backgroundColor: C.surface2 },
  modeText: { fontSize: 13, color: C.text },
  grow: { flex: 1 },
  action: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.text, alignItems: 'center', justifyContent: 'center' },
  actionIdle: { backgroundColor: C.faint },
  stopSquare: { width: 12, height: 12, borderRadius: 2, backgroundColor: C.white },
})
