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

서비스 목록·의존·이벤트·기능 묶음·새 서비스 더하는 순서는 **`docs/cordis-services.md`**.

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

## opencode 프로토콜

실측 기록은 **`docs/opencode-protocol.md`** 에 있다(약 27KB — 필요한 묶음만 읽는다). opencode 의 동작에 기대는 코드를 고치기 전에 읽고, 새로 실측한 것은 거기에 더한다. 늘 지킬 것만 여기 적는다:

- 엔진은 opencode **1.18.18 고정**, 채팅은 **레거시 경로**(`/session/*`·`/event`, 모든 호출에 `?directory=`). 신규 세대(`/api/*`)는 옛 기록 읽기 등에만
- `ctx.llm` 은 `model`·`agent` 를 **매 턴 명시**한다(안 주면 외부 provider 로 샌다). 구독을 먼저 걸고 보낸다. 턴 끝 = 이 턴 user 뒤의 `session.idle`
- 진짜 API 키는 opencode 에 주지 않는다 — 메인의 키 프록시가 붙인다. opencode env 는 프로젝트 코드에 샌다
- 프로젝트 폴더(와 상위 폴더)의 opencode 플러그인 파일은 엔진 안에서 실행된다 → `ctx.llm` 의 `engineFolder` 문에서 거절(#101). `ctx.llm` 에 폴더를 받는 메서드를 더하면 이 문을 지나게 한다
- 설정 변경은 엔진을 **다시 띄워야** 적용되고, 재시작하면 도는 턴이 끊긴다
- 권한 정본 목록(`GET /permission`)은 400 일 수 있다 → `permission.asked` 이벤트 폴백(#107). 승인에 `always` 를 보내지 않는다
- 폐쇄망: 런타임 내려받기 0, 바깥 요청 0. 동봉한 것만 쓴다
## 지금 상태

조각별 상세 기록은 **`docs/status.md`** 에 있다(약 50KB — 고치려는 기능의 줄만 읽는다. `grep -n '^| <이름>' docs/status.md`). 기능이 착지하면 그 줄을 고친다. 무엇이 있는지만 여기 적는다:

- **바탕 서비스**(`src/services/`): `providers`(모델 설정·키) · `engine`(opencode 띄우기·설정 생성·키 프록시) · `llm`(엔진과의 대화 — 엔진 지식은 여기와 engine 에만) · `sessions`(대화 목록) · `chat`(턴 소유·대기열) · `projects` · `settings` · `features`(기능 켜기/끄기) · `triggers`(@ · / · !) · `attachments`
- **기능 묶음**(끄면 통째로 내려간다, `shared/features.ts`): 필수 — 입력 트리거·`shell`(!명령)·`skills`·`mcp` / 고르는 것 — `terminal`·`trajectory`·`openIn`·`appMcp`(데스크탑 MCP) 기본 켜짐, `notifications`·`remote`(모바일 연결)·`web`(웹 가져오기)·`hooks`·`voice`(음성 입력)·`browser`(Chrome 조종) 기본 꺼짐
- **그 밖**: `quit`(종료 확인·창 닫기), 로그·부팅 진단(`electron/resilience.ts`·`logFile.ts`), 패키징(`scripts/fetch-*.mjs` + electron-builder, opencode·ripgrep·음성 엔진 동봉)
- **화면**(`renderer/`): 사이드바(프로젝트 전환·대화 목록·찾기·고정) + 대화(마크다운·문법 색·진행 줄·승인/질문 카드·모드 칩·할 일 줄·고친 파일/결과물 카드·훅 줄·찾기) + 입력 카드(`+` 메뉴의 스킬·MCP·훅 팝업, 첨부, 음성) + 오른쪽 패널(파일·폴더·HTML 미리보기) + 설정(일반·모델·기능·모바일)
- **모바일**(`mobile/`, Android): 데스크탑에 붙는 화면 — 단독 세션 없음. 지금은 루프백 평문 연결만(TLS·LAN·QR 없음)
- **테스트**: 착지 기준은 `npm run typecheck` + `npm test`(단위). 실물 테스트(`tests/live/`)는 쓰지도 돌리지도 않는다(요청이 있을 때만)
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

디자인 이야기는 전부 HTML 시안(Artifact 캔버스)으로 한다. 처음 승인된 화면 시안: https://claude.ai/artifact/H9ab8rS8Yn5GcA8YKyccL3
(사이드바 하나로 프로젝트 전환 + 대화 목록). 기능별 시안 사본은 `_workspace/mock-*/`.

## 하네스: litecode 개발

**목표:** opencode 실측 위에서 기능·수정을 착지시키되, typecheck·단위 테스트가 초록일 때만 끝났다고 한다 (실물 테스트는 2026-10-03 부터 과정에서 뺐다).

**트리거:** 기능 구현·버그 수정·안정화·참고 레포 이식 요청 시 `litecode-build` 스킬을 사용하라. 테스트만 돌리거나
쓸 때는 `live-test`, opencode 동작 확인은 `opencode-probe`, 경계면 검증은 `boundary-check`. 단순 질문은 직접 응답 가능.

**문서 규칙:** 이 파일은 세션마다 통째로 읽힌다 — **짧게 유지한다**(사용자 2026-10-06 "너무 과하다"). 기능별 상세·실측·미확인 목록은 `docs/status.md` 와 `docs/opencode-protocol.md` 에 적고, 여기에는 모든 작업에 필요한 규칙과 포인터만 둔다.

**변경 이력:** `docs/harness-history.md`
