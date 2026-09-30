---
name: boundary-check
description: "litecode 의 경계면을 교차 대조한다 — shared/ipc.ts ↔ preload.cts 채널, ChatResult ↔ App.tsx 소비, llm.ts 이벤트 처리 ↔ 실제 opencode SSE, ctx.llm 경계·inject 규칙. 타입체크·단위 테스트가 초록인데 런타임에서 어긋나는 결함이 표적. '경계면 확인', '계약 검증', 'IPC 맞나', '정합성 검사', 'QA 해줘', '왜 화면에 안 뜨나', '답이 이상하게 온다', '구조 원칙 어겼나' 요청 시 사용. 구현 직후 검증에도 사용. 일반 버그 탐색·코드 품질은 /code-review 가 맡는다."
---

# Boundary Check — 양쪽을 같이 연다

각 경계마다 **생산자와 소비자를 동시에 열고** 한 줄씩 맞춘다. 한쪽만 보면 둘 다 "맞아 보인다".

## 경계 목록과 대조 방법

### B1. IPC 채널 — `shared/ipc.ts` ↔ `electron/preload.cts` ↔ `electron/main.ts`

preload 는 CJS 라 `Channel` 을 import 못 하고 손으로 옮겨 적는다. 세 곳의 문자열이 전부 같아야 한다.

```bash
grep -n "'[a-z]*:[a-z]*'" shared/ipc.ts electron/preload.cts
grep -n "Channel\.\w*" electron/main.ts electron/preload.cts
```

- `ipc.ts` 의 모든 채널이 preload 에 있고 값이 같은가
- `LitecodeBridge` 의 메서드마다 preload 구현과 `ipcMain.handle` 이 있는가, 인자 순서가 같은가
- 확인 수단: `app.live.test.ts` 가 그 채널을 실제로 거치는가. 안 거치면 "테스트 공백"

### B2. 결과 모양 — `ChatResult` (llm.ts) ↔ `App.tsx`

- `llm.chat` 의 모든 return 경로를 나열하고, 각 경로에서 `ok/sessionId/text/error` 중 무엇이 채워지는지 표로 만든다
- `App.tsx` 가 그 표의 각 행을 올바르게 다루는가 (예: 실패인데 새 `sessionId` 가 왔을 때 버리지 않는가,
  실패 경로에서 `sending` 이 풀리는가, 예외가 던져지면 어떻게 되는가)

### B3. SSE — `llm.ts` 의 `handleFrame`/`subscribe` ↔ 실제 opencode 바이트

**코드만 보고 판정하지 않는다.** `opencode-probe` 절차로 격리 opencode 를 띄워 SSE 원본을 받고 대조한다.

- 코드가 기다리는 이벤트 이름·필드(`data.text`, `data.finish`, `data.error.message`)가 실제 바이트에 있는가
- 재구독·두 번째 턴·실패 턴에서도 맞는가 (재구독 시 과거 이벤트 재생 — `?after=` 처리 여부)
- 종료 이벤트가 안 오면 어떻게 되는가 (타임아웃, 스트림 끊김)
- abort 한 구독의 promise 가 처리되지 않은 rejection 으로 남지 않는가

### B4. 서비스 경계 — `ctx.llm` 가 opencode 를 숨기는가

```bash
grep -rn "opencode\|/api/session\|session\.next" renderer shared electron | grep -v "^.*://"
```

- renderer·shared·electron 에 opencode URL·이벤트 이름·opencode 전용 id 형식 가정이 새어 나왔나
  (주석 속 설명은 괜찮다. 코드가 의존하면 위반)
- `opencodeUrl` 같은 엔진 설정이 `LlmService` 옵션 밖으로 퍼지지 않았나

### B5. inject 규칙 — Cordis 비동기 마운트

```bash
grep -n "ctx\.\(providers\|llm\)" electron/*.ts src/**/*.ts
```

- `ctx.providers`/`ctx.llm` 을 쓰는 곳이 전부 `inject` 를 선언한 플러그인(또는 `ctx.inject` 콜백) 안인가
- 새 서비스가 다른 서비스를 쓰면 `static inject` 에 적었나

## 판정

각 지적에 등급을 붙인다:

- **차단** — 재현했다 (실물 테스트 실패, curl 로 확인, 화면에서 확인)
- **경고** — 코드상 명백하지만 재현은 못 했다
- **참고** — 취향·향후 위험

"테스트 공백" 을 따로 적는다: 이번 변경이 건드린 경계 중 실물 테스트가 거치지 않는 것.
공백은 결함이 아니지만, 다음 결함이 숨을 자리다.

## 돌릴 것

```bash
export PATH=/usr/local/bin:$HOME/.bun/bin:$PATH
npm run typecheck && npm test && npm run test:live
```

환경 때문에 못 돌렸으면 판정에 "실물 미실행" 이라고 쓴다. 통과로 쓰지 않는다.

## 산출물

`_workspace/03_qa.md` — 형식은 `boundary-qa` 에이전트 정의를 따른다.
