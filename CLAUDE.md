# CLAUDE.md — litecode

폐쇄망 환경에서 쓰는 **원클릭 code assistant**. `closed-code/desktop`(davis-code-desktop 을
복사해서 시작한 유산 구조)을 점진적으로 고치는 대신, 2026-09-29 에 **처음부터 새로 짓기로
결정**하고 만든 프로젝트다.

## 참고 코드

새 코드를 짤 때 아래 두 레포를 참고한다 — 베끼지 않고 패턴·실측만 가져온다.

| 레포 | 위치 | 뭘 참고하나 |
|---|---|---|
| `closed-code/desktop` | `/Users/a08368/vscodeProjects/closed-code/desktop` | 같은 opencode 를 다루던 기존 코드. 특히 `electron/opencode/*` 의 실측 주석(레거시/신규 세대 이벤트 차이, 세션 격리 함정, 하트비트 등)이 유용하다 — 우리가 새로 실측한 것과 대조해볼 것. 다만 `session/*` 의 kind/action 구조 자체는 참고하지 않는다(그게 새로 만든 이유다) |
| deepseek-harness (dsh) | `/Users/a08368/vscodeProjects/deepseek-harness` | Cordis 실사용 패턴(`docs/cordis-tutorial/`, `docs/cordis-primer.md`), LLM provider 추상화(`packages/llm/*` — custom baseURL·"hand-declared gateway"), 화면 조각(`packages/client/ui-trajectory` 등). MIT 라이선스, dsh 전용이 아닌 Cordis 자체 생태계도 있음(`cordiverse/cordis`). **개발 프리뷰 단계라 코드를 그대로 베끼지 말고 아이디어만 가져온다** — README 가 "compatibility-breaking changes 있을 것"이라고 명시함. **화면 디자인은 dsh 를 많이 참조한다** (사용자 지시 2026-09-30 — 패키지 대응표는 `.claude/agents/litecode-dev.md`) |

## 왜 새로 만들었나

- `closed-code/desktop` 은 davis 런타임용으로 짜인 코드(kind/action 봉투, `session/*` 계층)를
  opencode 에 억지로 맞춰 쓰고 있었다 — 그 흔적이 "구조가 이상하다"는 감각의 실체였다.
  (`session/*` 를 opencode 네이티브로 전면 재작성하는 계획은 `closed-code` 레포의
  `_workspace/01_plan.md` 에 P0~P5 단계까지 다 세워뒀지만, **davis 유산 위에서 고치는 것
  자체를 그만두기로** 하면서 보류됐다.)
- 목표(폐쇄망 원클릭)에 필요한 것만 처음부터 짜는 게 유산을 벗겨내는 것보다 빠르고 깨끗하다고
  판단했다.

## 아키텍처

```
Electron 렌더러 (React)          Electron 메인 프로세스
  사이드바(프로젝트 전환·         ──IPC──▶  Cordis Context
  새 대화·세션 목록) + 채팅창                 ├─ ctx.providers  (모델 provider 설정)
                                              └─ ctx.llm        (opencode 를 감싼다)
                                                    │
                                                    ▼
                                              opencode (외부 프로세스, REST+SSE)
                                                    │
                                                    ▼
                                              사내 LLM 게이트웨이 (LiteLLM 등)
```

- **엔진은 opencode 를 그대로 쓴다.** 에이전트 루프(툴 실행·프롬프트 구성·컨텍스트 압축)를
  처음부터 다시 짜는 건 opencode/dsh 가 가장 공들인 부분이라 일이 제일 크다 — 지금 벗어나려는
  "너무 커진 일"을 새 이름으로 반복하는 셈이다.
- **다만 opencode 는 `ctx.llm` 서비스 뒤에 숨긴다.** 위층(화면·세션)은 이 키만 알고 opencode
  를 직접 모른다. 나중에 엔진을 바꿔도 이 서비스 경계만 교체하면 된다 — closed-code 의
  "부패방지 계층"과 같은 목적을, 이번엔 Cordis 서비스 경계로 더 깔끔하게 표현한다.
- **플러그인 뼈대는 [Cordis](https://github.com/cordiverse/cordis)** (deepseek-harness 가
  쓰는 것과 같은 프레임워크, dsh 전용이 아니라 독립 OSS 다). 서비스는 `ctx.<key>` 로 등록되고
  키로 찾아 쓴다. `inject` 로 의존성을 선언하면 그 서비스가 뜰 때까지 자동으로 기다린다 —
  순서를 사람이 직접 안 짜도 된다.

### 아키텍처 함정 (실측으로 잡은 것)

