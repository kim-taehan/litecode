# 사용자 피드백

데스크탑 사용 중 보고한 문제와 불편함. 기록 + 코드 조사만 한다 — 수정은 안 한다. 뒤에 몰아서 다룬다.

> 2026-10-22: 대화 목록이 길어지는 게 부담스럽다는 이유로 "최근 10개 먼저 보기" 가 들어갔는데,
> 스크롤로 자연스럽게 앞을 보게 하는 편이 더 자연스럽단 피드백. #599 로 이어서 푼다.

## 형식
- `## YYYY-MM-DD #N — 짧은 제목` 부터 시작
- `- Where: ` 어떤 화면/어떤 동작에서 (사용자가 말한 그대로)
- `- What: ` 사용자 원문 (거의 그대로 옮긴다)
- `- Expect: ` 기대했던 동작 (사용자가 명시한 경우)
- `- Status: ` open

## 2026-10-13 #1 — 프로젝트 전환 팝업 위치

- Where: 사이드바 위쪽 프로젝트 전환(현재 프로젝트 카드)이 여는 팝업 (스크린샷 첨부 — 프로젝트 목록 + "폴더 열기⋯")
- What: "저 팝업 위치를 변경하려고 해"
- Expect: 왼쪽 사이드바(탭) 완전 옆으로 — 팝업을 사이드바 우측 가장자리 바로 옆으로 이동
- Status: done (2026-10-13)
- Fix: 2026-10-13 — `ProjectQuickOpen` 이 전환 버튼 rect 로 좌표(우측 8px·같은 높이)를 인라인으로 주도록 하고, CSS `.project-open__panel--anchored` 가 `transform: none` + 폭 클램프. 버튼이 없으면 상단 중앙 CSS 폴백.

### 조사
- 위치: `renderer/styles.css:225-231` — 팝업 위치를 통째로 정하는 CSS(`position: fixed; top: 84px; left: 50%; transform: translateX(-50%)`)
  - 관련: `renderer/ProjectQuickOpen.tsx:108`(패널 마크업) · `renderer/App.tsx:589,741`(`.app` 루트 하단 렌더) · `renderer/Sidebar.tsx:135`(트리거 카드 `.project-switch`)
