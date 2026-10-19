import { Context, Service } from 'cordis'
import { resolveModelKey } from '../../shared/engineModelId.ts'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { realDirectory } from './projectPath.ts'
import { titleFrom } from '../../shared/chat.ts'
import {
  MAX_SENDS_PER_TURN,
  MESSAGE_MAX,
  QUEUE_LIMIT,
  originOfConversation,
  projectId,
  shortIds,
  wrapInstruction,
} from '../../shared/delegation.ts'
import type { Conversation, Project } from '../../shared/contract.ts'
import './chat.ts'
import './sessions.ts'
import './projects.ts'
import './providers.ts'
import './llm.ts'

// 프로젝트 간 지시 — "받을 대화는 어디인가" 와 "보내기 전 자격" 의 단일 결정지 (이슈 #55·#137, 화면 진입점 #341). 두 호출자가 공유한다:
// - 모델 경로: 세션 도구 (appMcp/tools/sessions.ts — list·read·send). 그 목록·결과 **글**을 만들기는 도구 쪽이 하고, 여기는 대상·자격·전송만
// - 화면 경로: 오른쪽 패널의 Projects 탭 (사용자가 직접). 화면은 목록을 자기 데이터로 그린다 (renderer/delegationView.ts 의 같은 규칙),
//   보내기는 이 서비스의 자격을 여기서 다시 본다 — 화면 데이터는 바뀔 수 있고, 자격은 메인이 최종이다
// 받는 대화는 **자기 프로젝트 폴더·자기 모델·자기 모드**로 움직인다 (보내는 쪽 권한은 넘어가지 않는다). 쉬면 턴이 되고, 돌고 있으면 대기열.
// 보낸 대화의 지시는 `<message-from-conversation>` 으로 감싸고 출처(origin·from)를 대화에 남긴다 (받는 화면의 딱지가 읽는다)
// #351 — 승인 카드에서 사용자가 고를 선택지는 대상 목록보다 넓다: **새 대화**(newConversation — 그 프로젝트의 대화 모델·모드로 만든 새
// 대화에 보낸다)와 **보내는 프로젝트 자신의 대화**(targets 의 includeSelf). 자격(모델·대기열·턴당 수)은 그대로 본다

declare module 'cordis' {
  interface Context {
    delegation: DelegationService
  }
}

/** 다른 프로젝트 하나와 그 프로젝트에서 사용자가 마지막에 보던 대화 — 지시를 받는 곳 */
export interface DelegationTarget {
  /** 모델·화면에 보이는 프로젝트 id (p-…) */
  id: string
  project: Project
  conversation: Conversation
  /** 엔진에 넘길 수 없는 폴더면 그 사유 (#101) — 목록에는 있고, 보내면 이 사유로 거절 */
  problem?: string
}

/** 보내기의 결과 — 화면(Projects 탭)의 피드백과 도구의 결과 글이 같은 사실에서 만든다 */
export interface DelegationSent {
  state: 'sent' | 'queued'
  /** queued 면 앞에 쌓인 수 (1 = 그 턴) */
  ahead?: number
  /** 받는 대화(제목·짧은 id — 화면이 그 대화로 가려면) */
  conversationId: string
  conversationTitle: string
  shortId: string
  /** 받은 프로젝트의 이름 (딱지·감싼 글에 보인 것과 같다) */
  projectName: string
}

export class DelegationService extends Service {
  static readonly inject = ['chat', 'sessions', 'projects', 'providers', 'llm']

  constructor(ctx: Context) {
    super(ctx, 'delegation')
  }

  /** 등록된 프로젝트와 그 각각의 마지막에 보던 대화 — 폴더가 없어졌거나 그 대화가 없으면(본 적 없다·지워졌다) 빠진다.
   *  includeSelf=false(기본): 보내는 프로젝트(directory)는 제외(모델의 목록·읽기). true(#351): 이 프로젝트도 — 승인 카드에서 사용자가
   *  보내는 프로젝트의 대화(또는 그 프로젝트의 새 대화)를 고를 때. 경로는 realpath 로 맞춰 본다 (저장된 project 는 사용자가 고른 경로 그대로라) */
  async targets(directory: string, includeSelf = false): Promise<DelegationTarget[]> {
    const all = await this.ctx.sessions.list()
    const viewed = new Map<string, string>()
    for (const [project, id] of Object.entries(await this.ctx.sessions.lastViewed())) {
      const real = await realDirectory(project)
      if (real) viewed.set(real, id)
    }
    const targets: DelegationTarget[] = []
    for (const project of await this.ctx.projects.list()) {
      const real = await realDirectory(project.path)
      if (!real || (!includeSelf && real === directory)) continue
      const conversation = all.find((entry) => entry.id === viewed.get(real))
      if (!conversation) continue
      const problem = await this.ctx.llm.folderProblem(real)
      targets.push({ id: projectId(project.path), project, conversation, ...(problem && { problem }) })
    }
    return targets
  }

  /** 그 프로젝트(realpath)의 이름 — 받는 대화의 딱지·감싼 글에 보인다. 목록에서 빠진 폴더면 폴더 이름 */
  async nameOf(directory: string): Promise<string> {
    for (const project of await this.ctx.projects.list()) if ((await realDirectory(project.path)) === directory) return project.name
    return path.basename(directory)
  }

  /** 그 대화의 짧은 id (c-…) — 저장된 대화 전부를 한 묶음으로 (화면도 같은 묶음으로 푼다) */
  async shortOf(id: string): Promise<string> {
    return shortIds((await this.ctx.sessions.list()).map((entry) => entry.id)).get(id) ?? id
  }

