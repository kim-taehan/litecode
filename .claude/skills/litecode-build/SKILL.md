---
name: litecode-build
description: "litecode(폐쇄망 원클릭 code assistant — Electron·React·Cordis·opencode) 의 기능 구현·버그 수정·참고 레포 이식을 조율하는 오케스트레이터. 실측(opencode-prober) → 테스트 우선 구현(litecode-dev) → 경계면 QA(boundary-qa) → 실물 테스트 착지까지. '기능 추가', '구현해줘', '만들어줘', '버그 고쳐줘', '안정화', '프로젝트 전환 구현', '세션 영속화', '설정 화면', 'closed-code 에서 가져와', 'dsh 패턴 이식' 요청 시 사용. 후속 작업에도 반드시 사용 — '다시 실행', '재실행', '이어서', '수정', '보완', '업데이트', 'QA 지적 반영', '이전 결과 개선', '구현만 다시', 'QA 만 다시'. 단순 질문(이 함수 뭐하나, 파일 어디 있나)은 직접 답한다."
---

# litecode Build Orchestrator

litecode 의 작업을 세 에이전트로 조율한다. 기준은 하나다: **실물 테스트가 초록이어야 착지다.**

## 실행 모드: 서브 에이전트 (파이프라인, 백그라운드)

세 역할이 순서대로 이어지고(실측 → 구현 → QA), 서로 넘기는 것은 파일 하나씩이다. 팀원끼리 실시간으로
토론할 일이 거의 없어 팀 통신 비용이 이득보다 크다. 그래서 리더(당신)가 `Agent` 로 한 명씩 부르고,
산출물은 `_workspace/` 파일로 넘긴다.

**모든 에이전트는 `run_in_background: true` 로 띄운다.** 리더가 블로킹 대기하면 사용자가 진행 상황을 묻거나
방향을 틀 수 없다. 끝나면 알림이 온다.

| 에이전트 | subagent_type | 역할 | 스킬 | 출력 |
|---|---|---|---|---|
| `opencode-prober` | `opencode-prober` | opencode 실측 · 참고 레포 조사 | `opencode-probe` | `_workspace/01_probe.md` |
| `litecode-dev` | `litecode-dev` | 테스트 우선 구현 | `live-test` | 코드 + `_workspace/02_dev_report.md` |
| `boundary-qa` | `boundary-qa` | 경계면 교차 대조 + 실물 테스트 | `boundary-check`, `live-test` | `_workspace/03_qa.md` |

**모든 Agent 호출에 `model: "opus"` 를 명시한다.**

```
Agent({ name: "litecode-dev", subagent_type: "litecode-dev", model: "opus", run_in_background: true,
        description: "...", prompt: "지시 · 근거(파일 경로) · 범위" })
```

## 병렬 라운드 — 겹치는 파일이 적을 때만

Cordis 서비스·플러그인은 이름으로 갈려 있어 병렬에 유리하다. 막히는 건 공유 파일(`renderer/App.tsx`·`styles.css`·
`shared/ipc.ts`·`preload.cts`·`electron/main.ts`)과 실물 테스트(머신 하나에서 Electron·opencode 동시 기동 → 타이밍 흔들림)다.

- **동시 구현은 2개까지.** 두 번째부터는 `Agent(..., isolation: "worktree")` 로 따로 작업 공간을 준다
  - worktree 는 HEAD 기준이다 — 다른 라운드의 커밋 안 된 변경은 안 보인다. `_workspace/` 도 없다(gitignore) → 요구 문서는 **절대 경로**로 준다
  - worktree 에이전트는 원본 경로(`_workspace/`)에 **쓰지 못한다**(샌드박스) — 보고서는 최종 답변 본문으로 받고 리더가 `_workspace/02_dev_report_<기능>.md` 에 옮긴다. worktree 브랜치에 커밋까지 시킨다
  - 합치기 전 시험: 리더가 scratchpad 에 임시 worktree 를 만들어 시험 합치기 → 3종을 그 트리에서 돌린다. 공유 파일(ipc·preload·main) 충돌은 대부분 "같은 자리 덧붙임" — 양쪽 줄을 다 살리면 된다
  - `node_modules` 는 원본을 심볼릭 링크(`ln -s <원본>/node_modules node_modules`), 안 되면 `npm install`
- **화면은 기능별 새 컴포넌트 파일**로 만들고 `App.tsx` 에는 끼워 넣는 몇 줄만 — 합칠 때 충돌을 작게
- **실물 테스트도 기능별 새 파일**(`tests/live/<feature>.live.test.ts`) — 자기 앱을 띄우고 다른 테스트 순서에 기대지 않는다
- **실물 테스트는 한 번에 하나** — 잠금 `/tmp/litecode-live.lock` 을 잡고 돌린다:
  `until mkdir /tmp/litecode-live.lock 2>/dev/null; do sleep 20; done; npm run test:live; rc=$?; rmdir /tmp/litecode-live.lock; exit $rc`
  (잠금이 30분 넘게 남아 있고 vitest 프로세스가 없으면 죽은 잠금 — 지워도 된다)
