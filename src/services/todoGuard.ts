import { Context, Service } from 'cordis'
import './llm.ts' // 'llm/tool-started'·'llm/tool-done'·'llm/turn-*' 이벤트 선언과 ctx.llm
import { TodoSyncTracker } from './todoSync.ts'

// 할 일 동기화 재촉 (ctx.todoGuard, 이슈 #619 — #406 의 연장). TODO_SYNC_RULE(시스템 프롬프트) 을 작은 모델이 안 지키는
// 데(도구 134회 동안 0/7 실측) 앱이 세기해서 돕는다: 남은 항목이 있는 목록을 성공한 todowrite 로 쓴 뒤, 다른 도구를
// 실행에 넣은 8번째·32번째에 ctx.llm.remind 로 모델에게만 한 줄을 끼워 넣는다 (합성 글이라 말풍선·기록에 사람 말로
// 남지 않는다 — repeatGuard #284 와 같은 길·같은 모양). 모델이 재촉에 응하면(또 하나의 todowrite 성공) epoch 가
// 처음부터라 그 epoch 에는 두 번이 그 상한. todowrite 은 성공했을 때만 세는 쪽으로 본다 — 목록을 바꿈은 성공일 때고
// (틀린 인자의 running 은 error 가 되어 목록이 안 바뀐다), 시작 시점(running) 인자는 못 믿는다 (turnProgress 주석).
// 하위 작업(task·백그라운드)이 부른 도구는 안 센다 — 재촉은 부모 턴의 모델에게만 닿고 그 목록은 부모의 것이라.
// 이 묶음은 ctx.llm 을 모른다.

declare module 'cordis' {
  interface Context {
    todoGuard: TodoGuardService
  }
}

export class TodoGuardService extends Service {
  static readonly inject = ['llm']

  private readonly tracker = new TodoSyncTracker()

  constructor(ctx: Context) {
    super(ctx, 'todoGuard')
    ctx.on('llm/turn-started', ({ sessionId }) => this.tracker.reset(sessionId))
    ctx.on('llm/turn-ended', ({ sessionId }) => this.tracker.reset(sessionId))
    ctx.on('llm/tool-done', ({ sessionId, tool, input, child, error }) => {
      if (child || tool !== 'todowrite' || error !== undefined) return
      this.tracker.todoWritten(sessionId, input)
    })
    ctx.on('llm/tool-started', ({ sessionId, child }) => {
      if (child) return
      const text = this.tracker.toolStarted(sessionId)
      if (text) void this.ctx.llm.remind(sessionId, text) // 끼울 수 없으면(그 턴 막 끝남) 그 재촉은 버린다
    })
  }
}
