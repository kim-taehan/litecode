import { Context, Service } from 'cordis'
import './llm.ts' // 'llm/tool-started'·'llm/turn-*' 이벤트 선언과 ctx.llm
import { RepeatCounter, repeatReminder } from './repeatCounter.ts'

// 같은 도구 반복 알림 (ctx.repeatGuard, 이슈 #284 — 기능 묶음 repeatGuard). 작은 모델이 같은 도구를 같은 인자로 계속 부르는 루프를
// 부드럽게 끊는다: 막지 않고, 연속 3·5·8번째 호출이 실행에 들어간(running) 순간 모델에게 한 줄을 끼워 넣는다(ctx.llm.remind — 합성 글이라
// 말풍선·기록에 사람 말로 남지 않는다). 끝난(completed) 때 넣으면 엔진이 이미 다음 요청을 보낸 뒤라 한 스텝 늦고, 다음 스텝이 마지막 답이면
// 알림에 답하는 호출이 하나 더 생긴다(실측 5/5) — running 때 넣으면 그 도구 직후 요청에 실린다(10/10, docs/opencode-protocol.md). 대화(엔진 세션)마다 따로 세고, 새 턴이 시작되거나 끝나면 지운다. 하위 작업(task)이 부른 도구는 세지 않는다 —
// 알림이 부모 턴으로 가서 그 호출을 한 하위 에이전트가 못 읽는다. ctx.llm 은 이 기능을 모른다: 이 묶음을 내리면 알림만 사라진다.

declare module 'cordis' {
  interface Context {
    repeatGuard: RepeatGuardService
  }
}

export class RepeatGuardService extends Service {
  static readonly inject = ['llm']

  private readonly counter = new RepeatCounter()

  constructor(ctx: Context) {
    super(ctx, 'repeatGuard')
    ctx.on('llm/turn-started', ({ sessionId }) => this.counter.reset(sessionId))
    ctx.on('llm/turn-ended', ({ sessionId }) => this.counter.reset(sessionId))
    ctx.on('llm/tool-started', ({ sessionId, tool, input, child }) => {
      if (child) return
      const count = this.counter.observe(sessionId, tool, input)
      if (count === undefined) return
      void this.ctx.llm.remind(sessionId, repeatReminder(tool, count)) // 끼울 수 없으면(턴이 막 끝남) 그 알림은 버린다
    })
  }
}
