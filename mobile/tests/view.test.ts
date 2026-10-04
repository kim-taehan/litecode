import { describe, expect, it } from 'vitest'
import type { RemoteConversation } from '../../shared/remote.ts'
import { ago, attentionTitle, initials, outcomeLabel, rowView, statusBanner, turnHead, turnLines } from '../src/app/view.ts'

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

  it('statusBanner: 붙어 있으면 없다. 남은 초는 올림', () => {
    expect(statusBanner({ kind: 'connected' }, NOW)).toBeUndefined()
    expect(statusBanner({ kind: 'reconnecting', attempt: 2, retryAt: NOW + 1_200 }, NOW)).toBe('다시 연결 중 · 2초')
    expect(statusBanner({ kind: 'unresponsive', attempt: 1, retryAt: NOW }, NOW)).toBe('데스크탑 응답 없음 (잠자기?)')
    expect(statusBanner({ kind: 'revoked' }, NOW)).toBe('연결이 해제됐습니다')
  })
})
