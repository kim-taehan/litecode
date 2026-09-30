# CLAUDE.md — litecode

폐쇄망 환경에서 쓰는 **원클릭 code assistant**. `closed-code/desktop`(davis-code-desktop 을
복사해서 시작한 유산 구조)을 점진적으로 고치는 대신, 2026-09-29 에 **처음부터 새로 짓기로
결정**하고 만든 프로젝트다.

## 참고 코드

새 코드를 짤 때 아래 두 레포를 참고한다 — 베끼지 않고 패턴·실측만 가져온다.

| 레포 | 위치 | 뭘 참고하나 |
|---|---|---|
| `closed-code/desktop` | `/Users/a08368/vscodeProjects/closed-code/desktop` | 같은 opencode 를 다루던 기존 코드. 특히 `electron/opencode/*` 의 실측 주석(레거시/신규 세대 이벤트 차이, 세션 격리 함정, 하트비트 등)이 유용하다 — 우리가 새로 실측한 것과 대조해볼 것. 다만 `session/*` 의 kind/action 구조 자체는 참고하지 않는다(그게 새로 만든 이유다) |
| deepseek-harness (dsh) | `/Users/a08368/vscodeProjects/deepseek-harness` | Cordis 실사용 패턴(`docs/cordis-tutorial/`, `docs/cordis-primer.md`), LLM provider 추상화(`packages/llm/*` — custom baseURL·"hand-declared gateway"), 화면 조각(`packages/client/ui-trajectory` 등). MIT 라이선스, dsh 전용이 아닌 Cordis 자체 생태계도 있음(`cordiverse/cordis`). **개발 프리뷰 단계라 코드를 그대로 베끼지 말고 아이디어만 가져온다** — README 가 "compatibility-breaking changes 있을 것"이라고 명시함 |

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
  2. `GET /api/session/{id}/event` (SSE) 를 **프롬프트 보내기 전에 먼저 구독한다.** 순서가
     바뀌면 초반 이벤트를 놓친다.
  3. `POST /api/session/{id}/prompt` — 이 응답은 프롬프트가 **admit** 됐다는 확인일 뿐이다.
     실제 응답은 전부 SSE 로 온다 (동기 응답 아님).
- SSE 이벤트(`session.next.*`) 중 우리가 쓰는 것:
  - `session.next.text.ended` — `data.text` 에 **완성된** 텍스트 조각이 온다 (델타 아님)
  - `session.next.step.ended` — `data.finish !== 'tool-calls'` 면 턴이 끝난 것
  - `session.next.step.failed` — 실패로 턴이 끝난 것. `data.error.message` 에 사유
- **아직 안 한 것**: 우리 `ctx.providers` 의 provider/model id 를 opencode 자신의
  provider/model id 로 매핑하는 설정 화면. 지금은 opencode 의 기본값을 그대로 쓴다
  (`src/services/llm.ts` 의 TODO 참고).

## 지금 상태 (2026-09-29)

| 조각 | 상태 |
|---|---|
| `src/services/providers.ts` | provider 설정(이름·baseURL·프로토콜·모델 카탈로그) 관리 — dsh Settings > Models 화면과 같은 모양 |
| `src/services/llm.ts` | opencode 세션 생성 → SSE 구독 → 프롬프트 전송 → 텍스트 수집. **실제 연결 검증 완료** (게이트웨이가 안 떠 있어 LLM 응답 자체는 실패로 끝났지만, 그 실패를 정확히 잡아내는 것까지 확인함) |
| `electron/` + `renderer/` | Electron 앱. 사이드바(프로젝트 전환·새 대화·세션 목록) + 채팅창. IPC 로 위 서비스에 연결됨 |
| 설정 화면 | 없음. provider 는 `electron/main.ts` 에 하드코딩된 더미 하나뿐 |
| 세션 영속화 | 없음. 새로고침하면 대화 목록이 다 날아감 (React state 뿐) |
| 프로젝트(폴더) 여러 개 열기 | 없음. 지금은 프로젝트 개념 자체가 없다 — "화면이 너무 복잡해 보인다"는 지적으로 한 번에 하나만 열고 전환 버튼으로 바꾸는 쪽으로 방향을 잡았고, 그 화면 시안이 승인됐지만 아직 구현 전이다 |

## 실행

```bash
npm install
npm run dev        # vite 개발 서버 + electron 을 같이 띄운다
npm run typecheck
npm run spike       # electron 없이 src/index.ts 만 돌려보는 최소 확인용
```

Electron 은 `33.4.11` 로 고정돼 있다 — 이 머신에서 최신 버전(`44.x`) 바이너리 다운로드가
막혀 있어서, `closed-code/desktop` 이 쓰는 버전과 맞춰 로컬 캐시를 재사용했다.

## 디자인 시안

승인된 화면 시안: https://claude.ai/artifact/H9ab8rS8Yn5GcA8YKyccL3
(사이드바 하나로 프로젝트 전환 + 대화 목록을 접는 구조 — 지금 `renderer/App.tsx` 는 이 중
"대화 목록" 부분만 구현했고, "프로젝트 전환" 팝오버는 아직 없다.)
