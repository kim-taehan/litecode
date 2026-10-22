import { describe, expect, it } from 'vitest'
import type { HistoryMessage } from '../../shared/contract.ts'
import { stopFeedback } from '../../shared/hooks.ts'
import type { TurnItem } from '../../shared/ipc.ts'
import { translate, type MessageKey } from '../../shared/i18n/index.ts'
import { answerText, clockTime, formatDuration, interimSplit, interimText, looksLikePath, minimapTurns, minimapTurnDetails, splitTurn, thinkSummary, toolTitle, turnHeadText, upsertItem } from '../../renderer/turnView.ts'

// 답 한 턴의 화면 모양 — 진행 줄 쌓기, 작업/답 가르기, 줄 글자

const ko = (key: MessageKey, vars?: Record<string, string | number>) => translate('ko', key, vars)
const en = (key: MessageKey, vars?: Record<string, string | number>) => translate('en', key, vars)

const think = (id: string, text = 't', done = true): TurnItem => ({ kind: 'think', id, text, done })
const text = (id: string, value = 'x', done = true): TurnItem => ({ kind: 'text', id, text: value, done })
const tool = (id: string): TurnItem => ({ kind: 'tool', id, name: 'bash', status: 'done' })

describe('upsertItem', () => {
  it('처음 보는 id 는 끝에, 아는 id 는 그 자리에서 바꾼다', () => {
    const a = upsertItem(undefined, text('a', '1', false))
    const b = upsertItem(a, tool('b'))
    const c = upsertItem(b, text('a', '12'))
    expect(c.map((item) => item.id)).toEqual(['a', 'b'])
    expect(c[0]).toEqual(text('a', '12'))
  })
})

describe('splitTurn·answerText', () => {
  it('답은 마지막 도구·생각 뒤의 글 — 도구 앞에 쓴 글과 생각은 작업이다', () => {
    const items = [think('t1'), text('a'), tool('b'), think('t2'), text('c', 'final')]
    const { work, answer } = splitTurn(items)
    expect(work.map((item) => item.id)).toEqual(['t1', 'a', 'b', 't2'])
    expect(answer.map((item) => item.id)).toEqual(['c'])
    expect(answerText(answer, 'all')).toBe('final')
  })

  it('글만 있으면 작업이 없다. 줄이 없거나 덜 끝났으면 엔진이 준 답 전체', () => {
    expect(splitTurn([text('a')]).work).toEqual([])
    expect(answerText([], 'fallback')).toBe('fallback')
    expect(answerText([text('a', 'part', false)], 'fallback')).toBe('fallback')
  })

  // 턴 끝 훅(이슈 #102)의 줄은 답 글 뒤에 붙는다 — 그 줄 때문에 답이 작업으로 접히면 안 된다
  it('답 뒤에 붙은 훅 줄은 작업이다 — 답은 그 앞의 글 그대로', () => {
    const hook = (id: string): TurnItem => ({ kind: 'hook', id, event: 'Stop', command: 'npm test', outcome: 'passed', seconds: 1.2 })
    const { work, answer } = splitTurn([tool('b'), hook('h1'), text('c', 'final'), hook('h2'), hook('h3')])
    expect(work.map((item) => item.id)).toEqual(['b', 'h1', 'h2', 'h3'])
    expect(answer.map((item) => item.id)).toEqual(['c'])
    expect(answerText(answer, 'all')).toBe('final')
  })
})

describe('interimText (append-only 잠정답) — DeepSeek 하네스 방식', () => {
  it('마지막 도구·생각 뒤의 text 줄만 — 그 앞의 중간 글은 안 든다', () => {
    // [think, mid-text, tool, final-text] → 마지막 도구가 있는 'tool' 뒤에 'final-text'만 보임
    expect(interimText([think('t1'), text('a', 'mid'), tool('b'), text('c', 'final')])).toEqual(['final'])
  })

  it('글만 있으면 전부, 빈 줄은 뺀다', () => {
    expect(interimText([text('a', 'final')])).toEqual(['final'])
    expect(interimText([text('a', 'final'), text('b', '  ')])).toEqual(['final'])
  })

  it('도구가 끼어도 그 위의 글이 안 사라진다 (append-only) — [text, tool, text] 둘 다 보임', () => {
    // [text-mid, tool, text-final] → tool 이후의 text-only 가 'final'
    // DeepSeek 방식: tool 앞의 'mid' 는 보이지 않음 (work 로 이동)
    // 다만 tool 뒤의 'final' 이 보임
    expect(interimText([text('a', 'mid'), tool('b'), text('c', 'final')])).toEqual(['final'])
  })

  it('도구 사이 text 를 여러 번 보낸다 — [text1, tool, text2] → second 만', () => {
    expect(interimText([text('a', 'first'), tool('b'), text('c', 'second')])).toEqual(['second'])
  })

  it('도구 없이 글만 여러 줄이면 전부 보임 (분할 경계가 없으므로 전부 답)', () => {
    expect(interimText([text('a', '1'), text('b', '2')])).toEqual(['1', '2'])
  })

  it('생각·도구 모두 없으면 마지막 text 만', () => {
    expect(interimText([text('only', 'hello')])).toEqual(['hello'])
  })

  it('hook 줄은 건너뛴다 (splitTurn 의 규칙) — [tool, hook, text] → text', () => {
    const hook = (id: string): TurnItem => ({ kind: 'hook', id, event: 'Stop', command: 'x', outcome: 'passed', seconds: 1 })
    expect(interimText([tool('b'), hook('h1'), text('c', 'ans')])).toEqual(['ans'])
  })
})

