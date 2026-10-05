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
4. **서비스 생성자가 던지면 그 서비스는 영영 안 뜨고, 그것을 inject 한 bootstrap 이 말없이 기다린다**
   (실측 2026-10-05: 맨 위가 배열이 아닌 `providers.json`). 생성자에서 읽는 파일은
   `readJsonFileSync(file, shape)` 로 — 모양이 다르면 옮기고 기본값.

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
  - 신규 세대가 읽는 설정은 **전역 폴더 하나**(`OPENCODE_CONFIG_DIR`, 없으면 `$XDG_CONFIG_HOME/opencode`) + 세션 폴더**와 그 상위 폴더들**(프로젝트 최상위까지 — 아래 ⚠️ #101)의
    opencode.json(c)·`.opencode/` 뿐이다. `OPENCODE_CONFIG_CONTENT`·`OPENCODE_CONFIG` 로 넣은 provider 는 레거시 `GET /config` 에만 보이고 턴은
    `prompted` 에서 **조용히 멈춘다**. → 앱은 `OPENCODE_CONFIG_DIR=<userData>/opencode` 에 opencode.json 을 생성해 넘긴다
    (opencode 가 그 폴더에 npm 설치를 백그라운드로 한다 — **폐쇄망에서 실패하면 어떻게 되는지 미확인**)
  - ⚠️ **opencode 는 자기 env 를 프로젝트 플러그인(`.opencode/plugin/*.js`)·bash 도구에 넘긴다** — env 로 넘긴 키·서버 비밀번호가
    폴더 코드와 프롬프트 인젝션에 샌다 (QA 재현 2026-09-30, `--pure` 로 못 막음). **그래서 진짜 키는 opencode 에 주지 않고 메인 프로세스
    로컬 프록시가 붙인다** (opencode 엔 프록시 주소 + 랜덤 토큰만). **받아들인 잔여 위험:** 서버 비밀번호는 여전히 opencode env 에
    있어 폴더 코드가 토큰을 얻어 프록시를 **쓸** 수는 있다(키 값은 못 빼 감, 프록시는 저장된 주소로만). opencode 가 원래 그 폴더에서
    AI 에게 코드를 실행시키는 도구라 막을 수 없는 부분이다. 플러그인 로드는 /api/model 후 0.2~0.5초 비동기. 아래 env 방식은 "키를 넘기는 법" 실측으로만 남긴다
  - ⚠️ **프로젝트 폴더의 플러그인 파일은 엔진 설정으로 못 막는다** (실측 2026-10-05, `_workspace/01ah_plugin_block.md`, #101): 신규 세대 런타임이 `--pure`·`OPENCODE_DISABLE_PROJECT_CONFIG` 와
    무관하게(후보 21개 + 기준, 66/66) 세션 폴더에서 **프로젝트 최상위까지(git 아니면 `/` 까지, 빈 `.git/` 은 git 으로 안 친다)** 올라가며 `.opencode/{plugin,plugins}/*.{ts,js}`(숨김·심볼릭 링크·
    대소문자 무시)와 `opencode.json(c)` 의 `plugin`·`plugins` 항목(아무 경로, npm 이름이면 레지스트리 요청)을 엔진 프로세스 안에서 import 한다 — 앱 CONFIG_DIR 의 `plugin/` 도. 시점은 그 폴더의
    **첫 `/api/*` 호출과 첫 레거시 턴**(엔진 실행당 각 한 번, 그때 폴더를 다시 훑는다), 계획 모드·승인과 무관. 그래서 **`ctx.llm` 이 폴더를 엔진에 넘기는 문은 `engineFolder` 하나**이고, 거기서 매번
    (캐시 없음, ~1ms) `findEnginePlugins`(`src/services/enginePlugins.ts` — **`/` 까지** + CONFIG_DIR, 엔진보다 넓게)로 보고 걸리면 엔진에 요청하지 않고 걸린 경로와 함께 거절한다. `ctx.engine` 은
    기동 때 CONFIG_DIR 의 `plugin/`·`plugins/` 를 지운다. 대가: `.opencode/plugin` 을 가진 저장소와, 상위 폴더(예: `~/.opencode/plugin`, `~/opencode.json` 의 plugin)에 플러그인이 있는 사용자의 모든
    프로젝트는 못 연다("신뢰하고 열기" 는 사용자 결정 대기). 남는 틈: 검사와 엔진의 glob 사이에 파일을 만드는 경쟁. `ctx.llm` 에 폴더를 받는 메서드를 더하면 이 문을 지나게 한다. 버전을 올리면
    `probe-01ah/e1·e3·e7` 을 다시
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
    `OPENCODE_DISABLE_PROJECT_CONFIG=1`(**레거시가** 프로젝트 설정을 안 읽게 — 신규 세대 런타임은 이 플래그를 안 본다, "opencode 에 설정 넘기기" 의 ⚠️ #101. AGENTS.md(없으면 CLAUDE.md)는 `ctx.llm` 이 매 턴 `system` 으로 — `instructions.ts`). 개인 설정은 읽되(사용자 결정)
    앱 CONFIG_DIR 값이 이긴다 — `model`·`enabled_providers`(개인 설정이 앱 provider 를 꺼 **모든 턴이 Model not found** 였다)·`share:"disabled"`·`autoupdate`·`lsp`·`formatter` false.
    `instructions` 배열은 합쳐져 못 지운다(원격 URL 은 막힌 망에서 요청마다 5초). Claude Code 자료(`~/.claude/CLAUDE.md`·스킬·프로젝트 `.claude/skills`)는 `OPENCODE_DISABLE_CLAUDE_CODE`·
    `_EXTERNAL_SKILLS` 로 끔(켜는 스위치는 #7). 물려받은 `OPENCODE_*`·`OTEL_*`·`EXA/PARALLEL_API_KEY` 는 지운다(`OPENCODE_EXPERIMENTAL` 하나로 도구가 바뀐다).
    모델 없는 세션은 내장 무료 `opencode` provider(opencode.ai/zen)로 갔다 — `model` 로 막음. 지킴이 `egress-guard.live`(바깥 요청 0 — 단 프로젝트 `opencode.json` 의 npm `plugin` 항목은 레지스트리 요청을 낸다, #101 의 검사로 막는다)
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
  - **스킬** (#7, `_workspace/01r_skills.md`): 레거시는 앱 CONFIG_DIR/skills 를 읽어 시스템 프롬프트 끝 `<available_skills>` 에 싣는다(목록·본문은 폴더별 캐시 — 재시작해야 바뀜),
    목록은 `GET /skill?directory=`. `OPENCODE_DISABLE_PROJECT_CONFIG` 가 프로젝트 `.opencode/skills` 도 끄므로 `skills.paths` 로 되살린다(세션 폴더 기준). Claude Code 스킬
    (`~/.claude/skills`·`.claude/skills`)은 같은 `skills.paths` 로 — 스위치 기본 꺼짐. 내장 customize-opencode 는 `permission.skill` deny 를 전역 **과** 에이전트마다 맨 뒤에.
    `skill:"deny"` 면 도구·목록이 통째로 빠진다(기능 끔)
  - **MCP** (#28, `_workspace/01u_mcp.md`): `GET /mcp?directory=` 상태, `POST /mcp?directory=` `{name, config}` 로 **그 폴더 인스턴스에만** 붙인다(파일에 안 쓰고 비밀은 opencode 메모리에만,
    연결까지 기다림), `POST /mcp/{name}/disconnect`. 엔진을 다시 띄우면 사라져 `ctx.mcp` 가 매 턴(`llm/before-turn`) 다시 붙인다. 도구·권한 이름은 `<서버>_<도구>` — 와일드카드 `*_*`
    로 계획 deny·매번 묻기 ask(하위 에이전트 general-ask 도). `*_*` 는 밑줄 있는 내장 권한(external_directory·doom_loop·plan_enter·plan_exit)에도 걸려 기본값을 다시 적는다.
    로컬 서버 자식엔 opencode env 가 통째로 가므로 비밀 이름을 빈 값으로 덮는다. 원격은 `oauth:false`
  - **할 일 목록(todowrite)** (#83, `_workspace/01ae_todo.md`): 인자 `{todos:[{content, status, priority}]}` — id 없음, status(pending·in_progress·completed·cancelled)·priority 는
    검사 안 되는 문자열. **호출마다 목록 전체를 보내고 통째로 교체된다.** 끝난 파트의 `state.metadata.todos` 가 그 시점 목록, 같은 내용이 `todo.updated {sessionID, todos}` 로 오고
    `GET /session/{id}/todo?directory=` 가 맨 배열로 준다(재시작·자동 요약 뒤에도 남는다). 틀린 인자는 `running`(input 실림) 뒤 `error` 이고 목록은 안 바뀐다 → 화면은 `completed` 파트만 본다.
    네 모드 모두 도구가 있고 묻지 않는다, 하위 에이전트엔 없다. `todoread` 없음 — 자동 요약 뒤엔 모델이 목록을 모를 수 있다. 턴이 끝나도 `in_progress` 는 그대로 남는다
- **아직 안 한 것**: 우리 `ctx.providers` 의 provider/model id 를 opencode 자신의
  provider/model id 로 매핑하는 설정 화면. 지금은 두 id 가 같다고 보고 그대로 넘긴다 — 그래서 우리 provider
  id 가 opencode.json 에 없으면 "모델 없음" 오류가 난다.

## 지금 상태 (2026-09-30)

| 조각 | 상태 |
|---|---|
| `src/services/providers.ts` | provider 설정(이름·baseURL·프로토콜·모델 카탈로그) 관리 — dsh Settings > Models 화면과 같은 모양 |
| `src/services/engine.ts` | **`ctx.engine` — 앱이 opencode 서버 하나를 직접 띄운다** (2a, 2026-09-30). `OPENCODE_CONFIG_DIR`(키 없는 opencode.json 생성)·`OPENCODE_DB`·실행마다 랜덤 비밀번호·`OPENCODE_DISABLE_MODELS_FETCH=1`. **진짜 키는 opencode 에 없다** — `keyProxy.ts`(127.0.0.1, 실행마다 랜덤 토큰)가 붙여 저장된 baseURL 로 스트리밍 전달. 키에 헤더 불가 문자가 있으면 저장 거부. 프록시 변수(HTTP_PROXY·http_proxy)가 있으면 opencode 는 루프백 요청도 프록시로 보내므로 자식 env 의 `NO_PROXY`·`no_proxy` 에 루프백을 덧붙인다(#75, 실측 2026-10-05). Finder 로 띄운 앱의 PATH 는 짧아(`/usr/bin:/bin:…`) 엔진을 띄울 때 로그인 셸의 PATH 를 한 번 읽어 앞에 합친다(`loginPath.ts`, #84 — 로컬 MCP 의 npx·bash 도구의 node; 설치본에서의 효과는 미확인). provider 저장·삭제 → 재시작. 앱 종료 시 끄고, 이전 실행이 남긴 것은 PID 기록(명령줄+시작 시각 일치)으로 거둔다. 사용자 :4096 에 붙는 길(`OPENCODE_URL`)은 없어졌다 |
| `src/services/llm.ts` | **레거시 경로** (2026-10-02, #13·#20·#21). Basic 인증, 폴더별 `/event` 구독 → `prompt_async`(messageID·model·agent·AGENTS.md system) → 이 턴 user 뒤의 `session.idle` 로 끝. 진행 줄(`turnProgress.ts` — 글·생각·도구·요약·재시도), 통계(`turnUsage.ts` — step-finish), diff(`toolDiffs.ts`), 옛 신규 세대 대화 이어 쓰기(`migrate.ts`). 자동 요약 한 턴 3번 상한, heartbeat 무바이트 30초 → "중단됨". 재시작·크래시로 끊긴 턴은 "중단됨". **매 턴 `api.url` 대조** — provider 주소가 바뀌었으면 거부 (키 유출 방지) |
| `electron/` + `renderer/` | Electron 앱. 사이드바(프로젝트 전환·새 대화·세션 목록) + 채팅창. IPC 로 위 서비스에 연결됨 |
| 패키징 (2b) | electron-builder. `scripts/fetch-opencode.mjs` 가 opencode 1.18.18(npm 레지스트리, sha512)·ripgrep 15.1.0(sha256)을 `build/vendor/` 에 받고(레포 제외), `extraResources` 로 `Resources/opencode`·`Resources/rg` 에 싣는다. 앱은 `OPENCODE_BIN` > 동봉 > PATH 순으로 찾고, 동봉 rg 폴더를 opencode PATH 맨 앞에 둔다(폐쇄망 grep 300초 멈춤 방지). mac 서명은 키체인의 개발용 자체 서명 인증서 `litecode-dev` 가 있으면 그것(없으면 ad-hoc) — 같은 인증서라 다시 빌드해도 macOS 개인정보 허락(문서 폴더 등)이 유지된다. **공증 없음, 다른 Mac 에서 내려받은 zip 의 격리(quarantine) 동작은 미검증**. vite `base: './'` (설치본 file:// 에서 assets 경로) |
| 설정 화면 | 사이드바 하단 ⚙ 설정 → 모달의 모델 페이지 (dsh `ui-settings-models` 참조, 2026-09-30). provider 추가·편집·삭제, 모델 목록·가져오기. 정본은 `ctx.providers`(userData `providers.json`, 키는 `safeStorage` 암호화로 `provider-keys.json`, 렌더러는 설정 여부만). **저장 키는 저장된 Base URL 로만 나간다** — 주소를 바꾸면 키 재입력. 설정한 provider 로 실제 대화된다(ctx.engine 이 opencode 에 넘김, 2a). 바이너리 동봉·패키징은 2b |
| 테스트 | vitest 단위(`tests/unit/`) + **실물**(`tests/live/` — 격리된 진짜 opencode + 가짜 LLM + 진짜 Electron 창을 playwright 로 조작). **착지 기준은 typecheck + 단위**(2026-10-03 — 실물 테스트는 개발 과정에서 뺐다: 새로 쓰지도 머지 전에 돌리지도 않는다. 파일은 남아 있고 요청이 있을 때만 돌린다) |
| 세션 영속화 | `ctx.sessions` (2026-10-01). 내용 정본은 opencode DB, 앱은 목록 정보만(userData `sessions.json` — 제목·마지막 활동·모델·통계). 프로젝트당 50개(넘치면 오래된 것 자동 삭제)·하나씩 수동 삭제(두 번 눌러 확인). 삭제 뒤·opencode 기동 전에 DB 정리(`BUN_BE_BUN` + checkpoint→VACUUM). 폴더 없는 프로젝트 대화는 "폴더가 없습니다"(삭제만, opencode 요청 0). 끊긴 턴은 "중단됨". `/message` 는 100개씩 끝까지(한도 200) |
| 답 마크다운 | `renderer/Markdown.tsx` (2026-10-01). mdast + GFM → React 요소(`dangerouslySetInnerHTML` 없음, 원문 HTML 은 글자로), 한글 굵게 보정(`cjkStrong.ts`), 코드 블록 언어 머리 + 복사, 링크는 메인이 http(s) 만 OS 브라우저로(`shell:open-external`), 이미지는 alt 만(원격 요청 0), 창 이동·새 창 차단. 문법 색은 아래 줄 |
| 문법 색 | `renderer/highlight.ts` + `Highlighted.tsx` (2026-10-05, #81) — 답의 코드 블록·오른쪽 패널 파일 미리보기·diff 카드. highlight.js 11.11.1 + lowlight 3.3.0(정확히 고정), 문법 20개만 번들에(ts/tsx·js/jsx·json·html/xml·css·python·java·kotlin·go·rust·c·cpp·csharp·bash·yaml·toml(ini)·sql·markdown·diff·dockerfile) — wasm·eval·런타임 내려받기 없음, 번들 +95KB(gzip +30KB). shiki 는 같은 묶음에서 2.2MB·1,200줄에 0.7초라 안 썼다. 토큰은 React 요소(`hljs-*` 클래스), 색은 `highlight.css` 의 `--hl-*`(GitHub 팔레트, 시안 없이 고름). 모르는 언어·5,000줄/30만 자 초과·실패는 색 없이. 답이 오는 동안엔 200ms 간격으로만 다시 색칠. diff 는 옛 쪽·새 쪽을 따로 이어 색칠해 줄에 나눈다. 화면·설치본 미확인 |
| Trajectory 탭 | `ctx.trajectory`(`src/services/trajectory.ts`, 2026-10-01)가 `ctx.llm.readMessages` 의 `/message` 를 중립 레코드(user·assistant 스텝·tool·context)로 바꾼다. 화면 `renderer/Trajectory.tsx`: Chat/Trajectory 탭, 3레인 시간축(Input·Model·Tools, Duration = 같은 너비/실제 시간 — 쉰 구간 압축), Turns·Calls 접기, 단어 AND 검색. CONTEXT 줄은 지시문 변경만. 턴이 끝나면 다시 읽는다(실시간 아님) |
| 채팅 답 모양·진행 표시 | dsh 방식 (2026-10-02). 답은 말풍선 없이 열 전체(`.chat-column` = clamp(680, 64%, 920), 입력 카드 = 열 + 32), 턴 머리 "완료/실패/중단됨 · N초"(펼치면 생각·도구·지시문 줄), 진행 중엔 줄이 실시간으로 쌓이고 진행 줄 초가 오른다(`chat:progress` — 턴 끝 판정은 세션 SSE, 조각은 턴마다 전역 `/api/event`), 파일 칩·코드 블록 줄바꿈/복사 아이콘·미니맵·내 말 시각/복사. `ctx.llm` 이 Cordis 이벤트 `llm/turn-started`·`llm/turn-ended`(outcome done/failed/interrupted, 받아들여진 턴만 정확히 한 번) |
| `!명령` | 대화 카드 (2026-10-02, closed-code 방식). 메인 `ctx.shell` 이 `$SHELL -lc` 로 프로젝트 폴더에서 실행(100KB·60초·■ 중단), 맥락 밖. 카드의 "AI 에게 보내기" = `ctx.llm.addContext`(resume:false, **턴 중엔 막음** — 턴 중 resume:false 는 끼어든다, 01h). 카드는 `sessions.json` 에 남는다. 터미널 칸은 ⌘↓/⌘↑ 로만 |
| 설정 > 일반 | `ctx.settings`(userData `settings.json`, 2026-10-02) — 언어(ko/en, 기본 en — 사전 `shared/i18n/{ko,en}.ts`, 화면 `useT()`, 메인 `tr()`), 테마 Light/Dark/System(`nativeTheme.themeSource` → CSS `prefers-color-scheme`, 첫 창 backgroundColor), 대화 글자 크기 12~17(`--chat-font-size`), 코딩 뷰(Trajectory 탭 숨김), 알림 스위치, 설정 파일 열기. 모달 틀은 dsh 치수. 실물 테스트는 `LITECODE_TEST_LANGUAGE=ko` 로 한국어 고정, 테마 테스트는 `page.emulateMedia({ colorScheme: null })`(Playwright 는 light 를 흉내 낸다) |
| 알림 | `ctx.notifications`(2026-10-02) — `llm/turn-*`·`llm/attention*` 을 받아 창이 없거나 포커스가 없으면 PC 알림(대화마다 최신 하나, 제목 + "프로젝트 · 상태"), 앞이면 토스트·대화 행/프로젝트 점, 보고 있는 대화면 없음. 중단은 앱 안만. 클릭 → reveal + pendingOpen → 화면이 `openProject` 로 연다. dock 배지. `requestSingleInstanceLock` 은 서비스보다 먼저(engine 이 이전 실행 opencode 를 거두므로), macOS `activate` 는 창 생성. 테스트는 기록 host(`__litecodeNotifyTest`) |
| 승인·질문 카드 + 모드 | 라운드 A (2026-10-02). 입력창 왼쪽 모드 칩 계획/기본/매번 묻기/전체 권한(`shared/modes.ts`, opencode 에이전트 plan 덮어쓰기·build·litecode-ask·litecode-full — 계획은 edit·bash·webfetch deny 로 도구가 실제로 빠지고 `.opencode/plans` 도 막힘), Shift+Tab 은 계획→기본→매번 묻기(전체 권한은 메뉴 + 확인), 턴 중 잠금, 계획 턴 끝 "이 계획대로 실행", 전환 구분선, 새 대화 기본 모드(설정 > 일반). 권한·질문 대기는 전역 `/api/event` + 정본 GET 조회 → 턴 안 카드(허용 한 번/거절, 보기 + 자유 입력), 거절의 tool.failed 종료를 턴 끝으로. `llm/attention`·`llm/attention-resolved` 이벤트 → 알림 "답 필요". **권한 정본 목록은 못 읽을 수 있다**(#107, 실측 worktree `agent-a92e10a17a5d2775d/_workspace/01ai_permission_list.md`): 요청 metadata 에 빠진 선택 인자가 있으면(webfetch 의 timeout, glob·grep 의 path) `GET /permission` 이 400(`Expected JSON value, got undefined`) — 그 요청 하나가 그 폴더 목록 전체를 깨뜨리고(다른 대화의 bash 요청도 안 보인다), 멈춘 턴이 남긴 요청도 계속 깨뜨린다(엔진 재시작으로 풀리는지는 미확인). `permission.asked` 이벤트는 요청 전체를 싣고 오고 reply 는 정상이라, `ctx.llm` 이 이 턴의 이벤트로 본 요청을 기억해(풀리거나 답하면 지움) 목록에 없거나 못 읽은 요청을 그것으로 만든다. 목록을 읽었으면 목록이 정본, 못 읽으면 `[llm]` 경고(턴마다 한 번). 질문 목록은 같은 약점 없음. 실제 앱에서 매번 묻기 + 웹 가져오기의 카드 → 허용 → 완료 1회 확인 |
| 입력 트리거 | `ctx.triggers` 등록소 + `src/triggers/{at,slash,bang}.ts` 플러그인(effect 등록, 2026-10-01). `@` 는 경로 텍스트만, `/` 는 앱이 template 을 풀어 보내고 prompt `id`(`msg_litecode_…`)로 `ctx.sessions.labels` 에 친 글을 적어 다시 열어도 `/hi world` 로 보인다, 모르는 `/xxx` 는 막는다, `!` 는 `ctx.terminals`(프로젝트별 opencode pty, 화면 xterm)에서 돌고 대화 맥락에 안 들어간다 |
| 스킬 | `ctx.skills`(2026-10-03, #7) — 설정 > 스킬(지금 프로젝트의 스킬 목록·본문), `/` 후보, 대화의 "스킬 · 이름" 줄. 기능 `skills` 를 끄면 엔진에서 skill 도구째 빠진다. "Claude Code 스킬 함께 쓰기"는 기본 꺼짐 |
| MCP | `ctx.mcp`(2026-10-03, #28) — 설정 > MCP(원격·로컬 서버 추가·켜기/끄기·붙어 보기), 정의는 userData `mcp.json`, 비밀은 `mcp-secrets.json`(safeStorage). 프로젝트의 MCP 정의는 그 폴더를 열 때 자동으로 붙는다(사용자 결정). 대화엔 "MCP · 서버 · 도구" 줄 |
| 오른쪽 패널 | 2026-10-03 (#29, dsh 방식) — 파일 탭 + 폴더 탐색(`fileTree.ts`) + HTML 실행 미리보기(sandbox iframe `allow-scripts` 만, srcdoc + CSP, 창 이동 차단). 대화의 파일 칩을 누르면 여기서 열린다 |
| 도는 작업 목록 | 대화 머리 "작업 N" 버튼 (2026-10-03, #32, 시안 B·dsh `ui-jobs` 참조). 하위 작업이 있는 턴이 도는 동안만(N = 메인 1 + 도는 하위 작업), 펼치면 "진행 중 N" 아래 줄마다 경과·종류·설명 + 마지막 도구/생각·토큰, 줄을 누르면 최근 줄, "끝난 것 N" 접기, Esc·바깥 닫기. 데이터는 `chat:progress` 진행 줄 그대로(`renderer/jobsView.ts`). ■ 는 그 하위 작업만 멈춤 — `chat:stop-subtask` → `ctx.llm.stopSubtask`(자식 세션 `POST /session/{자식}/abort?directory=`, 실측 3/3: 부모 task 는 "Task cancelled" = 중단됨, 다른 자식과 부모 턴은 이어서 정상 종료). 메인 줄 토큰은 없음(진행 줄에 안 실림) |
| 기능 켜기/끄기 | `ctx.features`(#8) + 고정(2026-10-03, 사용자 결정 — `shared/features.ts` `FEATURE_FIXED`). **필수(늘 켜짐, 설정 > 기능에 카드 없음):** 입력 트리거 @ · / · !·!명령 실행·스킬·MCP. 저장된 값이 있어도 고정 값이 이긴다. **웹 가져오기**(`web`)는 2026-10-05 에 다시 고르는 기능으로(기본 꺼짐, 사용자 결정) — 켜면 엔진을 다시 띄워 `webfetch` 가 생긴다(가짜 LLM 으로 0 → 1 확인, 레거시엔 websearch 가 없다. 폐쇄망에선 닿는 주소만). 사용자가 고르는 것은 터미널 칸·추론 과정·다른 앱에서 열기·**데스크탑 MCP**(`appMcp`, #99 — 앱 내장 MCP 서버와 도구 묶음, 끄면 다음 턴부터 엔진에서 `litecode_*` 도구가 빠진다: 가짜 LLM 으로 7 → 0 확인)(기본 켜짐)·알림·모바일 연결(기본 꺼짐) |
| `+` 메뉴 · 스킬/MCP 팝업 | 입력 카드 `+` → 메뉴(스킬 개수 · MCP "연결 N · 실패 M") → 프로젝트 기준 팝업 둘 (2026-10-04, #43, 시안 `_workspace/mock-plus`). 설정의 스킬·MCP 메뉴는 없앴다. MCP 는 "이 프로젝트만"(앱이 userData `mcp-projects.json` 에 프로젝트 realpath 별로 저장한 서버 + 폴더의 `.mcp.json`·opencode.json 정의)과 "모든 프로젝트"(`mcp.json` + 개인 설정). **스위치는 그 프로젝트에서만**(`mcp-projects.json` 의 `enabled` 가 기본값을 덮는다 — 예전에 꺼 둔 앱 서버는 모든 프로젝트에서 꺼진 채). 개인 설정 서버는 끈 프로젝트에서 매 턴 disconnect, 켜면 connect(다시 붙는지는 미실측). 앱 서버 이름은 묶음이 달라도 저장 때 거절, 폴더 정의는 앱 서버와 이름이 같으면 안 붙인다. 프로젝트 전용 비밀은 `mcp-secrets.json` 의 `<경로>#<이름>`. 스킬 묶음은 파일 위치(프로젝트 폴더 아래 = 이 프로젝트만), 읽기 전용 + "폴더 열기"(없으면 만든다). 파일·이미지 첨부는 #44 |
| 모바일 앱 (`mobile/`) | 2026-10-04 (#42) — React Native + Expo SDK 57, Android 먼저(`com.litecode.mobile`). 자기 `package.json`(루트와 의존성 안 합침), Metro 가 `../shared` 를 본다. 루트 typecheck·`npm test`·electron-builder 는 `mobile/` 을 안 본다 — 확인은 `cd mobile && npx tsc --noEmit && npm test && npm run export:android`. **계약 `shared/remote.ts`**(/v1 REST + SSE, 설계 `_workspace/01t_mobile_arch.md`), 화면에 실리는 중립 타입 정의는 **`shared/contract.ts`**(서비스 파일은 re-export 만 — 여기에 Node·opencode 를 아는 코드를 넣지 않는다). 연결 코어 `mobile/src/core/`(순수 TS): `Transport`(지문 고정 네이티브 모듈이 끼워질 자리) → `RemoteClient` → 리듀서 `state.ts` → `Connection`. **데스크탑 쪽(`ctx.chat`·`ctx.remote`)은 아직 없다** — 앱은 `node mobile/dev/fake-desktop.mts`(개발용·평문 http·코드 `DEV0DEV0DEV0`, 에뮬레이터에선 `10.0.2.2:47600`)에 붙여 개발한다. RN 기본 fetch 는 응답 스트림이 없어 SSE 는 `expo/fetch` 로(기기 미검증). `gradlew assembleDebug` 는 없는 SDK 구성 요소를 `~/Library/Android/sdk` 에 자동 설치한다. **화면 껍데기(#47):** 시안 4장(`_workspace/mock-mobile` — 연결·목록·대화·설정)을 `mobile/src/app/screens` 에, 화면은 `AppSession`(`src/app/session.ts`)만 본다 — 지금 구현은 견본 `createDemoSession()`(계약의 스냅샷·이벤트를 진짜 리듀서에 흘린다), 진짜 연결은 `Connection` 을 같은 모양으로 감싸 그 자리에. 설치용 APK 는 `cd mobile && npm run apk` → `release/litecode-mobile.apk`(release variant·디버그 키 서명, JS 번들 포함, arm64-v8a, minSdk 24 — 기기 실행은 미검증) |
| 첨부 (`+` 메뉴) | 파일 추가·이미지 추가 (2026-10-04, #44, 실측 `_workspace/01y_attachments.md`). 화면은 경로만 들고 메인이 읽는다(`src/services/attachments.ts`) — 파일 고르기로 고른 경로만. **이미지**(png·jpeg, 매직 바이트)는 `ctx.llm.chat` 의 `images` → text 뒤 data: file 파트(`image_url` 로 나간다), 설정 > 모델의 모델별 "이미지 입력" 을 켠 모델만(`ctx.engine` 이 `modalities.input` 에 image 를 싣는다 — 없으면 opencode 가 이미지 대신 ERROR 글을 싣는다. 꺼진 모델은 메뉴에서 막고 메인도 거절). **글 파일은 file 파트로 안 보낸다** — 레거시도 `application/json`·`octet-stream` mime 은 그 세션의 모든 턴을 망가뜨린다(12/12, file 파트를 DELETE 하면 되살아남). 프로젝트 안은 본문 끝 `@상대경로`, 밖은 `이름:` + 코드 블록. `file://`·http·깨진 이미지·svg 는 끝 신호 없이 session.error 하나만 온다 → 앱이 읽어 data: 로. opencode 는 이미지를 긴 변 2000px·~5MB 로 줄여 DB 에 통째로 두고 매 턴 다시 보낸다. 친 글은 `labels`, 글 파일 칩은 `sessions.json` 의 `attachments[messageId]`, 이미지 칩은 엔진 기록의 file 파트(`url` 은 화면에 안 넘김). 상한 `shared/attachments.ts`(이미지 5장·20MB, 글 파일 5개·200KB — 실측 근거 없는 결정). gif·webp·pdf·미리보기 없음. 화면·게이트웨이 미확인. **붙여넣기·끌어다 놓기**(2026-10-05, #80) — 화면은 File 객체만 preload 에 넘기고 경로는 preload 가 `webUtils.getPathForFile` 로 얻는다(사용자가 실제로 놓거나 붙여넣은 파일만 경로가 나온다 — 화면이 경로 문자열을 보낼 채널은 없다). 종류는 메인이 파일을 보고 정하고(`droppedKind`) 고르기와 같은 검사·사유. 경로 없는 이미지(스크린숏)는 메인이 userData `pasted-images/` 에 임시 파일로 두고(`pastedImages.ts`) 보낸 뒤(`chat/attachments-read`)·칩 삭제·대화 삭제 때 지우며 앱 시작·종료 때 폴더를 비운다 — 지우는 것은 그 실행이 만든 경로뿐. 붙여넣기는 글과 서식(html·rtf)이 같이 있으면 글로 둔다(`renderer/dropPaste.ts` `pasteIntent`). 파일을 창 어디에 놓아도 기본 동작을 막는다(설치본은 file:// 출처라 `will-navigate` 가 못 거른다). 놓을 자리 표시는 시안 없이 dsh 를 따랐다. 실제 창·클립보드에서는 미확인. 고르기·놓기·붙여넣기의 조립과 붙여넣은 이미지 임시 파일은 `ctx.attachments`(`src/services/attachmentsService.ts`, inject `chat`, #97)가 쥔다 — 파일 고르기 대화상자는 host(`electron/attachmentsHost.ts`)로 받고, `main.ts` 의 `attachmentsBridge` 는 채널만 잇는다 |
| 앱 MCP 서버 | `ctx.appMcp`(`src/services/appMcp.ts`, 2026-10-04 #51, 설계·실측 `_workspace/01z_desktop_mcp.md`) — AI 가 앱 화면을 조작하는 내장 MCP 서버. 127.0.0.1·실행마다 Bearer 토큰·URL 경로의 프로젝트 키(폴더 realpath 와 1:1)·POST 만·본문 64KB. 붙이기는 `ctx.mcp.registerBuiltin` 으로 사용자 서버와 같은 길(매 턴 `llm/before-turn`, timeout 없이), 이름 `litecode` 는 예약(저장 거절·폴더 정의 shadowed). opencode 가 요구하는 것은 `initialize`·`tools/list`·`tools/call` + 알림 202 뿐(JSON 한 덩어리 응답 가능, 호출 끝마다 오는 `notifications/cancelled` 는 무시, 호출 요청에 **부른 세션 정보는 없다**). 도구는 `appMcp/tools/*` 가 effect 로 등록 — `open_file`(오른쪽 패널, 줄 이동 `renderer/lineJump.ts`)·`open_terminal`(채워만 둠, 개행·제어문자 거절, 터미널 기능을 끄면 목록에서 빠짐). 화면 도구는 화면이 `appMcp:view` 로 알린 프로젝트에만 닿는다(다른 프로젝트를 보고 있으면 그 사실을 결과 글로). 엔진 규칙: plan 은 `*_*` deny 뒤 `litecode_open_file` allow, litecode-ask 는 `*_*` ask 뒤 둘 다 allow. MCP 팝업엔 "내장" 줄. **세션 도구 넷**(#55, `appMcp/tools/sessions.ts`, 시안 `_workspace/mock-delegate`) — `list_sessions`·`read_session`(묻지 않음, `wait_seconds` 최대 45)·`send_to_session`·`start_session`(보낼 때마다 승인 카드 — 대상·그 모드·보낼 글 전문). 범위는 같은 프로젝트. 부른 대화는 `ctx.llm.callerOf` 가 그 폴더의 `running` 도구 파트(도구·인자 깊은 비교, `toolCalls.ts`)로 찾고, **사용자가 앱에서 허용한 callID 만** 실행한다(한 번 쓰면 소진, 같은 인자 호출이 둘이면 거절 — 엔진 API 로 스스로 허용한 호출은 거절). 승인에 `always` 를 보내지 않는다(그 폴더 모든 세션에서 더 안 묻게 된다). 깊이 1(지시를 받아 도는 턴은 다시 못 보냄)·턴당 5번·대기열 5개. 엔진 규칙: 보내기 둘은 전역 deny + build(권한만으로 정의)·full 에 개별 ask, 매번 묻기는 와일드카드 ask, general-ask 는 맨 뒤 deny, 계획엔 없음. 받는 글은 `<message-from-conversation>` 으로 감싸고 본문은 `labels`, 출처는 `sessions.json` 의 `origins`. 끝나도 보낸 대화 맥락에 넣지 않는다. **받을 대화는 사용자가 고른다**(#67, 시안 `mock-delegate/Pick.dc.html`) — 승인 카드에 같은 프로젝트의 대화 목록(자신·못 쓰는 대화 제외, 최근 활동 순, AI 가 고른 줄이 먼저 선택)과 "새 대화" 줄, 고른 대상(`AttentionTarget`)은 `replyAttention` → `ctx.chat.reply` → `ctx.llm.reply` 의 허용 기록에 적히고 엔진에는 `once` 만 간다. 도구는 그 대상으로 보내며 자격을 다시 보고, 대상이 바뀌면 결과 글이 실제 대상과 id 를 말한다(`The user chose a different conversation: "…" (id c-…)`), 화면의 진행 줄은 그 결과 글에서 실제 대상을 읽는다. 폰은 허용/거절만. 받는 대화는 자기 모드로, 보낸 대화를 멈춰도 계속 돈다. opencode 왕복·화면·실제 모델의 도구 사용은 미확인 |
| `src/services/chat.ts` | **`ctx.chat` — 대화별 턴 소유** (2026-10-04, #52, 설계 `_workspace/01z_desktop_mcp.md` §3-7 = 모바일 R0). 보내기(`send` → `sent`/`queued`)·대기열(`sendQueue.ts`, 출처(origin)가 같은 것끼리만 합침 — 지금은 `'user'` 뿐, 라운드 ③이 `'session:<id>'`)·턴 끝 처리(제목·저장·통계 합산 `shared/usage.ts`·다음 것 보내기)·중지(대기열 붙잡기)·승인 답 전달을 메인이 쥔다. 화면은 손님 — `chat:send` 는 바로 돌아오고 내 말·진행 줄·답·대기열은 이벤트(`chat:turn-started`·`progress`·`attention`·`turn-ended`·`queue`·`conversations-changed`, 모양은 `shared/chat.ts` = `shared/remote.ts` + 덧붙인 필드)로, 다시 뜬 화면은 `chat:snapshot` 으로 이어 그린다(`shared/chatReducer.ts`·`renderer/chatState.ts`). 목록 정보의 제목·시각·통계·엔진 세션은 `ctx.chat` 만 적고 화면은 고른 모델·모드만 `sessions:patch` 로. opencode 를 모른다. 도는 턴이 출처와 그 턴에서 보낸 지시 수를 쥔다(#55). 멈춘 턴은 **사람 글**(`user`·`device:…`)이 쌓여 있을 때만 대기열을 붙잡고, 한 사람이 되돌려도 다른 사람 글이 남아 있으면 계속 붙잡는다. 다른 대화의 지시(`session:…`)는 "빼기"(`chat:drop-queued`). 화면이 모르는 대화의 turn-started 는 화면이 목록에 넣는다. 남은 일: 모바일 리듀서와 합치기 |
| `src/services/remote.ts` | **`ctx.remote` — 모바일이 붙는 문** (2026-10-04, #56, 설계 `_workspace/01t_mobile_arch.md` R1). 대화는 `ctx.chat` 이 쥐고 이 서비스는 그 손님 하나를 내보낼 뿐이다(모바일은 데스크탑 기준 — 단독 세션 없음). 기능 `remote`(기본 꺼짐) + 설정 > 모바일의 스위치를 켜야 포트를 연다. **지금은 루프백 평문 http 만**(127.0.0.1:47600 — 에뮬레이터 `10.0.2.2`); 평문 리스너는 루프백이 아니면 안 열린다(`ENOTLOOPBACK`). TLS·지문·LAN 은 다음 라운드. 짝짓기 = 코드 12자(2분·1회용·5회 폐기) + 데스크탑 [허용](60초, 거절 403·시간 초과 408) → 256bit 토큰, 해시만 userData `remote-devices.json`. Bearer 인증, IP 당 실패 10회/분 → 5분 429, 해제 = 401 + `device.revoked`, `Origin` 있으면 403. 쓰기는 전부 `ctx.chat`(출처 `device:<id>`), 엔진을 모른다. full 모드 대화는 403. 폰의 새 대화는 첫 메시지 전까지 메모리 초안. SSE 는 seq 링(2000개·15분), 껐다 켜면 새 runId → reset. 확인은 `npm test` + `cd mobile && npm test`(`mobile/tests/desktop.test.ts` 가 폰 연결 코어를 진짜 서비스에 붙인다). 남은 틈: 폰이 만든 새 대화가 데스크탑 창에 바로 안 뜬다, 폰 쪽 확인 코드 계산 없음, 화면 미확인 |
| 사이드바 접힘·대화 이름 | 접으면 56px 아이콘 줄(`Rail` — 펼치기·새 대화·프로젝트 배지(전환 팝오버가 옆에 뜸)·진행 중인 대화 수(누르면 펼치고 진행 중 필터)·아래 설정)이 남는다 (2026-10-04, #60, 시안 `_workspace/mock-rail`, dsh ui-sidebar 의 레일 — dsh 의 Mac 데스크탑은 통째로 숨기지만 사용자가 레일을 골랐다). macOS 는 줄 맨 위 52px 가 창 버튼 자리(끌기 영역 `.rail__top`)이고 대화 머리 왼쪽 여백은 36px(70 − 56 + 22). 줄의 버튼은 어느 끌기 상자와도 겹치지 않게 놓았다 — **끌기 줄 위에 겹치는 버튼은 문서 순서상 끌기 줄 뒤에 있어야 눌린다**(예전 떠 있는 다시 열기 버튼이 이 결함으로 안 눌렸다, 단위·Playwright 로는 안 잡힌다). 실제 창에서의 눌림은 미확인. **대화 이름 바꾸기**(#63) — 사이드바 행 연필 → `sessions:rename` → `ctx.chat.rename` → `ctx.sessions.rename`(빈 이름 거절, 80자), 바꾼 대화는 `renamed` 표식이 붙어 통째 저장이 제목을 덮지 않고 `chat/conversations-changed` 로 다른 손님에 알린다 |
| 모바일 앱의 실제 연결 | 2026-10-04 (#62) — **앱은 데스크탑에 붙은 화면이다: 견본 없음, 짝이 없으면 연결 화면뿐**(사용자 "모바일은 데스크탑 기준 — 단독 세션 없음"). `DesktopLink`(`mobile/src/app/link.ts`: 불러오는 중 → 짝 없음 ⇄ 허용 대기 → 붙음)가 짝짓기·저장(`expo-secure-store`)·복원·해제를 쥐고, 화면은 `remoteSession.ts`(`Connection` 을 `AppSession` 으로)만 본다. 짝짓기 글자 규칙은 **`shared/remotePairing.ts`**(정규화·확인 코드·순수 TS sha256 — 데스크탑과 폰이 같은 함수, 기기 이름도 `pairDeviceName` 으로 맞춰야 확인 코드가 같다). **평문 http 는 루프백으로만** — 앱(`address.ts` `LOOPBACK_HOSTS`)과 APK 의 network security config(`plugins/withLoopbackCleartext.js`) 두 목록이 같아야 한다, LAN 은 이 목록을 넓히지 말고 TLS 라운드에서. SSE 는 `expo/fetch` 로 실시간이 된다(에뮬레이터 실측). 화면 변경은 에뮬레이터로 확인한다(`Keyboard.isVisible` 처럼 메서드를 떼어 넘기면 기기에서만 죽는다). 개발 서버 `node mobile/dev/fake-desktop.mts --port <n>` — 짝짓기는 터미널에 `allow`/`deny`(`--auto-allow` 로 생략), 코드 `DEV0-DEV0-DEV0`. 폰의 403(거절 vs 틀린 코드)은 본문 글로 갈린다 — `remote.ts` 의 `'denied on the desktop'` 을 바꾸면 `link.ts` `pairFailure` 도. 에뮬레이터에서 짝짓기·실시간 답·승인·끊김 복구·해제·재시작을 가짜 서버로 확인, **진짜 데스크탑 앱에 붙이는 것은 미확인** |
| 모바일 연결의 운반 | **`ctx.remote` 는 운반을 모른다** (2026-10-04, #68, 설계 `_workspace/01ab_mobile_bluetooth.md` ①). 요청은 `handle(RemoteRequest, peer, exchange)` → `RemoteReply \| 스트림`(`src/services/remote/carrier.ts`)으로만 받고, HTTP·블루투스는 그 밑의 **운반 플러그인**이다(`inject: ['remote']`, 자기 ctx 키 없음 — `ctx.remote.carrier(…)` 로 올리고 내린다, 연결이 켜져 있는 동안만 start). 지금 운반은 `remote/http.ts` 하나(리스너·`Origin` 거절·본문 상한). 인증 실패 제한의 열쇠는 운반이 준 peer. 느린 링크용 프레이밍은 `shared/remoteFraming.ts`(u16 길이 ‖ 종류 u8 ‖ id u16 ‖ 깃발 u8 ‖ 조각 ≤16KB, raw deflate — 데스크탑 `node:zlib`, 폰 `fflate`), 데스크탑 쪽 `remote/framed.ts`, 폰 쪽 `mobile/src/core/framed.ts`(`Transport` 구현). 이벤트 스트림은 통로가 밀릴 때만 같은 진행 줄을 최신 하나로 합친다(`remote/streamQueue.ts` — seq 는 건너뛰어도 거꾸로 가지 않는다, 합친 것은 맨 뒤로). 20KB/s 메모리 파이프에서 330KB 스냅샷 6.3초, 진행 200번짜리 턴 2.2MB → 링크 385KB(`mobile/tests/slowlink.test.ts`, 가짜 시계 — 실제 블루투스 수치 아님). 블루투스 자체(라이브러리·BLE)와 암호화 채널은 아직 없다 — 폰으로 하는 실험 E0·E1 뒤에 |
| 폰 알림 | 2026-10-05 (#71) — **공식 푸시(FCM/APNs) 없음**(폐쇄망·중계 서버 없음, 사용자 확인) — 폰이 연결로 받은 이벤트로 스스로 알린다. 규칙은 `mobile/src/app/alerts.ts`(순수): 답 필요·완료·실패, 중단·거절·보고 있는 대화 제외, 이벤트만 보고 스냅샷으로는 안 알린다(reset 뒤 옛 일이 다시 울리지 않게). 앞 = 화면 위 띠, 뒤 = `expo-notifications` 로컬 알림(대화마다 키 하나, 채널 attention·result, 누르면 그 대화 — 죽은 앱도). 이벤트는 `Connection.onEvent`(열지 않은 대화 포함, 재생분 제외). **연결 유지 = `mobile/modules/litecode-keepalive`**(자체 Expo 모듈): 포그라운드 서비스(타입 `remoteMessaging` — `dataSync` 는 Android 15 하루 6시간 제한) + 끝나지 않는 headless JS 작업, 기본 꺼짐. **연결 유지가 꺼져 있으면 앱이 뒤에 있는 동안 JS 가 이벤트를 처리하지 않는다** — 알림 0건, 다시 열 때 한 번에(에뮬레이터 실측, Android 15, 원인 미확인). `expo-notifications` 는 설정하지 않아도 FCM 라이브러리와 권한(`c2dm.RECEIVE` 등)을 APK 에 넣는다 — 보안 심사에 걸리면 `blockedPermissions` 나 자체 모듈로. 시험: 가짜 서버 `say <대화 id> <글>`, `adb shell cmd statusbar expand-notifications`. 실기기(Doze·제조사 최적화·배터리)·진짜 데스크탑 앱 연결은 미확인 |
| 메인 살림 | 2026-10-05 (#73, 참고 레포 검토) — **깨진 userData JSON 은 `<이름>.corrupt-<시각>` 으로 옮기고 빈 값으로**(`jsonFile.ts` — JSON 이 아니거나 맨 위 모양이 다를 때, 자동 삭제 없음). **로그** `userData/logs/main.log`(1MB × 3, `console.error/warn` + uncaughtException·unhandledRejection·render/child-process-gone, 비밀 가림) — 리스너를 걸어 Electron 기본 오류 대화상자는 안 뜬다. 렌더러가 죽으면 다시 불러온다(1분 3번까지). 부팅 15초 뒤 안 뜬 바탕 서비스 이름을 로그·대화상자로. 종료 정리 전체 기한 8초 + 끝내기 직전 opencode 자식 SIGKILL. 화면 권한 요청은 기본 거부 — 맨 위 프레임의 `clipboard-sanitized-write` 만(`electron/resilience.ts`, 설치 전 창에서 허용 확인). 창 자리는 `window.json`. 자식 출력은 스트림 디코더로 풀고 끝을 남긴다(`outputBuffer.ts` — `!명령` 은 앞·끝 50KB + 생략 줄). 키·비밀이 실린 fetch 는 `redirect:'manual'` + 3xx 거절. 이미지는 한 변 8192·6400만 픽셀까지. `cordis` 는 정확한 버전으로 고정. Cordis 가 잡은 오류·경고(서비스 생성자·플러그인·정리)는 logger exporter 로 `[cordis]` 줄이 되어 같은 로그에 남는다(#93). 설정 파일의 원소 모양이 틀려도(`[null]` 등) 서비스는 뜬다 — 틀린 원소만 버린다 |
| 화면 살림 | 2026-10-05 (#74) — 입력 초안(글·첨부 칩)은 대화 id 별(`renderer/drafts.ts`), 질문 카드 초안은 요청 id 별(`questionDrafts.ts`), 읽던 자리는 `대화:탭` 별(`scrollMemory.ts`) — 전부 메모리에만. 답 아래 복사 버튼, 빈 입력창 ↑↓ = 그 대화에 보낸 글(`inputHistory.ts`). HTTP 실패 문구는 `shared/httpError.ts` 한 곳(`문구 (원문)`) — **413 은 컨텍스트 초과보다 먼저 본다**(`request_too_large` 가 "새 대화로" 로 안내되지 않게). `aria-modal` 판은 `useFocusTrap`(사용자가 부르지 않은 판은 `steal:false`). 그리기 경계(`ErrorBoundary`)는 앱·대화 본문·설정 페이지·오른쪽 패널 넷. `AssistantTurn`·`UserMessage` 는 memo — 새 배열·함수를 props 로 넘기지 않는다(사이드바 행·`!` 카드는 아직 타자마다 다시 그린다). `!명령` 출력의 ANSI 는 표시와 보내기 본문에서 뗀다(`shared/ansi.ts`, 저장 원문은 그대로). 화면에서의 동작(스크롤 복원·포커스 순환·오류 화면)은 미확인 |
| 찾기 · 고정 | 2026-10-05 (#79, dsh ui-chat·ui-workspace 참조, 시안 없이). **대화 안 찾기** — ⌘F/Ctrl+F 로 대화 칸 오른쪽 위 찾기 줄(개수·이전·다음, Enter/Shift+Enter/Esc), 대화를 바꾸면 닫힌다. 화면이 직접 찾는다: `.bubble`·`.turn__work` 의 글자 노드를 문단별로 이어 찾아(`renderer/findView.ts`) CSS Custom Highlight 로 칠한다(`ChatFind.tsx` — DOM 을 안 고친다, 상한 2000). 접힌 작업 줄은 찾는 동안만 `hidden` 으로 숨긴 채 그려 두고(`useFindFold`) 일치가 그 안이면 펼친다 — 찾는 동안 모든 턴의 작업 줄이 DOM 에 있다. **대화 목록** — 제목 찾기 칸(대소문자 무시·낱말 AND, "진행 중" 필터와 함께, `sessionListView.ts`), 고정(`sessions:pin` → `ctx.chat.pin` → `ctx.sessions.pin`, `chat/conversations-changed`): 고정한 대화는 맨 위 묶음이고 **보관 50개에 세지 않으며 자동 삭제되지 않는다**(통째 저장이 고정을 안 덮는다). 모바일 목록엔 고정이 안 실린다. 화면 동작은 미확인 |
| 할 일 목록 | 2026-10-05 (#83, 실측 `_workspace/01ae_todo.md`, dsh `ui-conversation` TodoPanel 참조, 시안 없이) — AI 의 `todowrite` 를 그린다. 성공한 도구 줄에 `todos`(`shared/contract.ts` `TodoItem {text, status: pending·active·done·cancelled}`, 그 시점 목록 전체 — `turnProgress.ts` `partItem`)가 실려 실시간과 다시 연 대화가 같은 길. 대화 안은 "할 일 · 완료 n/m" 줄 + 체크리스트(`renderer/Todo.tsx` `TodoRow`), 입력 카드 위에 지금 목록 줄 `TodoDock`("할 일 n/m · 지금: ○○", 누르면 전체 — 남은 일이 없으면 숨김, 대기열 판이 있으면 그 위). 지금 목록 = 그 대화의 마지막 성공 줄(`renderer/todoView.ts` — 하위 작업 안은 안 봄), 취소는 전체 수에서 빼고, 턴이 끝난 뒤 active 로 남은 항목은 "멈춤". 읽은 범위(200개) 밖의 목록·`GET /session/{id}/todo`·"작업 N"·추론 과정 탭·모바일 화면은 안 함. 화면·실제 엔진 왕복 미확인 |
| 고친 파일 카드 | 2026-10-05 (#82, 실측 `_workspace/01ad_changed_files.md`, 시안 없이) — 끝난 턴(완료·실패·중단)의 답 아래 "AI 가 고친 파일 N · +a −d". 데이터는 **성공한 도구 줄의 diff(edit·write·apply_patch)를 턴 단위로 모은 것**(`renderer/changedFiles.ts`, 하위 작업 안 포함) — 엔진 `snapshot` 은 켜지 않았다(예전 사용자 결정 유지, 리더 판단). 그래서 명령(bash)으로 바꾼 파일은 빠지고, 여러 번 고친 파일의 줄 수는 합계(횟수 표시)이며, 카드 아래 문구가 그렇다고 말한다. 줄을 누르면 카드 안에 `DiffCard`, 옆 버튼은 오른쪽 패널, 8개 넘으면 "N개 더". 다시 연 대화도 같은 함수. 찾기(⌘F) 대상 아님. **snapshot 을 켜면** user 메시지 `info.summary.diffs`(= `GET /session/{id}/diff?directory=&messageID=<user id>`)가 턴 전→후 순 변경(bash·삭제·하위 작업 포함)을 주지만 턴마다 0.7~1초·큰 untracked 폴더 첫 턴 25초·저장소를 사용자 CLI 와 공유·git 필요·같은 폴더 동시 대화가 섞인다 — 바꿀 자리는 `changedFiles()` 하나. 화면 미확인 |
| 종료 확인 · 창 닫기 | `ctx.quit`(`src/services/quit.ts`, 2026-10-05 #92) — 끝내려 할 때(⌘Q·메뉴·트레이) 도는 턴(`ctx.chat.running()`)이나 붙어 있는 폰(`ctx.remote` 는 선택 의존 — `ctx.get`)이 있으면 네이티브 확인 창(기본 취소), 없으면 묻지 않는다. 자동 실행(`LITECODE_TEST_HIDDEN`)·OS 종료(`session-end`·`powerMonitor 'shutdown'`, 표식 60초)는 묻지 않고, `ctx.quit` 이 안 떴으면 그냥 끝낸다. **Windows·Linux 는 창 닫기 = 숨기기** + 트레이(열기·종료, 아이콘은 `electron/quitHost.ts` 에 실은 PNG), 처음 숨길 때 한 번 안내(`settings.json` `trayNoticeShown`), 설정 > 일반 "창을 닫아도 계속 실행"(`keepRunning`, 없으면 켜짐 — 끄면 창 닫기 = 종료 요청). macOS 는 그대로(창을 닫아도 턴은 메인이 쥐고 이어진다). 판정은 순수 함수(`quitPrompt`·`closeAction`·`staysInTray`), Electron 은 host. **Windows·Linux 실행·트레이 없는 Linux·macOS 실제 창은 미확인** |
| 결과물 카드 | 2026-10-05 (#91, dsh `deliverables/tool-present` 아이디어, 시안 없이) — AI 가 앱 MCP 의 `present`(`litecode_present`, 인자 `{files:[{path, title?}]}` 1~10개)로 "이 파일이 결과물" 이라고 선언하면 끝난 턴의 답 아래 "결과물 N" 카드(고친 파일 카드 위), 줄을 누르면 오른쪽 패널(파일 칩과 같은 길). 메인이 검사(프로젝트 안의 일반 파일만), 화면을 조작하지 않아 네 모드 모두 묻지 않는다(계획 포함). **전부 받아들였을 때만 성공** — 엔진이 MCP 결과의 `structuredContent` 를 파트에 남기지 않아(동봉 바이너리 확인) 받아들인 목록은 성공한 호출의 인자에서 읽는다(`turnProgress.ts` → 도구 줄의 `presented`, 실시간과 다시 연 대화가 같은 길). 하나라도 못 쓰면 `isError` + 항목별 사유. 하위 작업은 못 쓴다(전역 deny + 모드 에이전트마다 allow, general-ask 는 개별 deny), 카드도 메인 줄만 모은다(`renderer/presented.ts`, 같은 파일은 한 줄). 도구 줄은 "결과물 · 파일 N". 기본 모드에서 가짜 LLM 으로 엔진 왕복 1회 확인(묻지 않고 실행, 카드 뜸). 다른 모드·실제 모델의 도구 사용은 미확인 |
| 훅 | `ctx.hooks`(`src/services/hooks.ts` + `hooks/{config,run}.ts`, 2026-10-05 #102 1단계, 설계·실측 `_workspace/01af_hooks.md` 방식 B, 시안 `_workspace/mock-hooks`) — 사용자가 이벤트에 건 셸 명령을 **메인 프로세스가** 프로젝트 폴더에서 돌린다(엔진 플러그인 아님, 엔진은 `--pure` 그대로 — opencode 1.18.18 의 훅은 플러그인 훅뿐이고 `--pure` 에선 0개). 기능 `hooks`(기본 꺼짐). 형식은 Claude Code `hooks` 부분집합, 정의는 userData `hooks.json`(모든 프로젝트) + `hooks-projects.json`(프로젝트 realpath 별 훅·`enabled` 덮어쓰기 — 열쇠 `이벤트\|매처\|명령`), **돌 때마다 다시 읽는다**(화면은 3단계 — 지금은 파일을 직접 고친다, 읽을 때 깨진 파일은 옮기지 않고 훅 0개). 프로젝트 폴더의 `.claude/settings.json` 은 읽지 않는다(자동 실행 안 함 — 사용자 결정, 가져오기는 3단계). 실행은 `!명령` 과 같은 `exec.ts`(로그인 셸·프로세스 그룹·기한 30/60초·상한 600), 입력은 stdin JSON + env(`LITECODE_PROJECT_DIR`·`CLAUDE_PROJECT_DIR`·`LITECODE_FILE`)로만 — **도구 인자를 명령 문자열에 넣지 않는다**. 종료 코드 0 통과 / 2 막기(stderr 사유) / 그 밖·기한 초과 = 비차단 실패, 모든 프로젝트 → 이 프로젝트 순으로 하나씩, 막으면 거기서 멈춤. 연결점은 중립: `chat/before-send`(프롬프트 제출 — 사람 글만, 막으면 안 보내고 붙잡힌 대기열로 되돌림; 세션 시작 — 첫 턴; stdout 은 그 턴 `system` 뒤에), `chat/after-turn`(턴 끝 — 완료된 턴만, 막으면 사유를 출처 `'hook'` 의 다음 턴으로, 연속 3번까지), `llm/tool-done`(도구 실행 후 — 성공한 호출·하위 작업 포함, 관찰만), `llm/attention`·`llm/turn-ended`(알림 — 줄 없음). 대화엔 진행 줄 `kind:'hook'`(도는 턴과 방금 끝난 턴만 — 다시 연 대화엔 없다). 실행 기록은 `main.log` 에 WARN 줄로. 가짜 LLM + 진짜 엔진으로 도구 후·턴 끝·세션 시작(맥락이 LLM 요청에 실림)·프롬프트 막기(LLM 요청 0, 입력 되돌아옴) 1회씩 확인. **PreToolUse 는 권한 게이트로 돈다**(2단계): `ctx.hooks` 가 켜진 PreToolUse 매처(모든 프로젝트의 합집합)를 `ctx.llm.gateTools` 로 알리면 `ctx.engine` 이 에이전트마다 맨 뒤에 `ask` 를 얹는다(`toolGate` — 네 모드 + general·explore·general-ask, **지금 allow 인 것만**; 전체 권한에서도 걸린다, 계획의 deny 는 그대로). 대상이 달라졌을 때만 엔진을 다시 띄우고 도는 턴이 있으면 끝난 뒤로 미룬다 — 손으로 고친 파일은 다음에 보내는 턴부터. 승인 요청이 오면 `ctx.llm` 이 호출마다 한 번 `'llm/pre-tool'`(중립, serial)을 물어 막기 = `reject` + `message`(모델이 사유를 받고 턴이 이어진다 — message 없는 reject 는 턴을 끝낸다), 묻기 = 승인 카드, 통과·판정 없음 = **게이트가 걸린 권한이고 모드가 원래 묻지 않을 때만**(`shared/modes.ts` `modePermission`) `once`, 아니면 카드. 훅 통과로 보낸 once 는 승인 기록(#55)에 적지 않는다. 훅 실패·기한 초과는 통과. **glob·grep·webfetch 에도 건다**(#112 — 이 도구들의 요청은 권한 목록을 400 으로 만들지만 #107 의 이벤트 폴백으로 판정·답까지 간다; 호출마다 경고 한 줄). 걸 수 있는 것: bash·edit(write·apply_patch)·read·glob·grep·webfetch·task·skill·todowrite·MCP(`*_*` — 내장 도구 이름의 나열이 아닌 매처일 때). **websearch 만 걸지 않는다**(`UNGATED_TOOLS` — 레거시 경로에 도구가 없다). webfetch 는 허용이던 곳만 — 웹 가져오기가 꺼져 있거나 계획 모드면 deny 그대로(도구가 안 생긴다), 매번 묻기는 훅 통과여도 카드. 계획의 glob·grep 에도 돈다. 격리 실행(제품 서비스 + 진짜 셸 훅) 각 1회: 기본 모드 glob·grep·webfetch 통과·막기, explore 하위 작업의 glob, 계획의 glob, 웹 꺼짐, 매번 묻기 webfetch. 실제 앱(가짜 LLM + 진짜 엔진)에서 bash 훅의 통과·막기 전체 사슬 1회 확인. MCP 와일드카드 게이트 왕복·gpt- 의 apply_patch 는 미확인. 받아들인 한계: 개인 설정이 게이트 건 권한에 둔 패턴별 ask 는 훅 통과 시 자동 once 가 된다. **화면은 `+` 메뉴의 훅 팝업**(3단계 — 설정 메뉴 아님: 설정은 앱 전체, 훅은 프로젝트 기준이라는 사용자 결정. 기능이 꺼져 있으면 줄이 없다): "훅 · 켜짐 N" → 두 묶음(이 프로젝트만/모든 프로젝트), 스위치는 그 프로젝트에서만, 줄을 누르면 편집 판(이벤트·매처·명령·기한·범위, 시험 실행 — 견본 입력으로 한 번, 대화·기록에 안 남음, 그 훅의 최근 실행). 다리는 `hooks/bridge.ts`(`hooks:*` 8채널, **등록된 프로젝트의 폴더만**, 검증은 메인 — `shared/hooks.ts` `checkHookDraft` 를 화면과 같이 쓴다). 같은 열쇠(이벤트·매처·명령)의 훅은 묶음이 달라도 저장 거절, 고치면 켜기 값이 열쇠를 따라간다. **프로젝트 폴더의 `.claude/settings.json`·`settings.local.json` 훅은 가져오기 후보로만 읽는다** — 띠 → 확인 창(명령 전문, 기본 선택 없음, 바깥 전송 경고는 `sendsOutside` 의 단순 글자 판정)에서 고른 것만 "이 프로젝트만" 에 복사, 메인이 파일을 다시 읽어 고른 열쇠가 그대로 있을 때만. 걸리지 않는 도구만 가리키는 매처는 경고(`UNGATED_TOOLS` 는 engine.ts 와 같은 목록의 복제 — 테스트가 대조). 대화: 훅 줄(통과 조용히·막음 붉게·실패 경고색), 막힌 도구 줄(취소선·"실행 안 됨"·사유), 턴 끝 훅이 이어 보낸 글은 말풍선이 아닌 줄(글 머리 `Stop hook feedback:` 로 가린다)이고 입력 기록(↑)에 없다. 통과한 실행은 `main.log` 에 안 남는다(메모리 기록만). 실제 앱에서 팝업 → 가져오기(후보 2·기본 선택 0·바깥 전송 경고 1) → 가져온 훅이 곧바로 명령을 막는 것까지 1회 확인. 편집 판은 시안 없이 만들었고 눌러 보지 않았다 |
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

**목표:** opencode 실측 위에서 기능·수정을 착지시키되, typecheck·단위 테스트가 초록일 때만 끝났다고 한다 (실물 테스트는 2026-10-03 부터 과정에서 뺐다).

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
| 2026-10-03 | 실물 테스트를 과정에서 뺀다 — 새로 안 쓰고 안 돌린다, 머지 기준은 typecheck·단위 | skills/litecode-build, agents/litecode-dev, CLAUDE.md | 사용자 "실물 테스트를 빼자" (전체 한 번 8~9분, 머지마다) |
| 2026-10-02 | 디자인 이야기는 전부 HTML 시안(Artifact 캔버스)으로 — 구현자에겐 "시안: <링크>" | skills/litecode-build, agents/litecode-dev | 사용자 "모든 디자인은 html 시안으로 말한다" |
| 2026-10-02 | 실물 테스트 전체는 리더만 머지 전에 — 구현자는 자기 실물 파일만 | skills/litecode-build, agents/litecode-dev | 사용자 "실물 테스트는 니가 하는걸로 하자" (에이전트 50분대, 전체를 두 번 돌림) |
