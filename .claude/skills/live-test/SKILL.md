---
name: live-test
description: "litecode 의 테스트를 쓰고 돌린다 — 단위 테스트(vitest)와 실물 테스트(격리된 진짜 opencode + 가짜 LLM + 진짜 Electron 창을 playwright 로 조작). 새 기능·버그 수정에 맞는 테스트를 어느 층에 쓸지 정하고, 실패를 판독한다. '테스트 돌려줘', '실물 테스트', 'test:live', 'e2e', '앱 띄워서 확인', '진짜로 되나', '테스트 추가', '재현 테스트', '초록인가', '착지 확인' 요청 시 사용. 구현을 끝냈다고 보고하기 전에도 반드시 사용."
---

# Live Test — 초록은 실물에서 받는다

litecode 는 테스트가 필수다. 그중 **실물 테스트**가 착지 기준이다. 이유: 이 앱의 결함은 거의 다
경계(렌더러↔preload↔IPC↔ctx.llm↔opencode)에서 나고, 단위 테스트는 그 경계를 흉내 낸 가짜 위에서
돌기 때문에 가짜가 틀리면 같이 틀린다.

## 명령

```bash
export PATH=/usr/local/bin:$HOME/.bun/bin:$PATH   # 이 머신: node 는 /usr/local/bin, opencode 는 ~/.bun/bin
npm run typecheck
npm test            # 단위 — tests/unit/**/*.test.ts, 외부 프로세스 없음, 1초 안쪽
npm run test:live   # 실물 — tests/live/**/*.live.test.ts, 수십 초
```

opencode 가 다른 곳에 있으면 `OPENCODE_BIN=/path/to/opencode npm run test:live`.

## 실물 테스트가 띄우는 것

`tests/live/globalSetup.ts` 가 한 번 띄우고 끝나면 끈다.

```
[진짜 Electron 창] ─IPC─ [진짜 메인+ctx.llm] ─HTTP/SSE─ [진짜 opencode] ─HTTP─ [가짜 LLM]
   playwright 가 조작        dist-electron 을 매번 tsc     빈 포트·임시 XDG        tests/live/support/fakeLlm.ts
```

- **가짜는 LLM 하나뿐이다.** 사내 게이트웨이가 없는 곳에서도 턴을 끝까지 돌리려는 것. 응답은 결정적이다:
  - 보통: `echo: <마지막 user 메시지>` 를 두 조각으로 스트리밍
  - 메시지에 `[fail]` 이 있으면: HTTP 500 → opencode 가 `session.next.step.failed` 를 낸다
  - 새 시나리오(도구 호출 등)가 필요하면 **fakeLlm 에 규칙을 더한다.** opencode 를 흉내 내는 가짜는 만들지 않는다
- **opencode 격리** (`support/opencodeServer.ts`):
  - 빈 포트 — 사용자가 쓰는 opencode(:4096) 와 안 부딪힌다
  - `XDG_CONFIG_HOME/DATA/STATE` 를 임시 폴더로 — 전역 설정의 진짜 게이트웨이 키를 안 읽고, 세션 기록을 사용자 저장소에 안 남긴다. 캐시(`XDG_CACHE_HOME`)는 그대로 둬서 provider 패키지를 매번 받지 않는다 — 대가로 테스트가 사용자의 `~/.cache/opencode/models.json` 을 갱신할 수 있다 (opencode 를 평소에 띄울 때와 같은 갱신이라 받아들인 것)
  - cwd 는 임시 프로젝트 폴더 — 그 안의 `opencode.json` 이 가짜 LLM 을 기본 모델로 지정한다
  - 끌 때는 **자기가 띄운 child 만** 끈다
- **앱** (`app.live.test.ts`): `tsc -p tsconfig.electron.json` → vite dev 서버(빈 포트) → `_electron.launch` 에
  `LITECODE_DEV_SERVER_URL`·`OPENCODE_URL` 을 넘긴다

## 어느 층에 테스트를 쓰나

