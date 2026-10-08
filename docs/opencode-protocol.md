# opencode 프로토콜 — 실측 기록

litecode 가 엔진으로 쓰는 opencode(1.18.18 고정)를 실제로 돌려 확인한 것만 적는다. 정본은 언제나 뜬 서버의 `/doc`.
opencode 의 동작에 기대는 코드를 고치기 전에 해당 묶음을 읽고, 새로 실측한 것은 여기에 더한다. (CLAUDE.md 에서 옮김, 2026-10-06)

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
  - **도는 턴에 끼워 넣기** (#250, 실측 2026-10-08, 근거 `_workspace/01ar_interject_probe.md`, 가짜 LLM): 도는 세션에 `prompt_async` 를 또 보내면 204 즉시,
    user 메시지는 바로 저장되고 **도는 스텝이 끝난 직후의 다음 모델 호출에 실린다**(6/6 — 도는 도구·글 스텝 하나는 끝까지 간다). 그 뒤 assistant 의 parentID 는
    새 user, idle 은 합쳐 맨 끝 한 번. 그 뒤 스텝은 **마지막 user 의 agent·system·tools** 를 쓴다(1/1) → 끼워 넣는 말에도 도는 턴과 같은 값을 싣는다.
    도는 턴엔 `noReply` 가 무시된다(5/5). 승인 거절·abort 로 루프가 끝나면 끼워 넣은 user 는 답 없이 남는다(6/6). 이전 idle 과 엇갈려 늦게 닿으면 새 루프·
    자기 idle 을 받는다(8/8) → 끝 판정은 "끼워 넣은 user 를 모두 본 뒤의 idle". 동기 `/message` 는 루프 끝까지 블록(1/1). 승인 대기 중에 넣어도 승인은
    그대로 남고 승인하면 이어서 반영(1/1). 앱: `ctx.llm.reserve`(보내기 전에 `TurnScope.adopt`) → `Interjection.send`/`cancel`, 답 못 받은 말은 `ChatResult.unanswered`.
    미측정: 진짜 모델이 끼워 넣은 말 뒤 앞 일을 이어 가는지, task·자동 요약 중 끼워 넣기, 연달아 두 번, 이미지 첨부
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
  - **손으로 부르는 요약** (#144, 실측 2026-10-06 가짜 LLM): 레거시 `POST /session/{id}/summarize?directory=` 본문 `{providerID, modelID, auto?}` — 둘 다 **필수**(빠지면 400 `Missing key`),
    추가 필드 불가(messageID 를 못 정한다). 응답 200 `true` 는 요약이 **끝나거나 멈춘 뒤**에 온다(가짜 LLM 2.5초 → 2.55초) — 진행은 `/event` 로 본다.
    순서: user(엔진이 id 를 정함, 파트 `compaction{auto:false}`, 글 없음) → busy → 요약 답(`summary:true`, agent `compaction`, parentID = 그 user) → `session.compacted` → idle. **이음 user 가 없다.**
    요약 요청은 도구 없이 `<conversation>` 을 실어 그 모델로 간다(`max_tokens` = limit.output). 빈 세션도 요약한다(LLM 을 부른다) → 앱이 막는다. 요약 뒤 다음 턴은 정상.
    **멈춘 요약은 다음 프롬프트를 삼킨다 (3/3)**: abort 는 200 `true` → `session.error(MessageAbortedError)` → idle, 요약 답은 그 오류로 남는다. 그 뒤 첫 프롬프트는 답 대신
    요약 답(parentID = 새 user, summary:true)만 만들고 idle 이다 — 사용자의 글이 답을 못 받는다. `DELETE /session/{id}/message/{id}?directory=`(200 `true`)로 요약 답·요약 user 를 지우면
    다음 턴이 정상이다(3/3, 요약 user 만 지워도 되지만 고아 요약 답이 기록에 남는다). `ctx.llm.compact` 는 끝나지 않은 손 요약을 늘 지운다. 신규 세대 `POST /api/session/{id}/compact`(204)는 안 쟀다.
    자동 요약을 멈춘 뒤에도 같은지는 **안 쟀다**
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
  - **local MCP 를 Electron 으로** (#147, `_workspace/01aj_playwright_mcp.md`, 2026-10-06): `POST /mcp` 의 `config: {type:"local", command:[process.execPath, <cli.js>, …],
    environment:{ELECTRON_RUN_AS_NODE:"1"}}` — 개발 Electron·설치본 바이너리 둘 다 node 20.18.3 으로 돈다. 폐쇄망 PC 에 node 가 없어도 동봉한 JS MCP 서버를 쓸 수 있다.
    `RunAsNode` 퓨즈를 끄면 깨진다. local MCP 자식의 **cwd 는 그 프로젝트 폴더**다(재확인) — cwd 에 파일을 쓰는 서버(Playwright MCP 의 `.playwright-mcp/`)는 출력 폴더를 따로 줘야 한다.
    MCP 도구가 이미지를 돌려주면 도구 파트 `state.attachments: [{mime, url:"data:…"}]` 로 온다(글은 `state.output`). MCP 도구의 승인 요청은 `patterns:["*"]`, `metadata:{}` 다 —
    인자(주소 등)로 규칙을 나눌 수 없다, 인자는 도구 파트의 `state.input` 에서 읽는다. `POST /mcp/{name}/disconnect` 와 opencode 종료(SIGKILL 포함)는 stdio 자식의 표준입력을
    닫아 자식이 스스로 끝난다(mac, 각 1/1) — 자식이 띄운 손자(Chrome)는 자식이 정상 종료할 때만 정리된다. Playwright MCP 0.0.83: 기본 `--snapshot-mode full` 은 동작 응답에
    스냅샷을 **파일 링크**로만 준다 — `none` + 명시적 `browser_snapshot` 호출이 본문으로 받는 길이다. Chrome 은 `--user-data-dir=<경로>` 한 인자로 뜬다(경로에 공백이 있어도 — 2026-10-06 헤드리스 1/1)
  - **MCP 도구를 턴마다 숨기기** (#164, 2026-10-06, 일회용 스크립트 — 실물 opencode 1.18.18 + 가짜 LLM 의 `lastChat.tools`, 서버 이름 `my-srv`·`dot.srv x`, 도구 `do.thing-x`·`plain`·`Other Tool`):
    `/doc` 의 prompt_async 본문에 `tools: {[이름]: boolean}` 가 있다. `{"my-srv_plain": false}` 를 실은 턴의 LLM 요청 tools 에서 그 도구가 빠진다(같은 세션의 다른 도구·다른 세션·
    다른 폴더는 그대로). 엔진 도구 이름은 서버·도구 둘 다 `[A-Za-z0-9_-]` 밖 글자를 `_` 로(`dot.srv x` + `do.thing-x` → `dot_srv_x_do_thing-x`) — MCP 서버가 준 원래 이름
    (`my-srv_do.thing-x`)은 안 먹는다. **이 맵은 세션 `permission` 을 통째로 바꾸고(`[{permission:이름, pattern:"*", action:"deny"}]`) 다음 턴에도 남는다** — 필드가 없거나
    `{}` 면 앞 값 그대로, 다른 맵을 주면 바뀐다(합치지 않는다). 와일드카드(`my-srv_*`)도 먹는다. `true` 는 `action:"allow"` 규칙이 된다 — 모드의 ask 를 건너뛸 수 있어 싣지 않는다.
    그래서 `ctx.llm` 은 매 턴 엔진 이름이 될 수 없는 표지(`litecode:no-tool`) 하나 + 숨길 도구를 false 로 싣는다(표지만 실은 턴에 전부 되살아남 1/1). 하위 에이전트(task)의 자식 세션에 이 숨김이 가는지는 안 쟀다
  - **할 일 목록(todowrite)** (#83, `_workspace/01ae_todo.md`): 인자 `{todos:[{content, status, priority}]}` — id 없음, status(pending·in_progress·completed·cancelled)·priority 는
    검사 안 되는 문자열. **호출마다 목록 전체를 보내고 통째로 교체된다.** 끝난 파트의 `state.metadata.todos` 가 그 시점 목록, 같은 내용이 `todo.updated {sessionID, todos}` 로 오고
    `GET /session/{id}/todo?directory=` 가 맨 배열로 준다(재시작·자동 요약 뒤에도 남는다). 틀린 인자는 `running`(input 실림) 뒤 `error` 이고 목록은 안 바뀐다 → 화면은 `completed` 파트만 본다.
    네 모드 모두 도구가 있고 묻지 않는다, 하위 에이전트엔 없다. `todoread` 없음 — 자동 요약 뒤엔 모델이 목록을 모를 수 있다. 턴이 끝나도 `in_progress` 는 그대로 남는다
- **아직 안 한 것**: 우리 `ctx.providers` 의 provider/model id 를 opencode 자신의
  provider/model id 로 매핑하는 설정 화면. 지금은 두 id 가 같다고 보고 그대로 넘긴다 — 그래서 우리 provider
  id 가 opencode.json 에 없으면 "모델 없음" 오류가 난다.