1. **`ctx.providers` 를 `ctx.plugin(ProviderRegistry)` 바로 다음 줄에서 쓰면 안 된다.**
   서비스는 비동기로 마운트된다. 반드시 `inject: ['providers']` 를 선언한 플러그인 안에서만
   접근한다 — 안 그러면 "cannot read properties of undefined" 로 조용히 죽는다
   (`electron/main.ts` 의 `bootstrap` 함수가 이 패턴이다).
2. **cordis 4.0.0-rc.10 + `moduleResolution: NodeNext`** 조합에서 tsc 가 `Context`/`Service`
   를 값으로 못 찾는다(런타임은 멀쩡함). `moduleResolution: bundler` 로 우회했다.
3. **Electron 의 preload 스크립트는 항상 `require()` 로 읽힌다** — ESM `import` 를 못 쓴다.
   `electron/preload.cts` 로 따로 둬서 TypeScript 가 CommonJS(`.cjs`)로 강제 컴파일하게
   했다. 같은 프로젝트 안에서 메인 프로세스는 ESM, preload 만 CJS 로 공존한다.

## opencode 프로토콜 (실측, 2026-09-29, opencode 1.x)

정본은 언제나 뜬 서버의 `/doc` (OpenAPI). 아래는 실제로 확인한 것만 적는다.

- opencode 는 **레거시 세대**(`message.part.*`, `/session/*`)와 **신규 세대**
  (`session.next.*`, `/api/session/*`) 이벤트를 **둘 다** 가진다. **litecode 는 신규
  세대만 쓴다** — 레거시를 쓰는 유일한 이유는 "신규 경로가 LLM 요청에 MCP 도구를 안 싣는다"는
  opencode 쪽 결함인데, opencode 를 감싸는 이 프로젝트 차원에서는 해당 안 된다.
- 흐름:
  1. `POST /api/session` — `{}` 로 보내면 opencode 자신의 기본 provider/model(예:
     `gateway-local/qwen3.8-27b`, `opencode.json` 설정)로 세션이 생긴다.
     **⚠️ 믿으면 안 된다 (실측 2026-09-30):** 격리 opencode 로 5회씩 재 보니 `opencode.json` 의 `model`
     을 무시하고 models.dev 카탈로그(`~/.cache/opencode/models.json`)의 외부 provider
     (`nano-gpt/openai/gpt-6.1-sol`)로 세션이 생기는 경우가 절반 이상이었다 — 프롬프트가 엉뚱한 곳으로
     나간다. `enabled_providers` 로도 안 막혔다. 그래서 **`ctx.llm` 은 `model: { providerID, id }` 를 항상
     명시한다** — litecode 의 provider id·모델 id 를 opencode 의 것으로 그대로 넘긴다(매핑 화면 전까지).
     `location: { directory }` 도 받는다 (프로젝트 전환에 쓸 자리).
  2. `GET /api/session/{id}/event` (SSE) 를 **프롬프트 보내기 전에 먼저 구독한다.** 순서가
     바뀌면 초반 이벤트를 놓친다.
  3. `POST /api/session/{id}/prompt` — 이 응답은 프롬프트가 **admit** 됐다는 확인일 뿐이다.
     실제 응답은 전부 SSE 로 온다 (동기 응답 아님).
- SSE 이벤트(`session.next.*`) 중 우리가 쓰는 것:
  - `session.next.text.ended` — `data.text` 에 **완성된** 텍스트 조각이 온다 (델타 아님)
  - `session.next.step.ended` — `data.finish !== 'tool-calls'` 면 턴이 끝난 것
  - `session.next.step.failed` — 실패로 턴이 끝난 것. `data.error.message` 에 사유
- **재구독하면 과거 이벤트가 seq 1 부터 재생된다** (실측 2026-09-30, opencode 1.18.18). 같은 세션에
  두 번째 프롬프트를 보내려고 다시 구독하면 첫 턴의 `text.ended`·`step.ended` 가 먼저 온다.
  `GET /api/session/{id}/event?after=<seq>` 로 자를 수 있고, 이벤트마다 `durable.seq`, 프롬프트 응답에
  `data.admittedSeq`(= 이번 턴 `prompt.admitted` 의 seq) 가 있다. `?after=N` 은 seq > N 만 주지만 구독 시점엔
  이번 턴 seq 를 모르므로, `ctx.llm` 은 구독을 먼저 걸고 **`admittedSeq` 이하 이벤트를 재생분으로 버린다**
  (대가: 매 턴 그 세션의 과거 이벤트를 다 받는다). 이벤트 없는 세션에 구독하면 첫 이벤트 전까지 응답 헤더도
  안 온다 — 구독 fetch 를 await 한 뒤 프롬프트를 보내면 교착한다.
