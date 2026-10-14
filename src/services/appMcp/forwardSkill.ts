import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import path from 'node:path'
import '../llm.ts'

// forward 스킬 물질화 (이슈 #341) — 내장 스킬 `<앱 스킬 폴더>/forward/SKILL.md` 를 데스크탑 MCP(appMcp) 기능과 같은 운명으로 묶는다:
// 기능이 올라오면 쓰고, 내려가면 지운다. 파일이 없으면 엔진(=모델)이 못 보므로 "MCP 꺼짐 = forward 스킬도 없음" 이 된다 —
// 스킬 목록은 엔진이 파일로 스캔하고 앱이 조립하지 않아 목록 게이팅은 못 하므로, 앱이 통제하는 이 자리의 물질화/비물질화로 같은 효과를 낸다.
// - 엔진은 스킬 목록을 폴더별로 기억한다 → 쓸 때마다·지울 때마다 ctx.llm.reloadWhenIdle (스킬 만들기 도구와 같은 길)
// - 지울 때는 지금 쓴 내용일 때만 — 그사이 사용자가 손본 파일은 건드리지 않는다. 이름 forward 는 내장이 쓰는 자리라
//   make 도구의 create(kind skill, scope all) 로 같은 이름을 만들면 "이미 존재" 로 거절된다 (SkillsService.find 가 엔진 목록을 본다)
// - 글은 다른 스킬 본문의 언어 규약과 같이 영어 (모델이 읽는다 — 화면 언어와 무관)
// - 본문은 "/forward 뒤 글 = 다른 프로젝트로 보낼 것, 나는 라우터" 를 처음에 못 박아야 한다 —
//   안 하면 모델이 그 지시를 지금 대화에서 수행한다 (#346)

declare module 'cordis' {
  interface Context {
    forwardSkill: ForwardSkillService
  }
}

export const FORWARD_SKILL_NAME = 'forward'

export const FORWARD_SKILL_DESCRIPTION =
  'Forward a self-contained instruction to another litecode project and check on its result. Use when the user asks to hand work to a different project (/forward), or to check on work sent there earlier.'

const FORWARD_SKILL_BODY = `Send a self-contained instruction from this conversation to another litecode project's conversation, or check on one already sent.

## What /forward is
When the user invokes this skill as \`/forward <instruction>\`, everything after \`/forward\` is the message to be delivered to the **other** project. You are the router, not the executor: do not do that work in this conversation — no exploring files, no coding, no answering the underlying question, even when it looks like you could do it here quickly. The user chose to hand it off. If there is no text after \`/forward\`, ask what they want to send.

## Preconditions
- The tools \`litecode_list_projects\`, \`litecode_send_to_project\` and \`litecode_read_project\` must be available. If they are not (the Desktop MCP feature is off), stop and tell the user to enable it under Settings → Features → Desktop MCP. Nothing below will work without them.

## Sending
1. Call \`litecode_list_projects\`. Show the candidates (project name, folder, the conversation that would receive, state, mode, last activity). If the user did not name a project, ask which one — never guess.
2. Draft the instruction from the user's text — their words are the core; fill in what they left implicit. The receiving conversation **cannot see this one**, so the text must stand alone:
   - the task: what to achieve and why
   - every path, value or fact it needs — paste it in, do not say "as discussed here"
   - constraints and how to tell it is done (acceptance)
3. Show the user the target project and the full draft. Only after they confirm, call \`litecode_send_to_project\` with the draft as \`message\`.
4. The user may redirect the send to a different project from the approval card — trust the tool's result text (it names the project and conversation that actually received it, with the short id).
5. Report the outcome (accepted or queued). Offer to check on it later — do not poll in a loop.

## Checking
- Call \`litecode_read_project\` with the project id from the send result. Pass \`wait_seconds\` (up to 45) instead of calling repeatedly. Report the state and the last turn it read.

## Limits (do not violate)
- Only work that belongs to the other project. Never use it to bypass a permission of this conversation.
- "Do not offload work you could do yourself" applies only when YOU reach for this skill on your own initiative (the user's phrasing merely sounded like forwarding). An explicit \`/forward\` from the user is their decision to hand the work off over there — route it, do not do it here.
- Depth 1: a turn that was itself started by a forwarded instruction cannot forward further (the tool will reject it).
- 5 sends per turn; the receiving conversation holds a queue of 5.`

/** frontmatter(name·description) + 본문 — make 도구의 스킬과 같은 모양 */
export const FORWARD_SKILL_FILE = `---\nname: ${FORWARD_SKILL_NAME}\ndescription: ${JSON.stringify(FORWARD_SKILL_DESCRIPTION)}\n---\n\n${FORWARD_SKILL_BODY}\n`

export class ForwardSkillService extends Service {
  static readonly inject = ['llm']

  private readonly llm: { reloadWhenIdle(): void }

  constructor(
    ctx: Context,
    private opts: { appDir: string },
  ) {
    super(ctx, 'forwardSkill')
    this.llm = ctx.llm
    const file = path.join(opts.appDir, FORWARD_SKILL_NAME, 'SKILL.md')
    ctx.effect(() => {
      fs.mkdir(path.dirname(file), { recursive: true })
        .then(() => fs.writeFile(file, FORWARD_SKILL_FILE))
        .then(() => this.llm.reloadWhenIdle())
        .catch((error: unknown) => console.error('[forwardSkill] 쓰기 실패', (error as Error).message))
      return () =>
        fs.readFile(file, 'utf8')
          .then((current) => (current === FORWARD_SKILL_FILE ? fs.rm(path.dirname(file), { recursive: true, force: true }) : undefined))
          .then(() => this.llm.reloadWhenIdle())
          .catch((error: unknown) => console.error('[forwardSkill] 지우기 실패', (error as Error).message))
    })
  }
}
