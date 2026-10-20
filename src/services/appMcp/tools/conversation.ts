import type { Context } from 'cordis'
import { resolveModelKey } from '../../../../shared/engineModelId.ts'
import { randomUUID } from 'node:crypto'
import { realDirectory } from '../../projectPath.ts'
import { APP_MCP_NAME } from '../../mcp.ts'
import type { AppMcpTool } from '../rpc.ts'
import { TITLE_MAX } from '../../../../shared/chat.ts'
import { MAX_SENDS_PER_TURN, MESSAGE_MAX, NEW_CONVERSATION_TOOL, originOfConversation, wrapInstruction } from '../../../../shared/delegation.ts'
import type { Conversation } from '../../../../shared/contract.ts'
import '../../appMcp.ts'
import '../../chat.ts'
import '../../delegation.ts'
import '../../llm.ts'
import '../../providers.ts'
import '../../sessions.ts'

// 새 대화 도구 (이슈 #415) — 질문이 바뀌면 현재 프로젝트의 새 대화로 이어 가는 모델 손잡이. 다른 대화(보내기)와 달리 대상 프로젝트는
 // 항상 부른 대화의 프로젝트다: 새 대화는 그 대화가 쓰는 모델·모드로 만들고, 제목은 **모델이 직접** 인자로 준다(첫 메시지 자동 제목이
 // 아니라 — 보낸 뒤 제목을 이름 바꾸기로 세운다. renamed 처럼 통째 저장·자동 제목에 덮이지 않는다). 받는 첫 메시지는
 // `<message-from-conversation>` 로 감싸고 출처(딱지·`session:` origin)를 남긴다 — 보낸 대화의 진행 줄이 그 대화로 가리킨다(c-…).
 //
 // 자격(다른 대화의 지시로 도는 턴은 다시 못 만든다 — 깊이 1)·한 턴 수(보내기랑 함께 MAX_SENDS_PER_TURN)는 보내기와 같은 기준.
 // 하위 작업(백그라운드 작업)은 못 만드고, **사용자가 앱의 승인 카드에서 허용한 호출만** 받는다(보내기 도구의 approved — 이쪽이 만든
 // 대화는 사용자가 제목까지 보고 허용한 것이다). 엔진 권한 규칙은 engineConfig.ts — 전역 deny(하위 작업·모르는 에이전트는 못 본다) +
 // 기본·매번 묻기·전체 권한은 부를 때마다 승인 카드, 계획 모드엔 없다(보내기 도구와 같은 모양).
 // 설명·결과는 모델이 읽는다 — 영어. 프로젝트 이름·대화 제목·본문은 원문 그대로

const NO_CALLER = 'Could not tell which conversation made this call. Call the tool again.'