- **합치기는 리더**가 한다: 먼저 끝난 라운드를 커밋한 뒤 worktree 브랜치를 그 위로 합치고, 착지 조건 3종을 합친 트리에서 다시 돌린다
- 엔진 경계(`llm.ts`·`engine.ts`)나 같은 IPC 를 함께 고치는 라운드끼리는 병렬로 하지 않는다
- **돌고 있는 라운드에 범위를 얹지 않는다.** 도중에 온 요청은 `_workspace/00_next_*.md` 로 적고 다음 라운드(가능하면 병렬)로 띄운다 — 얹을 때마다 그 라운드가 다시 돌고 전체 실물 테스트도 다시 돈다(2026-10-02 채팅 라운드: 1~7 끝난 뒤 `!` 카드·이벤트·폭 수정을 얹어 크게 늦어짐). 예외: 지금 라운드가 만든 화면의 결함 수정처럼 그 라운드 없이는 못 하는 것
- **개발 중에는 자기 기능의 실물 파일만 돌린다**(`npx vitest run --config vitest.live.config.ts tests/live/<feature>.live.test.ts`, 잠금 안에서). 전체 `npm run test:live` 는 착지 직전 한 번 — 전체는 수 분이고 잠금 줄을 오래 쥔다

## 문턱 — 에이전트를 띄우기 전에 잰다

에이전트는 싸지 않다 (정의·스킬 로딩 + 재개할 때마다 대화 전체 재로딩). 이 레포는 작다(코드 수백 줄).

| 작업 | 판정 |
|---|---|
| 문서·주석, 한 파일 소폭 수정, 조사 | **리더 직접** (그래도 테스트는 쓴다 — `live-test` 스킬) |
| opencode 동작이 불확실함 | `opencode-prober` |
| 두 파일 이상, 또는 경계를 넘음 (IPC·SSE·서비스 경계) | `litecode-dev` → `boundary-qa` |
| 참고 레포 이식 | `opencode-prober`(조사·판정) → 채택분만 `litecode-dev` |

애매하면 리더가 직접 한다. 하다가 커지면 넘긴다.

**팀원에게 보내는 메시지는 지시 · 근거 · 범위 세 가지면 끝난다.** 과정 회고를 싣지 않는다.

**한 라운드에는 사용자가 요청한 것만 싣는다.** QA 의 `참고`·개선거리를 사용자 요청 라운드에 얹지 않는다 — 따로 모아
사용자에게 "다음에 할 것" 으로 보고한다. `차단`·`경고` 만 같은 라운드에서 고친다.
(2026-09-30: 즐겨찾기·삭제 요청에 QA 참고 4건을 얹었다가 사용자가 "너무 오래 걸린다" — 범위를 다시 줄였다)

## 워크플로우

### Phase 0: 컨텍스트 확인

1. `_workspace/` 를 확인한다
   - 없음 → **초기 실행**
   - 있음 + 사용자가 부분 수정 요청("QA 지적 반영", "구현만 다시") → **부분 재실행**: 해당 에이전트만, 이전 산출물 경로를 프롬프트에 넣어 부른다
   - 있음 + 새 작업 → **새 실행**: `_workspace/` 를 `_workspace_{YYYYMMDD_HHMMSS}/` 로 옮기고 시작
2. `CLAUDE.md` 의 "지금 상태" 표와 "opencode 프로토콜" 절을 읽는다 — 이미 내린 결정을 거스르는 지시를 만들지 않기 위해
3. 지금 떠 있는 프로세스를 확인해 둔다: `lsof -iTCP -sTCP:LISTEN -P | grep -E 'opencode|Electron|node'`.
   에이전트 프롬프트에 "이 PID 들은 사용자 것 — 건드리지 말 것" 으로 적는다

### Phase 1: 요구 정리 (리더)

- 요구를 **검증 가능한 성공 기준**으로 바꾼다. 가능하면 실물 테스트 시나리오 문장으로:
  "프로젝트 전환 버튼 → 폴더 선택 → 새 대화에서 보낸 메시지의 세션 directory 가 그 폴더다"
- 해석이 여럿이면 사용자에게 묻는다. 승인된 디자인 시안(CLAUDE.md 의 링크)이 있는 화면이면 시안을 기준으로 한다
- **화면 작업이면 deepseek-harness 의 해당 화면을 참조처로 지정한다** (사용자 지시 2026-09-30 — 디자인은 dsh 를 많이 참조).
  어느 패키지를 볼지는 `litecode-dev` 에이전트 정의의 "화면 디자인" 표. 00_request.md 에 "dsh 참조: `패키지`" 를 적는다.
  시안이 정한 구조는 시안, 시안이 비워 둔 상호작용·상태·부품 모양은 dsh
