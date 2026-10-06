import { useEffect, useRef, useState } from 'react'
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { Attention, AttentionAnswer, HistoryMessage, TurnItem } from '../../../../shared/contract.ts'
import { useKeyboardVisible, useNotice, useNow, useRemoteState } from '../hooks.ts'
import { ArrowUp, BackArrow, ChevronDown, ChevronRight, Warning } from '../icons.tsx'
import type { AppSession } from '../session.ts'
import { StatusBanner } from '../StatusBanner.tsx'
import { S } from '../strings.ts'
import { C, MONO } from '../theme.ts'
import type { QuestionView } from '../view.ts'
import { attentionTitle, composerBottomMargin, outcomeLabel, questionView, runningSubtasks, turnHead, turnLines, turnStartedAt, turnTexts, userMessageView } from '../view.ts'

// 3 대화 (시안 Chat). 리듀서의 ConversationView 하나를 그린다: 끝난 말풍선(messages) → 도는 턴(progress) → 승인 카드(attention) → 대기(queue).
// 답은 글자 그대로 그린다 — 마크다운은 다음 라운드. 모드 칩·"작업 N" 은 모양만.
// 명령(보내기·중지·되돌리기·답)은 전부 데스크탑으로 간다. 안 된 것은 입력창 위 안내 띠(notice)로 — 누르면 닫힌다.
export function ChatScreen({ session, cid, onBack }: { session: AppSession; cid: string; onBack(): void }) {
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

  // 이 대화를 받아 두고 이벤트를 따라간다 — 나가면 놓는다
  useEffect(() => {
    session.openConversation(cid)
    return () => {
      session.closeConversation(cid)
      session.clearNotice()
    }
  }, [session, cid])

  const project = state.projects.find((candidate) => candidate.path === conversation?.project)
  const model = session.models.find((candidate) => candidate.providerId === conversation?.model?.providerId && candidate.modelId === conversation?.model?.modelId)
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
  // 턴이 도는 중이고 입력이 비었으면 중지, 아니면 보내기(턴 중이면 데스크탑이 대기열에 넣는다)
  const stopping = (view?.running ?? false) && !draft.trim()

  return (
    <KeyboardAvoidingView style={[styles.screen, { paddingTop: insets.top + 8 }]} behavior="padding">
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel={S.backToList} style={styles.back} onPress={onBack}>
          <BackArrow />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={1}>
            {conversation?.title || S.untitled}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {[model?.displayName ?? conversation?.model?.modelId, project?.name].filter(Boolean).join(' · ')}
          </Text>
        </View>
        {jobs > 0 && (
          <Pressable accessibilityRole="button" accessibilityLabel={S.runningJobs(jobs)} style={styles.jobs}>
            <View style={styles.jobsRing} />
            <Text style={styles.jobsText}>{S.jobs(jobs)}</Text>
          </Pressable>
        )}
      </View>

      <View style={styles.status}>
        <StatusBanner session={session} />
      </View>

      <ScrollView ref={scroll} style={styles.body} contentContainerStyle={styles.bodyContent} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}>
        {view?.messages.map((message, index) => (message.role === 'user' ? <UserMessage key={index} message={message} /> : <Answer key={index} message={message} />))}
        {view?.running && (
          <Turn head={turnHead(S.running, startedAt === undefined ? undefined : now - startedAt, view.progress)} items={view.progress} initiallyOpen />
        )}
        {view?.attention.map((request) => (
          <AttentionCard key={request.id} request={request} onAnswer={(answer) => session.reply(request, answer)} />
        ))}
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
  subtitle: { fontSize: 12, color: C.sub },
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