function text(args: Record<string, unknown>, name: string, max: number): string {
  const value = args[name]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`)
  if (value.length > max) throw new Error(`${name} is too long (${value.length} characters, the limit is ${max}).`)
  return value
}

export function ConversationTools(ctx: Context): void {
  /** 그 프로젝트(realpath)의 대화 — 저장된 project 는 사용자가 고른 경로 그대로라 realpath 로 맞춰 본다 */
  async function inProject(directory: string): Promise<Conversation[]> {
    const all = await ctx.sessions.list()
    const real = new Map<string, string | undefined>()
    for (const project of new Set(all.map((entry) => entry.project))) real.set(project, project === directory ? directory : await realDirectory(project))
    return all.filter((entry) => real.get(entry.project) === directory)
  }

  /** 이 도구를 부른 대화 — 본 세션(하는 중인 턴)이고, 앱의 승인 카드에서 허용되고, 지시를 받아 도는 턴이 아닌 것. 자격 없으면 그 사유를
   *  던진다 (모델이 읽는다) */
  async function sender(directory: string, args: Record<string, unknown>): Promise<Conversation> {
    const found = await ctx.llm.callerOf(directory, { server: APP_MCP_NAME, tool: NEW_CONVERSATION_TOOL }, args)
    if (!found) throw new Error(NO_CALLER)
    if (found.child || ctx.chat.isTaskSession(found.sessionId)) throw new Error('A sub-task or background task cannot start a new conversation.')
    if (!found.approved) throw new Error('This call was not approved by the user in litecode. Nothing was started.')
    const conversation = (await inProject(directory)).find((entry) => entry.engineSessionId === found.sessionId)
    const turn = conversation && ctx.chat.turnOf(conversation.id)
    if (!conversation || !turn) throw new Error(NO_CALLER)
    if (turn.origin.startsWith('session:')) throw new Error('This turn was started by another conversation and cannot start a further one.')
    return conversation
  }

  /** 쓸 수 있는 모델이 있는가 (설정에서 모델이 사라진 대화는 아니다) */
  function usable(entry: Conversation): entry is Conversation & { model: { providerId: string; modelId: string } } {
    return !!entry.model && !!resolveModelKey(ctx.providers.get(entry.model.providerId)?.models ?? [], entry.model.modelId)
  }

  const start: AppMcpTool = {
    name: NEW_CONVERSATION_TOOL,
    description:
      'Use it proactively: whenever you judge that the user\'s question has shifted to a different topic that this conversation\'s ' +
      `context no longer serves, you MUST **start a new conversation in this project** with this tool as the very first action of ` +
      `that turn and continue the Q&A there. Do not answer the new topic in this conversation and do not force it into this ` +
      `conversation's context, and do not call any other tool before this one (not even a clarifying question). Do not ask ` +
      `"should we start a new conversation?" — show the approval card right away; if the user rejects it, continue the new topic here. ` +
      'You give the new conversation its title and the message that starts it. ' +
      `The message must be self-contained — the new conversation cannot see this one: cover the progress so far, the decisions ` +
      `taken, the files involved and the current branch. It is created in this project and runs with this conversation's model ` +
      `and mode. The user must approve each start with the title visible in the approval card. ` +
      'Returns with the new conversation\'s title and short id (c-…); the run row in this conversation links to it, ' +
      'so make sure the user opens it and continues there. ' +
      'Do not use it to split your own work into parts (that is task_start) or to reach something a permission refused.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: `The new conversation's title, given by you. At most ${TITLE_MAX} characters.` },
        message: { type: 'string', description: `The first message of the new conversation. Self-contained, at most ${MESSAGE_MAX} characters.` },
      },
      required: ['title', 'message'],
    },
    async run(args, { directory }) {
      const title = String(args['title'] ?? '').trim().slice(0, TITLE_MAX)
      if (!title) throw new Error('title is required.')
      const message = text(args, 'message', MESSAGE_MAX)
      const from = await sender(directory, args)
      // 모델·모드는 부른 대화 것 — 쓸 수 없으면(모델이 설정에서 사라졌다면) 그 프로젝트에서 최근 활동 순
      const others = (await inProject(directory)).filter((entry) => entry.id !== from.id).sort((a, b) => b.updatedAt - a.updatedAt)
      const source = (usable(from) ? from : undefined) ?? others.find(usable)
      if (!source) throw new Error('There is no conversation in this project with a usable model. Pick one in this conversation first.')
      if (!ctx.chat.countSend(from.id, MAX_SENDS_PER_TURN)) {
        throw new Error(`Too many new conversations started in this turn (the limit is ${MAX_SENDS_PER_TURN}).`)
      }
      const cid = randomUUID()
      const project = await ctx.delegation.nameOf(directory)
      await ctx.chat.send(cid, {
        text: wrapInstruction({ project, title: from.title }, message),
        display: message,
        project: from.project,
        model: source.model,
        ...(source.mode && { mode: source.mode }),
        origin: originOfConversation(from.id),
        from: { conversationId: from.id, title: from.title, project },
      })
      // 새 대화의 제목은 모델이 준 것 — 보낸 뒤(목록 저장 직후) 이름 바꾸기로 세운다. 자동으로 만든 첫 줄 제목이 아니라, 그 뒤 자동 제목도 덮지 못한다
      const renamed = await ctx.chat.rename(cid, title)
      if (!renamed) throw new Error('The new conversation was deleted before it could be titled.')
      const shortId = await ctx.delegation.shortOf(cid)
      return (
        `Started a new conversation "${renamed.title}" (${shortId}) in this project. It runs with the model and mode of "${from.title}". ` +
        'The run row above links to it — ask the user to open it and continue there. Nothing more is sent back to this conversation.'
      )
    },
  }

  ctx.effect(() => ctx.appMcp.register(start))
}
ConversationTools.inject = ['appMcp', 'chat', 'llm', 'sessions', 'providers', 'delegation']
