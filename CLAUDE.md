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
  를 직접 모른다. 나중에 엔진을 바꿔도 이 서비스 경계(`ctx.llm` + opencode 프로세스를 쥔 `ctx.engine`)만 교체하면 된다 — closed-code 의
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
  (`session.next.*`, `/api/session/*`) 이벤트를 **둘 다** 가진다. **litecode 는 채팅을 레거시 경로로 한다**
  (2026-10-02 결정·착지 #13·#20·#21, 실측 `_workspace/01w_legacy_migration.md`). 이유는 MCP·task 서브에이전트 — 신규 세대엔
  없다(1.18.34·dev 도 같음, upstream `v2` 브랜치에서 작업 중, 이슈 #45333). 아래 신규 세대 실측은 **이력과 L3(옛 기록 읽기)용**으로 남긴다.
  되돌리기는 git 태그 `pre-legacy`. 레거시 실측은 이 절 끝 "레거시 경로" 묶음에 있다.
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
- **opencode 에 설정 넘기기** (실측 2026-09-30, 1.18.18 — 근거 `_workspace/01_probe.md`, 2단계 설계의 전제):
  - 신규 세대가 읽는 설정은 **전역 폴더 하나**(`OPENCODE_CONFIG_DIR`, 없으면 `$XDG_CONFIG_HOME/opencode`) + 세션 폴더의
    opencode.json 뿐이다. `OPENCODE_CONFIG_CONTENT`·`OPENCODE_CONFIG` 로 넣은 provider 는 레거시 `GET /config` 에만 보이고 턴은
    `prompted` 에서 **조용히 멈춘다**. → 앱은 `OPENCODE_CONFIG_DIR=<userData>/opencode` 에 opencode.json 을 생성해 넘긴다
    (opencode 가 그 폴더에 npm 설치를 백그라운드로 한다 — **폐쇄망에서 실패하면 어떻게 되는지 미확인**)
  - ⚠️ **opencode 는 자기 env 를 프로젝트 플러그인(`.opencode/plugin/*.js`)·bash 도구에 넘긴다** — env 로 넘긴 키·서버 비밀번호가
    폴더 코드와 프롬프트 인젝션에 샌다 (QA 재현 2026-09-30, `--pure` 로 못 막음). **그래서 진짜 키는 opencode 에 주지 않고 메인 프로세스
    로컬 프록시가 붙인다** (opencode 엔 프록시 주소 + 랜덤 토큰만). **받아들인 잔여 위험:** 서버 비밀번호는 여전히 opencode env 에
    있어 폴더 코드가 토큰을 얻어 프록시를 **쓸** 수는 있다(키 값은 못 빼 감, 프록시는 저장된 주소로만). opencode 가 원래 그 폴더에서
    AI 에게 코드를 실행시키는 도구라 막을 수 없는 부분이다. 플러그인 로드는 /api/model 후 0.2~0.5초 비동기. 아래 env 방식은 "키를 넘기는 법" 실측으로만 남긴다
  - **키**는 provider 의 `"env": ["LITECODE_KEY_n"]` + 자식 프로세스 env 로만. `{env:X}`·`{file:…}` 는 치환 안 되고 **문자 그대로
    헤더에 실린다**. `PUT /auth/{id}` 키는 안 쓰인다
  - 레거시 `GET /provider`·`/config/providers` 는 풀린 키를 돌려준다 → 앱이 띄우는 opencode 에는 **항상
    `OPENCODE_SERVER_PASSWORD`** (Basic, 사용자명 `opencode`)
  - 설정 변경은 **재시작해야** 적용된다(dispose·PATCH 전부 안 먹음). 재시작 때 진행 중 턴은 끝 이벤트 없이 사라진다 —
    `ctx.llm` 이 스스로 "중단됨" 으로 끝내야 한다. 세션 기록은 남는다
  - **세션 폴더의 opencode.json 이 앱 provider 의 baseURL 까지 덮어 앱 키가 그리로 간다** (재현됨,
    `OPENCODE_DISABLE_PROJECT_CONFIG` 로 못 막음). `/api/model?location[directory]=` 의 `api.url` 로 덮였는지 보고 거부한다
  - 세션 저장소는 `OPENCODE_DB=<절대 경로>` 로 사용자 opencode 와 가른다. `XDG_CONFIG_HOME` 은 bash·git 이 물려받으므로 바꾸지 않는다
  - **폐쇄망** (실측 2026-09-30, `_workspace/01b_offline.md`): 대화는 네트워크 없이 된다 — `@ai-sdk/openai-compatible` 은 바이너리에
    내장. CONFIG_DIR npm 설치(`@opencode-ai/plugin`)는 **레거시 호출 때마다** 시도되고(01w §8 — 처음 적은 "`GET /config` 때만" 은 틀렸다)
    실패해도 턴은 된다. 설정 폴더에 표식 3개(빈 `node_modules/`·`package.json`·`package-lock.json`)를 두면 시도 0 → 앱이 앱 설정 폴더·
    `~/.config/opencode`·(있으면) `~/.opencode` 에 둔다(#12, 있는 파일은 안 덮음). models.dev 없이도 우리 provider 는 1초 안에 카탈로그에 뜬다 → `OPENCODE_DISABLE_MODELS_FETCH=1`.
    **grep·glob 도구는 첫 사용 때 github 에서 ripgrep 을 받으려 하고, 패킷을 버리는 망에선 ~300초 멈춘다** → ripgrep 을 동봉해
    opencode 자식 PATH 앞에 둔다(2b). 개발 머신에서 오프라인을 재현하려면 HOME 도 비워야 한다(`~/.npm` 캐시가 설치를 채워 준다)
  - 동봉: closed-code `scripts/fetch-opencode.mjs`(npm 레지스트리 플랫폼별 패키지, sha512) · `electron-builder.yml` extraResources ·
    `binary.ts` 거의 그대로. 버전은 **1.18.18 고정** (latest 는 1.18.33 — 올리기 전에 위 실측을 다시)
- **대화 중 모델 바꾸기** (실측 2026-10-01): `POST /api/session/{id}/model` body `{"model":{"providerID","id"}}` → 204. 다음 턴부터 새
  모델, 앞 맥락 유지(5/5). prompt 본문엔 model 을 못 싣는다(additionalProperties:false). **없는 모델로 바꿔도 204 이고 다음 턴이
  `prompted` 에서 조용히 멈춘다** → 바꾸기 전에 모델 확인을 먼저 통과시킨다. 진행 중 턴에 바꾸면 그 턴은 옛 모델로 끝난다
- **토큰·시간 통계** (실측 2026-10-01): 스텝마다 `session.next.step.ended.data.tokens {input, output, reasoning, cache:{read,write}}`
  (세션 합계는 opencode 가 안 준다 — 직접 합산). 모든 이벤트에 `data.timestamp`(ms). **`text.delta` 는 세션 SSE 에 안 온다** —
  첫 토큰 시각은 `text.started`. `step.started` 는 첫 바이트 뒤에 찍혀 TTFT 기준으로 못 쓴다(첫 스텝은 `prompted` 기준).
  usage 매핑: input = prompt_tokens − cached_tokens, cache.read = cached, output = completion − reasoning, cache.write 는 늘 0.
  비용은 가격을 줘도 0. custom 모델의 컨텍스트 한도는 0(모름) — opencode.json 모델에 `limit:{context}` 를 주면 반영된다.
  컨텍스트 구성(시스템·도구·메시지 크기)은 opencode 가 안 준다 — 추정만 가능
- **지운 대화가 DB 에 남는다** (실측 2026-10-01): 레거시 DELETE 뒤 본문은 WAL 에, 체크포인트 뒤엔 freelist 페이지에 남는다(macOS
  secure_delete=FAST). **checkpoint(TRUNCATE) → VACUUM → checkpoint** 까지 해야 0. opencode 가 떠 있는 동안 외부에서 해도 안전했다
  (동시 턴 중 10회, busy 0·손상 0). Electron 33 엔 node:sqlite 가 없어 **동봉 opencode 를 `BUN_BE_BUN=1` 로 띄워 bun:sqlite 를 쓴다**
  (문서화 안 된 동작 — 1.18.18 고정 전제). 잠금을 5초(opencode busy_timeout) 넘게 쥐면 그 사이 prompt 가 500 으로 실패한다
- **입력 트리거(@ · / · !)** (실측 2026-10-01, `_workspace/01d_triggers.md`): **`prompt.files` 는 쓰지 않는다** — openai-compatible 경로에선
  이미지 data: URI 만 되고 `.md`·`.txt`·`.ts` 를 붙이면 step.failed, **그 뒤 그 세션의 모든 턴이 같은 오류로 실패**(revert 로도 복구 안 됨).
  후보 목록은 신규 세대(`/api/fs/find`·`/api/fs/list`·`/api/command`)에 있지만 `/`·`!` 실행은 레거시뿐이고 기록이 갈라진다 → 앱이 풀어서
  `prompt.text` 로 보낸다. `prompt` 에 **`resume:false`** 를 주면 LLM 을 안 돌리고 입력만 저장(다음 턴 맥락에 실림). prompt 본문 `id`
  (`msg_…`)는 앱이 정할 수 있다(중복 409). 새 폴더의 첫 `/api/command` 는 빈 배열 — 0.1~0.3초 뒤 다시. 명령 파일 변경은 재시작해야 반영
- **`/message` 로 스텝 다시 그리기** (실측 2026-10-01, `_workspace/01e_trajectory.md`): assistant 메시지 하나 = 스텝 하나, `time.created` 는 step.started(= 응답이 오기 시작한 때) — 모델 대기는 직전 시각부터 잰다. 도구 파트 `{type:"tool", name, state:{status, input, content, structured, error?}, time:{created, ran, completed}}`, 실패는 `status:"error"` + `error.message` 뿐(코드 없음). 지시문(AGENTS.md)이 대화 중 바뀌면 `type:"system"` 메시지가 남고 그 턴 user 메시지 뒤에 `<system-update>…Instructions from: <경로>…` 로 LLM 에 실린다. 도구 목록 변경 이력은 없다
- **opencode pty** (실측 2026-10-01, 1.18.18): `POST /api/pty?location[directory]=<dir>` `{cwd, title}` → `{id, command:"/bin/zsh", args:["-l"], cwd, status, pid}` (args 는 주지 않는다 — 서버가 `-l` 을 붙인다). 웹소켓 `GET /api/pty/{id}/connect?location[directory]=<dir>&cursor=0` 에 **Basic Authorization 헤더 그대로**(없으면 401). 키 바이트를 그대로 보내고, 출력은 텍스트 프레임, 바이너리 프레임(`0x00{"cursor":N}`)은 제어라 버린다. `cursor=0` 이면 지금까지 출력을 재생. **다른 폴더로 붙으면 열리지도 닫히지도 않고 멈춘다**(기한 필요). 크기는 `PUT /api/pty/{id}` `{size:{rows,cols}}`. opencode 가 끝나면 셸도 끝난다. 네이티브 모듈 불필요 — 메인은 `ws`(Electron 33 의 Node 20 엔 전역 WebSocket 이 없다), 화면은 `@xterm/xterm`. 셸은 opencode env 를 물려받는다(서버 비밀번호 포함)
- **자동 압축** (실측 2026-10-02, `_workspace/01o_compaction.md`): 모델 `limit.context` 가 0/없으면 안 돈다 — 대화가 한도를 넘으면 `step.failed` 이고 그 대화는 이후 모든 턴이 실패한다.
  한도를 주면 매 스텝 `추정(요청 JSON 글자/4) > context − max(output, 20000)` **그리고** 직렬화 기록(도구 결과는 2000자로 셈)이 8000 토큰을 넘을 때 돈다 — 보고된 usage 와 무관.
  그래서 큰 도구 출력이 몇 번 오면 압축 전에 한도를 넘을 수 있고, context 가 ~24000 미만이면 첫 압축 뒤 다시 못 한다. SSE 는 `session.next.compaction.started`·`.ended`(data.text=요약)
  둘뿐이라 턴 끝 판정과 무관하고, 실패(요약 요청 오류)면 `ended` 없이 원래 요청이 나간다. 압축 뒤 앞 대화는 user 메시지 하나(`<conversation-checkpoint>`)로 바뀌고,
  `/message` 엔 `type:"compaction"` 이 끼며 원래 메시지는 남는다. `limit` 엔 **`output` 이 필수**다(빠지면 설정 파일 전체가 무시돼 provider 가 사라진다).
  화면(이슈 #5): 진행 줄 `compaction`(요약 중 → 구분선, ended 없이 step.* 면 지움), 한도 초과 오류는 "새 대화로" 안내(`contextOverflow.ts`), 설정의 컨텍스트 길이는 기본값 없음·24000 미만 경고, 통계 % 에 문턱 눈금
- **레거시 경로** (실측 2026-10-02, 1.18.18 — 근거 `_workspace/01w_legacy_migration.md`, `01x_auto_features.md`):
  - **흐름** (#13): 세션 `POST /session?directory=` `{model, title}`(제목을 주면 제목 LLM 호출이 없다) → 그 폴더 `GET /event?directory=` 를 먼저
    구독(`server.connected`) → `POST /session/{id}/prompt_async?directory=` `{messageID, model:{providerID,modelID}, agent, system, parts}` → 204.
    **모든 레거시 호출에 `?directory=`.** 끝 = **이 턴 user 메시지를 본 뒤의** `session.idle`(중지는 idle 이 두 번 와서 그 전 idle·`MessageAbortedError` 는 앞 턴 것).
    답 = `parentID` 가 내 messageID 인 assistant. messageID 는 opencode 형식(시간 오름차순)이어야 순서가 맞고, **같은 id 를 두 번 보내면 409 없이 앞 메시지에 합쳐진다.**
    모델은 sticky(마지막 user 의 모델), 에이전트는 아니다(빼면 build) → 매번 둘 다 싣는다. 재구독해도 과거 이벤트 재생은 없다. 모르는 agent 는 끝 신호가 없다
  - **차이**: 도구 인자 이름이 다르다(read·write 는 `filePath`). 계획 모드 턴의 user 글 뒤에 `<system-reminder>` 가 붙는다. build 의 시스템 프롬프트는 opencode 기본.
    `websearch` 는 레거시에 없다. 500 은 5번 재시도(~71초, `session.status {type:"retry", attempt, message, next}` → 진행 줄). `/event` heartbeat 10초 — 무바이트 30초면 끊긴 것.
    `noReply` 를 돌고 있는 턴에 넣으면 그 턴이 이어서 답한다(턴 중 막기 유지). prompt 의 `system` 은 user 메시지 `info.system` 에 남는다
  - **설정** (#12·#19): 레거시는 앱 CONFIG_DIR 외에 `~/.config/opencode`·`~/.opencode`·프로젝트 opencode.json·`.opencode/` 를 읽고 그 MCP 를 띄운다 →
    `OPENCODE_DISABLE_PROJECT_CONFIG=1`(프로젝트 막기, AGENTS.md(없으면 CLAUDE.md)는 `ctx.llm` 이 매 턴 `system` 으로 — `instructions.ts`). 개인 설정은 읽되(사용자 결정)
    앱 CONFIG_DIR 값이 이긴다 — `model`·`enabled_providers`(개인 설정이 앱 provider 를 꺼 **모든 턴이 Model not found** 였다)·`share:"disabled"`·`autoupdate`·`lsp`·`formatter` false.
    `instructions` 배열은 합쳐져 못 지운다(원격 URL 은 막힌 망에서 요청마다 5초). Claude Code 자료(`~/.claude/CLAUDE.md`·스킬·프로젝트 `.claude/skills`)는 `OPENCODE_DISABLE_CLAUDE_CODE`·
    `_EXTERNAL_SKILLS` 로 끔(켜는 스위치는 #7). 물려받은 `OPENCODE_*`·`OTEL_*`·`EXA/PARALLEL_API_KEY` 는 지운다(`OPENCODE_EXPERIMENTAL` 하나로 도구가 바뀐다).
    모델 없는 세션은 내장 무료 `opencode` provider(opencode.ai/zen)로 갔다 — `model` 로 막음. 지킴이 `egress-guard.live`(바깥 요청 0)
  - **웹 도구** (#14): 끄려면 전역 `permission` deny **와** 에이전트마다 맨 뒤 deny — 하나만이면 litecode-ask(`webfetch:ask`)·litecode-full(`"*":"allow"`)에서 되살아난다.
    레거시 `task` 하위 에이전트는 상위 모드 deny 를 안 물려받는다(전역 deny 로 막힘)
  - **자동 요약** (#20·#27): 문턱 = context − (min(limit.output, 32000) || 32000)(`compaction.reserved` 안 쓰임). **limit.output 은 모든 요청(요약 포함)의 `max_tokens` 로도 실린다**
    — 0/없으면 32000, 32000 초과는 잘림. 앱은 모델의 "최대 출력"(비우면 컨텍스트의 1/4, 최대 32000 — `shared/outputLimit.ts`)을 넣어 문턱이 컨텍스트의 75% 가 되게 한다
    (24000·출력 0 은 한 턴에 요약 19번, 4000 은 1번). 최대 출력 ≥ 컨텍스트는 저장 거부, 설정 경고는 문턱 16000 미만, `ctx.llm` 의 한 턴 3번 상한은 안전망.
    게이트웨이가 큰 max_tokens 를 거절하는지는 미측정. 보고 토큰이 문턱을 넘은 스텝 뒤, 그리고 게이트웨이 한도 초과(`ContextOverflowError`) 뒤에(한도를 비워도) 돈다.
    순서: 요약 user(compaction 파트) → 요약 답(summary:true) → 이음 user(합성 "Continue…" 또는 앞 user 복사본) → `session.compacted` → 그 답 → idle. 요약도 넘치면 이음 없이 idle.
    `ctx.llm` 은 턴 안의 요약·이음 user 를 그 턴 것으로 보고 이음의 답을 그 턴 답으로 쓴다
  - **diff** (#20): `apply_patch` 는 모델 id 에 `gpt-` 가 있을 때만 있고 그때는 edit·write 가 없다. edit `metadata.filediff{file(절대), patch}`, write `metadata{filepath, exists}`,
    apply_patch `metadata.files[]{filePath, type, patch}`. git 이 아닌 폴더의 worktree 는 `/` — 경로는 세션 폴더 기준으로 앱이 계산
  - **하위 작업(task)** (#31, 실측 2026-10-02 `_workspace/probe-31/`): 한 메시지의 task 여럿은 동시에 돈다. 자식 세션은 `session.created{info.parentID}`, 부모 task 파트
    `state.metadata.sessionId` 로 이어진다. 자식 이벤트·승인 요청(sessionID = 자식)은 같은 `/event` 로 오고, 부모 턴 끝은 부모 idle 만 본다. **자식은 부모 모드 권한을 안 물려받는다** —
    매번 묻기에서 general 이 묻지 않고 bash 를 실행했고 레거시 explore 엔 bash 가 있다 → 매번 묻기는 `general-ask`(묻는 하위 에이전트)만, 계획은 `task: deny`, `general-ask` 는 다른 모드에서 deny
    (`hidden` 으로는 목록에서 안 빠진다). 부모 abort 는 자식까지 멈춘다(task 오류 "Task cancelled"). 재시작하면 task·자식 도구가 running 으로 남는다. 자식 토큰은 부모 합계에 안 넣는다(dsh)
  - **옛 대화 이어 쓰기** (#21): 신규 세대 기록과 레거시 기록은 같은 세션 id 여도 서로 안 보인다. 다시 열 때 신규 기록(`/api/session/{id}/message`, 읽기 전용)을 앞에 붙이고,
    레거시 기록이 없고 신규 기록이 있는 세션의 첫 레거시 입력 직전에 옛 user·답 글을 `prompt_async {noReply, parts:[{synthetic:true, text:"<previous-conversation>…"}]}` 로 한 번
    (id 는 이번 입력 바로 앞, 뒤에서 12,000자). "한 번" 은 DB 의 레거시 기록 유무로 판단(`limit=1`). 추론 과정 탭엔 옛 기록이 없다. `src/services/migrate.ts`
- **아직 안 한 것**: 우리 `ctx.providers` 의 provider/model id 를 opencode 자신의
  provider/model id 로 매핑하는 설정 화면. 지금은 두 id 가 같다고 보고 그대로 넘긴다 — 그래서 우리 provider
  id 가 opencode.json 에 없으면 "모델 없음" 오류가 난다.

## 지금 상태 (2026-09-30)

| 조각 | 상태 |
|---|---|
| `src/services/providers.ts` | provider 설정(이름·baseURL·프로토콜·모델 카탈로그) 관리 — dsh Settings > Models 화면과 같은 모양 |
| `src/services/engine.ts` | **`ctx.engine` — 앱이 opencode 서버 하나를 직접 띄운다** (2a, 2026-09-30). `OPENCODE_CONFIG_DIR`(키 없는 opencode.json 생성)·`OPENCODE_DB`·실행마다 랜덤 비밀번호·`OPENCODE_DISABLE_MODELS_FETCH=1`. **진짜 키는 opencode 에 없다** — `keyProxy.ts`(127.0.0.1, 실행마다 랜덤 토큰)가 붙여 저장된 baseURL 로 스트리밍 전달. 키에 헤더 불가 문자가 있으면 저장 거부. provider 저장·삭제 → 재시작. 앱 종료 시 끄고, 이전 실행이 남긴 것은 PID 기록(명령줄+시작 시각 일치)으로 거둔다. 사용자 :4096 에 붙는 길(`OPENCODE_URL`)은 없어졌다 |
| `src/services/llm.ts` | **레거시 경로** (2026-10-02, #13·#20·#21). Basic 인증, 폴더별 `/event` 구독 → `prompt_async`(messageID·model·agent·AGENTS.md system) → 이 턴 user 뒤의 `session.idle` 로 끝. 진행 줄(`turnProgress.ts` — 글·생각·도구·요약·재시도), 통계(`turnUsage.ts` — step-finish), diff(`toolDiffs.ts`), 옛 신규 세대 대화 이어 쓰기(`migrate.ts`). 자동 요약 한 턴 3번 상한, heartbeat 무바이트 30초 → "중단됨". 재시작·크래시로 끊긴 턴은 "중단됨". **매 턴 `api.url` 대조** — provider 주소가 바뀌었으면 거부 (키 유출 방지) |
| `electron/` + `renderer/` | Electron 앱. 사이드바(프로젝트 전환·새 대화·세션 목록) + 채팅창. IPC 로 위 서비스에 연결됨 |
| 패키징 (2b) | electron-builder. `scripts/fetch-opencode.mjs` 가 opencode 1.18.18(npm 레지스트리, sha512)·ripgrep 15.1.0(sha256)을 `build/vendor/` 에 받고(레포 제외), `extraResources` 로 `Resources/opencode`·`Resources/rg` 에 싣는다. 앱은 `OPENCODE_BIN` > 동봉 > PATH 순으로 찾고, 동봉 rg 폴더를 opencode PATH 맨 앞에 둔다(폐쇄망 grep 300초 멈춤 방지). mac 서명은 키체인의 개발용 자체 서명 인증서 `litecode-dev` 가 있으면 그것(없으면 ad-hoc) — 같은 인증서라 다시 빌드해도 macOS 개인정보 허락(문서 폴더 등)이 유지된다. **공증 없음, 다른 Mac 에서 내려받은 zip 의 격리(quarantine) 동작은 미검증**. vite `base: './'` (설치본 file:// 에서 assets 경로) |
| 설정 화면 | 사이드바 하단 ⚙ 설정 → 모달의 모델 페이지 (dsh `ui-settings-models` 참조, 2026-09-30). provider 추가·편집·삭제, 모델 목록·가져오기. 정본은 `ctx.providers`(userData `providers.json`, 키는 `safeStorage` 암호화로 `provider-keys.json`, 렌더러는 설정 여부만). **저장 키는 저장된 Base URL 로만 나간다** — 주소를 바꾸면 키 재입력. 설정한 provider 로 실제 대화된다(ctx.engine 이 opencode 에 넘김, 2a). 바이너리 동봉·패키징은 2b |
| 테스트 | vitest 단위(`tests/unit/`) + **실물**(`tests/live/` — 격리된 진짜 opencode + 가짜 LLM + 진짜 Electron 창을 playwright 로 조작). 실물 테스트가 착지 기준이다 |
| 세션 영속화 | `ctx.sessions` (2026-10-01). 내용 정본은 opencode DB, 앱은 목록 정보만(userData `sessions.json` — 제목·마지막 활동·모델·통계). 프로젝트당 50개(넘치면 오래된 것 자동 삭제)·하나씩 수동 삭제(두 번 눌러 확인). 삭제 뒤·opencode 기동 전에 DB 정리(`BUN_BE_BUN` + checkpoint→VACUUM). 폴더 없는 프로젝트 대화는 "폴더가 없습니다"(삭제만, opencode 요청 0). 끊긴 턴은 "중단됨". `/message` 는 100개씩 끝까지(한도 200) |
| 답 마크다운 | `renderer/Markdown.tsx` (2026-10-01). mdast + GFM → React 요소(`dangerouslySetInnerHTML` 없음, 원문 HTML 은 글자로), 한글 굵게 보정(`cjkStrong.ts`), 코드 블록 언어 머리 + 복사, 링크는 메인이 http(s) 만 OS 브라우저로(`shell:open-external`), 이미지는 alt 만(원격 요청 0), 창 이동·새 창 차단. 문법 색 없음 |
| Trajectory 탭 | `ctx.trajectory`(`src/services/trajectory.ts`, 2026-10-01)가 `ctx.llm.readMessages` 의 `/message` 를 중립 레코드(user·assistant 스텝·tool·context)로 바꾼다. 화면 `renderer/Trajectory.tsx`: Chat/Trajectory 탭, 3레인 시간축(Input·Model·Tools, Duration = 같은 너비/실제 시간 — 쉰 구간 압축), Turns·Calls 접기, 단어 AND 검색. CONTEXT 줄은 지시문 변경만. 턴이 끝나면 다시 읽는다(실시간 아님) |
| 채팅 답 모양·진행 표시 | dsh 방식 (2026-10-02). 답은 말풍선 없이 열 전체(`.chat-column` = clamp(680, 64%, 920), 입력 카드 = 열 + 32), 턴 머리 "완료/실패/중단됨 · N초"(펼치면 생각·도구·지시문 줄), 진행 중엔 줄이 실시간으로 쌓이고 진행 줄 초가 오른다(`chat:progress` — 턴 끝 판정은 세션 SSE, 조각은 턴마다 전역 `/api/event`), 파일 칩·코드 블록 줄바꿈/복사 아이콘·미니맵·내 말 시각/복사. `ctx.llm` 이 Cordis 이벤트 `llm/turn-started`·`llm/turn-ended`(outcome done/failed/interrupted, 받아들여진 턴만 정확히 한 번) |
| `!명령` | 대화 카드 (2026-10-02, closed-code 방식). 메인 `ctx.shell` 이 `$SHELL -lc` 로 프로젝트 폴더에서 실행(100KB·60초·■ 중단), 맥락 밖. 카드의 "AI 에게 보내기" = `ctx.llm.addContext`(resume:false, **턴 중엔 막음** — 턴 중 resume:false 는 끼어든다, 01h). 카드는 `sessions.json` 에 남는다. 터미널 칸은 ⌘↓/⌘↑ 로만 |
| 설정 > 일반 | `ctx.settings`(userData `settings.json`, 2026-10-02) — 언어(ko/en, 기본 en — 사전 `shared/i18n/{ko,en}.ts`, 화면 `useT()`, 메인 `tr()`), 테마 Light/Dark/System(`nativeTheme.themeSource` → CSS `prefers-color-scheme`, 첫 창 backgroundColor), 대화 글자 크기 12~17(`--chat-font-size`), 코딩 뷰(Trajectory 탭 숨김), 알림 스위치, 설정 파일 열기. 모달 틀은 dsh 치수. 실물 테스트는 `LITECODE_TEST_LANGUAGE=ko` 로 한국어 고정, 테마 테스트는 `page.emulateMedia({ colorScheme: null })`(Playwright 는 light 를 흉내 낸다) |
| 알림 | `ctx.notifications`(2026-10-02) — `llm/turn-*`·`llm/attention*` 을 받아 창이 없거나 포커스가 없으면 PC 알림(대화마다 최신 하나, 제목 + "프로젝트 · 상태"), 앞이면 토스트·대화 행/프로젝트 점, 보고 있는 대화면 없음. 중단은 앱 안만. 클릭 → reveal + pendingOpen → 화면이 `openProject` 로 연다. dock 배지. `requestSingleInstanceLock` 은 서비스보다 먼저(engine 이 이전 실행 opencode 를 거두므로), macOS `activate` 는 창 생성. 테스트는 기록 host(`__litecodeNotifyTest`) |
| 승인·질문 카드 + 모드 | 라운드 A (2026-10-02). 입력창 왼쪽 모드 칩 계획/기본/매번 묻기/전체 권한(`shared/modes.ts`, opencode 에이전트 plan 덮어쓰기·build·litecode-ask·litecode-full — 계획은 edit·bash·webfetch deny 로 도구가 실제로 빠지고 `.opencode/plans` 도 막힘), Shift+Tab 은 계획→기본→매번 묻기(전체 권한은 메뉴 + 확인), 턴 중 잠금, 계획 턴 끝 "이 계획대로 실행", 전환 구분선, 새 대화 기본 모드(설정 > 일반). 권한·질문 대기는 전역 `/api/event` + 정본 GET 조회 → 턴 안 카드(허용 한 번/거절, 보기 + 자유 입력), 거절의 tool.failed 종료를 턴 끝으로. `llm/attention`·`llm/attention-resolved` 이벤트 → 알림 "답 필요" |
| 입력 트리거 | `ctx.triggers` 등록소 + `src/triggers/{at,slash,bang}.ts` 플러그인(effect 등록, 2026-10-01). `@` 는 경로 텍스트만, `/` 는 앱이 template 을 풀어 보내고 prompt `id`(`msg_litecode_…`)로 `ctx.sessions.labels` 에 친 글을 적어 다시 열어도 `/hi world` 로 보인다, 모르는 `/xxx` 는 막는다, `!` 는 `ctx.terminals`(프로젝트별 opencode pty, 화면 xterm)에서 돌고 대화 맥락에 안 들어간다 |
| 프로젝트 전환 | 시안대로 구현 (2026-09-30). 사이드바 전환 버튼 + 팝오버(검색·즐겨찾기·최근·폴더 열기), 목록에서 빼기(폴더는 안 지움), 이름 바꾸기(보이는 이름만), 잘린 경로·대화 제목은 마우스를 올리면 흘러가며 보이고 옆 카드에 전체 내용(dsh 방식), 앱을 켜면 마지막 프로젝트. 목록은 `ctx.projects`(userData `projects.json`). 대화는 프로젝트별로 메모리에만 — **대화 영속화는 아직 없다** |

## 실행

```bash
npm install
npm run dev        # vite 개발 서버 + electron 을 같이 띄운다
npm run typecheck
npm test           # 단위 테스트
npm run test:live  # 실물 테스트 — opencode 가 PATH 에 있어야 한다 (이 머신: ~/.bun/bin, 또는 OPENCODE_BIN)
npm run dist:mac   # 설치본(mac arm64·x64 zip) — opencode 1.18.18·ripgrep 을 받아(체크섬 대조) Resources 에 싣는다. 결과는 release/
npm run dist:win   # Windows 설치본 (이 머신에서 빌드는 되지만 실행은 미검증)
npm run test:dist  # 설치본 스모크 — 빈 PATH·격리 HOME 으로 .app 을 띄워 동봉 opencode·rg 로 대화·grep 확인. 빌드는 안 한다(먼저 dist:mac)
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
| 2026-09-30 | QA 는 `차단` 재현 스크립트를 `_workspace/qa-repro/` 에 남긴다 | agents/boundary-qa | 프로브를 지워 구현자가 재현 못 함 |
| 2026-09-30 | 테스트 창을 화면에 띄우지 않는다 (`LITECODE_TEST_HIDDEN=1`) — 에이전트·스크립트도 따른다 | skills/live-test | 사용자 "테스트 중 다른 일을 못 하겠다" |
| 2026-10-01 | 엔진 경계 = `ctx.llm` + `ctx.engine` (문서 정정), bootstrap 의 IPC·종료를 Cordis effect·fiber dispose 로 | agents/litecode-dev, electron/main.ts | 코디스 사용 검토 |
| 2026-10-01 | 병렬 라운드 규칙 — 동시 2개·worktree·기능별 컴포넌트/실물 테스트 파일·실물 테스트 잠금·리더가 합침 | skills/litecode-build | 사용자 "병렬 개발은 안 되나" |
| 2026-10-02 | 돌고 있는 라운드에 범위를 얹지 않는다(다음 라운드로), 개발 중엔 자기 실물 파일만·전체는 착지 직전 한 번 | skills/litecode-build | 사용자 "왜 이리 오래 걸리지" |
| 2026-10-02 | GitHub 흐름 — 라운드마다 이슈 → 브랜치 → PR → main 머지(머지는 사용자 확인). 원격 kim-taehan/litecode | skills/litecode-build | 사용자 지시 |
| 2026-10-02 | main 머지는 리더가 직접 검증(typecheck·단위·실물 전체 초록)한 뒤 묻지 않고 한다 | skills/litecode-build | 사용자 "머지까지 알아서 해" |
| 2026-10-02 | 채팅을 opencode 레거시 경로로 — "신규 세대만 쓴다" 원칙 폐기, 프로토콜 절에 레거시 묶음 | CLAUDE.md | 사용자 결정 (MCP·task) |
| 2026-10-02 | 디자인 이야기는 전부 HTML 시안(Artifact 캔버스)으로 — 구현자에겐 "시안: <링크>" | skills/litecode-build, agents/litecode-dev | 사용자 "모든 디자인은 html 시안으로 말한다" |
| 2026-10-02 | 실물 테스트 전체는 리더만 머지 전에 — 구현자는 자기 실물 파일만 | skills/litecode-build, agents/litecode-dev | 사용자 "실물 테스트는 니가 하는걸로 하자" (에이전트 50분대, 전체를 두 번 돌림) |
