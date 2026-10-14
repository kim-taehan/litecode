import { Context, Service } from 'cordis'
import path from 'node:path'
import { realDirectory } from './projectPath.ts'
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

  /** 보내는 프로젝트(directory, realpath)가 아닌 등록된 프로젝트와 그 각각의 마지막에 보던 대화 — 폴더가 없어졌거나 그 대화가 없으면(본 적
   *  없다·지워졌다) 빠진다. 경로는 realpath 로 맞춰 본다 (저장된 project 는 사용자가 고른 경로 그대로라) */
  async targets(directory: string): Promise<DelegationTarget[]> {
    const all = await this.ctx.sessions.list()
    const viewed = new Map<string, string>()
    for (const [project, id] of Object.entries(await this.ctx.sessions.lastViewed())) {
      const real = await realDirectory(project)
      if (real) viewed.set(real, id)
    }
    const targets: DelegationTarget[] = []
    for (const project of await this.ctx.projects.list()) {
      const real = await realDirectory(project.path)
      if (!real || real === directory) continue
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
   *  것 그대로다 (ctx.chat 이 저장된 대화에서 읽는다). 던지는 글은 영어(모델이 읽는다) — 화면도 같은 문장을 그대로 보인다 */
  async send(input: { directory: string; from: { id: string; title: string }; targetId: string; message: string; count?: boolean }): Promise<DelegationSent> {
    const { directory, from, message } = input
    if (typeof message !== 'string' || !message.trim()) throw new Error('message is required.')
    if (message.length > MESSAGE_MAX) throw new Error(`message is too long (${message.length} characters, the limit is ${MESSAGE_MAX}).`)
    const target = (await this.targets(directory)).find((entry) => entry.id === input.targetId)
    if (!target) throw new Error('Unknown project. Use an id from list_projects.')
    if (target.problem) throw new Error(`Target project cannot be used (${target.problem}).`)
    const to = target.conversation
    if (!to.model || !this.ctx.providers.get(to.model.providerId)?.models.some((model) => model.id === to.model!.modelId)) {
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
}
