import { Context, Service } from 'cordis'
import fs from 'node:fs/promises'
import path from 'node:path'
import './llm.ts'

// 디자인 스킬 물질화 (이슈 #422, forward 스킬 #341 의 틀) — 내장 스킬 `<앱 스킬 폴더>/design/SKILL.md` 를 라이트코드 디자인
// 기능과 같은 운명으로 묶는다: 기능이 올라오면 쓰고, 내려가면 지운다. 파일이 없으면 엔진(=모델)이 못 보므로
// "디자인 꺼짐 = /design 도 없음" 이 된다. 스킬 목록은 엔진이 파일로 스캔해 앱이 목록 게이팅을 못 하므로,
// 앱이 통제하는 이 자리의 물질화/비물질화로 같은 효과를 낸다.
// - 엔진은 스킬 목록을 폴더별로 기억한다 → 쓸 때마다·지울 때마다 ctx.llm.reloadWhenIdle (forwardSkill 과 같은 길)
// - 지울 때는 지금 쓴 내용일 때만 — 그사이 사용자가 손본 파일은 건드리지 않는다. 이름 design 은 내장이 쓰는 자리라
//   make 도구의 create(kind skill, scope all) 로 같은 이름을 만들면 "이미 존재" 로 거절된다
// - 글은 다른 스킬 본문의 언어 규약과 같이 영어 (모델이 읽는다 — 화면 언어와 무관)
// - 본문은 "/design 뒤 글 = 시안 지시, 같은 화면은 같은 파일을 고친다" 를 못 박아야 한다 —
//   안 하면 모델이 매번 새 파일을 만들거나 대화 안에서만 시안을 써 준다

declare module 'cordis' {
  interface Context {
    designSkill: DesignSkillService
  }
}

export const DESIGN_SKILL_NAME = 'design'

export const DESIGN_SKILL_DESCRIPTION =
  'Create a screen mockup (시안) as one self-contained HTML file and open it in the app right panel for live review. Use when the user asks for a design or mockup of a screen or page (/design).'

const DESIGN_SKILL_BODY = `Create a screen mockup (시안) as a single self-contained HTML file and put it in the app's right panel, where it re-renders by itself whenever the file changes — that is the whole point of this skill.

## What /design is
When the user invokes this skill as \`/design <screen>\`, everything after \`/design\` is the screen or area to mock up (a login screen, a settings page, a specific view of the project). If nothing follows \`/design\`, ask which screen to mock up. The user may also ask for a mockup in plain words; the same rules apply.

## Creating the mockup
1. If the real screen exists in this project (the user pointed at it, or an obviously same-named page is close), read it first — the mockup should look like that screen, refined. Otherwise stand on the user's text alone.
2. Write ONE standalone HTML file (name it \`mock-<screen>.html\`, e.g. \`mock-login.html\`) near where the real screen lives, or in the project root for a brand-new design. The file must be:
   - fully self-contained: all CSS and JS inline, with NO external fonts, CDNs, images or fetch — this environment is offline
   - real content for that screen (labels, fields, states), not placeholder lorem
   - under 1 MB of a single document — the panel renders the file whole, so do not split it across files
3. Open it in the panel: call \`litecode_open\` with the file if the Desktop MCP tools are available. If the tool is unavailable or refuses, the file chip in your reply is the way in — name the file plainly instead. Do not ask the user to open it.

## Iterating (this is the point)
The panel watches the open mockup file: every edit to it re-renders the preview by itself, without anyone opening or reloading anything. So when the user asks for a change ("make the button blue", "move the title up", "라벨을 아이디로"), edit the SAME file and reply in one short line — do not recreate the mockup, do not rename or move it, do not tell the user to refresh.
If the user wants a different screen, create the other file (mock-<other>.html) and open it; earlier mockups stay where they are.

## Limits (do not violate)
- A mockup is a design proposal, not production code: do not wire it to the app's framework, routing or data, and do not touch the real screen unless the user asks to apply the design to it.
- One file per screen, self-contained, offline-safe.`

/** frontmatter(name·description) + 본문 — forward 스킬과 같은 모양 */
export const DESIGN_SKILL_FILE = `---\nname: ${DESIGN_SKILL_NAME}\ndescription: ${JSON.stringify(DESIGN_SKILL_DESCRIPTION)}\n---\n\n${DESIGN_SKILL_BODY}\n`

export class DesignSkillService extends Service {
  static readonly inject = ['llm']

  private readonly llm: { reloadWhenIdle(): void }

  constructor(
    ctx: Context,
    private opts: { appDir: string },
  ) {
    super(ctx, 'designSkill')
    this.llm = ctx.llm
    const file = path.join(opts.appDir, DESIGN_SKILL_NAME, 'SKILL.md')
    ctx.effect(() => {
      fs.mkdir(path.dirname(file), { recursive: true })
        .then(() => fs.writeFile(file, DESIGN_SKILL_FILE))
        .then(() => this.llm.reloadWhenIdle())
        .catch((error: unknown) => console.error('[designSkill] 쓰기 실패', (error as Error).message))
      return () =>
        fs.readFile(file, 'utf8')
          .then((current) => (current === DESIGN_SKILL_FILE ? fs.rm(path.dirname(file), { recursive: true, force: true }) : undefined))
          .then(() => this.llm.reloadWhenIdle())
          .catch((error: unknown) => console.error('[designSkill] 지우기 실패', (error as Error).message))
    })
  }
}