describe('interimSplit (deepagents harness 구조 동일)', () => {
  it('work = splitTurn 의 work (think·tool·중간 text), interim = interimText, answer = splitTurn 의 answer', () => {
    const items = [think('t1'), text('a', 'mid'), tool('b'), text('c', 'final')]
    const { work, interim, answer } = interimSplit(items)
    expect(work.map((item) => item.id)).toEqual(['t1', 'a', 'b'])
    expect(interim).toEqual(['final'])
    expect(answer.map((item) => item.id)).toEqual(['c'])
  })

  it('글만: work 없음, interim = 전부, answer = 전부', () => {
    const items = [text('a', '1'), text('b', '2')]
    const { work, interim, answer } = interimSplit(items)
    expect(work).toEqual([])
    expect(interim).toEqual(['1', '2'])
    expect(answer.map((item) => item.id)).toEqual(['a', 'b'])
  })

  it('도구만: work = tool, interim / answer 없음', () => {
    const items = [tool('b')]
    const { work, interim, answer } = interimSplit(items)
    expect(work.map((item) => item.id)).toEqual(['b'])
    expect(interim).toEqual([])
    expect(answer).toEqual([])
  })

  it('hook 줄 — splitTurn 규칙 그대로: hook 만 있으면 work', () => {
    const hook = (id: string): TurnItem => ({ kind: 'hook', id, event: 'Stop', command: 'x', outcome: 'passed', seconds: 1 })
    const items = [tool('b'), hook('h1'), text('c', 'ans')]
    const { work, interim, answer } = interimSplit(items)
    expect(work.map((item) => item.id)).toEqual(['b', 'h1'])
    expect(interim).toEqual(['ans'])
    expect(answer.map((item) => item.id)).toEqual(['c'])
  })
})

describe('thinkSummary', () => {
  it('끝났으면 첫 문단 첫 줄, ** 를 뗀다', () => {
    expect(thinkSummary('**Planning** the answer\nmore\n\nSecond paragraph', true)).toBe('Planning the answer')
  })

  it('쓰는 중이면 마지막으로 다 쓴 문단의 첫 줄, 다 쓴 문단이 없으면 지금 문단', () => {
    expect(thinkSummary('First\n\nSecond line\n\nThird is stre', false)).toBe('Second line')
    expect(thinkSummary('Only one so f', false)).toBe('Only one so f')
    expect(thinkSummary('', false)).toBe('')
  })
})

describe('글자', () => {
  it('걸린 시간은 최소 1초, 분·시간 단위', () => {
    expect(formatDuration(ko, 0)).toBe('1초')
    expect(formatDuration(ko, 2_400)).toBe('2초')
    expect(formatDuration(ko, 75_000)).toBe('1분 15초')
    expect(formatDuration(ko, 3_660_000)).toBe('1시간 1분')
  })

  it('턴 머리: 완료/실패 + 시간 (모르면 시간 없이)', () => {
    expect(turnHeadText(ko, 2_000, false)).toBe('완료 · 2초')
    expect(turnHeadText(ko, undefined, false)).toBe('완료')
    expect(turnHeadText(ko, 1_000, true)).toBe('실패 · 1초')
    expect(turnHeadText(ko, 3_000, true, true)).toBe('중단됨 · 3초') // 끊긴 턴은 실패와 가른다
    expect(turnHeadText(ko, undefined, true, true)).toBe('중단됨')
    expect(turnHeadText(ko, 4_000, false, false, true)).toBe('거절함 · 4초') // 승인·질문 거절은 실패가 아니다
  })

  it('영어 사전으로도 같은 자리가 채워진다', () => {
    expect(turnHeadText(en, 75_000, false)).toBe('Done · 1m 15s')
    expect(turnHeadText(en, 3_000, true, true)).toBe('Interrupted · 3s')
  })

  it('도구 이름·시각', () => {
    expect(toolTitle('bash')).toBe('Bash')
    expect(clockTime(new Date(2026, 9, 1, 7, 5).getTime())).toBe('07:05')
  })

  it('경로처럼 보이는 인라인 코드만 후보 — 공백·평범한 낱말은 아니다', () => {
    expect(looksLikePath('src/a.ts')).toBe(true)
    expect(looksLikePath('package.json')).toBe(true)
    expect(looksLikePath('npm run dev')).toBe(false)
    expect(looksLikePath('useState')).toBe(false)
  })
})