  /** 자격을 보고 보낸다: 쓸 수 있는 대상(모델·폴더)·대기열 상한·count 면 한 턴의 보내기 수. 받는 대화의 폴더·모델·모드는 그 대화에 저장된
   *  것 그대로다 (ctx.chat 이 저장된 대화에서 읽는다). 던지는 글은 영어(모델이 읽는다) — 화면도 같은 문장을 그대로 보인다.
   *  conversationId(승인 카드에서 사용자가 고른 대화, #348)가 있으면 그 대화가 **대상 프로젝트의** 대화인지 여기서 보고, 아니면 그 대화로
   *  보낸다. newConversation(#351): 그 프로젝트에 새 대화를 만들어 보낸다 (모델·모드는 sendFresh 에서) */
  async send(input: { directory: string; from: { id: string; title: string }; targetId: string; message: string; count?: boolean; conversationId?: string; newConversation?: boolean }): Promise<DelegationSent> {
    const { directory, from, message } = input
    if (typeof message !== 'string' || !message.trim()) throw new Error('message is required.')
    if (message.length > MESSAGE_MAX) throw new Error(`message is too long (${message.length} characters, the limit is ${MESSAGE_MAX}).`)
    // includeSelf — 사용자가 승인 카드에서 보내는 프로젝트(자기 대화·새 대화)를 고를 수 있다 (#351)
    const target = (await this.targets(directory, true)).find((entry) => entry.id === input.targetId)
    if (!target) throw new Error('Unknown project. Use an id from list_projects.')
    if (target.problem) throw new Error(`Target project cannot be used (${target.problem}).`)
    if (input.newConversation) return this.sendFresh(directory, from, target, message, input.count)
    let to = target.conversation
    if (input.conversationId && input.conversationId !== to.id) {
      const all = await this.ctx.sessions.list()
      const picked = all.find((entry) => entry.id === input.conversationId)
      if (!picked) throw new Error('The conversation the user chose no longer exists.')
      if ((await realDirectory(picked.project)) !== (await realDirectory(target.project.path))) throw new Error('The conversation the user chose belongs to a different project.')
      to = picked
    }
    if (!to.model || !resolveModelKey(this.ctx.providers.get(to.model.providerId)?.models ?? [], to.model.modelId)) {
      throw new Error('Target conversation has no usable model.')
    }
    const waiting = this.ctx.chat.queued(to.id)
    if (waiting >= QUEUE_LIMIT) throw new Error(`Target queue is full (${waiting} waiting). Use read_project to check on it and try again later.`)
    if (input.count && !this.ctx.chat.countSend(from.id, MAX_SENDS_PER_TURN)) {
      throw new Error(`Too many instructions sent in this turn (the limit is ${MAX_SENDS_PER_TURN}).`)
    }
    const ahead = Math.max(1, waiting + (this.ctx.chat.turnOf(to.id) ? 1 : 0))
    const project = await this.nameOf(directory)
    const result = await this.ctx.chat.send(to.id, {
      text: wrapInstruction({ project, title: from.title }, message),
      display: message,
      origin: originOfConversation(from.id),
      from: { conversationId: from.id, title: from.title, project },
    })
    return {
      state: result.state === 'sent' ? 'sent' : 'queued',
      ...(result.state !== 'sent' && { ahead }),
      conversationId: to.id,
      conversationTitle: to.title,
      shortId: await this.shortOf(to.id),
      projectName: target.project.name,
    }
  }

  /** 그 프로젝트의 **새 대화**를 만들어 보낸다 (#351) — 새 대화는 돌고 있는 턴이 없으니 sent 가 유일하다. 모델·모드는 그 프로젝트의
   *  마지막에 보던 대화(대상) 것을 쓰고, 쓸 수 없으면 그 프로젝트에서 가장 최근의 쓸 수 있는 대화 것을 쓴다. 제목은 첫 메시지(보낸 글)에서
   *  ctx.chat 이 짓는다 — 보내고 나서 저장된 제목을 읽는다 */
  private async sendFresh(directory: string, from: { id: string; title: string }, target: DelegationTarget, message: string, count: boolean | undefined): Promise<DelegationSent> {
    if (count && !this.ctx.chat.countSend(from.id, MAX_SENDS_PER_TURN)) {
      throw new Error(`Too many instructions sent in this turn (the limit is ${MAX_SENDS_PER_TURN}).`)
    }
    const usable = (entry: Conversation): entry is Conversation & { model: { providerId: string; modelId: string } } =>
      !!entry.model && !!resolveModelKey(this.ctx.providers.get(entry.model.providerId)?.models ?? [], entry.model.modelId)
    const real = await realDirectory(target.project.path)
    const all = await this.ctx.sessions.list()
    const reals = new Map<string, string>()
    for (const entry of all) if (!reals.has(entry.project)) reals.set(entry.project, (await realDirectory(entry.project)) ?? entry.project)
    const inProject = all.filter((entry) => entry.project === target.project.path || reals.get(entry.project) === real)
    const source = [target.conversation, ...[...inProject].sort((a, b) => b.updatedAt - a.updatedAt)].find(usable)
    if (!source) throw new Error('Target project has no conversation with a usable model.')
    const cid = randomUUID()
    const project = await this.nameOf(directory)
    await this.ctx.chat.send(cid, {
      text: wrapInstruction({ project, title: from.title }, message),
      display: message,
      project: target.project.path,
      model: source.model,
      ...(source.mode && { mode: source.mode }),
      origin: originOfConversation(from.id),
      from: { conversationId: from.id, title: from.title, project },
    })
    const stored = (await this.ctx.sessions.list()).find((entry) => entry.id === cid)
    return {
      state: 'sent',
      conversationId: cid,
      conversationTitle: stored?.title || titleFrom(message),
      shortId: await this.shortOf(cid),
      projectName: target.project.name,
    }
  }
}
