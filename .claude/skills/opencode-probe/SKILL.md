---
name: opencode-probe
description: "격리된 opencode 를 띄워 프로토콜을 직접 실측하고, 참고 레포(closed-code/desktop·deepseek-harness)에서 가져올 패턴을 조사한다. '/doc 확인', 'opencode 가 이거 지원하나', '이벤트 모양', 'SSE 에 뭐가 오나', '실측해줘', '작업 디렉터리 지정 되나', '도구 호출 이벤트', 'closed-code 에서 어떻게 했나', 'dsh 에서 가져올 수 있나', '이식 가능한가' 요청 시 사용. opencode 동작이 불확실한 채로 구현하려 할 때도 먼저 사용."
---

# opencode Probe — 격리해서 찔러 본다

opencode 동작은 문서·기억·다른 레포 주석보다 **지금 뜬 서버**가 정본이다. 이 스킬은 사용자 환경을
더럽히지 않고 그 서버를 재는 절차다.

## 1. 격리된 opencode 띄우기

사용자 opencode(:4096 등)에 세션을 만들면 사용자 기록이 더러워지고, 전역 설정의 진짜 게이트웨이로
요청이 나간다. 그래서 실물 테스트와 같은 방식으로 따로 띄운다.

가장 쉬운 방법은 실물 테스트의 지원 코드를 그대로 쓰는 것이다:

```ts
// scratchpad/probe.mts  →  npx tsx scratchpad/probe.mts   (.mts 여야 top-level await 가 된다)
import { startFakeLlm } from '<repo>/tests/live/support/fakeLlm.ts'
import { startOpencode } from '<repo>/tests/live/support/opencodeServer.ts'
const llm = await startFakeLlm()
const oc = await startOpencode(llm.baseURL)
console.log(oc.url, oc.projectDir)   // 여기에 curl 로 붙는다
// ... 실측 ...
await oc.stop(); await llm.stop()
```

쉘로만 하려면 같은 원칙을 지킨다: 빈 포트, `cwd` = 임시 폴더(가짜 LLM 을 `model` 로 지정한 `opencode.json`),
`XDG_CONFIG_HOME/XDG_DATA_HOME/XDG_STATE_HOME` = 임시 폴더, `--pure`, **PID 를 변수에 잡아 두고 그것만 kill**.

## 2. 무엇을 재나

1. **`GET /doc`** — 엔드포인트·파라미터 목록. 먼저 여기서 찾는다
   ```bash
   curl -s $URL/doc | python3 -c "import json,sys; d=json.load(sys.stdin)
   for p,v in d['paths'].items():
     for m,o in v.items(): print(m.upper(), p, [x['name'] for x in o.get('parameters',[])])"
   ```
2. **SSE 원본** — 구독을 먼저 걸고(백그라운드 curl → 파일), 그 다음 프롬프트를 보낸다
   ```bash
   curl -sN --max-time 10 $URL/api/session/$ID/event > sse.txt &
   curl -s -X POST $URL/api/session/$ID/prompt -H 'content-type: application/json' -d '{"prompt":{"text":"..."}}'
   grep -o '"type":"[a-z._]*"\|"seq":[0-9]*' sse.txt | paste - -
   ```
3. **경계 조건** — 한 번 잘 되는 것보다 이게 중요하다: 재구독, 두 번째 턴, 실패(`[fail]`), 동시 요청,
   서버 재시작 후. 첫날 결함(재구독 재생)은 "두 번째" 에서 나왔다
4. 비결정적이면 5회 이상 반복해 빈도를 적는다

가짜 LLM 이 필요한 응답(도구 호출 등)을 못 내면 `tests/live/support/fakeLlm.ts` 에 규칙을 더하자고
보고서에 제안한다 — 실측용 임시 가짜를 따로 만들지 않는다 (실물 테스트와 어긋난다).

## 3. 지금까지 확인된 것 (2026-09-30, opencode 1.18.18)

CLAUDE.md 의 "opencode 프로토콜" 절에 더해:

- `POST /api/session` 응답의 `data.location.directory` = opencode 프로세스의 cwd
- `GET /api/session/{id}/event` 는 **구독할 때마다 그 세션의 과거 이벤트를 seq 1 부터 재생한다.**
  `?after=<seq>` 쿼리로 자를 수 있다. 각 이벤트에 `durable.seq` 가 있다
- `POST .../prompt` 응답: `{ data: { admittedSeq, id, sessionID, prompt, delivery: "steer" } }`
- 한 턴의 이벤트 순서: `prompt.admitted → prompted → step.started → text.started → text.ended → step.ended(finish:"stop")`
- **`POST /api/session` 을 `{}` 로 보내면 기본 모델이 비결정적이다.** config 의 `model` 대신 models.dev
  카탈로그의 외부 provider(`nano-gpt/...`)가 잡힐 때가 절반 이상 — `enabled_providers` 로도 안 막힌다.
  본문의 `model: { providerID, id }` 로 명시할 수 있다. `location: { directory }` 도 받는다.
  실패 턴의 `step.started.data.model` 에서 실제 쓰인 모델을 볼 수 있다
- `opencode` 가 `listening` 을 찍고도 `/doc` 이 수십 초 무응답인 때가 있다 — 폴링은 요청마다 타임아웃을 건다
- `opencode serve --port N --pure` 로 포트 고정·외부 플러그인 없이 뜬다. 첫 기동은 provider 패키지를 캐시에
  받느라 20초를 넘길 수 있다

새로 확인한 것은 보고서에 "CLAUDE.md 에 추가할 문장" 으로 적는다. 리더가 반영한다.

## 4. 참고 레포 조사

| 레포 | 볼 곳 | 가져오는 방식 |
|---|---|---|
| `closed-code/desktop` | `electron/opencode/*` 의 실측 주석 (레거시/신규 이벤트 차이, 세션 격리, 하트비트, 바이너리 탐색 `binary.ts`) | 우리 실측과 **대조**. 우리 서버에서 재현되면 채택 |
| `closed-code/desktop` | `session/*` | **보지 않는다** — kind/action 구조를 벗어나려고 litecode 를 만들었다 |
| `deepseek-harness` | `docs/cordis-*`, `packages/llm/*` | 아이디어만. 개발 프리뷰라 호환성이 깨진다 |
| `deepseek-harness` | `packages/client/ui-*` (화면) | **디자인의 주 참조처** (사용자 지시 2026-09-30). 모양·상호작용·상태 설계를 가져와 새로 쓴다 — 패키지 대응표는 `litecode-dev` 정의 |

판정은 넷 중 하나로: **그대로 가능 / 번역 필요(무엇을) / 부적합(왜) / 이미 있음**.
"닮았다" 는 판정 근거가 아니다 — 그쪽 코드가 기대는 전제(davis 런타임, 다른 opencode 버전)가 여기서도
참인지 확인한다.

## 5. 산출물

`_workspace/01_probe.md` — 형식은 `opencode-prober` 에이전트 정의를 따른다. 키·토큰은 가린다.
