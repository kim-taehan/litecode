import { describe, expect, it } from 'vitest'
import type { RemoteConversation } from '../../shared/remote.ts'
import { ago, attentionTitle, composerBottomMargin, initials, outcomeLabel, questionView, rowView, statusBanner, turnHead, turnLines, userMessageView } from '../src/app/view.ts'

const NOW = 1_800_000_000_000
const conversation: RemoteConversation = { id: 'c', project: '/p', title: '제목', updatedAt: NOW }

describe('view — 상태를 화면 글로', () => {
  it('ago: 지금 · 초 · 분 · 시간 · 어제 · 일', () => {
    const at = (ms: number) => ago(NOW - ms, NOW)
    expect([at(0), at(4_999), at(12_000), at(120_000), at(3 * 3_600_000), at(26 * 3_600_000), at(3 * 86_400_000 + 5)]).toEqual(['지금', '지금', '12초', '2분', '3시간', '어제', '3일'])
    expect(ago(NOW + 5_000, NOW)).toBe('지금') // 시계가 조금 어긋나도
  })

  it('initials: 낱말 둘이면 첫 글자씩, 하나면 앞 두 글자', () => {
    expect([initials('billing-api'), initials('litecode'), initials('내 프로젝트'), initials('')]).toEqual(['BA', 'LI', '내프', ''])
  })

  it('rowView: 받아 두지 않은 대화는 상태 글만 — 미리보기 글은 받아 둔 대화에서만 나온다', () => {
    expect(rowView(conversation, 'attention', undefined)).toEqual({ dot: 'attention', title: '제목', subtitle: '답 필요' })
    expect(rowView(conversation, 'running', undefined)).toEqual({ dot: 'running', title: '제목', subtitle: '진행 중' })
    expect(rowView(conversation, 'failed', undefined)).toEqual({ dot: 'failed', title: '제목', subtitle: '실패' })
    expect(rowView({ ...conversation, title: '' }, undefined, undefined)).toEqual({ dot: 'none', title: '새 대화', subtitle: '' })
  })

  it('attentionTitle: 권한 이름에 따라', () => {
    const permission = (action: string) => attentionTitle({ kind: 'permission', id: 'p', sessionId: 's', action, resources: [] })
    expect([permission('bash'), permission('edit'), permission('webfetch')]).toEqual(['명령 실행 승인', '파일 수정 승인', '실행 승인'])
    expect(attentionTitle({ kind: 'question', id: 'q', sessionId: 's', questions: [] })).toBe('질문')
  })

  it('turnHead: 0 인 것과 모르는 시간은 뺀다', () => {
    expect(turnHead('완료', 12_400, [{ kind: 'text', id: 't', text: '답', done: true }])).toBe('완료 · 12초')
    expect(turnHead('진행 중', undefined, [])).toBe('진행 중')
  })

  it('turnLines: 준비 중 도구·빈 생각·글은 줄이 아니다. MCP 도구는 서버/도구로', () => {
    expect(
      turnLines([
        { kind: 'think', id: 'a', text: '  ', done: false },
        { kind: 'tool', id: 'b', name: 'bash', status: 'preparing', summary: 'ls' },
        { kind: 'text', id: 'c', text: '글', done: true },
        { kind: 'tool', id: 'd', name: 'jira_search', status: 'done', summary: 'PAY-12', mcp: { server: 'jira', tool: 'search' } },
      ]),
    ).toEqual([{ id: 'd', text: 'jira/search PAY-12', mono: true }])
  })

  it('outcomeLabel: 거절 · 중단 · 실패 · 완료', () => {
    const message = { role: 'assistant' as const, text: '' }
    expect([outcomeLabel({ ...message, declined: true }), outcomeLabel({ ...message, interrupted: true, error: '중단됨' }), outcomeLabel({ ...message, error: '500' }), outcomeLabel(message)]).toEqual(['거절됨', '중단됨', '실패', '완료'])
  })

  it('composerBottomMargin: 키보드가 떠 있으면 시스템 바 여백을 더하지 않는다 — 입력 카드가 키보드 바로 위에 붙는다', () => {
    // 3버튼 내비게이션(48dp)·제스처 바(24dp)·없음
    expect([composerBottomMargin(48, false), composerBottomMargin(24, false), composerBottomMargin(0, false)]).toEqual([60, 36, 12])
    expect([composerBottomMargin(48, true), composerBottomMargin(24, true), composerBottomMargin(0, true)]).toEqual([12, 12, 12])
  })

  it('statusBanner: 붙어 있으면 없다. 남은 초는 올림', () => {
    expect(statusBanner({ kind: 'connected' }, NOW)).toBeUndefined()
    expect(statusBanner({ kind: 'reconnecting', attempt: 2, retryAt: NOW + 1_200 }, NOW)).toBe('다시 연결 중 · 2초')
    expect(statusBanner({ kind: 'unresponsive', attempt: 1, retryAt: NOW }, NOW)).toBe('데스크탑 응답 없음 (잠자기?)')
    expect(statusBanner({ kind: 'revoked' }, NOW)).toBe('연결이 해제됐습니다')
  })

  it('userMessageView: 훅이 이어 보낸 글은 말풍선이 아니라 훅 줄 — 머리("Stop hook feedback:")는 떼고 사유만', () => {
    expect(userMessageView({ role: 'user', text: 'Stop hook feedback: 테스트가 빨강입니다' })).toEqual({ kind: 'hook', reason: '테스트가 빨강입니다' })
    expect(userMessageView({ role: 'user', text: '\nStop hook feedback:' })).toEqual({ kind: 'hook', reason: '' })
  })

  it('userMessageView: 첨부만 보낸 메시지는 빈 말풍선이 아니라 첨부 이름만. 글은 앞뒤 빈칸을 뗀다', () => {
    expect(userMessageView({ role: 'user', text: '', attachments: [{ kind: 'image', name: 'shot.png' }, { kind: 'file', name: 'a.ts', size: 10 }] })).toEqual({ kind: 'bubble', text: '', attachments: ['shot.png', 'a.ts'] })
    expect(userMessageView({ role: 'user', text: '  안녕\n' })).toEqual({ kind: 'bubble', text: '안녕', attachments: [] })
  })

  it('userMessageView: 다른 대화가 보낸 지시는 딱지를 단다 — 내가 친 글과 가른다', () => {
    expect(userMessageView({ role: 'user', text: '빌드해', origin: { conversationId: 'x', title: '기획' } })).toEqual({ kind: 'bubble', text: '빌드해', attachments: [], origin: '기획' })
    expect(userMessageView({ role: 'user', text: '빌드해', origin: { conversationId: 'x', title: '' } })).toEqual({ kind: 'bubble', text: '빌드해', attachments: [], origin: '새 대화' })
  })

  it('questionView: 질문 하나 + 보기 + 하나 고르기만 폰에서 답한다 — 그 밖(보기 없음·여러 질문·여럿 고르기)은 데스크탑으로', () => {
    const question = (questions: Parameters<typeof questionView>[0]['questions']) => questionView({ kind: 'question', id: 'q', sessionId: 's', questions })
    const pick = { question: '어느 쪽?', options: [{ label: 'A' }, { label: 'B' }] }
    expect(question([pick])).toEqual({ kind: 'pick', question: '어느 쪽?', options: ['A', 'B'] })
    expect(question([{ question: '이름은?', options: [] }])).toEqual({ kind: 'desktop', questions: ['이름은?'] })
    expect(question([pick, { question: '둘째', options: [{ label: 'C' }] }])).toEqual({ kind: 'desktop', questions: ['어느 쪽?', '둘째'] })
    expect(question([{ ...pick, multiple: true }])).toEqual({ kind: 'desktop', questions: ['어느 쪽?'] })
    expect(question([])).toEqual({ kind: 'desktop', questions: [] })
  })
})
