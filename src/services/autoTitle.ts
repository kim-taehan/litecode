import type { Context } from 'cordis'
import './llm.ts'
import './sessions.ts'
import './settings.ts'
import './chat.ts'

// 자동 대화 제목 (이슈 #215, 설정 > 일반 "대화 제목을 AI 가 짧게 정리" — 기본 꺼짐). 원래 제목은 첫 메시지 첫 줄(shared/chat.ts titleFrom)이다.
// 켜져 있으면 대화의 **첫 턴이 잘 끝난 뒤** 그 대화의 모델에 짧은 제목을 한 번 묻고 ctx.sessions 의 제목을 바꾼다 (제목의 정본은 ctx.sessions —
// opencode 는 제목을 안 만든다). ctx.chat 의 턴 이벤트만 듣는다 — ctx.chat 은 이 플러그인을 모른다.
// - 묻기는 ctx.llm.askOnce (임시 세션 — 대화 목록·통계·알림·훅·대기열과 무관하고, 끝나면 지운다). 엔진을 직접 모른다
// - 턴 끝 처리를 막지 않는다 (백그라운드, 재시도 없이 한 번). 실패·시간 초과·빈 답이면 조용히 그대로 둔다 — 화면에 오류가 없다
// - 한 대화에 한 번: 엔진 세션이 없던 턴(첫 턴)만. 사용자가 이름을 바꾼 대화는 덮지 않는다 (ctx.sessions.autoTitle 이 renamed 를 본다)
// - 비밀이 덜 가게: 첫 사용자 글은 말풍선 글(첨부 내용·`/` 명령이 풀어 쓴 본문이 아니다)이고, 답은 글만(도구 결과 없음) — 각각 상한 바이트까지
// 제목이 바뀌면 'chat/conversations-changed' 로 알린다 — 화면은 목록을 다시 읽고, 모바일은 기존 conversations.changed 로 받는다

/** 답을 기다리는 한도 — 넘기면 엔진 턴을 멈추고(askOnce 의 stop) 그대로 둔다 */
export const AUTO_TITLE_TIMEOUT_MS = 15_000
/** 제목 글자 수 상한 (글자 단위) */
export const AUTO_TITLE_MAX = 40
/** 첫 사용자 글·첫 답에서 싣는 양 (각각, UTF-8 바이트) */
export const AUTO_TITLE_INPUT_BYTES = 1_000

export interface AutoTitleOptions {
  /** 시험이 줄인다 */
  timeoutMs?: number
}

type Answer = { ok: true; text: string } | { ok: false; error: string }

export function autoTitle(ctx: Context, opts: AutoTitleOptions = {}): void {
  /** 대화 id → 도는 첫 턴의 사용자 글 */
  const firsts = new Map<string, string>()
  ctx.on('chat/turn-started', ({ cid, message, conversation }) => {
    if (conversation.engineSessionId) firsts.delete(cid)
    else firsts.set(cid, message.text || conversation.title) // 글 없이 첨부만 보냈으면 제목(첫 파일 이름)
  })
  ctx.on('chat/turn-ended', ({ cid, message, outcome, conversation }) => {
    const first = firsts.get(cid)
    firsts.delete(cid)
    if (first === undefined || outcome !== 'done' || message.declined || !message.text.trim()) return
    if (ctx.settings.get().autoTitle !== true || !conversation?.model || conversation.renamed) return
    void retitle(cid, conversation.project, conversation.model, titlePrompt(first, message.text))
  })

  async function retitle(cid: string, project: string, model: { providerId: string; modelId: string }, prompt: string): Promise<void> {
    const stop = AbortSignal.timeout(opts.timeoutMs ?? AUTO_TITLE_TIMEOUT_MS)
    // askOnce 가 stop 을 듣지만, 엔진에 닿기 전(연결·세션 만들기)에 걸려도 여기서는 기한에 놓는다
    const timedOut = new Promise<Answer>((resolve) => stop.addEventListener('abort', () => resolve({ ok: false, error: 'timeout' }), { once: true }))
    const asked = ctx.llm.askOnce({ ...model, directory: project, prompt, stop }).catch((error: unknown): Answer => ({ ok: false, error: (error as Error).message }))
    const answer = await Promise.race([asked, timedOut])
    if (!answer.ok) return console.warn('[autoTitle] 제목을 못 받았다 — 그대로 둔다', answer.error)
    const title = cleanTitle(answer.text)
    if (!title) return
    const changed = await ctx.sessions.autoTitle(cid, title).catch(() => undefined)
    if (changed) ctx.emit('chat/conversations-changed', { project: changed.project, removed: [] })
  }
}
autoTitle.inject = ['llm', 'sessions', 'settings']

/** 제목을 묻는 글 — 첫 사용자 글과 첫 답을 각각 상한 바이트까지 */
export function titlePrompt(user: string, answer: string): string {
  return [
    'Write a short title for the conversation below.',
    `- One line, at most ${AUTO_TITLE_MAX} characters`,
    '- In the same language as the conversation',
    '- Reply with the title only: no quotes, no trailing punctuation, no explanation',
    '',
    '<user>',
    clipBytes(user.trim(), AUTO_TITLE_INPUT_BYTES),
    '</user>',
    '<assistant>',
    clipBytes(answer.trim(), AUTO_TITLE_INPUT_BYTES),
    '</assistant>',
  ].join('\n')
}

/** 모델이 준 글을 제목 한 줄로 — 생각 블록을 빼고 첫 줄, 머리표·굵게·"Title:"·앞뒤 따옴표·끝 마침표를 떼고 공백을 줄여 AUTO_TITLE_MAX 글자까지. 쓸 것이 없으면 빈 글 */
export function cleanTitle(raw: string): string {
  const line = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').split('\n').map((part) => part.trim()).find(Boolean) ?? ''
  const title = line
    .replace(/^#+\s*/, '')
    .replace(/^\*\*(.*)\*\*$/, '$1')
    .replace(/^(?:title|제목)\s*[:：]\s*/i, '')
    .replace(/[.。]+$/, '') // 따옴표 바깥의 마침표 ("…".)
    .replace(/^["'`“”‘’「『«]+|["'`“”‘’」』»]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.。]+$/, '')
    .trim()
  return [...title].slice(0, AUTO_TITLE_MAX).join('').trim()
}

/** UTF-8 로 max 바이트까지 — 잘린 글자는 버린다 */
function clipBytes(text: string, max: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= max) return text
  return bytes.subarray(0, max).toString('utf8').replace(/�+$/, '')
}