- **모델 카탈로그는 지연 로드된다** (실측 2026-09-30). 새로 뜬 opencode 는 `GET /api/model`(·`/api/provider`)이
  처음 불릴 때 로드를 시작하고 첫 응답은 빈 목록이다. 로드 전에 온 프롬프트는 로그에만 `ModelUnavailableError`
  를 남기고 **SSE 로는 아무 신호 없이 버려진다** — 턴이 영원히 안 끝난다 (준비 없이 1/5 성공). 없는 providerID
  로도 `POST /api/session` 은 200 이다. 목록은 **세 단계로 채워진다**: 빈 목록(~0.3초) → models.dev 원본
  8306개(설정 미반영 — 우리 provider 없음, 외부 nano-gpt 등 포함, ~0.3~0.65초) → 설정 반영 36개(0.7~1.1초).
  결함 1 의 "외부 provider 로 샘" 도 이 가운데 단계와 같은 목록이다. 그래서 `ctx.llm` 은 새 세션을 만들기 전에
  **찾는 모델이 목록에 나올 때까지**(최대 10초) `/api/model` 을 묻는다 — "비어 있지 않음" 으로 판단하면 가운데
  단계에서 있는 모델을 없다고 거절한다.
- opencode 가 `<system-update>…</system-update>`(스킬 목록 등)를 user 메시지 문자열 뒤에 붙여 LLM 에 보낼 때가
  있다 — **카탈로그 로드가 끝나기 전에 첫 턴이 들어간 세션에서만** 관측됐다 (위 모델 확인이 이 경로를 막으므로
  `ctx.llm` 을 거치면 0/9).
- opencode 가 `listening` 을 찍고도 `/doc` 에 수십 초 응답하지 않을 때가 있다 (2회 관측, 원인 미확인).
- **세션을 특정 폴더에서 돌리기** (실측 2026-09-30): `POST /api/session` 본문에 `location: { directory: <절대 경로> }`.
  도구 cwd·시스템 프롬프트의 작업 디렉터리·`AGENTS.md`·`opencode.json` 이 전부 그 폴더(또는 상위 git 루트) 기준이 된다.
  **opencode 서버 하나로 여러 프로젝트를 돌린다** — 폴더가 다른 세션을 동시에 돌려도 섞이지 않았다(5/5). closed-code 가
  프로젝트마다 서버를 띄운 이유(서버 전체 `/event` 스트림의 세션 섞임)는 세션별 `/api/session/{id}/event` 를 쓰는
  우리에겐 해당 없다.
- **모델 카탈로그는 폴더별이다**: `GET /api/model?location[directory]=<dir>` (안 주면 서버 cwd 기준). 서버 cwd 의
  `opencode.json` provider 는 다른 폴더에서 안 보인다 — 모든 폴더에 필요한 provider 는 전역 설정에 둔다.
  **쿼리 이름을 틀려도(`?directory=`) 200 에 서버 cwd 카탈로그가 조용히 온다.**
- **없는 폴더로 세션을 만들면 200 이지만, 그 세션은 모든 요청이 500 이고 그 경로는 서버 재시작 전까지 계속 500 이다**
  (나중에 폴더를 만들어도, `/instance/dispose` 해도). 사용자의 opencode 를 오염시키므로 `ctx.llm` 이 세션 전에 폴더를
  확인한다. 상대 경로·`~`·빈 문자열은 생성부터 500.
- 폴더 값은 realpath·끝 슬래시 정규화 없이 **문자열 그대로** 저장되고 `GET /api/session?directory=` 는 정확 일치다 —
  litecode 는 `fs.realpath` 한 값 하나로 통일한다.
- **아직 안 한 것**: 우리 `ctx.providers` 의 provider/model id 를 opencode 자신의
  provider/model id 로 매핑하는 설정 화면. 지금은 두 id 가 같다고 보고 그대로 넘긴다 — 그래서 우리 provider
  id 가 opencode.json 에 없으면 "모델 없음" 오류가 난다.

## 지금 상태 (2026-09-30)