- 메커니즘: 앵커(프로젝트 카드) 기준이 아니라 뷰포트 기준 고정 위치. 수평은 `left: 50%` + `translateX(-50%)` 로 창 정중앙, 수직은 `top: 84px`. JS 좌표 계산 없음(`switchRef` 는 바깥 클릭 감지용). → 사이드바 카드 위치와 무관하게 항상 창 상단 중앙에 뜬다. `docs/status.md:58`(#305, 2026-10-12): 원래 "팝오버"였는데 "상단 중앙 패널"로 바뀐 것이 본고.
- 판정: 코드에서 확인됨

## 2026-10-13 #2 — 설치본 앱과 dev 앱 포트 겹침

- Where: 설치된 앱(패키지)과 `npm run dev` 인스턴스를 동시에 실행할 때
- What: "지금 설치된 앱이랑 npm run dev 로 호출한 앱이랑 포트가 겹쳐서"
- Expect: "개발용 포트는 다른걸로 가고 싶고 아니면 동일한 포트 사용중일때 그거 피해서 할 수 있을까?" — dev 는 별도 포트, 또는 점유 중이면 다른 포트로 피하기
- Status: done (2026-10-13)
- Fix: 2026-10-13 — #332: dev 실행기(`scripts/dev.mjs`)가 5174 부터 빈 포트를 찾아 vite 를 그 포트(strictPort)로 띄우고 실제 URL 을 electron 에 준다. remote(http·TLS) 운반은 고정 포트(47600)가 다른 인스턴스에 점유되면 EADDRINUSE 로 다음 포트까지(8회) 피해 듣고, 상태·QR 이 실제 포트를 싣는다.

### 조사
- 위치:
  - `src/services/engine.ts:542-548` — 엔진(opencode) 포트: `freePort()`(127.0.0.1:0 으로 OS 임시 포트 회수), 고정값·env 없음. 기동: `engine.ts:437,455`
  - `src/services/keyProxy.ts:93` · `src/services/appMcp.ts:70` — key 프록시·앱 MCP: `listen(0)` OS 임시 포트
  - `src/services/remote/limits.ts:4` — 고정 포트 **47600**(`REMOTE_DEFAULT_PORT`, 앱이 듣는 고정 포트 중 유일). `remote/http.ts:91`·`remote/https.ts:45,109` 사용, `remote` 기능 **기본 꺼짐**(`shared/features.ts:48`)
  - `vite.config.ts:10-12` — dev 전용: vite 서버 **5174 고정**(`strictPort: true`); 설치본은 `file://` 렌더러라 안 씀
  - `electron/main.ts:84-87` — **단일 인스턴스 락**(userData 당 1개). dev·설치본 앱 이름 다 `litecode` → userData 동일(`electron/main.ts:110`, `--user-data-dir` 미사용)
  - `electron/main.ts:160` — 8080 은 provider 기본 baseURL(나가는 주소)이라 듣는 포트 아님
- 메커니즘: 엔진·프록시·MCP 는 실행마다 OS 임시 포트라 고정 충돌은 설계상 없음(잔여 리스크는 freePort close → opencode rebind 경합 창, 재시도·대체 포트 없음). 인스턴스 두 개가 동시에 있을 때 부딪힐 수 있는 고정 포트는 47600(remote 켬 전제)뿐 — EADDRINUSE 발생 시 기록만 하고 재시도·대체 없음. 그런데 동일 userData + 단일 인스턴스 락이라 기본 설정상 "설치본+dev 동시 구동" 자체가 막혀 있음 → 보고된 겹침은 비기본 실행(`--user-data-dir` 로 둘 다 띄웠거나, 5174 vite 충돌의 오독 등) 전제.
- 판정: 의심됨(코드상으로는, 실물 확인 필요) — 포트 구조는 확인됐지만, 현상 재현에는 실물 상태 확인 필요(둘 다 프로세스 살아있나, remote/l 켜져 있나, 5174 에러였나)

## 2026-10-13 #3 — ⌘+↑/↓ 세션 이동 + 현재 세션 표기 강화

- Where: 사이드바 대화(세션) 목록 (스크린샷 첨부 — 제목 + 경과 뱃지 "now"·"31min")
- What: "command 위 아래 화살표로 세션 이동하고 싶어" + "현재 세션에 대해서 더 확실하게 표기 하고 싶어"
- Expect: ⌘(Ctrl) + ↑/↓ 로 바로 이전/다음 대화로 건너뛰기(사이드바 목록 순서 기준) · 현재 세션은 **행 강조 + "현재" 라벨 뱃지**
- Status: done (2026-10-13)
- Fix: 2026-10-13 — #330(PR #331): `useSessionNav`(⌘↑/↓ = 이전/다음 대화, 목록 순서·끝에서 감) + 현재 행 `--fill-active` 바탕 + 시간 자리에 "현재" 뱃지(`sidebar.current`). 화살표를 비워주려면 터미널 탭 단축키는 ⌘T(새 터미널)·⌘[·⌘](이전/다음)으로 바꾸는 WIP 도 같이 끝.

## 2026-10-13 #5 — 선택된 대화 행을 더 확실하게

- Where: 사이드바 대화 목록 — (#3 의 현재 표기 위에 추가 요청)
- What: "근데 지금 선택된 대화 조금더 잘보이게 할 수 있을까??"
- Expect: 선택 행 바탕을 `--accent-soft`(연한 블루) + 제목 반볼드 (사용자 결정: "블루 선택")
- Status: done (2026-10-13)
- Fix: 2026-10-13 — #334(PR #335): `.session-item--active` 바탕 `--fill-active` → `--accent-soft` + 제목 500. 같은 날 dev → main sync(PR #336).

## 2026-10-13 #4 — (통합됨)

- Note: #3 에 통합 — 같은 영역(사이드바 세션 목록 이동·표기)이라 issue 도 하나
- Status: dropped (2026-10-13)

### 조사
- 위치:
  - 행: `renderer/Sidebar.tsx:178-295` (행 래퍼 .182-185, 여는 버튼 `.209-212` — 클릭 시 `setActiveIds`)
  - 현재 세션 상태: `renderer/App.tsx:68` `activeIds`(프로젝트→대화 id 맵) + `:158` 파생 `active`
  - 기존 현재 표기: `Sidebar.tsx:184` `session-item--active` → `styles.css:590` `background: var(--fill-hover)` — **호버와 완전 같은 약한 바탕**, 굵기·경계 없음. 더 짙은 토큰 `--fill-active`(`styles.css:16`) 존재하나 세션 행에 미사용
  - 전역 키 컨벤션: Mac=meta(!ctrl) / else=ctrl(!meta), alt 무시, `aria-modal` 이면 물러남, input·textarea·contenteditable 포커스에서 제외(컴포저 예외), preventDefault+stopPropagation, xterm 이기기 위해 캡처 fase·최신값 ref 로
  - **⌘↑/↓ 세션 이동 바인딩: 렌더러에 없음** (방향키 핸들은 드롭다운·콤포저뿐)
- 메커니즘: (A) 대화 교체 경로는 행 버튼의 `setActiveIds` 하나뿐 — 이동 구현은 `active` → 목록 index → 인접 요소로 교체. (B) 행 시각 요소: 상태 점 `notice-dot` · 제목 marquee · 고정 pin · 시간 뱃지 `now`/`5m`… · fresh·위임 마크.
- 판정: 코드에서 확인됨 — 단, 작업트리에 터미널 단축키 WIP(⌘↓/⌘↑ 해제)가 미커밋으로 있어 ⌘↑/↓ 를 비워주는 전제 — 사용자 결정으로 세션 이동 브랜치에 같이 종료

## 2026-10-13 #6 — LLM 대화로 훅 생성 기대

- Where: 훅 관리 다이얼로그 (새 훅 화면 — 이벤트·매치·명령·기한·범위 수동 입력)
- What: "보통 llm 에게 훅은 만들어달라고 시키지 않아?"
- Expect: "[훅 추가] 폼 빼버릴려고" — 추가 엔트리는 LLM 대화(`litecode_create` kind=hook)로만 (사용자 결정 2026-10-13, #7과 같은 issue)
- Status: done (2026-10-13)
- Fix: 2026-10-13 — #339: `HooksPopup` 의 [훅 추가] 버튼·`HookEditor` 신규 카드 제거(편집·삭제는 그대로), 인트로 는 설명 한 줄만

### 조사
- 위치:
  - UI: `renderer/PlusMenu.tsx:165-179`("훅" 줄 + `HooksPopup` 열기) · `renderer/HooksPopup.tsx:100-102`([훅 추가] 버튼) · `:145-365`(`HookEditor` 폼) — `:184` `window.litecode.saveHook`
  - 저장: `shared/ipc.ts:172,422`(`hooks:save`) → `src/services/hooks/bridge.ts:23` → `src/services/hooks.ts:269-275`(`saveHook` → `checkHookDraft`+`change`) — 파일 저장: `electron/main.ts:745-751` `userData/hooks.json` + `hooks-projects.json`, 형식 `src/services/hooks/config.ts:16-23`
  - **제이전트 도구: 존재** — `shared/make.ts:9-14`(`litecode` MCP + 도구 `create`, `MakeKind='skill'|'mcp_server'|'hook'`) → `src/services/appMcp/tools/make.ts:110-144`(스키마) · `:100-108`(`addHook` = **UI와 같은 `ctx.hooks.saveHook()`**) · `electron/main.ts:726` 플러그인 등록
  - 게이트: `src/services/engineConfig.ts:167-173` — 기본/전체 권한·매번 묻기 = `ask`, 계획 모드·하위 작업 = 도구 자체 없음(`deny`) · 기능 게이트 `shared/features.ts:9,14,39`
  - 승인 카드: `renderer/makeView.ts:58-95`(훅 카드 :90-91) · `renderer/Attention.tsx:72-81`(허용 시 scope 실어 답) · `renderer/Make.tsx:69-85`(카드 내용)
- 메커니즘: 훅은 UI 전용이 아님 — 모델이 `litecode_create(kind:'hook', …)` 를 부르면 UI 팝업과 **같은 `saveHook`·같은 `userData/*.json`** 에 저장됨. 다만: ① 계획 모드·하위 작업엔 도구 자체가 없음, ② 전체 권한에서도 매번 승인 카드를 물음(자동 승인 사용자 결정), ③ 카드를 데스크탑 화면(내용 확인)에서만 허용해야 저장됨.
- 판정: 코드에서 확인됨 — 사용자의 직관("LLM 에게 시키면 된다")은 코드상 성립. "수동 입력만 되는 듯" 보이는 이유는 위 제약(모드별 도구 유무 + 승인 카드) 때문으로 보이며, 실물에서 "시켜도 카드가 안 뜬다"는 현상이라면 별도 확인 필요

## 2026-10-13 #7 — MCP 연결은 보통 mcp.json 수정 · LLM 대화 요청

- Where: 입력창 `+` 메뉴 > MCP 서버 팝업 — 로컬 서버 추가 폼 (이름·종류·명령·인자·환경 변수를 화면에 직접 입력)
- What: "보통 mcp 연결할떄 이렇게 안하지 않나?" → "mcp.json 을 고치거나 llm 대화로 요청하잖아"
- Expect: "그래서 내가 하고 싶은 이야기는 아까 팝업에서 구지 서버추가 hook 추가 는 빼버릴려고" — MCP 팝업의 [+ 서버 추가]와 훅 팝업의 [훅 추가] 폼 제거, 추가는 LLM 대화(·mcp.json) 경로로만 + "우리 skill, mcp, hook 등을 만드는 도구 따로 제공하지 않아" — 생성 전용 폼(팝업)은 빼되, 기존 `litecode_create` 도구는 그대로 둔다 (사용자 결정 2026-10-13)
- Status: done (2026-10-13)
- Fix: 2026-10-13 — #339: `McpPopup` 의 [+ 서버 추가] 둘 · `ServerEditor` 신규 카드 제거(편집·삭제는 그대로), 추가 = LLM 대화 `litecode_create` · 프로젝트 `.mcp.json`

## 2026-10-20 #8 — 진행 중 중간 글("Let me…")이 채팅에 너무 많이 보여

- Where: 채팅 — 답이 도는 중(진행 중)에 AI 가 쓰는 중간 글(`kind: 'text'` 줄, 예: "Let me take a pragmatic approach…", "Let me read the handleEnvelope section…")이 실시간으로 채팅에 쌓이는 부분
- What: "Let me … 같은 중간(생각·계획) 글이 진행 중 채팅에 너무 많이 뜨서 노이즈가 심함" — #416 이 생각·도구 줄은 채팅에 안 쌓고(한 줄 + 우측 '턴 작업' 탭) 처리했지만 **중간 글(text 줄)은 채팅에 그대로 표시**되어 있음
- Expect: "litecode 하는 방식 참고해줘" → 시안 비교 후 **A 시안** 선택 — 진행 중 채팅에는 중간 글 안 보이고 파란 진행 줄(지금 하는 일 + 경과)만. 전문은 우측 '턴 작업' 탭. 끝난 턴의 최종 답은 그대로
- Status: done (2026-10-20)
- Fix: 2026-10-20 — `ChatTurn.tsx:132-134` `liveRows` 필터를 `kind: 'compaction'` 만으로 좁혀서 진행 중 채팅에 중간 글(text) 줄이 안 보이게 함. 채팅에는 파란 진행 줄(RunningLine) + compaction 알림만. 전문은 우측 "턴 작업" 탭(TurnTab.tsx) 그대로. 끝난 턴(`splitTurn`)은 영향 없음
- Fix 2 (2026-10-21, #565): 사용자 "최종 답도 스트리밍되지 않고 있어" — #534 가 글 줄을 다 숨겨 답이 끝날 때 한꺼번에 나왔다. 진행 중에도 마지막 도구·생각 뒤의 글(`turnView.ts liveAnswer` — splitTurn 과 같은 규칙)은 흘린다. 도구 앞 중간 글은 계속 숨김
- Fix 3 (2026-10-21, #573): 사용자 "중간 답도 보여지다가 사라지잖아" — `liveAnswer` 로 흘리던 글이 도구 호출 시 "중간 글"로 전환되며 채팅에서 사라져 혼란. 진행 중 채팅에는 compaction 줄만, 텍스트(중간 글 포함)는 우측 "턴 작업" 탭에만. `liveAnswer` 제거
- Fix 4 (2026-10-22, DeepSeek 하네스 append-only): 사용자 "딥시크처럼 구성하자" — DeepSeek CLI 의 방식: 진행 중에도 마지막 도구·생각 뒤의 글을 채팅에 스트리밍하되 **append-only** (도구가 끼어도 그 위의 글이 안 사라짐). `turnView.ts: liveAnswer` → `interimText` (string[] 반환, join 시 '\n\n' 으로 이어 붙임). `ChatTurn.tsx:138` `liveAnswerTexts = interimText(rest)` → `.turn__work` 에 단일 Markdown 블록으로 렌더링. 중간 글(도구 앞 text)은 계속 우측 "턴 작업" 탭에만. 끝난 턴(`splitTurn`)은 영향 없음
- Fix 5 (2026-10-22, #605): 사용자 "진행 줄 문구를 지금 하는 일(상태)에 맞게 여러 문구로" — 진행 줄(RunningLine)이 항상 "딥다이빙 중" 을 쓰던 게 아니라 맨 뒤에서 제일 최근 **활성 줄**의 종류별 문구로. `jobsView.ts: runningPhase` (items 역순 스캔: 재시도 대기 > 답 글(text 미완료) > 생각(think 미완료) > 도구 준비·실행 > 하위 작업 대기·준비·실행, 없으면 undefined → 기본 "딥다이빙 중"). `ChatTurn.tsx: RunningLine` — base 문구: 재시도는 "재시도 중 (n번째) · 사유"(기존, 접미사 없이) / `{도구명} 실행 중`(MCP 는 `서버/도구`) / "생각하는 중" / "답 작성 중" / "하위 작업 실행 중", 그 외 공통 "· {경과}" 접미사. `items` 을 `liveAfterWork` → `rest`(마지막 활성 줄 판정을 위해 전체). i18n: `chat.deepDivingFor` 제거(경과 접미사는 화면이 붙여 공통화), `chat.composing`·`chat.runningTool`·`chat.subtaskWorking` 추가(ko/en/zh). 라이브 테스트 기대 문구 ko 로(`tests/live/chat-layout.live`·`jobs.live`)

### 조사
- 위치:
  - (a) 파일 수정: `src/services/mcp.ts:720-727`(`projectServers` — `.mcp.json`→`opencode.json(c)`→`.opencode/opencode.json(c)` 겹쳐 읽기) → 매 턴 `prepare`(:428)→`attach`(:458, :464-466)→`ctx.llm.mcpAdd`(:488) = `POST /mcp?directory=`(`src/services/llm/service.ts:613-627`)로 그 폴더 인스턴스에 자동 붙음. 개인 설정 `~/.config/opencode`(`personalServers` :729-736)은 opencode 가 스스로 띄우고 앱은 보여 주기만(끄기/켜기 = disconnect/connect :498-507)
  - (b) LLM 대화: `litecode_create` kind=`mcp_server`(이슈 #145) — `shared/make.ts:10-15`·`src/services/appMcp/tools/make.ts:88-98`(`addMcpServer`): project+비밀 없으면 `ctx.mcp.addToProjectFile`(`mcp.ts:358-373`)이 **프로젝트 `.mcp.json` 을 실제로 고쳐 씀**, 아니면 `ctx.mcp.save`(팝업 폼과 같은 메서드, :297-341)로 앱 저장소. 승인 3겹(엔진 ask·하위 작업 제외·앱 카드 `renderer/Make.tsx` 저장 위치 선택)
  - 폼의 절대 경로 안내: `renderer/McpPopup.tsx:440`(`mcp.hint`) — `shared/i18n/ko.ts:688`(폐쇄망이라 npx 대신 미리 설치한 바이너리). 설계 근거: `_workspace/00_next_mcp.md`(프로젝트 자동 실행 = 사용자 결정)·`mcp.ts:18-54` 머리 주석
  - 테스트: `tests/unit/mcp.test.ts:146-159,185-192,274-302,453-470` · `tests/unit/makeTools.test.ts:251-356`(`.mcp.json` 에 Claude Code 모양 쓰기·비밀→앱 안) · 실물 `tests/live/mcp.live.test.ts:17`
- 메커니즘: 엔진의 `opencode.json` 에 mcp 블록이 없어, 세 길(폼·파일·대화) 모두 매 턴 `prepare → mcpAdd` 로 그 폴더 인스턴스에 런타임으로만 붙음(디스크 불리·엔진 재기동 시 다음 턴에 재붙임). 대화 경로는 `toFile` 일 때 (a) 의 `.mcp.json` 수정을 대리 — 즉 폼은 세 출처 중 "앱 저장소" 만 다루는 GUI일 뿐 독점 경로가 아님.
- 판정: 코드에서 확인됨 — 사용자가 기대한 두 경로(파일 수정·LLM 대화) 모두 실제로 존재·동작(유닛+실물 테스트 존재). 팝업 폼은 그중 하나일 뿐

## 2026-10-21 #575 — 미니맵 점 클릭 시 "턴 작업" 탭 안 열림

- Where: 채팅 오른쪽 미니맵(`Minimap.tsx`)의 가로줄(턴 마커)
- What: "미니맵 점만 클릭하면 우측에 '턴 작업' 탭이 안 열려요. 점 클릭 = 그 턴 보러 가기 + 탭을 열고 싶는데 지금 스크롤만 돼요."
- Expect: 미니맵 마커 클릭 = 해당 턴으로 스크롤 + 우측 "턴 작업" 탭 열림
- Status: done (2026-10-21, fix_575_minimap_turn_tab, PR → dev)
- Fix: 2026-10-21 — `Minimap` 마커가 클릭 시 스크롤만 한 뒤 `onTurnOpen(turn)` 을 부르게 만들고, `turnView.ts` 의 `minimapTurnDetails(messages, conversationId)` 가 각 마커에 그 턴의 `startedAt`(user.message.at)·끝난 답의 `items`·`duration`·`failed/interrupted/declined`·`conversationId` 를 채운다. `ConversationView` 는 끝난 턴이면 `feedCompletedTurn` + `openTurnTab`(진행 중 턴은 `openTurnTab` 만). 예전처럼 내 말(`.user-turn`) 닻 순서는 그대로라 scroll pairing 이 흔들리지 않는다.

## 2026-10-21 #577 — 창이 줄면 턴 미니맵이 숨김

- Where: 채팅 오른쪽 턴 미니맵(`Minimap.tsx`)
- What: "메인창이 줄면 하이드 되는데 확인해죠"
- Expect: 창이 줄어도 미니맵은 늘 보인다 (사용자 결정 2026-10-21)
- Status: done (2026-10-21, fix_577_minimap_always, PR → dev)
- Fix: 2026-10-21 — `renderer/chat.css` 의 `@container (max-width: 900px) { .minimap { display: none; } }` 제거. 채팅 칸(`.chat-pane`, `container-type: inline-size`) 폭이 900px 이하면 숨기던 규칙이라, 창을 줄이거나 사이드바·오른쪽 패널을 넓히면 채팅 칸 900px 미만으로 떨어져 미니맵이 사라졌다.

## 2026-10-22 #599 — "이전 N개 보기" 버튼 → 스크롤 최상단에서 자동으로 한 페이지 더

- Where: 채팅 — 오래된 대화가 있으면 "이전 N개 보기" 버튼. 현재는 클릭하면 **전체**가 아니라 최근 N=10개만 다시 불러와도 된다는 점 (이슈 #599).
- What: "버튼이 아닌 스크롤이 최상단으로 가면 자동으로 갱신되게" — "이전 N개 보기" 버튼 대신, 스크롤이 최상단(약 40px) 근처에 오면 자동으로 한 페이지만 더 본다 (사용자 결정, 2026-10-22)
- Expect: 스크롤로 자연스럽게 앞 턴을 볼 수 있게 + "이전 N개"의 실질적 개수가 보이는 숫자와 같은 페이지만 불러 온다
- Status: open (2026-10-22, fix_599_earlier_turns 브랜치 작업 중)

### 조사
- 위치:
  - `renderer/ConversationView.tsx:115-131` — `loadEarlier()`: 원래 `loadConversation(id)` (limit 없이 전체). 이제 `RECENT_FIRST_LIMIT=10` 으로 한 페이지만. 스크롤 `handler`(:136-152) 가 `nearTop(< 40px)` 만 되면 `loadEarlier()` 를 부름 — 버튼이 아닌 이벤트로 트리거
  - `renderer/ConversationView.tsx:153-169` — 로딩 후 새 첫 내 말(`.user-turn` 첫 개)이 이전 첫 내 말과 같은 y 가 되게 스크롤 오프셋 보정. `loadingRef` 로 중복 로딩 방지
  - `renderer/ConversationView.tsx:26-32` — 상단 "이전 N개 보기" 표시 줄 (`.main__load-more`) — 스크롤 자동 로드에도 같은 문구로 보임
  - `renderer/App.tsx:387-397` — 첫 로딩 (대화 열 때) 이 `RECENT_FIRST_LIMIT=10` 이라 더 있으면 `historyMore=true`
  - `src/services/llm/service.ts:574-591` — `history()`: limit 가 있으면 첫 내 말 턴 경계(:578-581)로 잘라 중간 턴이 안 섞이게; `visible.length===0 && raw.length>=limit` 이면 `more: true, hiddenCount: limit`
  - `renderer/session.ts:27-33` — `Session` 의 `historyMore`·`hiddenCount` 필드
  - `shared/contract.ts:246` — `History` 의 `hiddenCount` 필드
  - `renderer/chatState.ts:93-95` — `applyHistory()`
  - i18n: `shared/i18n/ko.ts:112`('위까지 내리면 이전 10개가 더 보인다'), `en.ts:107`('Scroll up for 10 earlier turns')
- 메커니즘: (1) `RECENT_FIRST_LIMIT` 을 `ConversationView` 로 이관해 `App`·`loadEarlier` 가 공용. (2) 스크롤 이벤트 + `nearTop` 검사 = 자동 한 페이지만. (3) 로딩 후 `firstTurnRef` 이전 첫 내 말 → new first turn 으로 보정. (4) `service.ts::history()` 가 limit 의 첫 메시지가 `user` 가 아님 (중간 턴) 이면 첫 `user` 경계로 잘라 중간 턴이 보이지 않게. 그 페이지만이 `user` 라면 `visible=[]` → `more`/`hiddenCount` 로 이전이 있음을 알리고 그 수가 `limit`(=10) 이 아니라 `raw.length - (0)` 인데, `raw` 이미 limit 개라 그대로
- 판정: 코드에서 확인됨 — `more: true` 와 `hiddenCount` 가 페이지만(최대 10)으로 정확히 알려야 하므로, `visible=[]` 인 경우에도 `more`/`hiddenCount: limit`(=10) 을 그대로 쓰고, `visible.length>0` 이면 경계로 잘아 표시

## 2026-10-22 #606 — 히스토리 페이징이 반대 방향 (첫 로딩에 가장 오래된 페이)

- Where: 채팅 — 긴 대화 처음 열 때·스크롤 최상단 자동 로딩 (#602 에서 추가된 `history()` 페이징)
- What: "3턴 대화가 1턴만 보인다" — #602 페이징이 #1: 첫 로딩 `offset=0, limit=10` 이 `all.slice(0,10)` 으로 **가장 오래된** 10개를 가져와 첫 페이에 오래된 턴만 보여 주는 문제, #2: `loadEarlier` 가 client 가 세운 메시지 수를 offset 으로 쓰다 보니 불러온 페이가 이미 본 것 **뒤(더 최신)** 쪽이어서 앞에 붙이면 순서가 뒤집히고 다음 페이 offset 이 흘러내리는 문제
- Expect: 첫 로딩 = 최신 N 개, 스크롤 최상단에서 더 이전 페이가 순서대로 (겹침·누락 없이) 이어 보임
- Status: open (2026-10-22, feat_605_deepagents_harness 에서 수정, 커밋 대기)
- Fix: 2026-10-22 — 페이징을 서비스 쪽 커서로: `query.offset` = 끝(최신)에서부터 이미 보여 준 엔진 메시지 수. `service.ts::history()` 가 `end = all.length - offset`, `start = end - limit` 로 페이를 자르고(페이가 user 턴 경계에서 끊기지 않게, 역사 시작이면 그대로), `History.offset = all.length - cut` 으로 다음 페이 커서를 돌려준다. client(App 첫 로딩·`loadEarlier`) 는 그 커서를 그대로 되돌려 client 세기 없음. 레거시 기록(`previousHistory`) 은 역사 시작에 이르는 페이에만 붙여 페이마다 중복 안 됨. 더 이상 안 쓰는 `hiddenCount`(contract·session)·버튼 시대 `chat.loadMore` i18n 키 제거.

## 2026-10-22 #607 — 대화 열면 페이지네이션(최근 10개) 제거 — 전체 히스토리 로드

- Where: 채팅 — 기존 대화 열 때·스크롤 최상단 자동 로딩 (#599/#602/#606 에 추가된 페이지네이션)
- What: "그건 관련된 로직 다 지워. 여기 창만 해도 10턴 넘게 대화 했는데 다시 열었을 때 3턴만 보이고 있어." — 최근 N=10 **엔진 메시지** 가 최근 턴 약 3개에 불과해, 긴 대화를 다시 열면 3턴만 보여 사용자 경험에 부적합 (사용자 결정 2026-10-22: 페이지네이션을 계속 고치지 않고 **전체 로드로 갈음**)
- Expect: 기존 대화 열면 전체 히스토리가 한 번에 렌더링 (페이지네이션·스크롤 최상단 자동 로딩 관련 로직 전부 제거)
- Status: done (2026-10-22, fix_607_history_full_load, PR → dev)
- Fix: 2026-10-22 — 페이지네이션 관련 로직을 전부 지우고 `history()` 가 전체 목록을 한 번에 돌려준다.
  - `shared/contract.ts` — `History` 의 `more?`·`offset?` 필드 제거
  - `src/services/llm/service.ts::history()` — `query? {limit,offset}` 파라미터·페이 slicing(end/start/턴 경계 cut)·more/nextOffset 모두 제거. 항상 `all`(전체)을 `historyMessages` 로 조립하고, 레거시 기록(`previousHistory`) 을 역사 시작(가장 오래된 것)에 붙인다
  - `src/services/sessions.ts::history(id)` — `query?` 파라미터와 `ctx.llm.history(..., query)` 전달 제거
  - `electron/main.ts` / `electron/preload.cts` / `shared/ipc.ts` — `LOAD_CONVERSATION`·`loadConversation` 의 `query` 인수 제거 (id only)
  - `renderer/session.ts` — `Session` 의 `historyMore?`·`historyOffset?` 필드 제거 (`history` 상태만 유지)
  - `renderer/ConversationView.tsx` — `RECENT_FIRST_LIMIT` 상수·`nearTop`·`loadEarlier()`·스크롤 리스너(`useEffect`)+`loadingRef`/`firstTurnRef`/`priorScrollTopRef`·스크롤 오프셋 보정 `useEffect`·`updateSession` prop·`applyHistory`/`useEffect`/`useRef` import 제거
  - `renderer/App.tsx` — `RECENT_FIRST_LIMIT` import 제거, 첫 로딩 `useEffect` 가 `loadConversation(id)` (전체) 로 바꾸고 `historyMore`/`historyOffset` 설정 제거, `ConversationView` 에 `updateSession` prop 제거
  - 테스트: 페이 관련 테스트 없음 (unit + live 모두 무변경 통과), typecheck clean

## 2026-10-23 #612 — hover 카드(전체 제목) 이 800ms 뒤에 뜬다 — 느림

- Where: 사이드바 대화 행 — 마우스를 올리면 뜨는 전체 제목 카드 (접힌 레일 아이콘도 같은 메커니즘)
- What: "보면 토글이 뜨는데 속도가 너무 느려" (2026-10-23, 스크린샷 첨부) — 호버해도 카드가 바로 안 보이고 확연한 지연 뒤에 뜬다
- Expect: 카드가 더 빨리 보이면 좋겠다 → "바로 나오면 좋겠어" (2026-10-23, 사용자 결정: 즉시 표시)
- Status: done (2026-10-23)
- Fix: 2026-10-23 — `renderer/hoverCard.tsx` useHoverCard의 800ms `setTimeout` 제거, 호버하자마자 카드 표시(타이머 ref·클리어 전체 삭제). live 테스트 `tests/live/sidebar.live.test.ts` 는 즉시 표시(700ms 미만)로 수정

### 조사
- 위치: `renderer/hoverCard.tsx:65-69` — `useHoverCard().enter()` 가 `setTimeout(setCard, 800)` (주석 "dsh HoverCard 열림 지연"). CSS `.hover-card`(`renderer/styles.css:1348-1373`) 에 transition·페이드 없음 — 순수 JS 타이머 지연
- 사용처: `renderer/Sidebar.tsx:367-376` (세션 행 `sessionHover.enter(…, true)` — 항상 카드) · `renderer/Rail.tsx:33-38` (레일 아이콘 `tip()` 헬퍼, 항상)
- 메커니즘: 호버 시 제목 글자 흐르기(marquee) 는 즉시 시작하지만, 전체 제목 카드는 800ms 뒤에 표시. 떠 나가면 즉시 사라짐
- 판정: 코드에서 확인됨 — 고정 800ms 지연이 "느림" 현상의 직접 원인

## 2026-10-23 #614 — 실패 턴의 작업 줄(생각·도구·중간 글)이 접히지 않는다

- Where: 채팅 — 실패한 턴의 머리("실패 · N분 N초")와 그 아래 작업 줄(생각·도구·중간 글)
- What: "실패를 할 수 있는데 중간대화 및 사고 과정을 숨기는기능이 미구현 이야 성공일때와 실패 있을때 최종답변만 남기는 프로세스를 그대로 유지하도록 하고 싶어" (2026-10-23, 스크린샷 첨부)
- Expect: 완료 턴("완료 · N초 ⌄" 기본 접힘)처럼 실패 턴도 끝난 뒤 기본 접힘 — 최종 답변(실패면 `⚠️ 사유`)만 보이고, 턴 머리를 눌러야 생각·도구·중간 글 줄이 보임 (사용자 결정 2026-10-23: 기본 상태를 접힌 채)
- Status: done (2026-10-23)
- Fix: 2026-10-23 — `ChatTurn.tsx` `AssistantTurn` 의 `unfolded = failed && !interrupted` 제거, 접기 규칙을 `foldable = !running && work.length > 0` 로 — 끝난 턴(완료·실패·중단·거절)이 전부 기본 접히고 머리 버튼으로 작업 줄을 펼친다(중단 #516 에 실패가 합류). 접힌 작업 줄은 DOM 에 hidden 으로 유지(대화 안 찾기 #79). 머리의 붉은 색·접기 문구는 기존 CSS·i18n 그대로. 단위 `tests/unit/interruptedFold.test.ts`.