- `_workspace/00_request.md` 에 요구 · 성공 기준 · 범위 밖을 적는다

### Phase 2: 실측 (`opencode-prober`, 필요할 때만)

opencode 의 동작에 기대는데 CLAUDE.md·`opencode-probe` 스킬의 "확인된 것" 에 없으면 부른다.
참고 레포 이식이면 항상 부른다. 산출물 `_workspace/01_probe.md` 의 "CLAUDE.md 에 추가할 문장" 은
리더가 검토해 CLAUDE.md 에 반영한다 (실측은 쌓여야 가치가 있다).

### Phase 3: 구현 (`litecode-dev`)

프롬프트에 `00_request.md`, (있으면) `01_probe.md` 경로, 성공 기준을 넣는다.
구현자는 **테스트를 먼저 쓰고** 착지 조건 3종(typecheck · test · test:live)을 초록으로 만든다.

### Phase 4: 경계면 QA (`boundary-qa`)

`02_dev_report.md` 를 입력으로 부른다. 판정이 "수정 필요" 면:
- `차단`·`경고` 지적만 추려 `litecode-dev` 에 다시 보낸다 (`SendMessage` 로 재개하거나 부분 재실행)
- 수정 후 QA 는 **해당 지적만** 재확인한다
- 이 왕복은 2회까지. 3회째도 차단이 남으면 사용자에게 상황을 보고하고 방향을 묻는다

### Phase 5: 착지 (리더)

1. 리더가 직접 착지 조건을 한 번 더 돌린다 — 에이전트 보고를 그대로 믿지 않는다
   ```bash
   export PATH=/usr/local/bin:$HOME/.bun/bin:$PATH
   npm run typecheck && npm test && npm run test:live
   ```
2. 남은 프로세스 확인 — 이번 작업이 띄운 것이 남아 있으면 그 PID 만 정리
3. `CLAUDE.md` "지금 상태" 표 갱신 (바뀐 조각만)
4. 사용자 보고: 무엇이 바뀌었나 · 어떤 테스트가 그것을 지키나 · 남은 공백. 커밋은 사용자가 요청할 때만

## 에러 핸들링

| 상황 | 대응 |
|---|---|
| 에이전트 실패/무응답 | 1회 재시도. 재실패면 그 단계 없이 진행하되 보고에 명시 (QA 누락이면 "QA 미실행" 으로 착지 보류) |
| 실물 테스트가 환경 문제로 못 돎 | opencode 경로·첫 기동 지연부터 확인 (`live-test` 실패 판독표). 못 풀면 착지라고 하지 않고 사용자에게 알린다 |
| 구현자가 "지시가 CLAUDE.md 와 부딪힌다" 고 멈춤 | 진행 지연이 아니다. 근거를 읽고 사용자에게 묻는다 |
| 실측 결과가 CLAUDE.md 와 다름 | 서버가 정본. CLAUDE.md 를 고치고 변경을 보고에 적는다 |
| 이번 변경과 무관한 기존 빨강 | 변경 전에도 빨강이었다는 실행 결과를 붙여 보고. 몰래 고치거나 skip 하지 않는다 |

## 데이터 흐름

```
00_request.md (리더) ─▶ 01_probe.md (prober, 선택) ─▶ 코드 + 02_dev_report.md (dev) ─▶ 03_qa.md (qa)
                                                          ▲                                   │
                                                          └────────── 차단/경고 (≤2회) ───────┘
```

`_workspace/` 는 git 에 넣지 않는다 (`.gitignore`). 사후 추적용으로 보존한다.

## 테스트 시나리오

**정상 흐름 — "세션을 이어서 대화하면 이전 답이 돌아오는 버그 고쳐줘"**
1. Phase 0: `_workspace/` 없음 → 초기 실행
2. Phase 1: 성공 기준 = `llm.live.test.ts` 의 "sessionId 를 넘기면 같은 세션에서 이어서 대화한다" 가 초록
3. Phase 2: 재구독 재생은 이미 확인됨(`opencode-probe` §3) → prober 생략
4. Phase 3: dev 가 빨강 확인 → `?after=` 또는 `admittedSeq` 로 수정 → 3종 초록
5. Phase 4: QA 가 B3(SSE) 대조, 실패 턴·abort 경로 확인 → 통과
6. Phase 5: 리더 재실행 초록 → 보고

**에러 흐름 — 실물 테스트가 기동 단계에서 실패**
1. Phase 3 에서 dev 가 `opencode 실행 실패 (opencode)` 보고
2. 리더가 `live-test` 판독표 확인 → PATH 에 `~/.bun/bin` 누락 → export 후 재지시
3. 그래도 실패하면 착지 보류, 사용자에게 opencode 경로를 묻는다