| 바뀐 것 | 쓸 테스트 |
|---|---|
| 순수 로직 (파싱, 상태 계산, 레지스트리) | 단위 `tests/unit/` |
| `ctx.llm` 의 opencode 호출·SSE 처리 | 실물 `tests/live/llm.live.test.ts` 에 시나리오 추가 |
| IPC 채널·preload·main 배선 | 실물 `tests/live/app.live.test.ts` |
| 화면 동작 (버튼, 목록, 입력) | 실물 `app.live.test.ts` — 사람이 하는 순서대로 조작하고 화면 텍스트로 확인 |
| 버그 | 그 버그가 **실제로 난 층**에 재현 테스트. 먼저 빨강을 본다 |

애매하면 실물에 쓴다. 단위 테스트는 빠르지만, 이 앱에서 단위만 초록인 건 착지가 아니다.

### 실물 테스트 작성 규칙

- 기대값은 가짜 LLM 규칙에서 **계산 가능한 값**으로 쓴다 (`'echo: 안녕'`). "뭔가 왔다" 수준의 단언은 결함을 못 잡는다
- 화면 대기는 `expect.poll(() => locator.textContent({ timeout: 1_000 }), { timeout: 30_000 })` 모양 —
  vitest 의 `expect` 에는 playwright 의 자동 대기 매처(`toHaveText`)가 없다
- 테스트끼리 스택(opencode 하나)을 공유한다. 세션은 테스트마다 새로 만들어 서로 안 섞이게 한다
- 새 파일은 `*.live.test.ts` 로 끝나야 수집된다

## 실패 판독

| 증상 | 먼저 볼 것 |
|---|---|
| `opencode 실행 실패 (opencode)` | PATH 에 `~/.bun/bin` 이 없다 → 위 export, 또는 `OPENCODE_BIN` |
| `opencode 가 60000ms 안에 안 떴다` | 오류 메시지의 `마지막 응답` 과 opencode 로그. 첫 실행은 캐시 채우느라 느리다 — 한 번 더 돌려 보고 판단 |
| 턴이 `testTimeout` 까지 안 끝남 | `ctx.llm` 이 종료 이벤트를 못 봤다. 격리 opencode 에 curl 로 SSE 를 직접 받아 이벤트 순서를 확인 (`opencode-probe` 스킬) |
| `HTTP 401 ... missing_api_key` | 가짜 LLM 이 아닌 **외부 provider 로 나갔다** — 세션 기본 모델 경합. 세션 생성 시 `model` 을 명시해야 한다 (`opencode-probe` §3). 이 상태로 반복 실행하지 않는다 — 테스트 프롬프트가 외부로 나간다 |
| 이전 턴의 답이 돌아옴 | SSE 재구독 시 과거 이벤트가 seq 1 부터 재생된다 — `?after=` 로 잘라야 한다 (2026-09-30 실측) |
| 앱 테스트만 실패, 서비스 테스트는 통과 | 경계 문제: preload 채널 이름, preload 로딩(`[preload-error]` 로그), 셀렉터 |
| 오래 띄워 둔 앱 창에서 `window.litecode.X is not a function` | 코드가 바뀐 뒤의 **낡은 창**이다 — 렌더러는 vite 가 새 코드로 갈아 끼웠는데 main·preload 는 띄울 때의 옛 코드다. 제품 결함 아님. 창을 닫고 새로 띄운다 (2026-09-30 데모에서 발생) |
| `연결됨` 을 못 찾음 | `listProviders` IPC 가 안 돌았다 — preload 가 안 붙었을 가능성이 크다 |

**초록을 만들려고 가짜 LLM·셀렉터·기대값을 느슨하게 고치지 않는다.** 실패가 테스트 쪽 잘못이라는
근거(실측)가 있을 때만 테스트를 고친다.

## 끝나고 확인

```bash
lsof -iTCP -sTCP:LISTEN -P | grep -E 'opencode|Electron'
```

테스트가 띄운 것이 남아 있으면 안 된다. 임시 폴더(`litecode-live-*`)도 마찬가지로 **자기가 만든 경로만** 지운다 —
같은 이름 패턴을 리더 데모와 다른 에이전트의 실물 테스트가 동시에 쓴다. 패턴으로 지우지 않는다. 여기 보이는 opencode·Electron 중 **실행 시간(`ps -o etime`)이
테스트보다 긴 것은 사용자 것**이다 — 끄지 않는다.