describe('minimapTurns', () => {
  // 미니맵 줄은 대화 칸의 `.user-turn` 닻과 순서로 짝짓는다 (Minimap.tsx). 턴 끝 훅이 이어 보낸 글은 `.hook-followup` 으로 그려져 닻이 아니다 (ChatTurn.tsx UserMessage)
  const messages: HistoryMessage[] = [
    { role: 'user', text: '첫 질문' },
    { role: 'assistant', text: '답 1' },
    { role: 'user', text: stopFeedback('테스트를 돌리세요') },
    { role: 'assistant', text: '답 2' },
    { role: 'user', text: '둘째 질문' },
    { role: 'assistant', text: '답 3' },
  ]
  it('턴 끝 훅이 이어 보낸 글은 줄이 아니다 — 줄 수가 닻 수와 같고 이름표에 훅 머리가 없다', () => {
    expect(minimapTurns(messages, 'c-1')).toEqual(['첫 질문', '둘째 질문'])
  })
  it('글 없이 첨부만 보낸 턴은 파일 이름이 이름표다', () => {
    expect(minimapTurns([{ role: 'user', text: '', attachments: [{ name: 'a.png' }, { name: 'b.txt' }] } as HistoryMessage], 'c-1')).toEqual(['a.png, b.txt'])
  })
})

describe('minimapTurnDetails', () => {
  // 이슈 #575 — 마커 클릭 시 우측 "턴 작업" 탭에 보낼 데이터: 그 턴(내 말)의 startedAt·진행 줄. 뒤를 이은 어시스턴트 응답이 있으면 끝난 턴

  const msg = (patch: Partial<HistoryMessage>): HistoryMessage => ({ ...patch } as HistoryMessage)
  const item: TurnItem = { kind: 'text', id: 'a', text: 'done', done: true }

  it('끝난 턴이면 내 말 시 + 뒤 어시스턴트의 진행 줄·모든 정보가 붙는다', () => {
    const details = minimapTurnDetails(
      [
        msg({ role: 'user', text: '질문', at: 100 }),
        msg({ role: 'assistant', text: '답', items: [item], duration: 2_000, error: undefined }),
      ],
      'c-1',
    )
    expect(details).toEqual([{ text: '질문', startedAt: 100, conversationId: 'c-1', items: [item], duration: 2_000, failed: false }])
  })

  it('마지막 내 말 뒤에 어시스턴트 반응이 없으면 진행 중 — 줄이 비고 시작만 남는다', () => {
    const [only] = minimapTurnDetails([msg({ role: 'user', text: '첫 말', at: 5 })], 'c-1')
    expect(only).toEqual({ text: '첫 말', startedAt: 5, conversationId: 'c-1', items: [], failed: false })
  })

  it('실패·중단·거절 응답은 그대로 전한다', () => {
    const details = minimapTurnDetails(
      [
        msg({ role: 'user', text: '질문', at: 100 }),
        msg({ role: 'assistant', text: '', items: [item], error: 'boom', interrupted: true, declined: true }),
      ],
      'c-1',
    )
    expect(details[0]).toMatchObject({ failed: true, interrupted: true, declined: true })
  })

  it('턴 끝 훅이 보낸 글은 줄에 안 들어간다 (minimapTurns 와 같은 닻)', () => {
    expect(
      minimapTurnDetails(
        [
          msg({ role: 'user', text: 'a' }),
          msg({ role: 'assistant', text: '' }),
          msg({ role: 'user', text: stopFeedback('hook') }),
          msg({ role: 'assistant', text: '' }),
        ],
        'c-1',
      ).map((t) => t.text),
    ).toEqual(['a'])
  })
})