| 조각 | 상태 |
|---|---|
| `src/services/providers.ts` | provider 설정(이름·baseURL·프로토콜·모델 카탈로그) 관리 — dsh Settings > Models 화면과 같은 모양 |
| `src/services/llm.ts` | opencode 세션 생성(모델 명시 + 카탈로그에 모델이 뜰 때까지 대기) → SSE 구독 → 프롬프트 전송 → `admittedSeq` 이하 재생분을 버리고 텍스트 수집. 실물 테스트로 고정됨 (2026-09-30). **남은 공백:** SSE 타임아웃 없음(SSE 로 안 오는 실패는 영원히 대기), 전송 실패 시 unhandled rejection, 재시작 직후 이어가는 세션은 모델 확인 안 함 |
| `electron/` + `renderer/` | Electron 앱. 사이드바(프로젝트 전환·새 대화·세션 목록) + 채팅창. IPC 로 위 서비스에 연결됨 |
| 설정 화면 | 없음. provider 는 `electron/main.ts` 에 하드코딩된 더미 하나뿐 |
| 테스트 | vitest 단위(`tests/unit/`) + **실물**(`tests/live/` — 격리된 진짜 opencode + 가짜 LLM + 진짜 Electron 창을 playwright 로 조작). 실물 테스트가 착지 기준이다 |
| 세션 영속화 | 없음. 새로고침하면 대화 목록이 다 날아감 (React state 뿐) |
| 프로젝트 전환 | 시안대로 구현 (2026-09-30). 사이드바 전환 버튼 + 팝오버(검색·즐겨찾기·최근·폴더 열기), 목록에서 빼기(폴더는 안 지움), 이름 바꾸기(보이는 이름만), 잘린 경로·대화 제목은 마우스를 올리면 흘러가며 보이고 옆 카드에 전체 내용(dsh 방식), 앱을 켜면 마지막 프로젝트. 목록은 `ctx.projects`(userData `projects.json`). 대화는 프로젝트별로 메모리에만 — **대화 영속화는 아직 없다** |

## 실행

```bash
npm install
npm run dev        # vite 개발 서버 + electron 을 같이 띄운다
npm run typecheck
npm test           # 단위 테스트
npm run test:live  # 실물 테스트 — opencode 가 PATH 에 있어야 한다 (이 머신: ~/.bun/bin, 또는 OPENCODE_BIN)
npm run spike       # electron 없이 src/index.ts 만 돌려보는 최소 확인용
```

Electron 은 `33.4.11` 로 고정돼 있다 — 이 머신에서 최신 버전(`44.x`) 바이너리 다운로드가
막혀 있어서, `closed-code/desktop` 이 쓰는 버전과 맞춰 로컬 캐시를 재사용했다.

## 디자인 시안

승인된 화면 시안: https://claude.ai/artifact/H9ab8rS8Yn5GcA8YKyccL3
(사이드바 하나로 프로젝트 전환 + 대화 목록을 접는 구조 — 지금 `renderer/App.tsx` 는 이 중
"대화 목록" 부분만 구현했고, "프로젝트 전환" 팝오버는 아직 없다.)

## 하네스: litecode 개발

**목표:** opencode 실측 위에서 기능·수정을 착지시키되, 실물 테스트(진짜 opencode·Electron)가 초록일 때만 끝났다고 한다.

**트리거:** 기능 구현·버그 수정·안정화·참고 레포 이식 요청 시 `litecode-build` 스킬을 사용하라. 테스트만 돌리거나
쓸 때는 `live-test`, opencode 동작 확인은 `opencode-probe`, 경계면 검증은 `boundary-check`. 단순 질문은 직접 응답 가능.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-09-30 | 초기 구성 — 에이전트 3(opencode-prober·litecode-dev·boundary-qa) + 스킬 4 + vitest·playwright 실물 테스트 스택 | 전체 | 사용자 요청: 테스트 필수, 실물 테스트 포함 |
| 2026-09-30 | 첫 실행(llm.ts 결함 3건) 후 실측 반영 — 캐시 비격리의 대가 명시, 401 판독 행 추가 | skills/live-test, skills/opencode-probe | QA 지적(사용자 models.json 갱신), 외부 provider 유출 실측 |
| 2026-09-30 | 화면 디자인은 deepseek-harness `packages/client/ui-*` 를 주 참조처로 — 화면↔패키지 대응표, 시안과의 우선순위 | agents/litecode-dev, agents/boundary-qa, skills/litecode-build, skills/opencode-probe | 사용자 지시 |
| 2026-09-30 | "지우는 것도 자기가 만든 것만" 규칙 — 임시 폴더는 기록한 경로만 삭제 | agents/boundary-qa, agents/litecode-dev, skills/live-test | QA 가 추측으로 리더 데모의 임시 폴더를 지움 |
| 2026-09-30 | 한 라운드에는 사용자 요청만 — QA 참고는 따로 모아 보고 | skills/litecode-build | 사용자 "너무 오래 걸린다" |
